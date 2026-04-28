import Fastify, { FastifyInstance } from "fastify";
import { createUlid } from "../events/types.js";
import { Orchestrator, createOrchestrator } from "../orchestrator/index.js";

export type BuildAppOptions = {
  orchestrator?: Orchestrator;
  startOrchestrator?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const orchestrator = options.orchestrator ?? createOrchestrator();
  if (options.startOrchestrator !== false) {
    await orchestrator.start();
  }

  const app = Fastify({ logger: true });

  app.addHook("onClose", async () => {
    await orchestrator.stop();
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/admin/health", async () => ({
    status: "ok",
    runtime: runtimeModes(),
    keeperhub: await keeperHubStatus(orchestrator),
    orchestrator: orchestrator.status()
  }));

  app.get("/admin/agents", async () => orchestrator.status().agents);

  app.post("/styles/upload", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = createUlid();
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const event = await orchestrator.publish({
      type: "style.uploaded",
      actor: walletAddress,
      payload: {
        requestId,
        samples: requireStringArray(body.samples, "samples"),
        attestationMessage: body.attestationMessage,
        attestationSignature: body.attestationSignature,
        language: body.language ?? "en",
        genres: Array.isArray(body.genres) ? body.genres : [],
        royaltyWei: body.royaltyWei ?? "1000000000000000",
        tokenMetadataURI: body.tokenMetadataURI ?? ""
      }
    });
    return reply.code(202).send({ requestId, eventId: event.id });
  });

  app.post("/styles/confirm-mint", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = requireString(body.requestId, "requestId");
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const tokenId = requireString(body.tokenId, "tokenId");
    const txHash = requireString(body.txHash, "txHash");
    const pendingStyleId = typeof body.pendingStyleId === "string" ? body.pendingStyleId : undefined;

    const style = await orchestrator.chain.styleOf(tokenId);
    if (runtimeModes().chain === "0g" && style.creator.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error("Mint confirmation creator does not match connected wallet");
    }
    if (pendingStyleId) {
      const pendingProfileKey = `style:${pendingStyleId}:profile`;
      const confirmedProfileKey = `style:${tokenId}:profile`;
      const pendingProfile = await orchestrator.storage.kvGet<Record<string, unknown>>(pendingProfileKey);
      if (pendingProfile) {
        void orchestrator.storage
          .kvSet(confirmedProfileKey, {
            ...pendingProfile,
            confirmedStyleId: tokenId,
            pendingStyleId,
            mintTxHash: txHash
          })
          .catch((error) => {
            request.log.warn({ error }, "background confirmed profile write failed");
          });
      }
    }

    const event = await orchestrator.publish({
      id: `${requestId}:style.minted:${tokenId}`,
      type: "style.minted",
      actor: "system",
      styleId: tokenId,
      payload: {
        requestId,
        tokenId,
        pendingStyleId,
        txHash,
        explorerUrl: explorerTxUrl(txHash),
        status: "confirmed_onchain"
      }
    });
    return reply.send({ ok: true, eventId: event.id });
  });

  app.get("/credits/:address", async (request) => {
    const params = request.params as { address: string };
    const [credits, creditPriceWei, autoRefill] = await Promise.all([
      orchestrator.chain.credits(params.address),
      orchestrator.chain.creditPrice(),
      orchestrator.chain.autoRefillOf(params.address)
    ]);
    return {
      address: params.address,
      credits: credits.toString(),
      creditPriceWei: creditPriceWei.toString(),
      autoRefill: {
        maxBudget: autoRefill.maxBudget.toString(),
        spent: autoRefill.spent.toString(),
        remainingBudget: (autoRefill.maxBudget > autoRefill.spent ? autoRefill.maxBudget - autoRefill.spent : 0n).toString(),
        threshold: autoRefill.threshold.toString(),
        perRefill: autoRefill.perRefill.toString(),
        enabled: autoRefill.enabled,
        supported: autoRefill.supported
      }
    };
  });

  app.get("/keeperhub/chains", async () => {
    const chainId = Number(process.env.KEEPERHUB_CHAIN_ID || process.env.OG_CHAIN_ID || 16602);
    return orchestrator.keeperhub.isChainSupported(chainId);
  });

  app.post("/credits/buy-intent", async (request, reply) => {
    const body = asRecord(request.body);
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const amount = BigInt(requireString(body.amount, "amount"));
    const requestId = typeof body.requestId === "string" ? body.requestId : createUlid();
    const intent = await orchestrator.chain.buyCreditsIntent(amount);
    await orchestrator.publish({
      id: `${requestId}:credit.purchase.intent.created`,
      type: "credit.purchase.intent.created",
      actor: "system",
      consumerAddress: walletAddress,
      payload: { requestId, amount: amount.toString(), intent }
    });
    return reply.code(202).send({ requestId, intent });
  });

  app.post("/credits/confirm-purchase", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = requireString(body.requestId, "requestId");
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const txHash = requireString(body.txHash, "txHash");
    const amount = requireString(body.amount, "amount");
    const event = await orchestrator.publish({
      id: `${requestId}:credit.purchased:${txHash}`,
      type: "credit.purchased",
      actor: "system",
      consumerAddress: walletAddress,
      payload: { requestId, amount, txHash, explorerUrl: explorerTxUrl(txHash), status: "confirmed_onchain" }
    });
    return reply.send({ ok: true, eventId: event.id });
  });

  app.post("/credits/auto-refill-intent", async (request, reply) => {
    const body = asRecord(request.body);
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const maxBudget = BigInt(requireString(body.maxBudgetWei, "maxBudgetWei"));
    const threshold = BigInt(requireString(body.threshold, "threshold"));
    const perRefill = BigInt(requireString(body.perRefill, "perRefill"));
    const requestId = typeof body.requestId === "string" ? body.requestId : createUlid();
    const intent = await orchestrator.chain.setAutoRefillIntent({
      consumerAddress: walletAddress,
      maxBudget,
      threshold,
      perRefill
    });
    await orchestrator.publish({
      id: `${requestId}:credit.auto_refill.intent.created`,
      type: "credit.auto_refill.intent.created",
      actor: "system",
      consumerAddress: walletAddress,
      payload: { requestId, maxBudgetWei: maxBudget.toString(), threshold: threshold.toString(), perRefill: perRefill.toString(), intent }
    });
    return reply.code(202).send({ requestId, intent });
  });

  app.post("/credits/confirm-auto-refill", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = requireString(body.requestId, "requestId");
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const txHash = requireString(body.txHash, "txHash");
    const config = await orchestrator.chain.autoRefillOf(walletAddress);
    const event = await orchestrator.publish({
      id: `${requestId}:credit.auto_refill.configured:${txHash}`,
      type: "credit.auto_refill.configured",
      actor: "system",
      consumerAddress: walletAddress,
      payload: {
        requestId,
        txHash,
        explorerUrl: explorerTxUrl(txHash),
        status: "confirmed_onchain",
        autoRefill: {
          maxBudget: config.maxBudget.toString(),
          spent: config.spent.toString(),
          remainingBudget: (config.maxBudget > config.spent ? config.maxBudget - config.spent : 0n).toString(),
          threshold: config.threshold.toString(),
          perRefill: config.perRefill.toString(),
          enabled: config.enabled,
          supported: config.supported
        }
      }
    });
    return reply.send({ ok: true, eventId: event.id });
  });

  app.post("/generate", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = createUlid();
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const styleId = requireString(body.styleId, "styleId");
    const event = await orchestrator.publish({
      type: "generation.requested",
      actor: walletAddress,
      styleId,
      consumerAddress: walletAddress,
      payload: {
        requestId,
        consumerAddress: walletAddress,
        styleId,
        prompt: requireString(body.prompt, "prompt"),
        platforms: Array.isArray(body.platforms) ? body.platforms : ["x", "linkedin", "instagram"]
      }
    });
    return reply.code(202).send({ requestId, eventId: event.id });
  });

  app.post("/feedback", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = createUlid();
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const styleId = requireString(body.styleId, "styleId");
    const event = await orchestrator.publish({
      type: "feedback.received",
      actor: walletAddress,
      styleId,
      consumerAddress: walletAddress,
      payload: {
        requestId,
        styleId,
        feedback: requireString(body.feedback, "feedback"),
        generationEventId: body.generationEventId
      }
    });
    return reply.code(202).send({ requestId, eventId: event.id });
  });

  app.post("/settlement/confirm", async (request, reply) => {
    const body = asRecord(request.body);
    const requestId = requireString(body.requestId, "requestId");
    const walletAddress = requireString(body.walletAddress, "walletAddress");
    const styleId = requireString(body.styleId, "styleId");
    const txHash = requireString(body.txHash, "txHash");
    await orchestrator.publish({
      id: `${requestId}:credit.deducted:${txHash}`,
      type: "credit.deducted",
      actor: "system",
      styleId,
      consumerAddress: walletAddress,
      payload: { requestId, txHash, explorerUrl: explorerTxUrl(txHash), status: "confirmed_onchain" }
    });
    const event = await orchestrator.publish({
      id: `${requestId}:royalty.settled:${txHash}`,
      type: "royalty.settled",
      actor: "system",
      styleId,
      consumerAddress: walletAddress,
      payload: { requestId, txHash, explorerUrl: explorerTxUrl(txHash), status: "confirmed_onchain" }
    });
    const [credits, autoRefill] = await Promise.all([
      orchestrator.chain.credits(walletAddress),
      orchestrator.chain.autoRefillOf(walletAddress)
    ]);
    if (autoRefill.enabled && credits <= autoRefill.threshold) {
      await orchestrator.publish({
        id: `${requestId}:credit.low:auto-refill:${txHash}`,
        type: "credit.low",
        actor: "system",
        styleId,
        consumerAddress: walletAddress,
        payload: {
          requestId,
          reason: "post_settlement_threshold",
          credits: credits.toString(),
          threshold: autoRefill.threshold.toString(),
          autoRefill: {
            maxBudget: autoRefill.maxBudget.toString(),
            spent: autoRefill.spent.toString(),
            remainingBudget: (autoRefill.maxBudget > autoRefill.spent ? autoRefill.maxBudget - autoRefill.spent : 0n).toString(),
            threshold: autoRefill.threshold.toString(),
            perRefill: autoRefill.perRefill.toString(),
            enabled: autoRefill.enabled,
            supported: autoRefill.supported
          }
        }
      });
    }
    return reply.send({ ok: true, eventId: event.id });
  });

  app.get("/events/:requestId", async (request) => {
    const params = request.params as { requestId: string };
    return { requestId: params.requestId, events: orchestrator.eventsForRequest(params.requestId) };
  });

  app.get("/events/stream/:requestId", async (request, reply) => {
    const params = request.params as { requestId: string };
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no"
    });
    raw.write(`: connected ${Date.now()}\n\n`);

    const send = (event: unknown) => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      raw.write(`: keepalive ${Date.now()}\n\n`);
    }, 15_000);
    for (const event of orchestrator.eventsForRequest(params.requestId)) {
      send(event);
    }
    const unsubscribe = orchestrator.events.subscribeAll((event) => {
      if (event.id === params.requestId || event.payload.requestId === params.requestId) {
        send(event);
      }
    });
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Missing required string array: ${field}`);
  }
  return value as string[];
}

function runtimeModes() {
  return {
    storage: process.env.AGENT_STORAGE_MODE === "0g" ? "0g" : "memory",
    compute:
      process.env.AGENT_COMPUTE_MODE === "0g" || process.env.AGENT_COMPUTE_MODE === "live" ? "0g" : "mock",
    chain: process.env.AGENT_CHAIN_MODE === "0g" || process.env.AGENT_CHAIN_MODE === "live" ? "0g" : "mock",
    costProfile:
      process.env.AGENT_STORAGE_MODE === "0g" ||
      process.env.AGENT_COMPUTE_MODE === "0g" ||
      process.env.AGENT_COMPUTE_MODE === "live" ||
      process.env.AGENT_CHAIN_MODE === "0g" ||
      process.env.AGENT_CHAIN_MODE === "live"
        ? "live_0g"
        : "zero_cost_mock"
  };
}

function explorerTxUrl(txHash: string): string {
  const explorer = process.env.OG_EXPLORER_URL?.replace(/\/$/, "") ?? "https://chainscan-galileo.0g.ai";
  return `${explorer}/tx/${txHash}`;
}

async function keeperHubStatus(orchestrator: Orchestrator) {
  const chainId = Number(process.env.KEEPERHUB_CHAIN_ID || process.env.OG_CHAIN_ID || 16602);
  try {
    return await orchestrator.keeperhub.isChainSupported(chainId);
  } catch (error) {
    return { supported: false, chainId, reason: error instanceof Error ? error.message : String(error) };
  }
}

import { Buffer } from "node:buffer";
import Fastify, { FastifyInstance, FastifyReply } from "fastify";
import { detailedStyleGuidePrompt } from "../agents/prompts.js";
import { AgentEvent, createUlid } from "../events/types.js";
import { MockChainClient } from "../infra/chain.js";
import { Orchestrator, createOrchestrator } from "../orchestrator/index.js";
import { AgentStorage, ChatResult } from "../infra/types.js";

type StyleOutputPreview = {
  requestId?: string;
  prompt?: string;
  draft?: string;
  variants?: Record<string, string>;
  teeVerified?: boolean | null;
  timestamp?: number;
};

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
  const proofCache = new Map<string, { expiresAt: number; value: unknown }>();
  let zeroGHealthCache: { expiresAt: number; value: unknown } | undefined;

  app.addHook("onClose", async () => {
    await orchestrator.stop();
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/admin/health", async () => {
    const zeroG = await cachedZeroGHealth(() => zeroGHealthCache, (value) => {
      zeroGHealthCache = value;
    });
    return {
      status: "ok",
      runtime: runtimeModes(),
      modes: runtimeModes(),
      "0g_health": zeroG,
      zeroG,
      persistence: storageDiagnostics(orchestrator.storage),
      orchestrator: orchestrator.status()
    };
  });

  app.get("/admin/agents", async () => orchestrator.status().agents);

  app.get("/proof/:requestId", async (request, reply) => {
    const params = request.params as { requestId: string };
    const cached = proofCache.get(params.requestId);
    const proof = cached && cached.expiresAt > Date.now()
      ? cached.value
      : await buildProofBundle(orchestrator, params.requestId);
    proofCache.set(params.requestId, { expiresAt: Date.now() + 60_000, value: proof });
    const accept = request.headers.accept ?? "";
    if (accept.includes("text/html")) {
      return reply.type("text/html").send(renderProofHtml(proof));
    }
    return proof;
  });

  app.get("/storage/blob", async (request, reply) => {
    const query = request.query as { rootHash?: string };
    const rootHash = query.rootHash;
    if (!rootHash) {
      return reply.code(400).send({ error: "missing_root_hash" });
    }
    const bytes = await orchestrator.storage.downloadRaw(rootHash);
    const text = Buffer.from(bytes).toString("utf8");
    try {
      return reply.send(JSON.parse(text));
    } catch {
      return reply.type("text/plain").send(text);
    }
  });

  app.get("/styles", async (request) => {
    const query = request.query as { ids?: string; max?: string; includeUnlisted?: string };
    const max = clampPositiveInteger(query.max, 12, 50);
    const liveChain = runtimeModes().chain === "0g";
    const ids = query.ids
      ? query.ids.split(",").map((id) => id.trim()).filter(Boolean)
      : liveChain
        ? Array.from({ length: max }, (_item, index) => String(index + 1))
        : styleIdsWithLocalEvidence(orchestrator, max);
    const styles = await mapWithConcurrency(ids, 4, async (tokenId) => {
        try {
          return await styleDetails(orchestrator, tokenId);
        } catch {
          return null;
        }
      });
    const discovered = styles
      .filter((style): style is NonNullable<typeof style> => Boolean(style))
      .filter((style) => liveChain || styleHasBackendEvidence(style))
      .filter((style) => query.includeUnlisted === "true" || style.chain.listed);
    discovered.sort(compareMarketplaceStyles);
    return {
      source: liveChain ? "StyleRegistry.styleOf on 0G Chain" : "local backend evidence",
      scannedTokenIds: ids,
      profiledCount: discovered.filter((style) => Boolean(style.profile)).length,
      generatedCount: discovered.filter((style) => style.recentOutputs.length > 0).length,
      styles: discovered
    };
  });

  app.get("/styles/:tokenId", async (request) => {
    const params = request.params as { tokenId: string };
    return styleDetails(orchestrator, params.tokenId);
  });

  app.post("/styles/:tokenId/regenerate-guide", async (request, reply) => {
    const params = request.params as { tokenId: string };
    try {
      return await regenerateDetailedStyleGuide(orchestrator, params.tokenId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ ok: false, error: "style_guide_generation_failed", message });
    }
  });

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
        styleName: optionalString(body.styleName),
        description: optionalString(body.description),
        keywords: stringArrayOrEmpty(body.keywords).slice(0, 8),
        sourceKind: optionalString(body.sourceKind) ?? "unknown",
        sourceSummary: optionalString(body.sourceSummary),
        sourceMaterials: sanitizeSourceMaterials(body.sourceMaterials),
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
    if (runtimeModes().chain === "0g" && !(orchestrator.chain instanceof MockChainClient) && style.creator.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error("Mint confirmation creator does not match connected wallet");
    }
    const receipt = await verifyOrFail(reply, () =>
      orchestrator.chain.verifyMintReceipt(txHash, { tokenId, creator: walletAddress })
    );
    if (!receipt) {
      await orchestrator.publish({
        id: `${requestId}:style.failed:${txHash}`,
        type: "style.failed",
        actor: "system",
        styleId: tokenId,
        payload: {
          requestId,
          tokenId,
          pendingStyleId,
          txHash,
          reason: "mint_receipt_verification_failed"
        }
      });
      return;
    }
    if (pendingStyleId) {
      const pendingProfileKey = `style:${pendingStyleId}:profile`;
      const confirmedProfileKey = `style:${tokenId}:profile`;
      const pendingProfile = await orchestrator.storage.kvGet<Record<string, unknown>>(pendingProfileKey);
      const confirmedWrites: Array<Promise<void>> = [];
      if (pendingProfile) {
        confirmedWrites.push(
          orchestrator.storage.kvSet(confirmedProfileKey, {
            ...pendingProfile,
            confirmedStyleId: tokenId,
            pendingStyleId,
            mintTxHash: txHash
          })
        );
      }
      const pendingAgentBrainKey = `style:${pendingStyleId}:agentBrain`;
      const confirmedAgentBrainKey = `style:${tokenId}:agentBrain`;
      const pendingAgentBrain = await orchestrator.storage.kvGet<Record<string, unknown>>(pendingAgentBrainKey);
      if (pendingAgentBrain) {
        confirmedWrites.push(
          orchestrator.storage.kvSet(confirmedAgentBrainKey, {
            ...pendingAgentBrain,
            confirmedStyleId: tokenId,
            pendingStyleId,
            mintTxHash: txHash
          })
        );
      }
      if (confirmedWrites.length > 0) {
        try {
          await Promise.all(confirmedWrites);
        } catch (error) {
          request.log.warn({ error }, "confirmed style metadata write failed");
        }
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
        receipt,
        status: "confirmed_onchain"
      }
    });
    return reply.send({ ok: true, eventId: event.id });
  });

  app.get("/credits/:address", async (request) => {
    const params = request.params as { address: string };
    const [credits, creditPriceWei] = await Promise.all([
      orchestrator.chain.credits(params.address),
      orchestrator.chain.creditPrice()
    ]);
    return {
      address: params.address,
      credits: credits.toString(),
      creditPriceWei: creditPriceWei.toString()
    };
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
    const receipt = await verifyOrFail(reply, () =>
      orchestrator.chain.verifyCreditPurchaseReceipt(txHash, { buyer: walletAddress, amount })
    );
    if (!receipt) {
      return;
    }
    const event = await orchestrator.publish({
      id: `${requestId}:credit.purchased:${txHash}`,
      type: "credit.purchased",
      actor: "system",
      consumerAddress: walletAddress,
      payload: { requestId, amount, txHash, explorerUrl: explorerTxUrl(txHash), receipt, status: "confirmed_onchain" }
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
        platforms: sanitizeGenerationPlatforms(body.platforms),
        ...(body.styleHint && typeof body.styleHint === "object" ? { styleHint: body.styleHint } : {})
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
    const receipt = await verifyOrFail(reply, () =>
      orchestrator.chain.verifySettlementReceipt(txHash, { consumer: walletAddress, tokenId: styleId })
    );
    if (!receipt) {
      return;
    }
    await orchestrator.publish({
      id: `${requestId}:credit.deducted:${txHash}`,
      type: "credit.deducted",
      actor: "system",
      styleId,
      consumerAddress: walletAddress,
      payload: { requestId, txHash, explorerUrl: explorerTxUrl(txHash), receipt, status: "confirmed_onchain" }
    });
    const event = await orchestrator.publish({
      id: `${requestId}:royalty.settled:${txHash}`,
      type: "royalty.settled",
      actor: "system",
      styleId,
      consumerAddress: walletAddress,
      payload: { requestId, txHash, explorerUrl: explorerTxUrl(txHash), receipt, status: "confirmed_onchain" }
    });
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
      "X-Accel-Buffering": "no"
    });

    const send = (event: unknown) => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    raw.write(": connected\n\n");
    const keepAlive = setInterval(() => {
      raw.write(": ping\n\n");
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
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  return app;
}

async function verifyOrFail<T>(reply: FastifyReply, verify: () => Promise<T>): Promise<T | undefined> {
  try {
    return await verify();
  } catch (error) {
    const message = error instanceof Error ? error.message : "receipt verification failed";
    reply.code(400).send({ ok: false, error: "receipt_verification_failed", message });
    return undefined;
  }
}

type KvLookup<T> = { key: string; value: T } | { key?: undefined; value: null };

async function firstStoredKv<T>(orchestrator: Orchestrator, keys: Array<string | undefined>): Promise<KvLookup<T>> {
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const value = await orchestrator.storage.kvGet<T>(key);
    if (value) {
      return { key, value };
    }
  }
  return { value: null };
}

function kvKeyFromUri(uri: string | undefined): string | undefined {
  const prefix = "0g://kv/";
  if (!uri?.startsWith(prefix)) {
    return undefined;
  }
  const key = uri.slice(prefix.length);
  return key.length > 0 ? key : undefined;
}

function pendingStyleIdFromProfileKey(key: string | undefined): string | undefined {
  const prefix = "style:";
  const suffix = ":profile";
  if (!key?.startsWith(prefix) || !key.endsWith(suffix)) {
    return undefined;
  }
  const styleId = key.slice(prefix.length, -suffix.length);
  return styleId.startsWith("pending:") ? styleId : undefined;
}

async function styleDetails(orchestrator: Orchestrator, tokenId: string) {
  const style = await orchestrator.chain.styleOf(tokenId);
  const confirmedProfileKey = `style:${tokenId}:profile`;
  const chainProfileKey = kvKeyFromUri(style.profileURI);
  const [profileLookup, recentOutputs] = await Promise.all([
    firstStoredKv<Record<string, unknown>>(orchestrator, [confirmedProfileKey, chainProfileKey]),
    recentOutputsForStyle(orchestrator, tokenId, style.creator)
  ]);
  const storedProfile = profileLookup.value;
  const pendingStyleId =
    stringField(storedProfile, "pendingStyleId") ??
    pendingStyleIdFromProfileKey(profileLookup.key) ??
    pendingStyleIdFromProfileKey(chainProfileKey);
  const confirmedAgentBrainKey = `style:${tokenId}:agentBrain`;
  const agentBrainLookup = await firstStoredKv<Record<string, unknown>>(orchestrator, [
    confirmedAgentBrainKey,
    pendingStyleId ? `style:${pendingStyleId}:agentBrain` : undefined
  ]);
  const agentBrain = agentBrainLookup.value;
  const profileKey = profileLookup.key ?? confirmedProfileKey;
  const agentBrainKey = agentBrainLookup.key ?? confirmedAgentBrainKey;
  const profile = enrichProfileForResponse(storedProfile);
  const manifestRootHash =
    stringField(agentBrain, "manifest_root_hash") ??
    (style.encryptedSamplesURI.startsWith("0g://agent-brain/")
      ? style.encryptedSamplesURI.replace("0g://agent-brain/", "")
      : undefined);
  const normalizedAgentBrain = agentBrain
    ? {
        manifestRootHash,
        manifestHash: stringField(agentBrain, "manifest_hash"),
        manifestStorageTxHash: stringField(agentBrain, "manifest_storage_tx_hash"),
        keyHash: nestedString(agentBrain, ["encryption", "key_hash"]),
        wrapMode: nestedString(agentBrain, ["encryption", "wrap_mode"]),
        samplesRootHash: nestedString(agentBrain, ["samples", "encrypted_root_hash"]),
        profileRootHash: nestedString(agentBrain, ["profile", "encrypted_root_hash"]),
        memoryLogStream: nestedString(agentBrain, ["memory", "log_stream"]),
        computeModel: nestedString(agentBrain, ["compute", "model"]),
        computeProvider: nestedString(agentBrain, ["compute", "provider"]),
        manifest: agentBrain
      }
    : manifestRootHash
      ? { manifestRootHash }
      : null;
  return {
    tokenId,
    source: runtimeModes().chain === "0g" ? "onchain" : "mock",
    chain: {
      creator: style.creator,
      royaltyWei: style.royaltyWei.toString(),
      totalEarnings: style.totalEarnings.toString(),
      sampleCount: style.sampleCount,
      listed: style.listed,
      encryptedSamplesURI: style.encryptedSamplesURI,
      profileURI: style.profileURI,
      language: style.language,
      genres: style.genres,
      attestationURI: style.attestationURI,
      metadataHash: style.metadataHash
    },
    profileKey,
    agentBrainKey,
    profile,
    agentBrain: normalizedAgentBrain,
    marketplace: marketplaceSummary({ tokenId, profile, agentBrain: normalizedAgentBrain, recentOutputs, listed: style.listed }),
    recentOutputs,
    evidenceLinks: [
      manifestRootHash ? { label: "AgentBrain manifest", url: storageBlobUrl(manifestRootHash) } : undefined
    ].filter(Boolean)
  };
}

function styleIdsWithLocalEvidence(orchestrator: Orchestrator, max: number): string[] {
  const ids = new Set<string>();
  for (const event of orchestrator.events.allEvents()) {
    for (const candidate of [
      event.styleId,
      stringField(event.payload, "styleId"),
      stringField(event.payload, "tokenId")
    ]) {
      const tokenId = normalizeListedTokenId(candidate);
      if (tokenId) {
        ids.add(tokenId);
      }
    }
  }
  return [...ids].slice(0, max);
}

function normalizeListedTokenId(value: string | undefined): string | undefined {
  const tokenId = value?.trim();
  if (!tokenId || tokenId.startsWith("pending:")) {
    return undefined;
  }
  return /^\d+$/.test(tokenId) ? tokenId : undefined;
}

function styleHasBackendEvidence(style: Awaited<ReturnType<typeof styleDetails>>): boolean {
  return Boolean(style.profile || style.agentBrain || style.recentOutputs.length > 0);
}

async function regenerateDetailedStyleGuide(orchestrator: Orchestrator, tokenId: string) {
  const style = await orchestrator.chain.styleOf(tokenId);
  const confirmedProfileKey = `style:${tokenId}:profile`;
  const chainProfileKey = kvKeyFromUri(style.profileURI);
  const profileLookup = await firstStoredKv<Record<string, unknown>>(orchestrator, [confirmedProfileKey, chainProfileKey]);
  const profileKey = profileLookup.key ?? confirmedProfileKey;
  const storedProfile = profileLookup.value;
  if (!storedProfile) {
    throw new Error(`No stored profile found for token ${tokenId}`);
  }
  const uploadedSamples = uploadedSamplesForProfile(orchestrator, storedProfile);
  if (!uploadedSamples.length) {
    throw new Error("Original uploaded samples were not found in the request event log");
  }

  const metadata = styleGuideMetadata(tokenId, style, storedProfile, uploadedSamples);
  const compute = await orchestrator.compute.chat(
    detailedStyleGuidePrompt({
      profile: storedProfile,
      samples: uploadedSamples,
      metadata
    }),
    { maxRetries: 1, maxTokens: 4200 }
  );
  const guide = parseTaggedJson(compute.content, "style_guide");
  if (!hasDetailedStyleGuide(guide)) {
    throw new Error("0G Compute returned a style guide without a prompt-ready brief and examples");
  }

  const styleGuideCompute = computeEvidence(compute, "detailed_style_guide");
  const updatedProfile = {
    ...storedProfile,
    detailed_style_guide: guide,
    styleGuideCompute,
    updatedAt: Date.now()
  };
  await orchestrator.storage.kvSet(profileKey, updatedProfile);

  const pendingStyleId =
    stringField(storedProfile, "pendingStyleId") ??
    pendingStyleIdFromProfileKey(profileLookup.key) ??
    pendingStyleIdFromProfileKey(chainProfileKey);
  const confirmedAgentBrainKey = `style:${tokenId}:agentBrain`;
  const agentBrainLookup = await firstStoredKv<Record<string, unknown>>(orchestrator, [
    confirmedAgentBrainKey,
    pendingStyleId ? `style:${pendingStyleId}:agentBrain` : undefined
  ]);
  const agentBrainKey = agentBrainLookup.key ?? confirmedAgentBrainKey;
  const agentBrain = agentBrainLookup.value;
  if (agentBrain) {
    await orchestrator.storage.kvSet(agentBrainKey, {
      ...agentBrain,
      updated_at: Date.now(),
      profile: {
        ...(agentBrain.profile && typeof agentBrain.profile === "object" && !Array.isArray(agentBrain.profile)
          ? agentBrain.profile
          : {}),
        kv_key: profileKey,
        detailed_style_guide_kv_key: profileKey,
        detailed_style_guide_generated_at: new Date().toISOString()
      }
    });
  }

  const requestId = requestIdForProfile(storedProfile) ?? `style-${tokenId}-guide`;
  await orchestrator.publish({
    id: `${requestId}:style.guide.regenerated:${Date.now()}`,
    type: "agent.activity",
    actor: "style_curator",
    styleId: tokenId,
    payload: {
      requestId,
      agent: "style_curator",
      agentLabel: "Style Curator",
      tool: "generate_detailed_style_guide",
      status: "completed",
      message: "0G Compute generated a detailed style guide from the original uploaded samples.",
      profileKey,
      sampleCount: uploadedSamples.length,
      hasDetailedStyleGuide: true,
      compute: styleGuideCompute,
      langGraphThread: `voices:${requestId}`
    }
  });

  return styleDetails(orchestrator, tokenId);
}

function marketplaceSummary(input: {
  tokenId: string;
  profile: Record<string, unknown> | null;
  agentBrain: Record<string, unknown> | null;
  recentOutputs: StyleOutputPreview[];
  listed: boolean;
}) {
  const labels = profileLabels(input.profile);
  const sampleExcerpts = stringArrayField(input.profile, "sampleExcerpts")
    .map(cleanProfileExcerpt)
    .filter((excerpt) => excerpt.length > 0)
    .slice(0, 3);
  const styleName = stringField(input.profile, "styleName");
  const primary = stringField(input.profile, "primary") ?? labels[0];
  const essence =
    stringField(input.profile, "voice_essence") ??
    stringField(input.profile, "voiceEssence") ??
    (labels.length > 0 ? `${labels.join(", ")} voice profile` : undefined);
  const latestOutput = input.recentOutputs[0];
  return {
    title: styleName || (primary ? `${titleCase(primary)} style` : `Style token ${input.tokenId}`),
    status: input.profile ? "ready_to_generate" : "onchain_only",
    statusLabel: input.profile ? "Ready to generate" : "On-chain only",
    listed: input.listed,
    summary: essence ?? "This token is listed on-chain, but no stored profile was found for the current backend.",
    tags: labels,
    sampleExcerpts,
    outputPreview: latestOutput?.draft ?? firstVariant(latestOutput?.variants),
    outputPrompt: latestOutput?.prompt,
    outputCount: input.recentOutputs.length,
    hasAgentBrain: Boolean(input.agentBrain?.manifestRootHash),
    hasProfile: Boolean(input.profile),
    updatedAt: numberField(input.profile, "updatedAt")
  };
}

function enrichProfileForResponse(profile: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!profile) {
    return null;
  }
  return {
    ...profile,
    sampleExcerpts: stringArrayField(profile, "sampleExcerpts")
      .concat(stringArrayField(profile, "sample_excerpts"))
      .map(cleanProfileExcerpt)
      .filter(Boolean)
      .slice(0, 8)
  };
}

function uploadedSamplesForProfile(orchestrator: Orchestrator, profile: Record<string, unknown> | null): string[] {
  const requestId = requestIdForProfile(profile);
  if (!requestId) {
    return [];
  }
  return orchestrator
    .eventsForRequest(requestId)
    .filter((event) => event.type === "style.uploaded")
    .flatMap((event) => stringArrayField(event.payload, "samples"));
}

function requestIdForProfile(profile: Record<string, unknown> | null): string | undefined {
  const requestId = stringField(profile, "requestId");
  if (requestId) {
    return requestId;
  }
  const thread = stringField(profile, "langGraphThread");
  return thread?.startsWith("voices:") ? thread.slice("voices:".length) : undefined;
}

function styleGuideMetadata(
  tokenId: string,
  style: Awaited<ReturnType<Orchestrator["chain"]["styleOf"]>>,
  profile: Record<string, unknown>,
  samples: string[]
): Record<string, unknown> {
  const sourceContext =
    profile.sourceContext && typeof profile.sourceContext === "object" && !Array.isArray(profile.sourceContext)
      ? profile.sourceContext as Record<string, unknown>
      : {};
  return {
    tokenId,
    creator: style.creator,
    sourceKind: stringField(profile, "sourceKind") ?? stringField(sourceContext, "sourceKind") ?? "unknown",
    sourceSummary: stringField(profile, "sourceSummary") ?? stringField(sourceContext, "sourceSummary"),
    sourceMaterials: Array.isArray(profile.sourceMaterials) ? profile.sourceMaterials : sourceContext.sourceMaterials,
    fullSampleCount: samples.length,
    fullSampleBytes: Buffer.byteLength(samples.join("\n"), "utf8"),
    existingProfileKeys: Object.keys(profile),
    styleName: stringField(profile, "styleName"),
    keywords: stringArrayField(profile, "keywords"),
    computeMode: runtimeModes().compute,
    storageMode: runtimeModes().storage
  };
}

function hasDetailedStyleGuide(guide: Record<string, unknown>): boolean {
  return Boolean(stringField(guide, "prompt_ready_style_brief")) && Array.isArray(guide.actual_examples) && guide.actual_examples.length > 0;
}

function computeEvidence(compute: ChatResult, purpose: string): Record<string, unknown> {
  return {
    purpose,
    provider: compute.providerAddress,
    model: compute.model,
    chatId: compute.chatId,
    teeVerified: compute.teeVerified ?? compute.verified ?? null,
    inputTokens: compute.inputTokens,
    outputTokens: compute.outputTokens,
    durationMs: compute.durationMs,
    computePath: compute.computePath
  };
}

function parseTaggedJson(content: string, tag: string): Record<string, unknown> {
  const cleaned = stripCodeFence(content);
  const tagged = matchTaggedContent(cleaned, tag);
  const source = stripCodeFence(tagged ?? stripLooseTag(cleaned, tag));
  const candidate = normalizeJsonObjectSource(source);

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tagged response was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const snippet = cleaned.replace(/\s+/g, " ").slice(0, 240);
    const reason = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Could not parse ${tag} JSON from 0G Compute response: ${reason}. Response starts: ${snippet}`);
  }
}

function normalizeJsonObjectSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    return extractFirstJsonObject(trimmed);
  }
  const lastBrace = trimmed.lastIndexOf("}");
  const body = lastBrace >= 0 ? trimmed.slice(0, lastBrace + 1) : trimmed;
  if (body.trim().endsWith("}")) {
    return `{${body.trim()}`;
  }
  return `{${body.trim().replace(/,\s*$/, "")}}`;
}

function stripLooseTag(content: string, tag: string): string {
  return content
    .replace(new RegExp(`<${tag}[^>]*>`, "gi"), "")
    .replace(new RegExp(`<\\/${tag}>`, "gi"), "")
    .trim();
}

function matchTaggedContent(content: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return content.match(pattern)?.[1]?.trim();
}

function stripCodeFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractFirstJsonObject(content: string): string {
  const start = content.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object found");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1).trim();
      }
    }
  }

  return content.slice(start).trim();
}

async function recentOutputsForStyle(orchestrator: Orchestrator, tokenId: string, creator: string): Promise<StyleOutputPreview[]> {
  const byRequest = new Map<string, StyleOutputPreview>();
  for (const event of orchestrator.events.allEvents()) {
    if (event.styleId !== tokenId) {
      continue;
    }
    const requestId = stringField(event.payload, "requestId") ?? event.id;
    const existing = byRequest.get(requestId) ?? { requestId };
    if (event.type === "generation.drafted") {
      existing.prompt = stringField(event.payload, "prompt") ?? existing.prompt;
      existing.draft = stringField(event.payload, "draft") ?? existing.draft;
      existing.teeVerified = booleanField(event.payload, "teeVerified") ?? existing.teeVerified;
      existing.timestamp = Math.max(existing.timestamp ?? 0, event.timestamp);
    }
    if (event.type === "generation.published") {
      existing.variants = stringRecordField(event.payload, "variants") ?? existing.variants;
      existing.teeVerified = booleanField(event.payload, "teeVerified") ?? existing.teeVerified;
      existing.timestamp = Math.max(existing.timestamp ?? 0, event.timestamp);
    }
    if (event.type === "generation.drafted" || event.type === "generation.published") {
      byRequest.set(requestId, existing);
    }
  }

  try {
    const history = await orchestrator.storage.logScan<Record<string, unknown>>(`consumer:${creator}:history`);
    for (const entry of history) {
      if (stringField(entry.value, "styleId") !== tokenId) {
        continue;
      }
      const requestId = entry.key.replace(/^(gen|published):/, "");
      const existing = byRequest.get(requestId) ?? { requestId };
      if (entry.key.startsWith("gen:")) {
        existing.prompt = stringField(entry.value, "prompt") ?? existing.prompt;
        existing.draft = stringField(entry.value, "draft") ?? existing.draft;
      }
      if (entry.key.startsWith("published:")) {
        existing.variants = stringRecordField(entry.value, "variants") ?? existing.variants;
      }
      existing.teeVerified = booleanField(entry.value, "teeVerified") ?? existing.teeVerified;
      existing.timestamp = Math.max(existing.timestamp ?? 0, numberField(entry.value, "timestamp") ?? 0);
      byRequest.set(requestId, existing);
    }
  } catch {
    // Output history is enrichment only; on-chain style browsing should still work if log reads fail.
  }

  return [...byRequest.values()]
    .filter((output) => output.draft || output.variants)
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
    .slice(0, 5);
}

async function buildProofBundle(orchestrator: Orchestrator, requestId: string) {
  const events = orchestrator.eventsForRequest(requestId);
  const first = events[0];
  const last = events[events.length - 1];
  const styleId = latestString(events, (event) => event.styleId || stringField(event.payload, "styleId") || stringField(event.payload, "tokenId"));
  const agentBrainRootHash = latestString(events, (event) => stringField(event.payload, "agentBrainRootHash"));
  const profileKey =
    latestString(events, (event) => stringField(event.payload, "profileKey")) ||
    (styleId ? `style:${styleId}:profile` : undefined);
  const agentBrain =
    styleId ? await orchestrator.storage.kvGet<Record<string, unknown>>(`style:${styleId}:agentBrain`) : null;
  const mintTxHash = latestString(events, (event) =>
    event.type === "style.minted" ? stringField(event.payload, "txHash") : undefined
  );
  const settlementTxHash = latestString(events, (event) =>
    (event.type === "royalty.settled" || event.type === "credit.deducted") ? stringField(event.payload, "txHash") : undefined
  );

  return {
    request_id: requestId,
    workflow_kind: proofWorkflowKind(events),
    status: proofStatus(events),
    started_at: first ? new Date(first.timestamp).toISOString() : null,
    completed_at: last ? new Date(last.timestamp).toISOString() : null,
    actor: {
      wallet: first?.actor ?? null,
      role: proofActorRole(events)
    },
    runtime: runtimeModes(),
    agent_trail: buildAgentTrail(events),
    agent_brain: {
      manifest_root_hash: agentBrainRootHash ?? stringField(agentBrain, "manifest_root_hash"),
      manifest_storage_tx: latestString(events, (event) => stringField(event.payload, "agentBrainTxHash")) ?? stringField(agentBrain, "manifest_storage_tx_hash"),
      manifest_hash: latestString(events, (event) => stringField(event.payload, "agentBrainManifestHash")) ?? stringField(agentBrain, "manifest_hash"),
      manifest_url: storageBlobUrl(agentBrainRootHash ?? stringField(agentBrain, "manifest_root_hash")),
      samples_root_hash: latestString(events, (event) => stringField(event.payload, "samplesRootHash")) ?? nestedString(agentBrain, ["samples", "encrypted_root_hash"]),
      samples_storage_tx: latestString(events, (event) => stringField(event.payload, "storageTxHash")) ?? nestedString(agentBrain, ["samples", "storage_tx_hash"]),
      profile_root_hash: latestString(events, (event) => stringField(event.payload, "profileRootHash")) ?? nestedString(agentBrain, ["profile", "encrypted_root_hash"]),
      profile_kv_key: profileKey ?? nestedString(agentBrain, ["profile", "kv_key"]),
      memory_log_stream: nestedString(agentBrain, ["memory", "log_stream"]),
      key_hash: latestString(events, (event) => stringField(event.payload, "keyHash")) ?? nestedString(agentBrain, ["encryption", "key_hash"]),
      key_wrap_mode: latestString(events, (event) => stringField(event.payload, "keyWrapMode")) ?? nestedString(agentBrain, ["encryption", "wrap_mode"])
    },
    compute_calls: collectComputeCalls(events),
    checkpoints: checkpointProofs(requestId),
    receipt_verifications: collectReceiptVerifications(events),
    chain: {
      style_registry: process.env.STYLE_REGISTRY_ADDRESS || null,
      credit_system: process.env.CREDIT_SYSTEM_ADDRESS || null,
      royalty_vault: process.env.ROYALTY_VAULT_ADDRESS || null,
      token_id: styleId ?? null,
      mint_tx_hash: mintTxHash ?? null,
      mint_tx_explorer: mintTxHash ? explorerTxUrl(mintTxHash) : null,
      settlement_tx_hash: settlementTxHash ?? null,
      settlement_tx_explorer: settlementTxHash ? explorerTxUrl(settlementTxHash) : null
    },
    evidence_links: evidenceLinks({
      agentBrainRootHash: agentBrainRootHash ?? stringField(agentBrain, "manifest_root_hash"),
      mintTxHash,
      settlementTxHash
    }),
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      timestamp: new Date(event.timestamp).toISOString(),
      actor: event.actor,
      styleId: event.styleId,
      consumerAddress: event.consumerAddress,
      payload: event.payload
    }))
  };
}

function renderProofHtml(proof: unknown): string {
  const record = proof && typeof proof === "object" ? proof as Record<string, unknown> : {};
  const evidenceLinks = arrayValue(record.evidence_links);
  const computeCalls = arrayValue(record.compute_calls);
  const agentTrail = arrayValue(record.agent_trail);
  const receipts = arrayValue(record.receipt_verifications);
  const chain = recordValue(record.chain);
  const agentBrain = recordValue(record.agent_brain);
  const runtime = recordValue(record.runtime);
  const actor = recordValue(record.actor);
  const requestId = stringValue(record.request_id, "unknown");
  const status = stringValue(record.status, "unknown");
  const workflow = stringValue(record.workflow_kind, "unknown");
  const startedAt = stringValue(record.started_at);
  const completedAt = stringValue(record.completed_at);
  const duration = proofDuration(startedAt, completedAt);
  const tokenId = stringValue(chain.token_id, "unknown");
  const settlementTx = stringValue(chain.settlement_tx_hash);
  const mintTx = stringValue(chain.mint_tx_hash);
  const statusClass = proofStatusClass(status);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voices Proof ${escapeHtml(String(record.request_id ?? ""))}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090d12;
      --panel: #101720;
      --panel2: #141e29;
      --line: rgba(148, 163, 184, .22);
      --text: #edf3f8;
      --muted: #9aa9b8;
      --soft: #c9d5df;
      --accent: #ff7a45;
      --accent2: #64d2ff;
      --green: #76e39a;
      --red: #ff8a8a;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% -8%, rgba(255, 122, 69, .22), transparent 32rem),
        radial-gradient(circle at 84% 4%, rgba(100, 210, 255, .12), transparent 30rem),
        linear-gradient(180deg, #0d1117 0%, #090d12 52%, #070a0f 100%);
      color: var(--text);
    }
    a { color: inherit; text-decoration: none; }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 56px; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 900; letter-spacing: 0; }
    .brandMark {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent), #ffd0b6);
      box-shadow: 0 12px 36px rgba(255, 122, 69, .22);
    }
    .toplink {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 9px 13px;
      color: var(--soft);
      font-size: 13px;
      background: rgba(16, 23, 32, .72);
    }
    .hero {
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 22px;
      padding: 26px;
      background: linear-gradient(135deg, rgba(20, 30, 41, .92), rgba(12, 17, 24, .88));
      box-shadow: 0 24px 80px rgba(0, 0, 0, .28);
      overflow: hidden;
    }
    .heroTop { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
    .eyebrow { color: var(--accent2); font-size: 12px; font-weight: 850; text-transform: uppercase; letter-spacing: .08em; }
    h1 { margin: 8px 0 8px; font-size: clamp(32px, 5vw, 56px); line-height: .96; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.55; }
    .request { margin-top: 10px; color: var(--soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
    .statusPill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 9px 12px;
      font-size: 13px;
      font-weight: 850;
      background: rgba(255, 255, 255, .05);
      white-space: nowrap;
    }
    .statusPill:before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--muted);
      box-shadow: 0 0 0 4px rgba(154, 169, 184, .12);
    }
    .status-settled:before, .status-success:before { background: var(--green); box-shadow: 0 0 0 4px rgba(118, 227, 154, .15); }
    .status-failed:before { background: var(--red); box-shadow: 0 0 0 4px rgba(255, 138, 138, .15); }
    .heroGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 22px; }
    .metric {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, .045);
      border-radius: 14px;
      padding: 14px;
      min-height: 86px;
      overflow-wrap: anywhere;
    }
    .metric span, .label { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; font-weight: 800; }
    .metric strong { display: block; margin-top: 8px; color: var(--text); font-size: 16px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr); gap: 16px; margin-top: 16px; align-items: start; }
    .section, .sideCard {
      border: 1px solid var(--line);
      background: rgba(16, 23, 32, .82);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 18px 54px rgba(0, 0, 0, .18);
    }
    .section + .section, .sideCard + .sideCard { margin-top: 16px; }
    .sectionHead { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 14px; }
    h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
    .count { color: var(--muted); font-size: 12px; font-weight: 800; }
    .chainGrid, .brainGrid, .runtimeGrid { display: grid; gap: 10px; }
    .chainGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .kv {
      border: 1px solid rgba(148, 163, 184, .16);
      background: rgba(255, 255, 255, .035);
      border-radius: 12px;
      padding: 12px;
      overflow-wrap: anywhere;
    }
    .kv strong { display: block; margin-top: 6px; color: var(--soft); font-size: 13px; line-height: 1.35; }
    .linkGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .proofLink {
      display: block;
      border: 1px solid rgba(100, 210, 255, .22);
      background: rgba(100, 210, 255, .07);
      border-radius: 14px;
      padding: 13px;
      color: #d9f4ff;
    }
    .proofLink span { display: block; color: rgba(217, 244, 255, .68); font-size: 11px; margin-top: 6px; overflow-wrap: anywhere; }
    .timeline { position: relative; display: grid; gap: 10px; }
    .step {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 10px;
    }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: var(--accent2); margin: 5px auto 0; box-shadow: 0 0 0 4px rgba(100, 210, 255, .13); }
    .step[data-status="completed"] .dot { background: var(--green); box-shadow: 0 0 0 4px rgba(118, 227, 154, .13); }
    .step[data-status="failed"] .dot { background: var(--red); box-shadow: 0 0 0 4px rgba(255, 138, 138, .13); }
    .stepCard {
      border: 1px solid rgba(148, 163, 184, .16);
      background: rgba(255, 255, 255, .035);
      border-radius: 13px;
      padding: 12px;
    }
    .stepTop { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .stepTop strong { font-size: 13px; }
    .stepTop time { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .step p { margin-top: 5px; font-size: 13px; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    .tag {
      border: 1px solid rgba(148, 163, 184, .18);
      border-radius: 999px;
      padding: 4px 7px;
      color: var(--soft);
      background: rgba(255, 255, 255, .04);
      font-size: 11px;
      font-weight: 800;
    }
    .computeList { display: grid; gap: 10px; }
    .computeCard {
      border: 1px solid rgba(255, 122, 69, .22);
      background: rgba(255, 122, 69, .07);
      border-radius: 14px;
      padding: 13px;
    }
    .computeCard strong { display: block; font-size: 13px; }
    .computeMeta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    details {
      border: 1px solid var(--line);
      background: rgba(3, 7, 11, .74);
      border-radius: 16px;
      padding: 0;
      overflow: hidden;
    }
    summary { cursor: pointer; list-style: none; padding: 15px 16px; font-weight: 850; }
    summary::-webkit-details-marker { display: none; }
    pre {
      margin: 0;
      border-top: 1px solid var(--line);
      white-space: pre-wrap;
      word-break: break-word;
      background: #03070b;
      color: #dce7ef;
      padding: 16px;
      overflow: auto;
      max-height: 620px;
      font-size: 12px;
      line-height: 1.5;
    }
    .empty { color: var(--muted); font-size: 13px; }
    @media (max-width: 860px) {
      main { width: min(100% - 22px, 1180px); padding-top: 18px; }
      .hero { padding: 18px; border-radius: 18px; }
      .heroTop, .topbar { flex-direction: column; align-items: flex-start; }
      .heroGrid, .layout, .chainGrid { grid-template-columns: 1fr; }
      .computeMeta { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <div class="topbar">
      <div class="brand"><span class="brandMark" aria-hidden="true"></span><span>Voices Proof Trail</span></div>
      <a class="toplink" href="/styles/${escapeHtml(tokenId)}/try">Back to style</a>
    </div>

    <section class="hero">
      <div class="heroTop">
        <div>
          <div class="eyebrow">${escapeHtml(workflow)} workflow</div>
          <h1>${escapeHtml(titleCase(status))}</h1>
          <p>Verifiable record of the 0G agent workflow, voice evidence, compute calls, and on-chain settlement.</p>
          <div class="request">${escapeHtml(requestId)}</div>
        </div>
        <div class="statusPill ${statusClass}">${escapeHtml(titleCase(status))}</div>
      </div>
      <div class="heroGrid">
        ${proofMetric("Token", tokenId)}
        ${proofMetric("Consumer", shortHash(stringValue(actor.wallet, "unknown")))}
        ${proofMetric("Agent steps", String(agentTrail.length))}
        ${proofMetric("Duration", duration)}
      </div>
    </section>

    <div class="layout">
      <div>
        <section class="section">
          <div class="sectionHead"><h2>On-Chain Settlement</h2><span class="count">${settlementTx ? "confirmed" : "pending"}</span></div>
          <div class="chainGrid">
            ${proofKv("Style token", tokenId)}
            ${proofKv("Royalty status", titleCase(status))}
            ${proofKv("Mint transaction", txLink(mintTx, stringValue(chain.mint_tx_explorer)), true)}
            ${proofKv("Settlement transaction", txLink(settlementTx, stringValue(chain.settlement_tx_explorer)), true)}
            ${proofKv("CreditSystem", shortHash(stringValue(chain.credit_system, "not recorded")))}
            ${proofKv("RoyaltyVault", shortHash(stringValue(chain.royalty_vault, "not recorded")))}
          </div>
        </section>

        <section class="section">
          <div class="sectionHead"><h2>Agent Timeline</h2><span class="count">${agentTrail.length} steps</span></div>
          ${renderAgentTimeline(agentTrail)}
        </section>
      </div>

      <aside>
        <section class="sideCard">
          <div class="sectionHead"><h2>Evidence</h2><span class="count">${evidenceLinks.length} links</span></div>
          ${renderEvidenceLinks(evidenceLinks)}
        </section>

        <section class="sideCard">
          <div class="sectionHead"><h2>AgentBrain</h2><span class="count">iNFT memory</span></div>
          ${renderAgentBrain(agentBrain)}
        </section>

        <section class="sideCard">
          <div class="sectionHead"><h2>Runtime</h2><span class="count">${escapeHtml(stringValue(runtime.costProfile, "runtime"))}</span></div>
          <div class="runtimeGrid">
            ${proofKv("Storage", stringValue(runtime.storage, "unknown"))}
            ${proofKv("Compute", `${stringValue(runtime.compute, "unknown")} / ${stringValue(runtime.compute_path, "unknown")}`)}
            ${proofKv("CrewAI", `${stringValue(runtime.crewai_compute, "unknown")} / ${stringValue(runtime.crewai_compute_path, "unknown")}`)}
            ${proofKv("Chain", stringValue(runtime.chain, "unknown"))}
          </div>
        </section>

        <section class="sideCard">
          <div class="sectionHead"><h2>Compute Calls</h2><span class="count">${computeCalls.length}</span></div>
          ${renderComputeCalls(computeCalls)}
        </section>
      </aside>
    </div>

    <section class="section">
      <div class="sectionHead"><h2>Receipt Checks</h2><span class="count">${receipts.length}</span></div>
      ${renderReceipts(receipts)}
    </section>

    <section class="section">
      <details>
        <summary>Raw proof JSON</summary>
        <pre>${escapeHtml(JSON.stringify(proof, null, 2))}</pre>
      </details>
    </section>
  </main>
</body>
</html>`;
}

function proofMetric(label: string, value: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "not recorded")}</strong></div>`;
}

function proofKv(label: string, value: string, html = false): string {
  return `<div class="kv"><span class="label">${escapeHtml(label)}</span><strong>${html ? value : escapeHtml(value || "not recorded")}</strong></div>`;
}

function txLink(txHash: string, explorerUrl?: string): string {
  if (!txHash) {
    return escapeHtml("not recorded");
  }
  const href = explorerUrl || explorerTxUrl(txHash);
  return `<a class="proofLink" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(shortHash(txHash))}<span>${escapeHtml(txHash)}</span></a>`;
}

function renderEvidenceLinks(items: unknown[]): string {
  if (!items.length) {
    return `<p class="empty">No external evidence links found yet.</p>`;
  }
  return `<div class="linkGrid">${items.map((item) => {
    const link = recordValue(item);
    const label = stringValue(link.label, "Evidence");
    const url = stringValue(link.url);
    if (!url) return "";
    return `<a class="proofLink" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}<span>${escapeHtml(shortUrl(url))}</span></a>`;
  }).join("")}</div>`;
}

function renderAgentBrain(agentBrain: Record<string, unknown>): string {
  const manifestUrl = stringValue(agentBrain.manifest_url);
  const manifestRoot = stringValue(agentBrain.manifest_root_hash);
  return `<div class="brainGrid">
    ${proofKv("Manifest root", manifestUrl && manifestRoot ? txLink(manifestRoot, manifestUrl) : shortHash(manifestRoot || "not recorded"), Boolean(manifestUrl && manifestRoot))}
    ${proofKv("Manifest storage tx", shortHash(stringValue(agentBrain.manifest_storage_tx, "not recorded")))}
    ${proofKv("Manifest hash", shortHash(stringValue(agentBrain.manifest_hash, "not recorded")))}
    ${proofKv("Samples storage tx", shortHash(stringValue(agentBrain.samples_storage_tx, "not recorded")))}
    ${proofKv("Samples root", shortHash(stringValue(agentBrain.samples_root_hash, "not recorded")))}
    ${proofKv("Profile root", shortHash(stringValue(agentBrain.profile_root_hash, "not recorded")))}
    ${proofKv("Profile KV", stringValue(agentBrain.profile_kv_key, "not recorded"))}
    ${proofKv("Memory stream", stringValue(agentBrain.memory_log_stream, "not recorded"))}
    ${proofKv("Key hash", shortHash(stringValue(agentBrain.key_hash, "not recorded")))}
    ${proofKv("Wrap mode", stringValue(agentBrain.key_wrap_mode, "not recorded"))}
  </div>`;
}

function renderAgentTimeline(items: unknown[]): string {
  if (!items.length) {
    return `<p class="empty">No agent activity has been recorded for this request.</p>`;
  }
  return `<div class="timeline">${items.map((item) => {
    const step = recordValue(item);
    const status = stringValue(step.status, "unknown");
    const agent = titleCase(stringValue(step.agent, "agent").replaceAll("_", " "));
    const tool = stringValue(step.tool, "tool");
    const message = stringValue(step.message, "Agent step recorded.");
    const timestamp = stringValue(step.timestamp);
    const duration = numberValue(step.duration_ms);
    return `<div class="step" data-status="${escapeHtml(status)}">
      <span class="dot" aria-hidden="true"></span>
      <div class="stepCard">
        <div class="stepTop"><strong>${escapeHtml(agent)}</strong><time>${escapeHtml(formatProofTime(timestamp))}</time></div>
        <p>${escapeHtml(message)}</p>
        <div class="tags">
          <span class="tag">${escapeHtml(tool)}</span>
          <span class="tag">${escapeHtml(status)}</span>
          ${duration !== undefined ? `<span class="tag">${escapeHtml(formatMs(duration))}</span>` : ""}
        </div>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function renderComputeCalls(items: unknown[]): string {
  if (!items.length) {
    return `<p class="empty">No compute evidence was attached to this request.</p>`;
  }
  return `<div class="computeList">${items.map((item, index) => {
    const compute = recordValue(item);
    const purpose = stringValue(compute.purpose, `compute call ${index + 1}`);
    const verified = stringValue(compute.teeVerified, "recorded");
    return `<div class="computeCard">
      <strong>${escapeHtml(titleCase(purpose.replaceAll("_", " ")))}</strong>
      <div class="computeMeta">
        ${proofKv("Model", stringValue(compute.model, "unknown"))}
        ${proofKv("Path", stringValue(compute.path, stringValue(compute.computePath, "unknown")))}
        ${proofKv("Chat ID", shortHash(stringValue(compute.chatId, "not recorded")))}
        ${proofKv("Verified", verified)}
        ${proofKv("Tokens", `${stringValue(compute.inputTokens, "?")} in / ${stringValue(compute.outputTokens, "?")} out`)}
        ${proofKv("Duration", formatMs(numberValue(compute.durationMs) ?? 0))}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function renderReceipts(items: unknown[]): string {
  if (!items.length) {
    return `<p class="empty">No receipt verifications are attached yet.</p>`;
  }
  return `<div class="linkGrid">${items.map((item) => {
    const receipt = recordValue(item);
    const events = arrayValue(receipt.events);
    const txHash = stringValue(receipt.tx_hash);
    return `<div class="kv">
      <span class="label">${escapeHtml(stringValue(receipt.event_type, "receipt"))}</span>
      <strong>${escapeHtml(shortHash(txHash || "not recorded"))}</strong>
      <div class="tags">
        ${numberValue(receipt.block_number) !== undefined ? `<span class="tag">block ${escapeHtml(String(numberValue(receipt.block_number)))}</span>` : ""}
        <span class="tag">${events.length} event${events.length === 1 ? "" : "s"}</span>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function proofDuration(startedAt: string, completedAt: string): string {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "not recorded";
  }
  return formatMs(end - start);
}

function proofStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("settled") || normalized.includes("minted") || normalized.includes("published")) return "status-settled";
  if (normalized.includes("failed")) return "status-failed";
  return "status-running";
}

function formatProofTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "unknown";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit"
  }).format(parsed);
}

function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function shortHash(value: string): string {
  if (!value || value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname.length > 28 ? `${url.pathname.slice(0, 28)}...` : url.pathname}`;
  } catch {
    return shortHash(value);
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildAgentTrail(events: AgentEvent[]) {
  const started = new Map<string, number>();
  return events
    .filter((event) => event.type === "agent.activity")
    .map((event) => {
      const agent = stringField(event.payload, "agent");
      const toolName = stringField(event.payload, "tool");
      const key = `${agent}:${toolName}`;
      const status = stringField(event.payload, "status");
      if (status === "started") {
        started.set(key, event.timestamp);
      }
      const startedAt = started.get(key);
      return {
        agent,
        tool: toolName,
        status,
        message: stringField(event.payload, "message"),
        timestamp: new Date(event.timestamp).toISOString(),
        duration_ms: startedAt && status !== "started" ? event.timestamp - startedAt : undefined,
        result: event.payload
      };
    });
}

function collectComputeCalls(events: AgentEvent[]) {
  const seen = new Set<string>();
  const calls: unknown[] = [];
  for (const event of events) {
    for (const field of ["compute", "styleGuideCompute"]) {
      const compute = event.payload[field];
      if (!compute || typeof compute !== "object") {
        continue;
      }
      const record = compute as Record<string, unknown>;
      const key = [
        record.purpose,
        record.chatId,
        record.provider,
        record.model,
        event.id
      ].join(":");
      if (!seen.has(key)) {
        seen.add(key);
        calls.push(compute);
      }
    }
  }
  return calls;
}

function collectReceiptVerifications(events: AgentEvent[]) {
  return events
    .map((event) => {
      const receipt = event.payload.receipt;
      if (!receipt || typeof receipt !== "object") {
        return undefined;
      }
      return {
        event_type: event.type,
        tx_hash: stringField(receipt, "txHash"),
        block_number: numberField(receipt, "blockNumber"),
        events: Array.isArray((receipt as Record<string, unknown>).events)
          ? (receipt as Record<string, unknown>).events
          : []
      };
    })
    .filter(Boolean);
}

function checkpointProofs(requestId: string) {
  const threadId = `voices:${requestId}`;
  const namespace = "runtime";
  return [
    {
      thread_id: threadId,
      namespace,
      active_kv_key: `lg:thread:${threadId}:ns:${namespace}:active`,
      log_stream: `lg:thread:${threadId}:ns:${namespace}`,
      flushed_to_0g: process.env.AGENT_STORAGE_MODE === "0g" && process.env.AGENT_CHECKPOINT_FLUSH_MODE === "0g"
    }
  ];
}

function evidenceLinks(input: { agentBrainRootHash?: string; mintTxHash?: string; settlementTxHash?: string }) {
  return [
    input.agentBrainRootHash
      ? { label: "AgentBrain manifest", url: storageBlobUrl(input.agentBrainRootHash) }
      : undefined,
    input.mintTxHash ? { label: "Mint transaction", url: explorerTxUrl(input.mintTxHash) } : undefined,
    input.settlementTxHash ? { label: "Settlement transaction", url: explorerTxUrl(input.settlementTxHash) } : undefined
  ].filter(Boolean);
}

function proofWorkflowKind(events: AgentEvent[]): string {
  if (events.some((event) => event.type === "style.uploaded")) return "creator_onboarding";
  if (events.some((event) => event.type === "generation.requested")) return "generation";
  if (events.some((event) => event.type === "feedback.received")) return "feedback_refinement";
  if (events.some((event) => event.type === "credit.low")) return "credit_low";
  return "unknown";
}

function proofStatus(events: AgentEvent[]): string {
  if (events.some((event) => event.type.endsWith(".failed"))) return "failed";
  if (events.some((event) => event.type === "royalty.settled")) return "settled";
  if (events.some((event) => event.type === "generation.published")) return "published";
  if (events.some((event) => event.type === "style.minted")) return "minted";
  if (events.some((event) => event.type === "style.mint.intent.created")) return "awaiting_wallet_signature";
  return events.length > 0 ? "running_or_pending" : "not_found";
}

function proofActorRole(events: AgentEvent[]): string {
  if (events.some((event) => event.type === "style.uploaded")) return "creator";
  if (events.some((event) => event.type === "generation.requested")) return "consumer";
  return "system_or_unknown";
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

const GENERATION_PLATFORMS = new Set(["x", "thread", "instagram", "blog", "github_readme"]);

function sanitizeGenerationPlatforms(value: unknown): string[] {
  const requested = Array.isArray(value) ? value : ["x"];
  for (const item of requested) {
    const normalized = normalizeGenerationPlatform(item);
    if (normalized && GENERATION_PLATFORMS.has(normalized)) {
      return [normalized];
    }
  }
  return ["x"];
}

function normalizeGenerationPlatform(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "twitter" || normalized === "tweet" || normalized === "tweets") return "x";
  if (normalized === "x") return "x";
  if (normalized === "thread" || normalized === "tweet_thread" || normalized === "twitter_thread") return "thread";
  if (normalized === "linked_in" || normalized === "linkedin") return "thread";
  if (normalized === "ig" || normalized === "instagram" || normalized === "caption") return "instagram";
  if (normalized === "blogger" || normalized === "blogger_article" || normalized === "blog_article" || normalized === "article" || normalized === "blog") return "blog";
  if (normalized === "github" || normalized === "github_readme" || normalized === "readme" || normalized === "github_readme_file") return "github_readme";
  return normalized;
}

function sanitizeSourceMaterials(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const materials: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const label = optionalString(record.label);
    const kind = optionalString(record.kind);
    if (!label || !kind) {
      continue;
    }
    materials.push({
      id: optionalString(record.id),
      kind,
      label,
      characterCount: typeof record.characterCount === "number" ? record.characterCount : undefined,
      unitCount: typeof record.unitCount === "number" ? record.unitCount : undefined,
      importedAt: optionalString(record.importedAt),
      metadata: sanitizeJsonObject(record.metadata)
    });
    if (materials.length >= 24) {
      break;
    }
  }
  return materials;
}

function sanitizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry) => {
      const item = entry[1];
      return item === null || ["string", "number", "boolean"].includes(typeof item) || Array.isArray(item);
    })
    .map(([key, item]) => [
      key,
      Array.isArray(item)
        ? item.filter((nested) => nested === null || ["string", "number", "boolean"].includes(typeof nested)).slice(0, 50)
        : item
    ]);
  return Object.fromEntries(entries);
}

function clampPositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function compareMarketplaceStyles(
  left: Awaited<ReturnType<typeof styleDetails>>,
  right: Awaited<ReturnType<typeof styleDetails>>
): number {
  const leftReady = left.marketplace.hasProfile ? 1 : 0;
  const rightReady = right.marketplace.hasProfile ? 1 : 0;
  if (leftReady !== rightReady) return rightReady - leftReady;

  const leftOutputs = left.recentOutputs.length > 0 ? 1 : 0;
  const rightOutputs = right.recentOutputs.length > 0 ? 1 : 0;
  if (leftOutputs !== rightOutputs) return rightOutputs - leftOutputs;

  const leftTime = left.marketplace.updatedAt ?? left.recentOutputs[0]?.timestamp ?? 0;
  const rightTime = right.marketplace.updatedAt ?? right.recentOutputs[0]?.timestamp ?? 0;
  if (leftTime !== rightTime) return rightTime - leftTime;

  return Number(right.tokenId) - Number(left.tokenId);
}

function profileLabels(profile: Record<string, unknown> | null): string[] {
  const tone = profile && typeof profile.tone === "object" && !Array.isArray(profile.tone)
    ? (profile.tone as Record<string, unknown>)
    : null;
  const labels = [
    ...stringArrayField(profile, "labels"),
    stringField(profile, "primary"),
    ...stringArrayField(profile, "secondary"),
    ...stringArrayField(profile, "tone"),
    ...stringArrayField(tone, "labels"),
    stringField(tone, "primary"),
    ...stringArrayField(tone, "secondary")
  ].filter((value): value is string => Boolean(value));
  return [...new Set(labels)].slice(0, 8);
}

function cleanProfileExcerpt(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.startsWith("<source")) {
    return text;
  }
  const fullTextIndex = text.toLowerCase().indexOf("full source text:");
  if (fullTextIndex !== -1) {
    return text.slice(fullTextIndex + "full source text:".length).replace(/<\/source>\s*$/i, "").trim().slice(0, 240);
  }
  return "";
}

function stringArrayField(value: unknown, key: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const field = (value as Record<string, unknown>)[key];
  if (Array.isArray(field)) {
    return field.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return typeof field === "string" && field.trim().length > 0 ? [field] : [];
}

function stringRecordField(value: unknown, key: string): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    return undefined;
  }
  const entries = Object.entries(field).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "boolean" ? field : undefined;
}

function firstVariant(variants: Record<string, string> | undefined): string | undefined {
  return variants ? Object.values(variants).find((value) => value.trim().length > 0) : undefined;
}

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function runtimeModes() {
  const computeMode = process.env.AGENT_COMPUTE_MODE?.trim().toLowerCase();
  const computeLive = computeMode === "0g" || computeMode === "live";
  const computeOpenAI = computeMode === "openai" || computeMode === "chatgpt";
  const crewAiComputeMode = (process.env.CREWAI_COMPUTE_MODE || process.env.VOICES_CREWAI_COMPUTE_MODE || "").trim().toLowerCase();
  const crewAiComputeOpenAI = crewAiComputeMode === "openai" || crewAiComputeMode === "chatgpt";
  return {
    storage: process.env.AGENT_STORAGE_MODE === "0g" ? "0g" : "memory",
    compute: computeLive ? "0g" : computeOpenAI ? "openai" : "mock",
    compute_path: computeLive
      ? process.env.OG_COMPUTE_PROVIDER_ADDRESS
        ? "broker"
        : process.env.OG_COMPUTE_SERVICE_URL
          ? "direct"
          : "unconfigured"
      : computeOpenAI
        ? "openai_responses"
        : "mock",
    chain: process.env.AGENT_CHAIN_MODE === "0g" || process.env.AGENT_CHAIN_MODE === "live" ? "0g" : "mock",
    checkpoint_flush: process.env.AGENT_CHECKPOINT_FLUSH_MODE === "0g" ? "0g" : "local_cache",
    planner: process.env.AGENT_LANGGRAPH_PLANNER_MODE || "deterministic",
    generation_runtime: "crewai",
    crewai_mode: process.env.CREWAI_RUNTIME_MODE || "auto",
    crewai_compute: crewAiComputeOpenAI ? "openai" : "runtime_compute",
    crewai_compute_path: crewAiComputeOpenAI ? "openai_responses" : "compute_bridge",
    costProfile:
      process.env.AGENT_STORAGE_MODE === "0g" ||
      process.env.AGENT_COMPUTE_MODE === "0g" ||
      process.env.AGENT_COMPUTE_MODE === "live" ||
      process.env.AGENT_CHAIN_MODE === "0g" ||
      process.env.AGENT_CHAIN_MODE === "live"
        ? "live_0g"
        : computeOpenAI || crewAiComputeOpenAI
          ? "live_openai"
        : "zero_cost_mock"
  };
}

function storageDiagnostics(storage: AgentStorage): Record<string, unknown> {
  const diagnostics = (storage as AgentStorage & { diagnostics?: () => Record<string, unknown> }).diagnostics;
  return typeof diagnostics === "function" ? diagnostics.call(storage) : { backend: "unknown" };
}

function explorerTxUrl(txHash: string): string {
  const explorer = process.env.OG_EXPLORER_URL?.replace(/\/$/, "") ?? "https://chainscan-galileo.0g.ai";
  return `${explorer}/tx/${txHash}`;
}

function storageBlobUrl(rootHash?: string): string | null {
  if (!rootHash) {
    return null;
  }
  return `/storage/blob?rootHash=${encodeURIComponent(rootHash)}`;
}

function latestString(events: AgentEvent[], select: (event: AgentEvent) => string | undefined): string | undefined {
  for (const event of [...events].reverse()) {
    const value = select(event);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function nestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

async function cachedZeroGHealth(
  getCache: () => { expiresAt: number; value: unknown } | undefined,
  setCache: (value: { expiresAt: number; value: unknown }) => void
): Promise<unknown> {
  const cached = getCache();
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const value = await zeroGHealth();
  setCache({ expiresAt: Date.now() + 30_000, value });
  return value;
}

async function zeroGHealth() {
  const rpcUrl = process.env.OG_RPC_URL || "https://evmrpc-testnet.0g.ai";
  const storageIndexer = process.env.OG_STORAGE_INDEXER_RPC || "https://indexer-storage-testnet-turbo.0g.ai";
  const serviceUrl = process.env.OG_COMPUTE_SERVICE_URL || null;
  const modes = runtimeModes();
  const computeOpenAI = modes.compute === "openai";
  const [blockHeight, storageReachable, computeReachable] = await Promise.all([
    modes.chain === "0g" ? rpcBlockHeight(rpcUrl) : Promise.resolve(null),
    modes.storage === "0g" ? httpReachable(storageIndexer) : Promise.resolve(null),
    modes.compute === "0g" && serviceUrl ? httpReachable(serviceUrl) : Promise.resolve(null)
  ]);
  return {
    chain_rpc: rpcUrl,
    chain_reachable: modes.chain === "0g" ? blockHeight !== null : null,
    chain_block_height: blockHeight,
    storage_indexer: storageIndexer,
    storage_indexer_reachable: storageReachable,
    storage_mode_live: process.env.AGENT_STORAGE_MODE === "0g",
    compute_provider: computeOpenAI ? "openai" : process.env.OG_COMPUTE_PROVIDER_ADDRESS || null,
    compute_service_url: computeOpenAI ? "https://api.openai.com/v1/responses" : serviceUrl,
    compute_provider_reachable: computeReachable,
    compute_mode_live: process.env.AGENT_COMPUTE_MODE === "0g" || process.env.AGENT_COMPUTE_MODE === "live" || process.env.AGENT_COMPUTE_MODE === "openai" || process.env.AGENT_COMPUTE_MODE === "chatgpt",
    crewai_compute_provider: modes.crewai_compute === "openai" ? "openai" : modes.compute,
    crewai_compute_service_url: modes.crewai_compute === "openai" ? "https://api.openai.com/v1/responses" : null,
    crewai_compute_mode_live: modes.crewai_compute === "openai" || modes.compute === "0g" || modes.compute === "openai",
    chain_mode_live: process.env.AGENT_CHAIN_MODE === "0g" || process.env.AGENT_CHAIN_MODE === "live"
  };
}

async function httpReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcBlockHeight(rpcUrl: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      signal: controller.signal
    });
    const data = await response.json() as { result?: string };
    return data.result ? Number.parseInt(data.result, 16) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

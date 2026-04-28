import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { AgentCompute } from "../infra/types.js";
import { createTestOrchestrator, longSample } from "../test/helpers.js";

test("StyleCurator extracts profile and emits a mint transaction intent", async () => {
  const { orchestrator } = createTestOrchestrator();
  await orchestrator.start();

  const wallet = ethers.Wallet.createRandom();
  const message = `I confirm this is my own writing, signed by ${wallet.address}`;
  const signature = await wallet.signMessage(message);
  await orchestrator.publish({
    id: "style-upload-1",
    type: "style.uploaded",
    timestamp: Date.now(),
    actor: wallet.address,
    payload: {
      requestId: "req-style",
      samples: [longSample()],
      attestationMessage: message,
      attestationSignature: signature,
      genres: ["technical"]
    }
  });
  await orchestrator.drain();

  const events = orchestrator.eventsForRequest("req-style");
  const intent = events.find((event) => event.type === "style.mint.intent.created");
  assert.ok(intent);
  assert.equal(intent.payload.status, "awaiting_wallet_signature");
  assert.ok(intent.payload.transactionIntent);
});

test("StyleCurator accepts tagged JSON wrapped like live model responses", async () => {
  const compute: AgentCompute = {
    async chat() {
      return {
        content: [
          "```xml",
          '<STYLE_PROFILE source="0g-compute">',
          "```json",
          JSON.stringify({
            tone: { labels: ["practical", "skeptical"], primary: "practical" },
            vocabulary: { distinctive_words: ["event", "profile", "settlement"] },
            sentence_rhythm: { average_sentence_length: "medium" },
            sample_excerpts: ["The handoff matters because every agent writes an event before another agent acts."],
            voice_essence: "Builder-first, concrete, and careful about what is live versus pending."
          }),
          "```",
          "</STYLE_PROFILE>",
          "```"
        ].join("\n"),
        verified: true,
        model: "wrapped-live-shape"
      };
    },
    async verifyResponse() {
      return true;
    },
    async ensureFunds() {}
  };
  const { orchestrator } = createTestOrchestrator({ compute });
  await orchestrator.start();

  const wallet = ethers.Wallet.createRandom();
  const message = `I confirm this is my own writing, signed by ${wallet.address}`;
  const signature = await wallet.signMessage(message);
  await orchestrator.publish({
    id: "style-upload-wrapped",
    type: "style.uploaded",
    timestamp: Date.now(),
    actor: wallet.address,
    payload: {
      requestId: "req-style-wrapped",
      samples: [longSample()],
      attestationMessage: message,
      attestationSignature: signature
    }
  });
  await orchestrator.drain();

  const events = orchestrator.eventsForRequest("req-style-wrapped");
  assert.equal(events.some((event) => event.type === "style.failed"), false);
  assert.equal(events.some((event) => event.type === "style.mint.intent.created"), true);
});

test("ContentCreator and DistributionManager turn requested generation into published variants", async () => {
  const { orchestrator, storage, chain } = createTestOrchestrator();
  chain.setCredits("0x00000000000000000000000000000000000000a1", 3n);
  await storage.kvSet("style:1:profile", {
    tone: ["clear"],
    sentence_rhythm: "direct",
    sampleExcerpts: ["Example voice excerpt."]
  });
  await orchestrator.start();

  await orchestrator.publish({
    id: "gen-1",
    type: "generation.requested",
    timestamp: Date.now(),
    actor: "0x00000000000000000000000000000000000000a1",
    styleId: "1",
    consumerAddress: "0x00000000000000000000000000000000000000a1",
    payload: {
      requestId: "req-gen",
      prompt: "Announce a hackathon demo",
      platforms: ["x", "linkedin", "instagram"]
    }
  });
  await orchestrator.drain();

  const events = orchestrator.eventsForRequest("req-gen");
  assert.equal(events.some((event) => event.type === "generation.drafted"), true);
  assert.equal(events.some((event) => event.type === "generation.published"), true);
  assert.equal(events.some((event) => event.type === "settlement.intent.created"), true);
  const published = events.find((event) => event.type === "generation.published");
  assert.equal(published?.payload.settlementStatus, "awaiting_wallet_signature");
  assert.ok(published?.payload.spendIntent);
});

test("ContentCreator emits credit.low when consumer has no credits", async () => {
  const { orchestrator, storage, chain } = createTestOrchestrator();
  chain.setCredits("0x00000000000000000000000000000000000000b1", 0n);
  await storage.kvSet("style:1:profile", { tone: ["clear"] });
  await orchestrator.start();

  await orchestrator.publish({
    id: "gen-low-credit",
    type: "generation.requested",
    timestamp: Date.now(),
    actor: "0x00000000000000000000000000000000000000b1",
    styleId: "1",
    consumerAddress: "0x00000000000000000000000000000000000000b1",
    payload: { requestId: "req-low", prompt: "Write something" }
  });
  await orchestrator.drain();

  assert.equal(orchestrator.eventsForRequest("req-low").some((event) => event.type === "credit.low"), true);
});

test("DistributionManager uses KeeperHub for autonomous auto-refill when on-chain config allows it", async () => {
  const keeperhub = {
    async isChainSupported() {
      return { supported: true, network: "sepolia" };
    },
    async executeContractCall() {
      return {
        status: "confirmed" as const,
        workflowId: "direct_refill_1",
        txHash: "0xrefill",
        blockExplorerUrl: "https://example.test/tx/0xrefill"
      };
    },
    async executeTransaction() {
      return { status: "pending_keeperhub" as const };
    },
    async pollWorkflow() {
      return { status: "confirmed" as const, workflowId: "direct_refill_1", txHash: "0xrefill" };
    }
  };
  const { orchestrator, chain } = createTestOrchestrator({ keeperhub });
  const consumer = "0x00000000000000000000000000000000000000d1";
  chain.setCredits(consumer, 1n);
  chain.setAutoRefill(consumer, {
    maxBudget: 5000000000000000n,
    spent: 0n,
    threshold: 1n,
    perRefill: 5n,
    enabled: true,
    supported: true
  });
  await orchestrator.start();

  await orchestrator.publish({
    id: "credit-low-1",
    type: "credit.low",
    timestamp: Date.now(),
    actor: "system",
    consumerAddress: consumer,
    payload: { requestId: "req-refill", reason: "post_settlement_threshold" }
  });
  await orchestrator.drain();

  const events = orchestrator.eventsForRequest("req-refill");
  const replenished = events.find((event) => event.type === "credit.replenished");
  assert.ok(replenished);
  assert.equal(replenished.payload.workflowId, "direct_refill_1");
  assert.equal(replenished.payload.txHash, "0xrefill");
});

test("StyleCurator refines a profile from feedback without direct agent calls", async () => {
  const { orchestrator, storage } = createTestOrchestrator();
  await storage.kvSet("style:1:profile", {
    tone: ["clear"],
    vocabulary: ["agents"],
    sampleExcerpts: ["Example voice excerpt."]
  });
  await orchestrator.start();

  await orchestrator.publish({
    id: "feedback-1",
    type: "feedback.received",
    timestamp: Date.now(),
    actor: "0x00000000000000000000000000000000000000c1",
    styleId: "1",
    consumerAddress: "0x00000000000000000000000000000000000000c1",
    payload: {
      requestId: "req-feedback",
      feedback: "The voice is close, but it needs more concrete technical specificity and less generic launch language."
    }
  });
  await orchestrator.drain();

  const events = orchestrator.eventsForRequest("req-feedback");
  assert.equal(events.some((event) => event.type === "style.refined"), true);
  const profile = await storage.kvGet<Record<string, unknown>>("style:1:profile");
  assert.equal(profile?.lastRefinementQualitySignal, "mixed");
});

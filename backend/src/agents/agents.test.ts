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

test("0G planner mode still follows creator onboarding tool order", async () => {
  const previousPlannerMode = process.env.AGENT_LANGGRAPH_PLANNER_MODE;
  process.env.AGENT_LANGGRAPH_PLANNER_MODE = "0g";
  try {
    const compute: AgentCompute = {
      async chat(messages) {
        const prompt = messages.map((message) => message.content).join("\n");
        if (prompt.includes("selecting the next LangGraph ReAct tool call")) {
          return {
            content: JSON.stringify({ tool: "refine_profile_from_feedback", args: {} }),
            verified: true,
            model: "planner-adversarial-test"
          };
        }
        return {
          content: JSON.stringify({
            tone: { labels: ["technical", "reflective"], primary: "technical" },
            vocabulary: { distinctive_words: ["agent", "proof", "storage"] },
            sentence_rhythm: { average_sentence_length: "medium" },
            sample_excerpts: ["Every useful action leaves a verifiable trace."],
            voice_essence: "Technical, reflective, and evidence-oriented."
          }),
          verified: true,
          model: "profile-test"
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
      id: "style-upload-planner-order",
      type: "style.uploaded",
      timestamp: Date.now(),
      actor: wallet.address,
      payload: {
        requestId: "req-style-planner-order",
        samples: [longSample()],
        attestationMessage: message,
        attestationSignature: signature,
        genres: ["technical"]
      }
    });
    await orchestrator.drain();

    const events = orchestrator.eventsForRequest("req-style-planner-order");
    const activityTools = events
      .filter((event) => event.type === "agent.activity")
      .map((event) => event.payload.tool);
    assert.deepEqual(
      activityTools.filter((tool) =>
        [
          "verify_attestation",
          "encrypt_and_store_samples",
          "extract_style_profile",
          "build_and_upload_agent_brain",
          "mint_inft",
          "refine_profile_from_feedback"
        ].includes(String(tool))
      ),
      [
        "verify_attestation",
        "verify_attestation",
        "encrypt_and_store_samples",
        "encrypt_and_store_samples",
        "extract_style_profile",
        "extract_style_profile",
        "build_and_upload_agent_brain",
        "build_and_upload_agent_brain",
        "mint_inft",
        "mint_inft"
      ]
    );
    assert.equal(events.some((event) => event.type === "style.failed"), false);
    assert.equal(events.some((event) => event.type === "style.mint.intent.created"), true);
  } finally {
    if (previousPlannerMode === undefined) {
      delete process.env.AGENT_LANGGRAPH_PLANNER_MODE;
    } else {
      process.env.AGENT_LANGGRAPH_PLANNER_MODE = previousPlannerMode;
    }
  }
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

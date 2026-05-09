import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { AgentCompute } from "../infra/types.js";
import { createTestOrchestrator, longSample } from "../test/helpers.js";
import { contentGenerationPrompt } from "./prompts.js";

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
      platforms: ["thread", "x", "instagram"]
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
  const variants = published?.payload.variants as Record<string, string> | undefined;
  assert.ok(variants?.thread);
  const tweets = variants.thread.split(/\n\n+/);
  assert.ok(tweets.length >= 3 && tweets.length <= 5, `expected 3-5 tweets, got ${tweets.length}`);
  for (const tweet of tweets) {
    assert.ok(tweet.length <= 220, `tweet exceeded 220 chars: ${tweet.length}`);
    assert.doesNotMatch(tweet, /^\d+\s*\/\s*\d+\s+\d+\s*\/\s*\d+\b/);
  }
});

test("DistributionManager normalizes pre-numbered CrewAI drafts into a clean tweet thread", async () => {
  const previousCrewMode = process.env.CREWAI_RUNTIME_MODE;
  const previousCrewComputeMode = process.env.CREWAI_COMPUTE_MODE;
  const previousDistributionTuning = process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING;
  process.env.CREWAI_RUNTIME_MODE = "bridge";
  process.env.CREWAI_COMPUTE_MODE = "mock";
  process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING = "off";
  const malformedThread = [
    "1/4 \u2022 introducing Voices:",
    "",
    "a 0G-powered marketplace for turning writing style into an ownable AI asset.",
    "",
    "2/4 \u2022 the core idea:",
    "",
    "creators upload samples, the platform analyzes tone, cadence, structure, and phrasing, and those patterns become a licensable style.",
    "",
    "3/4 \u2022 the ownership layer:",
    "",
    "people can browse, mint, and use styles with permission while creators earn when their voice is used.",
    "",
    "4/4 \u2022 the goal:",
    "",
    "make ethical AI content creation feel practical instead of performative."
  ].join("\n");
  const compute: AgentCompute = {
    async chat(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("Voice Critic + Memory Agent") || prompt.includes("<draft_to_review>")) {
        return {
          content: JSON.stringify({
            draft: malformedThread,
            style_match: { score: 0.9, why: "Thread shape follows the evidence." },
            needs_revision: false,
            critique: "Good compact thread.",
            feedback: "Keep short-form launches concrete.",
            learned_preferences: ["Prefer compact, mechanism-first thread posts."]
          }),
          verified: true,
          model: "thread-critic-test"
        };
      }
      if (prompt.includes("<runtime_voice_packet_json>") && prompt.includes("<user_task>")) {
        return {
          content: `<draft>${malformedThread}</draft>`,
          verified: true,
          model: "thread-writer-test"
        };
      }
      return {
        content: JSON.stringify({ tool: "final", args: {} }),
        verified: true,
        model: "planner-test"
      };
    },
    async verifyResponse() {
      return true;
    },
    async ensureFunds() {}
  };
  try {
    const { orchestrator, storage, chain } = createTestOrchestrator({ compute });
    chain.setCredits("0x00000000000000000000000000000000000000a3", 3n);
    await storage.kvSet("style:3:profile", {
      tone: ["builder-first"],
      sentence_rhythm: "compact",
      sampleExcerpts: ["Draftr isn't just a wrapper. On the backend side, the interesting part is the handoff."]
    });
    await orchestrator.start();

    await orchestrator.publish({
      id: "gen-thread-normalize",
      type: "generation.requested",
      timestamp: Date.now(),
      actor: "0x00000000000000000000000000000000000000a3",
      styleId: "3",
      consumerAddress: "0x00000000000000000000000000000000000000a3",
      payload: {
        requestId: "req-thread-normalize",
        prompt: "Introduce Voices as a tweet thread",
        platforms: ["thread"]
      }
    });
    await orchestrator.drain();

    const published = orchestrator.eventsForRequest("req-thread-normalize").find((event) => event.type === "generation.published");
    const variants = published?.payload.variants as Record<string, string> | undefined;
    assert.ok(variants?.thread);
    const tweets = variants.thread.split(/\n\n+/);
    assert.equal(tweets.length, 4);
    tweets.forEach((tweet, index) => {
      assert.match(tweet, new RegExp(`^${index + 1}/4\\s`));
      assert.doesNotMatch(tweet, /^\d+\s*\/\s*\d+\s+\d+\s*\/\s*\d+\b/);
      assert.ok(tweet.length <= 220, `tweet exceeded 220 chars: ${tweet.length}`);
    });
    assert.match(variants.thread, /introducing Voices/i);
  } finally {
    if (previousCrewMode === undefined) {
      delete process.env.CREWAI_RUNTIME_MODE;
    } else {
      process.env.CREWAI_RUNTIME_MODE = previousCrewMode;
    }
    if (previousCrewComputeMode === undefined) {
      delete process.env.CREWAI_COMPUTE_MODE;
    } else {
      process.env.CREWAI_COMPUTE_MODE = previousCrewComputeMode;
    }
    if (previousDistributionTuning === undefined) {
      delete process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING;
    } else {
      process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING = previousDistributionTuning;
    }
  }
});

test("ContentCreator runs CrewAI generation with selected voice context and accepts the agent draft", async () => {
  const previousCrewMode = process.env.CREWAI_RUNTIME_MODE;
  const previousCrewComputeMode = process.env.CREWAI_COMPUTE_MODE;
  process.env.CREWAI_RUNTIME_MODE = "bridge";
  process.env.CREWAI_COMPUTE_MODE = "mock";
  let generationCalls = 0;
  let generationPrompt = "";
  const compute: AgentCompute = {
    async chat(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("Voice Critic + Memory Agent") || prompt.includes("<draft_to_review>")) {
        return {
          content: JSON.stringify({
            draft: "Web3 needs less posture and more receipts: what runs onchain, who controls the data, and where the trust assumption actually moved.",
            style_match: { score: 0.86, why: "Keeps the technical, receipt-oriented register from the evidence." },
            needs_revision: false,
            revision_guidance: "",
            critique: "The draft uses compact technical framing and avoids generic launch language.",
            feedback: "Receipt-oriented phrasing matched the supplied evidence.",
            learned_preferences: ["Keep future short-form drafts concrete and mechanism-first."]
          }),
          verified: true,
          model: "voice-critic-test"
        };
      }
      if (prompt.includes("<runtime_voice_packet_json>") && prompt.includes("<user_task>")) {
        generationCalls += 1;
        generationPrompt = prompt;
        return {
          content: "<draft>Web3 needs less posture and more receipts: what runs onchain, who controls the data, and where the trust assumption actually moved.</draft>",
          verified: true,
          model: "voice-context-test"
        };
      }
      return {
        content: JSON.stringify({ tool: "final", args: {} }),
        verified: true,
        model: "planner-test"
      };
    },
    async verifyResponse() {
      return true;
    },
    async ensureFunds() {}
  };
  try {
    const { orchestrator, storage, chain } = createTestOrchestrator({ compute });
    chain.setCredits("0x00000000000000000000000000000000000000a2", 3n);
    await storage.kvSet("style:2:profile", {
      tone: { primary: "technical" },
      detailed_style_guide: {
        prompt_ready_style_brief: "Use concise, technical, receipt-oriented phrasing.",
        actual_examples: [
          {
            text: "week - n: - Leveraged AI and computer vision to enhance data integrity and user experience in SampleApp. - Integrated blockchain for secure, transparent, and immutable record-keeping.",
            observed_patterns: ["README bullet summary with technical verbs."]
          }
        ],
        generation_recipe: {
          tweet: ["Write one concise finished tweet.", "Do not copy README bullet material."]
        }
      },
      sampleExcerpts: [
        "week - n: - Leveraged AI and computer vision to enhance data integrity and user experience in SampleApp. - Integrated blockchain for secure, transparent, and immutable record-keeping."
      ],
      source_profile: { primary_source_type: "github_readme" }
    });
    await storage.kvSet("style:2:agentBrain", {
      manifest_version: 1,
      agent_type: "voices-style-agent",
      memory: { log_stream: "style:2:memory" }
    });
    await orchestrator.start();

    await orchestrator.publish({
      id: "gen-source-leak",
      type: "generation.requested",
      timestamp: Date.now(),
      actor: "0x00000000000000000000000000000000000000a2",
      styleId: "2",
      consumerAddress: "0x00000000000000000000000000000000000000a2",
      payload: {
        requestId: "req-source-leak",
        prompt: "tweet about web3",
        platforms: ["x"]
      }
    });
    await orchestrator.drain();

    const events = orchestrator.eventsForRequest("req-source-leak");
    const published = events.find((event) => event.type === "generation.published");
    const drafted = events.find((event) => event.type === "generation.drafted");
    const variants = (published?.payload.variants ?? {}) as Record<string, string>;
    assert.equal(generationCalls, 1);
    assert.match(generationPrompt, /<runtime_voice_packet_json>/);
    assert.match(generationPrompt, /SampleApp/);
    assert.match(generationPrompt, /memory_log_count/);
    assert.equal(events.some((event) => event.type === "generation.failed"), false);
    assert.equal(
      events.some((event) => event.type === "agent.activity" && event.payload.agentLabel === "Voice Critic + Memory Agent"),
      true
    );
    const draftCompute = (drafted?.payload.compute ?? {}) as Record<string, unknown>;
    assert.match(String(draftCompute.runtime), /bridge/);
    assert.match(String(variants.x), /Web3 needs less posture/);
  } finally {
    if (previousCrewMode === undefined) {
      delete process.env.CREWAI_RUNTIME_MODE;
    } else {
      process.env.CREWAI_RUNTIME_MODE = previousCrewMode;
    }
    if (previousCrewComputeMode === undefined) {
      delete process.env.CREWAI_COMPUTE_MODE;
    } else {
      process.env.CREWAI_COMPUTE_MODE = previousCrewComputeMode;
    }
  }
});

test("CrewAI critic score below the quality bar triggers a revision pass", async () => {
  const previousCrewMode = process.env.CREWAI_RUNTIME_MODE;
  const previousCrewComputeMode = process.env.CREWAI_COMPUTE_MODE;
  const previousMinStyleScore = process.env.CREWAI_MIN_STYLE_SCORE;
  const previousMaxRevisions = process.env.CREWAI_MAX_REVISIONS;
  const previousDistributionTuning = process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING;
  process.env.CREWAI_RUNTIME_MODE = "bridge";
  process.env.CREWAI_COMPUTE_MODE = "mock";
  process.env.CREWAI_MIN_STYLE_SCORE = "0.72";
  process.env.CREWAI_MAX_REVISIONS = "1";
  process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING = "off";
  let writerCalls = 0;
  let criticCalls = 0;
  const compute: AgentCompute = {
    async chat(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("Voice Critic + Memory Agent") || prompt.includes("<draft_to_review>")) {
        criticCalls += 1;
        const revised = criticCalls > 1;
        return {
          content: JSON.stringify({
            draft: revised
              ? "Web3 works when the mechanism is clear: who owns the data, what runs onchain, and where the trust assumption moved."
              : "Web3 is changing ownership for everyone.",
            style_match: {
              score: revised ? 0.86 : 0.58,
              why: revised ? "Concrete mechanism-first framing." : "Too generic for the supplied evidence."
            },
            needs_revision: false,
            revision_guidance: "Make the draft more mechanism-first and less generic.",
            critique: revised ? "Revision matches the stored voice evidence." : "The first draft is too broad.",
            feedback: "Prefer mechanism-first framing.",
            learned_preferences: ["Use concrete ownership and trust-assumption language."]
          }),
          verified: true,
          model: "voice-critic-test"
        };
      }
      if (prompt.includes("<runtime_voice_packet_json>") && prompt.includes("<user_task>")) {
        writerCalls += 1;
        const revised = prompt.includes("Revise the previous draft");
        return {
          content: revised
            ? "<draft>Web3 works when the mechanism is clear: who owns the data, what runs onchain, and where the trust assumption moved.</draft>"
            : "<draft>Web3 is changing ownership for everyone.</draft>",
          verified: true,
          model: "voice-writer-test"
        };
      }
      return {
        content: JSON.stringify({ tool: "final", args: {} }),
        verified: true,
        model: "planner-test"
      };
    },
    async verifyResponse() {
      return true;
    },
    async ensureFunds() {}
  };
  try {
    const { orchestrator, storage, chain } = createTestOrchestrator({ compute });
    chain.setCredits("0x00000000000000000000000000000000000000a4", 3n);
    await storage.kvSet("style:4:profile", {
      tone: { primary: "technical" },
      detailed_style_guide: {
        prompt_ready_style_brief: "Use concise, mechanism-first writing with concrete ownership and trust assumptions.",
        actual_examples: [
          {
            text: "Web3 needs less posture and more receipts: what runs onchain, who controls the data, and where the trust assumption actually moved.",
            observed_patterns: ["Uses mechanism-first framing instead of generic claims."]
          }
        ]
      },
      sampleExcerpts: [
        "Web3 needs less posture and more receipts: what runs onchain, who controls the data, and where the trust assumption actually moved."
      ]
    });
    await orchestrator.start();

    await orchestrator.publish({
      id: "gen-critic-revision",
      type: "generation.requested",
      timestamp: Date.now(),
      actor: "0x00000000000000000000000000000000000000a4",
      styleId: "4",
      consumerAddress: "0x00000000000000000000000000000000000000a4",
      payload: {
        requestId: "req-critic-revision",
        prompt: "tweet about why web3 matters",
        platforms: ["x"]
      }
    });
    await orchestrator.drain();

    const events = orchestrator.eventsForRequest("req-critic-revision");
    const published = events.find((event) => event.type === "generation.published");
    const variants = (published?.payload.variants ?? {}) as Record<string, string>;
    assert.equal(writerCalls, 2);
    assert.equal(criticCalls, 2);
    assert.equal(events.some((event) => event.type === "generation.failed"), false);
    assert.equal(
      events.some((event) => event.type === "agent.activity" && String(event.payload.message).includes("requesting one targeted revision")),
      true
    );
    assert.match(variants.x, /what runs onchain/i);
  } finally {
    if (previousCrewMode === undefined) delete process.env.CREWAI_RUNTIME_MODE;
    else process.env.CREWAI_RUNTIME_MODE = previousCrewMode;
    if (previousCrewComputeMode === undefined) delete process.env.CREWAI_COMPUTE_MODE;
    else process.env.CREWAI_COMPUTE_MODE = previousCrewComputeMode;
    if (previousMinStyleScore === undefined) delete process.env.CREWAI_MIN_STYLE_SCORE;
    else process.env.CREWAI_MIN_STYLE_SCORE = previousMinStyleScore;
    if (previousMaxRevisions === undefined) delete process.env.CREWAI_MAX_REVISIONS;
    else process.env.CREWAI_MAX_REVISIONS = previousMaxRevisions;
    if (previousDistributionTuning === undefined) delete process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING;
    else process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING = previousDistributionTuning;
  }
});

test("Content generation prompt anchors the model with selected voice examples", () => {
  const privateExample = "week - n: • Leveraged AI and computer vision to enhance data integrity and user experience in SampleApp.";
  const messages = contentGenerationPrompt({
    styleProfile: {
      detailed_style_guide: {
        prompt_ready_style_brief: "Concise technical voice with concrete mechanisms.",
        actual_examples: [{ text: privateExample, observed_patterns: ["Uses terse release-note bullets."] }],
        generation_recipe: { tweet: ["Write one concise finished tweet."] }
      },
      sampleExcerpts: [privateExample],
      source_profile: {
        primary_source_type: "github_readme",
        generation_guidelines_by_format: { tweet: ["Compress the mechanism into one post."] }
      }
    },
    prompt: "tweet about web3",
    excerpts: [privateExample],
    platforms: ["x"]
  });
  const promptText = messages.map((message) => message.content).join("\n");
  assert.equal(promptText.includes("SampleApp"), true);
  assert.equal(promptText.includes("Leveraged AI and computer vision"), true);
  assert.equal(promptText.includes("Uses terse release-note bullets"), true);
  assert.match(promptText, /silently compare the draft against the examples/);
  assert.match(promptText, /voice_transfer_strategy_json/);
});

test("Content generation prompt derives transfer strategy from supplied evidence", () => {
  const messages = contentGenerationPrompt({
    styleProfile: {
      detailed_style_guide: {
        prompt_ready_style_brief: "Technical and reflective builder voice.",
        actual_examples: [
          {
            text: "The app takes source material, plans multiple short ideas, generates narration + subtitles, and renders final vertical videos.",
            observed_patterns: ["Explains the system by decomposing the pipeline."]
          },
          {
            text: "It helped me tighten UUID validation, request/response contract handling, asset upload behavior, and SSE/live progress updates during video generation.",
            observed_patterns: ["Uses implementation-side breakdowns."]
          }
        ],
        generation_recipe: { tweet: ["Explain the project through concrete mechanics."] }
      },
      source_profile: { primary_source_type: "twitter" }
    },
    prompt: "introduce my new project Voices, a marketplace for ownable AI writing styles",
    excerpts: [
      "The app takes source material, plans multiple short ideas, generates narration + subtitles, and renders final vertical videos.",
      "It helped me tighten UUID validation, request/response contract handling, asset upload behavior, and SSE/live progress updates during video generation."
    ],
    platforms: ["x"]
  });
  const promptText = messages.map((message) => message.content).join("\n");
  assert.match(promptText, /voice_transfer_strategy_json/);
  assert.match(promptText, /evidence_derived_shape/);
  assert.match(promptText, /The app takes source material/);
  assert.doesNotMatch(promptText, /task_kind/);
  assert.doesNotMatch(promptText, /startup/);
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

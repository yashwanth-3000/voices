import { Wallet } from "ethers";
import { buildApp } from "./http/app.js";
import { EventLog } from "./events/event-log.js";
import { MockChainClient } from "./infra/chain.js";
import { MockComputeClient } from "./infra/compute.js";
import { KeeperHubRestClient } from "./infra/keeperhub.js";
import { MemoryStorageClient } from "./infra/storage.js";
import { Orchestrator } from "./orchestrator/index.js";

const wallet = Wallet.createRandom();
const storage = new MemoryStorageClient();
const chain = new MockChainClient();
const orchestrator = new Orchestrator({
  storage,
  chain,
  compute: new MockComputeClient(),
  keeperhub: new KeeperHubRestClient(),
  eventLog: new EventLog({ storage })
});

const app = await buildApp({ orchestrator });

try {
  const message = `I confirm these samples are my own writing, signed by ${wallet.address}`;
  const attestationSignature = await wallet.signMessage(message);
  const sample = [
    "Most agent demos fail in the same quiet way: the model answers once, the page updates once, and everyone politely pretends a workflow happened. That is not how real creative work feels. Real work leaves a trail. A creator uploads messy source material, a system extracts a useful shape from it, a buyer asks for something new, and the system keeps learning from the edits that follow.",
    "Voices treats a writing style like a living asset instead of a prompt pasted into a textbox. The raw samples are encrypted first, because the creator should not have to publish their private drafts to prove they have a voice. The profile that comes out is intentionally structured: tone, sentence rhythm, favorite turns of phrase, avoided patterns, recurring themes, and a short fingerprint that downstream agents can use without copying the source.",
    "The interesting part is the handoff. The Style Curator does not call the Content Creator directly. It writes an event. The Content Creator does not know who will publish the result. It writes an event. The Distribution Manager does not pretend settlement happened because a UI spinner completed. It produces a transaction intent and waits for the execution layer to confirm. That is the difference between a pipeline dressed up as agents and an actual event-driven system.",
    "The voice I like for this product is practical, a little skeptical, and builder-first. It should use plain words, but not flatten the idea. It should explain the moving parts clearly enough that a judge can follow the architecture in thirty seconds, while still making the creator ownership story feel concrete. Short sentences help when the concept is dense. Specific nouns help even more: profile hash, encrypted samples, credit spend, royalty settlement, feedback event.",
    "The product should avoid vague launch language. No 'revolutionary platform' filler. No claims that the system is fully decentralized when the demo still has server-side conveniences. Say what is real, say what is mocked, and say what the production version would harden. That kind of honesty is not less impressive. It makes the demo easier to trust."
  ].join("\n\n");

  const upload = await post("/styles/upload", {
    walletAddress: wallet.address,
    samples: [sample],
    attestationMessage: message,
    attestationSignature,
    language: "en",
    genres: ["technical", "creator-tools"]
  });
  await orchestrator.drain();

  const mintIntent = eventOfType(upload.requestId, "style.mint.intent.created");
  const pendingStyleId = mintIntent.styleId;
  if (!pendingStyleId) {
    throw new Error("style.mint.intent.created did not include a pending styleId");
  }
  await post("/styles/confirm-mint", {
    requestId: upload.requestId,
    walletAddress: wallet.address,
    pendingStyleId,
    tokenId: "1",
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000001"
  });
  await orchestrator.drain();
  const minted = eventOfType(upload.requestId, "style.minted");
  const styleId = minted.styleId;
  if (!styleId) throw new Error("style.minted did not include a styleId");

  const generated = await post("/generate", {
    walletAddress: wallet.address,
    styleId,
    prompt: "Announce that Voices turns creator writing styles into iNFT-powered agent assets on 0G.",
    platforms: ["thread", "x", "instagram"]
  });
  await orchestrator.drain();

  const published = eventOfType(generated.requestId, "generation.published");
  await post("/settlement/confirm", {
    requestId: generated.requestId,
    walletAddress: wallet.address,
    styleId,
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000002"
  });
  await orchestrator.drain();

  const feedback = await post("/feedback", {
    walletAddress: wallet.address,
    styleId,
    feedback: "The voice is close, but make it more concrete and less generic for technical builders."
  });
  await orchestrator.drain();

  eventOfType(feedback.requestId, "style.refined");

  const result = {
    ok: true,
    agentStatus: orchestrator.status().agents.map((agent) => ({
      name: agent.name,
      status: agent.status,
      subscribedEvents: agent.subscribedEvents
    })),
    upload: {
      requestId: upload.requestId,
      events: eventsFor(upload.requestId).map((event) => event.type),
      styleId
    },
    generation: {
      requestId: generated.requestId,
      events: eventsFor(generated.requestId).map((event) => event.type),
      settlementStatus: published.payload.settlementStatus
    },
    feedback: {
      requestId: feedback.requestId,
      events: eventsFor(feedback.requestId).map((event) => event.type)
    }
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close();
}

async function post(path: string, body: Record<string, unknown>): Promise<{ requestId: string; eventId: string }> {
  const response = await app.inject({
    method: "POST",
    url: path,
    payload: body
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${path} failed with ${response.statusCode}: ${response.body}`);
  }
  return JSON.parse(response.body) as { requestId: string; eventId: string };
}

function eventOfType(requestId: string, type: string) {
  const event = eventsFor(requestId).find((candidate) => candidate.type === type);
  if (!event) {
    throw new Error(`Missing ${type} for request ${requestId}`);
  }
  return event;
}

function eventsFor(requestId: string) {
  return orchestrator.eventsForRequest(requestId);
}

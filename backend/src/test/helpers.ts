import { EventBus } from "../events/event-bus.js";
import { MockChainClient } from "../infra/chain.js";
import { MockComputeClient } from "../infra/compute.js";
import { KeeperHubRestClient } from "../infra/keeperhub.js";
import { MemoryStorageClient } from "../infra/storage.js";
import { AgentCompute } from "../infra/types.js";
import { Orchestrator } from "../orchestrator/index.js";

export function createTestOrchestrator(overrides: { compute?: AgentCompute } = {}) {
  const storage = new MemoryStorageClient();
  const compute = overrides.compute ?? new MockComputeClient();
  const chain = new MockChainClient();
  const keeperhub = new KeeperHubRestClient();
  const bus = new EventBus({ storage });
  const orchestrator = new Orchestrator({ storage, compute, chain, keeperhub, bus });
  return { orchestrator, storage, compute, chain, keeperhub, bus };
}

export function longSample(): string {
  return [
    "Most agent demos fail in the same quiet way: the model answers once, the page updates once, and everyone politely pretends a workflow happened. That is not how real creative work feels. Real work leaves a trail. A creator uploads messy source material, a system extracts a useful shape from it, a buyer asks for something new, and the system keeps learning from the edits that follow.",
    "Voices treats a writing style like a living asset instead of a prompt pasted into a textbox. The raw samples are encrypted first, because the creator should not have to publish their private drafts to prove they have a voice. The profile that comes out is intentionally structured: tone, sentence rhythm, favorite turns of phrase, avoided patterns, recurring themes, and a short fingerprint that downstream agents can use without copying the source.",
    "The interesting part is the handoff. The Style Curator does not call the Content Creator directly. It writes an event. The Content Creator does not know who will publish the result. It writes an event. The Distribution Manager does not pretend settlement happened because a UI spinner completed. It produces a transaction intent and waits for the execution layer to confirm. That is the difference between a pipeline dressed up as agents and an actual event-driven system.",
    "The voice I like for this product is practical, a little skeptical, and builder-first. It should use plain words, but not flatten the idea. It should explain the moving parts clearly enough that a judge can follow the architecture in thirty seconds, while still making the creator ownership story feel concrete. Short sentences help when the concept is dense. Specific nouns help even more: profile hash, encrypted samples, credit spend, royalty settlement, feedback event.",
    "The product should avoid vague launch language. No 'revolutionary platform' filler. No claims that the system is fully decentralized when the demo still has server-side conveniences. Say what is real, say what is mocked, and say what the production version would harden. That kind of honesty is not less impressive. It makes the demo easier to trust."
  ].join("\n\n");
}

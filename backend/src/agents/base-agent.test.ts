import assert from "node:assert/strict";
import test from "node:test";
import { BaseAgent } from "./base-agent.js";
import { AgentEvent } from "../events/types.js";
import { createTestOrchestrator } from "../test/helpers.js";

class TestAgent extends BaseAgent {
  readonly name = "Test Agent";
  readonly subscribedEvents = ["style.uploaded"] as const;
  seen = 0;
  shouldThrow = false;

  protected async handleEvent(): Promise<void> {
    this.seen += 1;
    if (this.shouldThrow) {
      throw new Error("boom");
    }
  }
}

test("BaseAgent transitions through idle and handles only subscribed events", async () => {
  const { bus, storage, compute, chain, keeperhub } = createTestOrchestrator();
  const agent = new TestAgent({ bus, storage, compute, chain, keeperhub });
  await agent.start();

  await agent.onEvent(event("generation.requested"));
  assert.equal(agent.seen, 0);

  await agent.onEvent(event("style.uploaded"));
  assert.equal(agent.seen, 1);
  assert.equal(agent.status().status, "idle");
});

test("BaseAgent reports errors and emits failure event", async () => {
  const { bus, storage, compute, chain, keeperhub } = createTestOrchestrator();
  const agent = new TestAgent({ bus, storage, compute, chain, keeperhub });
  agent.shouldThrow = true;
  await agent.start();

  await agent.onEvent(event("style.uploaded"));
  await bus.drain();

  assert.equal(agent.status().status, "error");
  assert.equal(bus.eventsForRequest("req-test").some((item) => item.type === "style.failed"), true);
});

function event(type: AgentEvent["type"]): AgentEvent {
  return {
    id: `evt-${type}`,
    type,
    timestamp: Date.now(),
    actor: "0xabc",
    payload: { requestId: "req-test" }
  };
}


import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "./event-bus.js";
import { createAgentEvent } from "./types.js";
import { MemoryStorageClient } from "../infra/storage.js";

test("EventBus publishes, deduplicates, and routes subscriptions", async () => {
  const storage = new MemoryStorageClient();
  const bus = new EventBus({ storage });
  const seen: string[] = [];
  bus.subscribe(["generation.requested"], (event) => {
    seen.push(event.id);
  });

  const event = createAgentEvent({
    id: "evt-1",
    type: "generation.requested",
    actor: "0xabc",
    payload: { requestId: "req-1" }
  });

  await bus.publish(event);
  await bus.publish(event);
  await bus.drain();

  assert.deepEqual(seen, ["evt-1"]);
  assert.equal(bus.eventsForRequest("req-1").length, 1);
});

test("EventBus replays durable log entries", async () => {
  const storage = new MemoryStorageClient();
  const first = new EventBus({ storage });
  await first.publish({
    id: "evt-2",
    type: "style.uploaded",
    timestamp: 1,
    actor: "0xabc",
    payload: { requestId: "req-2" }
  });

  const second = new EventBus({ storage });
  const replayed = await second.replay();

  assert.equal(replayed.length, 1);
  assert.equal(second.eventsForRequest("req-2")[0]?.id, "evt-2");
});


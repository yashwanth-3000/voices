import assert from "node:assert/strict";
import test from "node:test";
import { EventLog } from "./event-log.js";
import { createAgentEvent } from "./types.js";
import { MemoryStorageClient } from "../infra/storage.js";

test("EventLog publishes, deduplicates, and streams appended events", async () => {
  const storage = new MemoryStorageClient();
  const events = new EventLog({ storage });
  const seen: string[] = [];
  events.subscribeAll((event) => {
    seen.push(event.id);
  });

  const event = createAgentEvent({
    id: "evt-1",
    type: "generation.requested",
    actor: "0xabc",
    payload: { requestId: "req-1" }
  });

  await events.publish(event);
  await events.publish(event);
  await events.drain();

  assert.deepEqual(seen, ["evt-1"]);
  assert.equal(events.eventsForRequest("req-1").length, 1);
});

test("EventLog replays durable log entries", async () => {
  const storage = new MemoryStorageClient();
  const first = new EventLog({ storage });
  await first.publish({
    id: "evt-2",
    type: "style.uploaded",
    timestamp: 1,
    actor: "0xabc",
    payload: { requestId: "req-2" }
  });
  await first.drain();

  const second = new EventLog({ storage });
  const replayed = await second.replay();

  assert.equal(replayed.length, 1);
  assert.equal(second.eventsForRequest("req-2")[0]?.id, "evt-2");
});

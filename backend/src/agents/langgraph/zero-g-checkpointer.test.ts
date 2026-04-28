import assert from "node:assert/strict";
import test from "node:test";
import { Checkpoint } from "@langchain/langgraph-checkpoint";
import { MemoryStorageClient } from "../../infra/storage.js";
import { ZeroGCheckpointSaver } from "./zero-g-checkpointer.js";

test("ZeroGCheckpointSaver persists latest checkpoint, history, and pending writes", async () => {
  const storage = new MemoryStorageClient();
  const saver = new ZeroGCheckpointSaver(storage);
  const config = { configurable: { thread_id: "thread-1", checkpoint_ns: "voices" } };
  const checkpoint: Checkpoint = {
    v: 4,
    id: "checkpoint-1",
    ts: new Date(0).toISOString(),
    channel_values: { activeAgent: "style_curator" },
    channel_versions: { activeAgent: 1 },
    versions_seen: {}
  };

  const savedConfig = await saver.put(config, checkpoint, { source: "input", step: -1, parents: {} }, {});
  await saver.putWrites(savedConfig, [["activeAgent", "content_creator"]], "task-1");

  const tuple = await saver.getTuple(savedConfig);
  assert.equal(tuple?.checkpoint.id, "checkpoint-1");
  assert.equal(tuple?.metadata?.source, "input");
  assert.deepEqual(tuple?.pendingWrites, [["task-1", "activeAgent", "content_creator"]]);

  const latest = await saver.getTuple(config);
  assert.equal(latest?.checkpoint.channel_values.activeAgent, "style_curator");

  const listed = [];
  for await (const item of saver.list(config)) {
    listed.push(item);
  }
  assert.equal(listed.length, 1);
  assert.equal(listed[0].config.configurable?.checkpoint_id, "checkpoint-1");
});

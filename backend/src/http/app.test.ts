import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import { createTestOrchestrator } from "../test/helpers.js";

test("POST /generate queues generation.requested and events can be polled", async () => {
  const { orchestrator, storage, chain } = createTestOrchestrator();
  chain.setCredits("0x00000000000000000000000000000000000000c1", 2n);
  await storage.kvSet("style:1:profile", { tone: ["clear"] });
  const app = await buildApp({ orchestrator });

  const response = await app.inject({
    method: "POST",
    url: "/generate",
    payload: {
      walletAddress: "0x00000000000000000000000000000000000000c1",
      styleId: "1",
      prompt: "Write a launch post",
      platforms: ["x"]
    }
  });
  assert.equal(response.statusCode, 202);
  const body = response.json() as { requestId: string };

  await orchestrator.drain();
  const events = await app.inject({ method: "GET", url: `/events/${body.requestId}` });
  assert.equal(events.statusCode, 200);
  assert.equal(events.json().events.some((event: { type: string }) => event.type === "generation.requested"), true);
  assert.equal(events.json().events.some((event: { type: string }) => event.type === "generation.published"), true);

  await app.close();
});

test("admin routes report agent status", async () => {
  const { orchestrator } = createTestOrchestrator();
  const app = await buildApp({ orchestrator });

  const health = await app.inject({ method: "GET", url: "/admin/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, "ok");

  const agents = await app.inject({ method: "GET", url: "/admin/agents" });
  assert.equal(agents.statusCode, 200);
  assert.equal(agents.json().length, 3);

  await app.close();
});


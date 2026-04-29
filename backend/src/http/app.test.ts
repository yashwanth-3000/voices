import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { buildApp } from "./app.js";
import { createTestOrchestrator, longSample } from "../test/helpers.js";

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

test("style onboarding creates an AgentBrain-backed proof trail", async () => {
  const { orchestrator } = createTestOrchestrator();
  const app = await buildApp({ orchestrator });
  const wallet = Wallet.createRandom();
  const message = `I confirm these samples are my own writing, signed by ${wallet.address}`;
  const attestationSignature = await wallet.signMessage(message);

  const upload = await app.inject({
    method: "POST",
    url: "/styles/upload",
    payload: {
      walletAddress: wallet.address,
      samples: [longSample()],
      attestationMessage: message,
      attestationSignature,
      language: "en",
      genres: ["technical"]
    }
  });
  assert.equal(upload.statusCode, 202);
  const uploadBody = upload.json() as { requestId: string };
  await orchestrator.drain();

  const events = (await app.inject({ method: "GET", url: `/events/${uploadBody.requestId}` })).json().events as Array<{
    type: string;
    styleId?: string;
    payload: Record<string, unknown>;
  }>;
  const mintIntent = events.find((event) => event.type === "style.mint.intent.created");
  assert.ok(mintIntent);
  assert.equal(typeof mintIntent.payload.agentBrainRootHash, "string");
  assert.equal(typeof mintIntent.payload.agentBrainManifestHash, "string");
  assert.equal(typeof mintIntent.payload.keyHash, "string");
  const transactionIntent = mintIntent.payload.transactionIntent as { data?: unknown };
  assert.equal(typeof transactionIntent.data, "string");
  assert.equal((transactionIntent.data as string).includes(Buffer.from("server-side-demo-sealed-key").toString("hex")), false);

  const txHash = "0x0000000000000000000000000000000000000000000000000000000000000077";
  const confirm = await app.inject({
    method: "POST",
    url: "/styles/confirm-mint",
    payload: {
      requestId: uploadBody.requestId,
      walletAddress: wallet.address,
      pendingStyleId: mintIntent.styleId,
      tokenId: "7",
      txHash
    }
  });
  assert.equal(confirm.statusCode, 200);

  const proofResponse = await app.inject({ method: "GET", url: `/proof/${uploadBody.requestId}` });
  assert.equal(proofResponse.statusCode, 200);
  const proof = proofResponse.json() as {
    agent_brain: { manifest_root_hash?: string; key_hash?: string };
    chain: { mint_tx_hash?: string };
    evidence_links: Array<{ label: string; url: string }>;
  };
  assert.equal(typeof proof.agent_brain.manifest_root_hash, "string");
  assert.equal(typeof proof.agent_brain.key_hash, "string");
  assert.equal(proof.chain.mint_tx_hash, txHash);
  assert.equal(proof.evidence_links.some((link) => link.label === "AgentBrain manifest"), true);

  const htmlProof = await app.inject({
    method: "GET",
    url: `/proof/${uploadBody.requestId}`,
    headers: { accept: "text/html" }
  });
  assert.equal(htmlProof.statusCode, 200);
  assert.match(htmlProof.body, /Voices Proof Trail/);

  await app.close();
});

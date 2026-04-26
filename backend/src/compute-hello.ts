import { createRequire } from "node:module";
import { ethers } from "ethers";
import OpenAI from "openai";
import { normalizePrivateKey, optionalEnv, requiredEnv } from "./config.js";

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } = require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

const messages: ChatMessage[] = [
  { role: "system", content: "You are a concise assistant helping test a hackathon integration." },
  { role: "user", content: "Reply with one sentence confirming 0G Compute is reachable for voices." }
];

function normalizeDirectBaseUrl(serviceUrl: string): string {
  const trimmed = serviceUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/v1/proxy")) {
    return trimmed;
  }
  return `${trimmed}/v1/proxy`;
}

async function runDirectApiHello() {
  const serviceUrl = requiredEnv("OG_COMPUTE_SERVICE_URL");
  const model = requiredEnv("OG_COMPUTE_MODEL");
  const apiKey = requiredEnv("OG_COMPUTE_API_KEY");

  const client = new OpenAI({
    baseURL: normalizeDirectBaseUrl(serviceUrl),
    apiKey
  });

  const completion = await client.chat.completions.create({ model, messages });
  console.log("0G Compute direct API hello-world complete");
  console.log(completion.choices[0]?.message?.content || "(empty response)");
}

async function runBrokerHello() {
  const rpcUrl = optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai");
  const privateKey = normalizePrivateKey(requiredEnv("PRIVATE_KEY"));
  const providerAddress = requiredEnv("OG_COMPUTE_PROVIDER_ADDRESS");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const broker = await createZGComputeNetworkBroker(
    wallet as unknown as Parameters<typeof createZGComputeNetworkBroker>[0]
  );
  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const body = { model, messages };
  const headers = await broker.inference.getRequestHeaders(providerAddress, JSON.stringify(body));

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`0G Compute request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const chatId = response.headers.get("ZG-Res-Key") || response.headers.get("zg-res-key") || data.id || data.chatID;
  const verified = await broker.inference.processResponse(providerAddress, chatId, JSON.stringify(data.usage || {}));

  console.log("0G Compute broker hello-world complete");
  console.log(`Provider: ${providerAddress}`);
  console.log(`Model: ${model}`);
  console.log(`TEE response verified: ${verified ?? "skipped"}`);
  console.log(data.choices?.[0]?.message?.content || "(empty response)");
}

async function main() {
  if (process.env.OG_COMPUTE_API_KEY && process.env.OG_COMPUTE_SERVICE_URL && process.env.OG_COMPUTE_MODEL) {
    await runDirectApiHello();
    return;
  }

  await runBrokerHello();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

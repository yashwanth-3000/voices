import "./config.js";
import { createKeeperHubClient } from "./infra/keeperhub.js";

async function main() {
  const chainId = Number(process.env.KEEPERHUB_CHAIN_ID || process.env.OG_CHAIN_ID || 16602);
  const keeperhub = createKeeperHubClient();
  const support = await keeperhub.isChainSupported(chainId);

  console.log("KeeperHub chain support check");
  console.log(JSON.stringify({ chainId, ...support }, null, 2));

  if (!support.supported) {
    console.log("No transaction was attempted because the configured chain is not supported by KeeperHub.");
  } else if (!process.env.KEEPERHUB_API_KEY) {
    console.log("Set KEEPERHUB_API_KEY before attempting Direct Execution writes.");
  } else {
    console.log("KeeperHub API key is configured. Use the auto-refill path to execute a real contract call.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

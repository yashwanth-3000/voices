import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { decryptBytes, encryptBytes, resolveAesKey } from "./crypto.js";
import { normalizePrivateKey, optionalEnv, requiredEnv } from "./config.js";

type UploadResult =
  | { txHash: string; rootHash: string; txSeq: number }
  | { txHashes: string[]; rootHashes: string[]; txSeqs: number[] };

function rootHashFromUpload(result: UploadResult): string {
  if ("rootHash" in result) {
    return result.rootHash;
  }

  if (result.rootHashes.length !== 1) {
    throw new Error(`Expected one root hash for hello-world upload, got ${result.rootHashes.length}`);
  }

  return result.rootHashes[0];
}

async function downloadWithRetry(indexer: Indexer, rootHash: string): Promise<Uint8Array> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const [blob, err] = await indexer.downloadToBlob(rootHash, { proof: true });
    if (!err) {
      return new Uint8Array(await blob.arrayBuffer());
    }

    lastError = err;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }

  throw lastError || new Error("Download failed");
}

async function main() {
  const rpcUrl = optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai");
  const indexerUrl = optionalEnv("OG_STORAGE_INDEXER_RPC", "https://indexer-storage-testnet-turbo.0g.ai");
  const privateKey = normalizePrivateKey(requiredEnv("PRIVATE_KEY"));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const indexer = new Indexer(indexerUrl);

  const plaintext = Buffer.from(`Hello 0G Storage from voices at ${new Date().toISOString()}`, "utf8");
  const key = resolveAesKey(process.env.OG_STORAGE_ENCRYPTION_KEY);
  const encryptedPayload = encryptBytes(plaintext, key);
  const memData = new MemData(encryptedPayload);

  const [tree, treeErr] = await memData.merkleTree();
  if (treeErr || !tree) {
    throw new Error(`Merkle tree error: ${treeErr?.message || "unknown"}`);
  }

  const [tx, uploadErr] = await indexer.upload(
    memData,
    rpcUrl,
    signer as unknown as Parameters<Indexer["upload"]>[2]
  );
  if (uploadErr || !tx) {
    throw new Error(`Upload error: ${uploadErr?.message || "unknown"}`);
  }

  const rootHash = rootHashFromUpload(tx);
  const downloaded = await downloadWithRetry(indexer, rootHash);
  const decrypted = decryptBytes(downloaded, key);

  if (!decrypted.equals(plaintext)) {
    throw new Error("Downloaded payload decrypted, but did not match the original plaintext");
  }

  console.log("0G Storage hello-world complete");
  console.log(`Wallet: ${signer.address}`);
  console.log(`Root hash: ${rootHash}`);
  console.log(`Merkle root: ${tree.rootHash()}`);
  console.log(`Decrypted bytes: ${decrypted.toString("utf8")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

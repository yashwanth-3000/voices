import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Indexer, MemData, Batcher, KvClient, getFlowContract } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { decryptBytes, encryptBytes, resolveAesKey } from "../crypto.js";
import { normalizePrivateKey, optionalEnv, requiredEnv } from "../config.js";
import { AgentStorage } from "./types.js";

type LogEntry = { key: string; value: unknown };
type StorageCache = { kv?: Record<string, unknown>; logs?: Record<string, LogEntry[]> };

export class MemoryStorageClient implements AgentStorage {
  protected readonly kv = new Map<string, unknown>();
  protected readonly logs = new Map<string, LogEntry[]>();
  protected readonly blobs = new Map<string, Uint8Array>();

  async kvSet<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }

  async kvGet<T>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T | undefined) ?? null;
  }

  async kvDelete(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async logAppend<T>(streamId: string, key: string, value: T): Promise<void> {
    const entries = this.logs.get(streamId) ?? [];
    if (!entries.some((entry) => entry.key === key)) {
      entries.push({ key, value });
    }
    this.logs.set(streamId, entries);
  }

  async logScan<T>(streamId: string, prefix = "", after?: string): Promise<Array<{ key: string; value: T }>> {
    const entries = this.logs.get(streamId) ?? [];
    const startIndex = after ? entries.findIndex((entry) => entry.key === after) + 1 : 0;
    return entries
      .slice(Math.max(0, startIndex))
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => ({ key: entry.key, value: entry.value as T }));
  }

  async uploadEncrypted(bytes: Uint8Array, encryptionKey?: string): Promise<{ rootHash: string; txHash?: string }> {
    const key = resolveAesKey(encryptionKey);
    const encrypted = encryptBytes(bytes, key);
    const rootHash = `memory://${createHash("sha256").update(encrypted).digest("hex")}`;
    this.blobs.set(rootHash, encrypted);
    return { rootHash };
  }

  async downloadEncrypted(rootHash: string, encryptionKey?: string): Promise<Uint8Array> {
    const encrypted = this.blobs.get(rootHash);
    if (!encrypted) {
      throw new Error(`Missing encrypted blob: ${rootHash}`);
    }
    return decryptBytes(encrypted, resolveAesKey(encryptionKey));
  }
}

export class ZeroGStorageClient extends MemoryStorageClient {
  private readonly rpcUrl: string;
  private readonly indexerUrl: string;
  private readonly flowContractAddress: string;
  private readonly kvRpc?: string;
  private readonly signer: ethers.Wallet;
  private readonly indexer: Indexer;
  private readonly cachePath?: string;

  constructor() {
    super();
    this.rpcUrl = optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai");
    this.indexerUrl = optionalEnv("OG_STORAGE_INDEXER_RPC", "https://indexer-storage-testnet-turbo.0g.ai");
    this.flowContractAddress = requiredEnv("OG_STORAGE_FLOW_CONTRACT");
    this.kvRpc = process.env.OG_STORAGE_KV_RPC?.trim();
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.signer = new ethers.Wallet(normalizePrivateKey(requiredEnv("PRIVATE_KEY")), provider);
    this.indexer = new Indexer(this.indexerUrl);
    this.cachePath = process.env.AGENT_STORAGE_CACHE_PATH === "off"
      ? undefined
      : resolve(process.env.AGENT_STORAGE_CACHE_PATH?.trim() || ".voices-storage-cache.json");
    this.loadLocalCache();
  }

  override async kvSet<T>(key: string, value: T): Promise<void> {
    await super.kvSet(key, value);
    await this.writeKv("voices:kv", key, value);
    this.persistLocalCache();
  }

  override async kvGet<T>(key: string): Promise<T | null> {
    const cached = await super.kvGet<T>(key);
    if (cached) {
      return cached;
    }
    return this.kvReadThrough<T>(key);
  }

  override async logAppend<T>(streamId: string, key: string, value: T): Promise<void> {
    await super.logAppend(streamId, key, value);
    await this.writeKv(streamId, key, value);
    this.persistLocalCache();
  }

  override async uploadEncrypted(bytes: Uint8Array, encryptionKey?: string): Promise<{ rootHash: string; txHash?: string }> {
    const encrypted = encryptBytes(bytes, resolveAesKey(encryptionKey));
    const file = new MemData(encrypted);
    const [tx, err] = await this.indexer.upload(
      file,
      this.rpcUrl,
      this.signer as unknown as Parameters<Indexer["upload"]>[2]
    );
    if (err || !tx) {
      throw err ?? new Error("0G encrypted upload failed");
    }

    if ("rootHash" in tx) {
      return { rootHash: tx.rootHash, txHash: tx.txHash };
    }
    return { rootHash: tx.rootHashes[0], txHash: tx.txHashes[0] };
  }

  override async downloadEncrypted(rootHash: string, encryptionKey?: string): Promise<Uint8Array> {
    const [blob, err] = await this.indexer.downloadToBlob(rootHash, { proof: true });
    if (err) {
      throw err;
    }
    const encrypted = new Uint8Array(await blob.arrayBuffer());
    return decryptBytes(encrypted, resolveAesKey(encryptionKey));
  }

  async kvReadThrough<T>(key: string): Promise<T | null> {
    const cached = await super.kvGet<T>(key);
    if (cached || !this.kvRpc) {
      return cached;
    }
    const kv = new KvClient(this.kvRpc);
    const value = await kv.getValue(streamIdFor("voices:kv"), utf8Bytes(key));
    if (!value) {
      return null;
    }
    return JSON.parse(Buffer.from(value.data, "base64").toString("utf8")) as T;
  }

  private async writeKv<T>(streamId: string, key: string, value: T): Promise<void> {
    const [nodes, selectErr] = await this.indexer.selectNodes(1);
    if (selectErr) {
      throw selectErr;
    }
    const flow = getFlowContract(this.flowContractAddress, this.signer as unknown as Parameters<typeof getFlowContract>[1]);
    const batcher = new Batcher(1, nodes, flow, this.rpcUrl);
    batcher.streamDataBuilder.set(streamIdFor(streamId), utf8Bytes(key), utf8Bytes(JSON.stringify(value)));
    const [, err] = await batcher.exec();
    if (err) {
      throw err;
    }
  }

  private loadLocalCache(): void {
    if (!this.cachePath || !existsSync(this.cachePath)) {
      return;
    }
    const cache = JSON.parse(readFileSync(this.cachePath, "utf8")) as StorageCache;
    for (const [key, value] of Object.entries(cache.kv ?? {})) {
      this.kv.set(key, value);
    }
    for (const [streamId, entries] of Object.entries(cache.logs ?? {})) {
      this.logs.set(streamId, entries);
    }
  }

  private persistLocalCache(): void {
    if (!this.cachePath) {
      return;
    }
    const cache: StorageCache = {
      kv: Object.fromEntries(this.kv.entries()),
      logs: Object.fromEntries(this.logs.entries())
    };
    writeFileSync(this.cachePath, JSON.stringify(cache, null, 2));
  }
}

export function createStorageClient(): AgentStorage {
  return process.env.AGENT_STORAGE_MODE === "0g" ? new ZeroGStorageClient() : new MemoryStorageClient();
}

function streamIdFor(input: string): string {
  return ethers.id(input);
}

function utf8Bytes(input: string): Uint8Array {
  return Uint8Array.from(Buffer.from(input, "utf8"));
}

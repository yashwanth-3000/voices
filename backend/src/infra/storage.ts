import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Indexer, MemData, Batcher, KvClient, getFlowContract } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { decryptBytes, encryptBytes, resolveAesKey } from "../crypto.js";
import { normalizePrivateKey, optionalEnv, requiredEnv } from "../config.js";
import { AgentStorage } from "./types.js";

type LogEntry = { key: string; value: unknown };
type StorageCache = { kv?: Record<string, unknown>; logs?: Record<string, LogEntry[]> };
type PendingKvWrite = {
  streamId: string;
  key: string;
  value: unknown;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const DEFAULT_STORAGE_OPERATION_TIMEOUT_MS = 90_000;

export class MemoryStorageClient implements AgentStorage {
  protected readonly kv = new Map<string, unknown>();
  protected readonly logs = new Map<string, LogEntry[]>();
  protected readonly blobs = new Map<string, Uint8Array>();

  diagnostics(): Record<string, unknown> {
    return {
      backend: "memory",
      kvEntries: this.kv.size,
      logStreams: this.logs.size,
      logEntries: countLogEntries(this.logs)
    };
  }

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

  async uploadRaw(bytes: Uint8Array): Promise<{ rootHash: string; txHash?: string }> {
    const rootHash = `memory://${createHash("sha256").update(bytes).digest("hex")}`;
    this.blobs.set(rootHash, new Uint8Array(bytes));
    return { rootHash };
  }

  async downloadRaw(rootHash: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(rootHash);
    if (!bytes) {
      throw new Error(`Missing raw blob: ${rootHash}`);
    }
    return bytes;
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
  private readonly flushCheckpointsToZeroG: boolean;
  private readonly operationTimeoutMs: number;
  private storageTxQueue: Promise<void> = Promise.resolve();
  private kvFlushTimer?: ReturnType<typeof setTimeout>;
  private pendingKvWrites: PendingKvWrite[] = [];

  constructor() {
    super();
    this.rpcUrl = optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai");
    this.indexerUrl = optionalEnv("OG_STORAGE_INDEXER_RPC", "https://indexer-storage-testnet-turbo.0g.ai");
    this.flowContractAddress = requiredEnv("OG_STORAGE_FLOW_CONTRACT");
    this.kvRpc = process.env.OG_STORAGE_KV_RPC?.trim();
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.signer = new ethers.Wallet(normalizePrivateKey(requiredEnv("PRIVATE_KEY")), provider);
    this.indexer = new Indexer(this.indexerUrl);
    this.operationTimeoutMs = positiveIntegerEnv("OG_STORAGE_OPERATION_TIMEOUT_MS", DEFAULT_STORAGE_OPERATION_TIMEOUT_MS);
    this.cachePath = process.env.AGENT_STORAGE_CACHE_PATH === "off"
      ? undefined
      : resolve(process.env.AGENT_STORAGE_CACHE_PATH?.trim() || ".voices-storage-cache.json");
    this.flushCheckpointsToZeroG = process.env.AGENT_CHECKPOINT_FLUSH_MODE === "0g";
    this.seedLocalCache();
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
    return this.runStorageTransaction("encrypted upload", async () => {
      const encrypted = encryptBytes(bytes, resolveAesKey(encryptionKey));
      return this.uploadMemData(encrypted, "0G encrypted upload failed");
    });
  }

  override async uploadRaw(bytes: Uint8Array): Promise<{ rootHash: string; txHash?: string }> {
    return this.runStorageTransaction("raw upload", async () => this.uploadMemData(bytes, "0G raw upload failed"));
  }

  override async downloadRaw(rootHash: string): Promise<Uint8Array> {
    const [blob, err] = await this.indexer.downloadToBlob(rootHash, { proof: true });
    if (err) {
      throw err;
    }
    return new Uint8Array(await blob.arrayBuffer());
  }

  override async downloadEncrypted(rootHash: string, encryptionKey?: string): Promise<Uint8Array> {
    const [blob, err] = await this.indexer.downloadToBlob(rootHash, { proof: true });
    if (err) {
      throw err;
    }
    const encrypted = new Uint8Array(await blob.arrayBuffer());
    return decryptBytes(encrypted, resolveAesKey(encryptionKey));
  }

  override diagnostics(): Record<string, unknown> {
    const seedPath = process.env.AGENT_STORAGE_SEED_PATH?.trim();
    const resolvedSeedPath = seedPath ? resolve(seedPath) : undefined;
    const cacheExists = Boolean(this.cachePath && existsSync(this.cachePath));
    return {
      backend: "0g",
      kvRpcConfigured: Boolean(this.kvRpc),
      checkpointFlush: this.flushCheckpointsToZeroG ? "0g" : "local_cache",
      kvEntries: this.kv.size,
      logStreams: this.logs.size,
      logEntries: countLogEntries(this.logs),
      localCache: {
        enabled: Boolean(this.cachePath),
        path: this.cachePath,
        exists: cacheExists,
        bytes: cacheExists && this.cachePath ? fileSize(this.cachePath) : 0,
        seedPath: resolvedSeedPath,
        seedExists: Boolean(resolvedSeedPath && existsSync(resolvedSeedPath)),
        railwayVolumeMount: process.env.RAILWAY_VOLUME_MOUNT_PATH || undefined
      }
    };
  }

  private async uploadMemData(bytes: Uint8Array, failureMessage: string): Promise<{ rootHash: string; txHash?: string }> {
    const file = new MemData(bytes);
    const [tx, err] = await this.indexer.upload(
      file,
      this.rpcUrl,
      this.signer as unknown as Parameters<Indexer["upload"]>[2]
    );
    if (err || !tx) {
      throw err ?? new Error(failureMessage);
    }

    if ("rootHash" in tx) {
      return { rootHash: tx.rootHash, txHash: tx.txHash };
    }
    return { rootHash: tx.rootHashes[0], txHash: tx.txHashes[0] };
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
    if (isCheckpointWrite(streamId, key) && !this.flushCheckpointsToZeroG) {
      return;
    }

    const flush = this.enqueueKvWrite(streamId, key, value);
    if (isCheckpointWrite(streamId, key)) {
      flush.catch((error) => {
        console.warn(`0G Storage checkpoint flush failed for ${streamId}:${key}: ${errorMessage(error)}`);
      });
      return;
    }
    await flush;
  }

  private enqueueKvWrite(streamId: string, key: string, value: unknown): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.pendingKvWrites.push({ streamId, key, value, resolve, reject });
    });

    this.kvFlushTimer ??= setTimeout(() => {
      this.kvFlushTimer = undefined;
      void this.flushKvWrites();
    }, 100);

    return promise;
  }

  private async flushKvWrites(): Promise<void> {
    const writes = this.pendingKvWrites.splice(0);
    if (writes.length === 0) {
      return;
    }

    try {
      await this.runStorageTransaction(`kv/log batch (${writes.length} write${writes.length === 1 ? "" : "s"})`, async () => {
        await this.writeKvBatch(writes);
      });
      for (const write of writes) {
        write.resolve();
      }
    } catch (error) {
      for (const write of writes) {
        write.reject(error);
      }
    }
  }

  private async writeKvBatch(writes: PendingKvWrite[]): Promise<void> {
    const [nodes, selectErr] = await this.indexer.selectNodes(1);
    if (selectErr) {
      throw selectErr;
    }
    const flow = getFlowContract(this.flowContractAddress, this.signer as unknown as Parameters<typeof getFlowContract>[1]);
    const batcher = new Batcher(1, nodes, flow, this.rpcUrl);
    for (const write of writes) {
      batcher.streamDataBuilder.set(streamIdFor(write.streamId), utf8Bytes(write.key), utf8Bytes(JSON.stringify(write.value)));
    }
    const [, err] = await batcher.exec();
    if (err) {
      throw err;
    }
  }

  private async runStorageTransaction<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const task = this.storageTxQueue
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            return await withTimeout(
              operation(),
              this.operationTimeoutMs,
              `0G Storage ${label} timed out after ${formatDuration(this.operationTimeoutMs)}`
            );
          } catch (error) {
            if (attempt < 2 && isNonceContentionError(error)) {
              console.warn(`0G Storage ${label} hit nonce contention; retrying after pending tx settles.`);
              await sleep(4_000 * (attempt + 1));
              continue;
            }
            throw error;
          }
        }
        throw new Error(`0G Storage ${label} failed`);
      });

    this.storageTxQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
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

  private seedLocalCache(): void {
    const seedPath = process.env.AGENT_STORAGE_SEED_PATH?.trim();
    if (!this.cachePath || !seedPath || existsSync(this.cachePath)) {
      return;
    }
    const resolvedSeedPath = resolve(seedPath);
    if (!existsSync(resolvedSeedPath)) {
      return;
    }
    mkdirSync(dirname(this.cachePath), { recursive: true });
    copyFileSync(resolvedSeedPath, this.cachePath);
  }

  private persistLocalCache(): void {
    if (!this.cachePath) {
      return;
    }
    mkdirSync(dirname(this.cachePath), { recursive: true });
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

function isNonceContentionError(error: unknown): boolean {
  const record = error as { code?: string; shortMessage?: string; message?: string; info?: { error?: { message?: string } } };
  const text = [
    record.code,
    record.shortMessage,
    record.message,
    record.info?.error?.message
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("replacement") || text.includes("underpriced") || text.includes("nonce") || text.includes("already known");
}

function countLogEntries(logs: Map<string, LogEntry[]>): number {
  let count = 0;
  for (const entries of logs.values()) {
    count += entries.length;
  }
  return count;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isCheckpointWrite(streamId: string, key: string): boolean {
  return streamId.startsWith("lg:") || key.startsWith("lg:");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]?.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function formatDuration(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)}s` : `${ms}ms`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

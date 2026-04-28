import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
  ChannelVersions,
  PendingWrite,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId
} from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { AgentStorage } from "../../infra/types.js";

type SerializedPayload = {
  type: string;
  data: string;
};

type StoredCheckpoint = {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpoint: SerializedPayload;
  metadata: SerializedPayload;
  newVersions?: ChannelVersions;
};

type StoredWrite = {
  taskId: string;
  channel: string;
  value: SerializedPayload;
};

type StoredWrites = Record<string, StoredWrite>;

type ThreadIndex = Record<string, string[]>;

const CHECKPOINT_INDEX_KEY = "lg:threads:index";

export class ZeroGCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly storage: AgentStorage) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = getThreadId(config);
    const checkpointNs = getCheckpointNamespace(config);
    const requestedCheckpointId = getCheckpointId(config);
    const stored = requestedCheckpointId
      ? await this.getStoredCheckpoint(threadId, checkpointNs, requestedCheckpointId)
      : await this.storage.kvGet<StoredCheckpoint>(activeKey(threadId, checkpointNs));

    if (!stored) {
      return undefined;
    }

    const checkpoint = await this.deserialize<Checkpoint>(stored.checkpoint);
    const metadata = await this.deserialize<CheckpointMetadata>(stored.metadata);
    const pendingWrites = await this.getPendingWrites(threadId, checkpointNs, stored.checkpointId);
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          ...config.configurable,
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: stored.checkpointId
        }
      },
      checkpoint,
      metadata,
      pendingWrites
    };

    if (stored.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: stored.parentCheckpointId
        }
      };
    }

    return tuple;
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const threadIds = config.configurable?.thread_id
      ? [String(config.configurable.thread_id)]
      : Object.keys(await this.readThreadIndex());
    const configNs = config.configurable?.checkpoint_ns;
    const configCheckpointId = config.configurable?.checkpoint_id;
    let remaining = options.limit;

    for (const threadId of threadIds) {
      const namespaces = await this.namespacesForThread(threadId);
      for (const checkpointNs of namespaces) {
        if (configNs !== undefined && checkpointNs !== String(configNs)) {
          continue;
        }

        const stream = await this.storage.logScan<StoredCheckpoint>(historyStream(threadId, checkpointNs));
        const records = stream
          .map((entry) => entry.value)
          .filter((entry) => !configCheckpointId || entry.checkpointId === configCheckpointId)
          .filter((entry) => !options.before?.configurable?.checkpoint_id || entry.checkpointId < String(options.before.configurable.checkpoint_id))
          .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId));

        for (const stored of records) {
          const metadata = await this.deserialize<CheckpointMetadata>(stored.metadata);
          if (options.filter && !metadataMatches(metadata, options.filter)) {
            continue;
          }
          if (remaining !== undefined) {
            if (remaining <= 0) {
              return;
            }
            remaining -= 1;
          }
          const tuple = await this.storedToTuple(stored);
          yield tuple;
        }
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const threadId = getThreadId(config);
    const checkpointNs = getCheckpointNamespace(config);
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const stored: StoredCheckpoint = {
      threadId,
      checkpointNs,
      checkpointId: preparedCheckpoint.id,
      parentCheckpointId: config.configurable?.checkpoint_id ? String(config.configurable.checkpoint_id) : undefined,
      checkpoint: await this.serialize(preparedCheckpoint),
      metadata: await this.serialize(metadata),
      newVersions
    };

    await this.storage.kvSet(activeKey(threadId, checkpointNs), stored);
    await this.storage.logAppend(historyStream(threadId, checkpointNs), stored.checkpointId, stored);
    await this.addNamespaceToIndex(threadId, checkpointNs);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: stored.checkpointId
      }
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = getThreadId(config);
    const checkpointNs = getCheckpointNamespace(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (checkpointId === undefined) {
      throw new Error('Failed to put writes. Missing required "checkpoint_id" in config.configurable.');
    }

    const key = pendingKey(threadId, checkpointNs, String(checkpointId));
    const existing = (await this.storage.kvGet<StoredWrites>(key)) ?? {};

    for (const [index, [channel, value]] of writes.entries()) {
      const writeIndex = WRITES_IDX_MAP[String(channel)] ?? index;
      const innerKey = `${taskId},${writeIndex}`;
      if (writeIndex >= 0 && existing[innerKey]) {
        continue;
      }
      existing[innerKey] = {
        taskId,
        channel: String(channel),
        value: await this.serialize(value)
      };
    }

    await this.storage.kvSet(key, existing);
  }

  async deleteThread(threadId: string): Promise<void> {
    const index = await this.readThreadIndex();
    const namespaces = index[threadId] ?? [];
    for (const checkpointNs of namespaces) {
      await this.storage.kvDelete(activeKey(threadId, checkpointNs));
    }
    delete index[threadId];
    await this.storage.kvSet(CHECKPOINT_INDEX_KEY, index);
  }

  private async storedToTuple(stored: StoredCheckpoint): Promise<CheckpointTuple> {
    const checkpoint = await this.deserialize<Checkpoint>(stored.checkpoint);
    const metadata = await this.deserialize<CheckpointMetadata>(stored.metadata);
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: stored.threadId,
          checkpoint_ns: stored.checkpointNs,
          checkpoint_id: stored.checkpointId
        }
      },
      checkpoint,
      metadata,
      pendingWrites: await this.getPendingWrites(stored.threadId, stored.checkpointNs, stored.checkpointId)
    };
    if (stored.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: stored.threadId,
          checkpoint_ns: stored.checkpointNs,
          checkpoint_id: stored.parentCheckpointId
        }
      };
    }
    return tuple;
  }

  private async getStoredCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<StoredCheckpoint | null> {
    const entries = await this.storage.logScan<StoredCheckpoint>(historyStream(threadId, checkpointNs));
    return entries.find((entry) => entry.key === checkpointId || entry.value.checkpointId === checkpointId)?.value ?? null;
  }

  private async getPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<CheckpointPendingWrite[]> {
    const writes = (await this.storage.kvGet<StoredWrites>(pendingKey(threadId, checkpointNs, checkpointId))) ?? {};
    return Promise.all(
      Object.values(writes).map(async (write) => [
        write.taskId,
        write.channel,
        await this.deserialize(write.value)
      ])
    );
  }

  private async serialize(value: unknown): Promise<SerializedPayload> {
    const [type, data] = await this.serde.dumpsTyped(value);
    return { type, data: Buffer.from(data).toString("base64") };
  }

  private async deserialize<T>(payload: SerializedPayload): Promise<T> {
    return this.serde.loadsTyped(payload.type, Buffer.from(payload.data, "base64")) as Promise<T>;
  }

  private async readThreadIndex(): Promise<ThreadIndex> {
    return (await this.storage.kvGet<ThreadIndex>(CHECKPOINT_INDEX_KEY)) ?? {};
  }

  private async addNamespaceToIndex(threadId: string, checkpointNs: string): Promise<void> {
    const index = await this.readThreadIndex();
    const namespaces = new Set(index[threadId] ?? []);
    if (namespaces.has(checkpointNs)) {
      return;
    }
    namespaces.add(checkpointNs);
    index[threadId] = [...namespaces].sort();
    await this.storage.kvSet(CHECKPOINT_INDEX_KEY, index);
  }

  private async namespacesForThread(threadId: string): Promise<string[]> {
    return (await this.readThreadIndex())[threadId] ?? [""];
  }
}

function getThreadId(config: RunnableConfig): string {
  const threadId = config.configurable?.thread_id;
  if (threadId === undefined) {
    throw new Error('Missing required LangGraph "thread_id" in config.configurable.');
  }
  return String(threadId);
}

function getCheckpointNamespace(config: RunnableConfig): string {
  return String(config.configurable?.checkpoint_ns ?? "");
}

function activeKey(threadId: string, checkpointNs: string): string {
  return `lg:thread:${threadId}:ns:${checkpointNs}:active`;
}

function pendingKey(threadId: string, checkpointNs: string, checkpointId: string): string {
  return `lg:thread:${threadId}:ns:${checkpointNs}:pending:${checkpointId}`;
}

function historyStream(threadId: string, checkpointNs: string): string {
  return `lg:thread:${threadId}:ns:${checkpointNs}`;
}

function metadataMatches(metadata: CheckpointMetadata, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => (metadata as Record<string, unknown>)[key] === value);
}

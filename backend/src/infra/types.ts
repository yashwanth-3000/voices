import { AgentEvent } from "../events/types.js";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatResult = {
  content: string;
  chatId?: string;
  providerSig?: string;
  verified?: boolean | null;
  teeVerified?: boolean | null;
  providerAddress?: string;
  serviceUrl?: string;
  model?: string;
  computePath?: "mock" | "direct" | "broker" | "openai";
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
};

export type ChatOptions = {
  model?: string;
  maxRetries?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};

export type TransactionIntent = {
  to: string;
  data: string;
  value: string;
  description: string;
};

export type KeeperHubResult = {
  status: "confirmed" | "pending_keeperhub" | "failed";
  workflowId?: string;
  txHash?: string;
  reason?: string;
};

export type ReceiptVerification = {
  txHash: string;
  blockNumber?: number;
  events: Array<{
    contract: string;
    name: string;
    args: Record<string, string>;
  }>;
};

export type StyleInfo = {
  creator: string;
  royaltyWei: bigint;
  totalEarnings: bigint;
  sampleCount: number;
  listed: boolean;
  encryptedSamplesURI: string;
  profileURI: string;
  language: string;
  genres: string;
  attestationURI: string;
  metadataHash: string;
};

export type MintStyleInput = {
  tokenMetadataURI: string;
  encryptedSamplesURI: string;
  profileURI: string;
  metadataHash: string;
  sealedKey: string;
  royaltyWei: string;
  sampleCount: number;
  language: string;
  genres: string;
  attestationURI: string;
};

export interface AgentStorage {
  kvSet<T>(key: string, value: T): Promise<void>;
  kvGet<T>(key: string): Promise<T | null>;
  kvDelete(key: string): Promise<void>;
  logAppend<T>(streamId: string, key: string, value: T): Promise<void>;
  logScan<T>(streamId: string, prefix?: string, after?: string): Promise<Array<{ key: string; value: T }>>;
  uploadRaw(bytes: Uint8Array): Promise<{ rootHash: string; txHash?: string }>;
  downloadRaw(rootHash: string): Promise<Uint8Array>;
  uploadEncrypted(bytes: Uint8Array, encryptionKey?: string): Promise<{ rootHash: string; txHash?: string }>;
  downloadEncrypted(rootHash: string, encryptionKey?: string): Promise<Uint8Array>;
}

export interface AgentCompute {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  verifyResponse(content: string, chatId?: string): Promise<boolean | null>;
  ensureFunds(): Promise<void>;
}

export interface AgentChain {
  mintStyleIntent(input: MintStyleInput): TransactionIntent;
  buyCreditsIntent(amount: bigint): Promise<TransactionIntent>;
  spendCreditIntent(tokenId: string): TransactionIntent;
  verifyMintReceipt(txHash: string, expected: { tokenId: string; creator: string }): Promise<ReceiptVerification>;
  verifyCreditPurchaseReceipt(txHash: string, expected: { buyer: string; amount: string }): Promise<ReceiptVerification>;
  verifySettlementReceipt(txHash: string, expected: { consumer: string; tokenId: string }): Promise<ReceiptVerification>;
  creditPrice(): Promise<bigint>;
  credits(address: string): Promise<bigint>;
  styleOf(tokenId: string): Promise<StyleInfo>;
  creatorOf(tokenId: string): Promise<string>;
  royaltyOf(tokenId: string): Promise<bigint>;
}

export interface KeeperHubClient {
  executeTransaction(intent: TransactionIntent): Promise<KeeperHubResult>;
  pollWorkflow(workflowId: string): Promise<KeeperHubResult>;
}

export interface AgentRuntime {
  storage: AgentStorage;
  compute: AgentCompute;
  chain: AgentChain;
  keeperhub: KeeperHubClient;
  publish(event: AgentEvent): Promise<AgentEvent>;
}

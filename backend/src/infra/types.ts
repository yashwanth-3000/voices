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
  model?: string;
};

export type TransactionIntent = {
  to: string;
  data: string;
  value: string;
  description: string;
};

export type ContractCallInput = {
  contractAddress: string;
  network?: string;
  chainId?: number;
  functionName: string;
  functionArgs?: unknown[];
  abi?: string;
  value?: string;
  gasLimitMultiplier?: string;
  description: string;
};

export type KeeperHubResult = {
  status: "confirmed" | "pending_keeperhub" | "failed";
  workflowId?: string;
  txHash?: string;
  blockExplorerUrl?: string;
  reason?: string;
  raw?: unknown;
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

export type AutoRefillConfig = {
  maxBudget: bigint;
  spent: bigint;
  threshold: bigint;
  perRefill: bigint;
  enabled: boolean;
  supported: boolean;
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
  uploadEncrypted(bytes: Uint8Array, encryptionKey?: string): Promise<{ rootHash: string; txHash?: string }>;
  downloadEncrypted(rootHash: string, encryptionKey?: string): Promise<Uint8Array>;
}

export interface AgentCompute {
  chat(messages: ChatMessage[], options?: { model?: string; maxRetries?: number; maxTokens?: number }): Promise<ChatResult>;
  verifyResponse(content: string, chatId?: string): Promise<boolean | null>;
  ensureFunds(): Promise<void>;
}

export interface AgentChain {
  mintStyleIntent(input: MintStyleInput): TransactionIntent;
  buyCreditsIntent(amount: bigint): Promise<TransactionIntent>;
  setAutoRefillIntent(input: {
    consumerAddress: string;
    maxBudget: bigint;
    threshold: bigint;
    perRefill: bigint;
  }): Promise<TransactionIntent>;
  spendCreditIntent(tokenId: string): TransactionIntent;
  refillFromAllowanceCall(consumerAddress: string): ContractCallInput;
  creditPrice(): Promise<bigint>;
  credits(address: string): Promise<bigint>;
  autoRefillOf(address: string): Promise<AutoRefillConfig>;
  styleOf(tokenId: string): Promise<StyleInfo>;
  creatorOf(tokenId: string): Promise<string>;
  royaltyOf(tokenId: string): Promise<bigint>;
}

export interface KeeperHubClient {
  isChainSupported(chainId: number): Promise<{ supported: boolean; network?: string; supportedChains?: string[]; reason?: string }>;
  executeContractCall(input: ContractCallInput): Promise<KeeperHubResult>;
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

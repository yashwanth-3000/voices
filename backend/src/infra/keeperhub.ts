import { ContractCallInput, KeeperHubClient, KeeperHubResult, TransactionIntent } from "./types.js";

type KeeperHubChain = {
  chainId: number;
  name: string;
  chainType: string;
  isEnabled: boolean;
  isTestnet: boolean;
};

type KeeperHubStatusResponse = {
  executionId?: string;
  status?: string;
  transactionHash?: string;
  transactionLink?: string;
  error?: unknown;
  result?: unknown;
};

const DEFAULT_KEEPERHUB_API_URL = "https://app.keeperhub.com/api";
const DEFAULT_KEEPERHUB_CHAIN_ID = 16602;

export class KeeperHubRestClient implements KeeperHubClient {
  private readonly apiUrl = (process.env.KEEPERHUB_API_URL ?? DEFAULT_KEEPERHUB_API_URL).replace(/\/$/, "");
  private readonly apiKey = process.env.KEEPERHUB_API_KEY?.trim();
  private chainsCache?: { expiresAt: number; chains: KeeperHubChain[] };

  async isChainSupported(chainId: number): Promise<{
    supported: boolean;
    network?: string;
    supportedChains?: string[];
    reason?: string;
  }> {
    const chains = await this.listChains();
    const enabled = chains.filter((chain) => chain.isEnabled);
    const match = enabled.find((chain) => chain.chainId === chainId);
    const supportedChains = enabled.map((chain) => `${chain.chainId}:${chain.name}`);
    if (!match) {
      return {
        supported: false,
        supportedChains,
        reason: `KeeperHub does not currently list chain ${chainId}. Supported enabled chains: ${supportedChains.join(", ")}`
      };
    }
    return { supported: true, network: process.env.KEEPERHUB_NETWORK || networkSlug(match), supportedChains };
  }

  async executeContractCall(input: ContractCallInput): Promise<KeeperHubResult> {
    if (!this.apiKey) {
      return {
        status: "pending_keeperhub",
        reason: "KeeperHub API key is not configured. Set KEEPERHUB_API_KEY to execute autonomous calls.",
        workflowId: `keeperhub-not-configured:${input.functionName}`
      };
    }

    const chainId = input.chainId ?? Number(process.env.KEEPERHUB_CHAIN_ID || process.env.OG_CHAIN_ID || DEFAULT_KEEPERHUB_CHAIN_ID);
    const support = await this.isChainSupported(chainId);
    if (!support.supported) {
      return {
        status: "failed",
        reason: support.reason,
        raw: { supportedChains: support.supportedChains, chainId }
      };
    }

    const body = {
      contractAddress: input.contractAddress,
      network: input.network || support.network,
      functionName: input.functionName,
      functionArgs: JSON.stringify(input.functionArgs ?? []),
      abi: input.abi,
      value: input.value ?? "0",
      gasLimitMultiplier: input.gasLimitMultiplier ?? "1.2"
    };

    const response = await fetch(`${this.apiUrl}/execute/contract-call`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    const data = await parseKeeperHubJson(response);
    if (!response.ok) {
      return { status: "failed", reason: keeperHubError(response.status, data), raw: data };
    }

    if (data.status === "completed") {
      return await this.normalizeStatus(data.executionId ? await this.pollWorkflow(data.executionId) : data, data.executionId);
    }

    return {
      status: "pending_keeperhub",
      workflowId: data.executionId ?? data.id,
      reason: data.status ?? "submitted",
      raw: data
    };
  }

  async executeTransaction(intent: TransactionIntent): Promise<KeeperHubResult> {
    return {
      status: "pending_keeperhub",
      reason:
        "Raw transaction intents are intentionally user-signed in Voices. KeeperHub is used for permissionless agent calls such as CreditSystem.refillFromAllowance.",
      workflowId: `user-signed-intent:${Buffer.from(intent.description).toString("hex").slice(0, 16)}`,
      raw: intent
    };
  }

  async pollWorkflow(workflowId: string): Promise<KeeperHubResult> {
    if (!this.apiKey) {
      return {
        status: "pending_keeperhub",
        workflowId,
        reason: "KeeperHub API key is not configured"
      };
    }
    if (workflowId.startsWith("user-signed-intent:") || workflowId.startsWith("keeperhub-not-configured:")) {
      return { status: "pending_keeperhub", workflowId, reason: "No KeeperHub execution was created for this id" };
    }

    const response = await fetch(`${this.apiUrl}/execute/${workflowId}/status`, {
      headers: this.headers()
    });
    const data = await parseKeeperHubJson(response);
    if (!response.ok) {
      return { status: "failed", workflowId, reason: keeperHubError(response.status, data), raw: data };
    }
    return this.normalizeStatus(data, workflowId);
  }

  private normalizeStatus(data: KeeperHubStatusResponse, fallbackWorkflowId?: string): KeeperHubResult {
    const workflowId = data.executionId ?? fallbackWorkflowId;
    if (data.status === "completed") {
      return {
        status: "confirmed",
        workflowId,
        txHash: data.transactionHash,
        blockExplorerUrl: data.transactionLink,
        raw: data
      };
    }
    if (data.status === "failed") {
      return {
        status: "failed",
        workflowId,
        reason: typeof data.error === "string" ? data.error : JSON.stringify(data.error ?? "KeeperHub execution failed"),
        raw: data
      };
    }
    return { status: "pending_keeperhub", workflowId, reason: data.status ?? "pending", raw: data };
  }

  private async listChains(): Promise<KeeperHubChain[]> {
    if (this.chainsCache && this.chainsCache.expiresAt > Date.now()) {
      return this.chainsCache.chains;
    }
    const response = await fetch(`${this.apiUrl}/chains`, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined
    });
    const data = await parseKeeperHubJson(response);
    if (!response.ok) {
      throw new Error(keeperHubError(response.status, data));
    }
    const chains = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    this.chainsCache = { chains, expiresAt: Date.now() + 5 * 60_000 };
    return chains;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "X-API-Key": this.apiKey ?? ""
    };
  }
}

export function createKeeperHubClient(): KeeperHubClient {
  return new KeeperHubRestClient();
}

async function parseKeeperHubJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function keeperHubError(status: number, data: Record<string, any>): string {
  const message = data.message ?? data.error ?? data.details ?? JSON.stringify(data);
  return `KeeperHub ${status}: ${message}`;
}

function networkSlug(chain: KeeperHubChain): string {
  const known: Record<number, string> = {
    1: "ethereum",
    11155111: "sepolia",
    8453: "base",
    84532: "base-sepolia",
    137: "polygon",
    80002: "polygon-amoy",
    42161: "arbitrum",
    421614: "arbitrum-sepolia",
    56: "bnb",
    97: "bnb-testnet",
    43114: "avalanche",
    43113: "avalanche-fuji"
  };
  return known[chain.chainId] ?? chain.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

import { ethers } from "ethers";
import { optionalEnv } from "../config.js";
import { AgentChain, AutoRefillConfig, ContractCallInput, MintStyleInput, StyleInfo, TransactionIntent } from "./types.js";

const STYLE_REGISTRY_ABI = [
  "function mintStyle(string,string,string,bytes32,bytes,uint256,uint32,string,string,string) returns (uint256)",
  "function styleOf(uint256) view returns (tuple(address creator,uint256 royaltyWei,uint256 totalEarnings,uint32 sampleCount,bool listed,string encryptedSamplesURI,string profileURI,string language,string genres,string attestationURI,bytes32 metadataHash))",
  "function creatorOf(uint256) view returns (address)",
  "function royaltyOf(uint256) view returns (uint256)"
];

const CREDIT_SYSTEM_ABI = [
  "function buyCredits(uint256 amount) payable",
  "function spendCredit(uint256 tokenId)",
  "function setAutoRefill(uint256 maxBudget,uint256 threshold,uint256 perRefill) payable",
  "function refillFromAllowance(address consumer)",
  "function autoRefill(address consumer) view returns (uint256 maxBudget,uint256 spent,uint256 threshold,uint256 perRefill,bool enabled)",
  "function credits(address) view returns (uint256)",
  "function creditPriceWei() view returns (uint256)"
];

const CREDIT_SYSTEM_JSON_ABI = new ethers.Interface(CREDIT_SYSTEM_ABI).formatJson();

export class MockChainClient implements AgentChain {
  private readonly creditBalances = new Map<string, bigint>();
  private readonly styles = new Map<string, StyleInfo>();
  private readonly autoRefillConfigs = new Map<string, AutoRefillConfig>();

  constructor() {
    this.creditBalances.set("default", 10n);
  }

  setCredits(address: string, credits: bigint): void {
    this.creditBalances.set(address.toLowerCase(), credits);
  }

  setStyle(tokenId: string, style: StyleInfo): void {
    this.styles.set(tokenId, style);
  }

  setAutoRefill(address: string, config: AutoRefillConfig): void {
    this.autoRefillConfigs.set(address.toLowerCase(), config);
  }

  mintStyleIntent(input: MintStyleInput): TransactionIntent {
    return { to: "mock-style-registry", data: JSON.stringify(input), value: "0", description: "mintStyle" };
  }

  async buyCreditsIntent(amount: bigint): Promise<TransactionIntent> {
    return { to: "mock-credit-system", data: amount.toString(), value: "0", description: "buyCredits" };
  }

  async setAutoRefillIntent(input: {
    consumerAddress: string;
    maxBudget: bigint;
    threshold: bigint;
    perRefill: bigint;
  }): Promise<TransactionIntent> {
    const current = await this.autoRefillOf(input.consumerAddress);
    const value = input.maxBudget > current.maxBudget ? input.maxBudget - current.maxBudget : 0n;
    this.autoRefillConfigs.set(input.consumerAddress.toLowerCase(), {
      maxBudget: input.maxBudget,
      spent: current.spent,
      threshold: input.threshold,
      perRefill: input.perRefill,
      enabled: true,
      supported: true
    });
    return {
      to: "mock-credit-system",
      data: JSON.stringify({
        functionName: "setAutoRefill",
        consumerAddress: input.consumerAddress,
        maxBudget: input.maxBudget.toString(),
        threshold: input.threshold.toString(),
        perRefill: input.perRefill.toString()
      }),
      value: value.toString(),
      description: "CreditSystem.setAutoRefill"
    };
  }

  spendCreditIntent(tokenId: string): TransactionIntent {
    return { to: "mock-credit-system", data: tokenId, value: "0", description: "spendCredit" };
  }

  refillFromAllowanceCall(consumerAddress: string): ContractCallInput {
    return {
      contractAddress: "mock-credit-system",
      chainId: Number(process.env.OG_CHAIN_ID || 16602),
      functionName: "refillFromAllowance",
      functionArgs: [consumerAddress],
      abi: CREDIT_SYSTEM_JSON_ABI,
      value: "0",
      description: "CreditSystem.refillFromAllowance"
    };
  }

  async credits(address: string): Promise<bigint> {
    return this.creditBalances.get(address.toLowerCase()) ?? this.creditBalances.get("default") ?? 0n;
  }

  async creditPrice(): Promise<bigint> {
    return 1000000000000000n;
  }

  async autoRefillOf(address: string): Promise<AutoRefillConfig> {
    return (
      this.autoRefillConfigs.get(address.toLowerCase()) ?? {
        maxBudget: 0n,
        spent: 0n,
        threshold: 0n,
        perRefill: 0n,
        enabled: false,
        supported: true
      }
    );
  }

  async styleOf(tokenId: string): Promise<StyleInfo> {
    return this.styles.get(tokenId) ?? {
      creator: "0x0000000000000000000000000000000000000001",
      royaltyWei: 1000000000000000n,
      totalEarnings: 0n,
      sampleCount: 1,
      listed: true,
      encryptedSamplesURI: "",
      profileURI: `style:${tokenId}:profile`,
      language: "en",
      genres: "technical",
      attestationURI: "",
      metadataHash: ethers.ZeroHash
    };
  }

  async creatorOf(tokenId: string): Promise<string> {
    return (await this.styleOf(tokenId)).creator;
  }

  async royaltyOf(tokenId: string): Promise<bigint> {
    return (await this.styleOf(tokenId)).royaltyWei;
  }
}

export class EthersChainClient implements AgentChain {
  private readonly styleRegistry: ethers.Contract;
  private readonly creditSystem: ethers.Contract;
  private readonly styleInterface = new ethers.Interface(STYLE_REGISTRY_ABI);
  private readonly creditInterface = new ethers.Interface(CREDIT_SYSTEM_ABI);

  constructor() {
    const provider = new ethers.JsonRpcProvider(optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai"));
    this.styleRegistry = new ethers.Contract(requiredAddress("STYLE_REGISTRY_ADDRESS"), STYLE_REGISTRY_ABI, provider);
    this.creditSystem = new ethers.Contract(requiredAddress("CREDIT_SYSTEM_ADDRESS"), CREDIT_SYSTEM_ABI, provider);
  }

  mintStyleIntent(input: MintStyleInput): TransactionIntent {
    return {
      to: this.styleRegistry.target.toString(),
      data: this.styleInterface.encodeFunctionData("mintStyle", [
        input.tokenMetadataURI,
        input.encryptedSamplesURI,
        input.profileURI,
        input.metadataHash,
        input.sealedKey,
        input.royaltyWei,
        input.sampleCount,
        input.language,
        input.genres,
        input.attestationURI
      ]),
      value: "0",
      description: "StyleRegistry.mintStyle"
    };
  }

  async buyCreditsIntent(amount: bigint): Promise<TransactionIntent> {
    const creditPriceWei = await this.creditPrice();
    return {
      to: this.creditSystem.target.toString(),
      data: this.creditInterface.encodeFunctionData("buyCredits", [amount]),
      value: (creditPriceWei * amount).toString(),
      description: "CreditSystem.buyCredits"
    };
  }

  async setAutoRefillIntent(input: {
    consumerAddress: string;
    maxBudget: bigint;
    threshold: bigint;
    perRefill: bigint;
  }): Promise<TransactionIntent> {
    const current = await this.autoRefillOf(input.consumerAddress);
    if (!current.supported) {
      throw new Error("Current CreditSystem deployment does not support auto-refill. Redeploy the upgraded contract first.");
    }
    if (input.maxBudget < current.maxBudget) {
      throw new Error("Auto-refill budget cannot be decreased from the UI; disable and redeploy config if needed");
    }
    const newlyFunded = input.maxBudget - current.maxBudget;
    return {
      to: this.creditSystem.target.toString(),
      data: this.creditInterface.encodeFunctionData("setAutoRefill", [
        input.maxBudget,
        input.threshold,
        input.perRefill
      ]),
      value: newlyFunded.toString(),
      description: "CreditSystem.setAutoRefill"
    };
  }

  spendCreditIntent(tokenId: string): TransactionIntent {
    return {
      to: this.creditSystem.target.toString(),
      data: this.creditInterface.encodeFunctionData("spendCredit", [tokenId]),
      value: "0",
      description: "CreditSystem.spendCredit"
    };
  }

  refillFromAllowanceCall(consumerAddress: string): ContractCallInput {
    return {
      contractAddress: this.creditSystem.target.toString(),
      network: process.env.KEEPERHUB_NETWORK,
      chainId: Number(process.env.KEEPERHUB_CHAIN_ID || process.env.OG_CHAIN_ID || 16602),
      functionName: "refillFromAllowance",
      functionArgs: [consumerAddress],
      abi: CREDIT_SYSTEM_JSON_ABI,
      value: "0",
      gasLimitMultiplier: "1.2",
      description: "CreditSystem.refillFromAllowance"
    };
  }

  async credits(address: string): Promise<bigint> {
    return this.creditSystem.credits(address) as Promise<bigint>;
  }

  async creditPrice(): Promise<bigint> {
    return this.creditSystem.creditPriceWei() as Promise<bigint>;
  }

  async autoRefillOf(address: string): Promise<AutoRefillConfig> {
    try {
      const config = await this.creditSystem.autoRefill(address);
      return {
        maxBudget: config.maxBudget,
        spent: config.spent,
        threshold: config.threshold,
        perRefill: config.perRefill,
        enabled: config.enabled,
        supported: true
      };
    } catch {
      return {
        maxBudget: 0n,
        spent: 0n,
        threshold: 0n,
        perRefill: 0n,
        enabled: false,
        supported: false
      };
    }
  }

  async styleOf(tokenId: string): Promise<StyleInfo> {
    const style = await this.styleRegistry.styleOf(tokenId);
    return {
      creator: style.creator,
      royaltyWei: style.royaltyWei,
      totalEarnings: style.totalEarnings,
      sampleCount: Number(style.sampleCount),
      listed: style.listed,
      encryptedSamplesURI: style.encryptedSamplesURI,
      profileURI: style.profileURI,
      language: style.language,
      genres: style.genres,
      attestationURI: style.attestationURI,
      metadataHash: style.metadataHash
    };
  }

  async creatorOf(tokenId: string): Promise<string> {
    return this.styleRegistry.creatorOf(tokenId) as Promise<string>;
  }

  async royaltyOf(tokenId: string): Promise<bigint> {
    return this.styleRegistry.royaltyOf(tokenId) as Promise<bigint>;
  }
}

export function createChainClient(): AgentChain {
  return process.env.AGENT_CHAIN_MODE === "0g" || process.env.AGENT_CHAIN_MODE === "live"
    ? new EthersChainClient()
    : new MockChainClient();
}

function requiredAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required contract address: ${name}`);
  }
  return value;
}

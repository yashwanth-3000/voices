import { ethers } from "ethers";
import { optionalEnv } from "../config.js";
import { AgentChain, MintStyleInput, StyleInfo, TransactionIntent } from "./types.js";

const STYLE_REGISTRY_ABI = [
  "function mintStyle(string,string,string,bytes32,bytes,uint256,uint32,string,string,string) returns (uint256)",
  "function styleOf(uint256) view returns (tuple(address creator,uint256 royaltyWei,uint256 totalEarnings,uint32 sampleCount,bool listed,string encryptedSamplesURI,string profileURI,string language,string genres,string attestationURI,bytes32 metadataHash))",
  "function creatorOf(uint256) view returns (address)",
  "function royaltyOf(uint256) view returns (uint256)"
];

const CREDIT_SYSTEM_ABI = [
  "function buyCredits(uint256 amount) payable",
  "function spendCredit(uint256 tokenId)",
  "function credits(address) view returns (uint256)",
  "function creditPriceWei() view returns (uint256)"
];

export class MockChainClient implements AgentChain {
  private readonly creditBalances = new Map<string, bigint>();
  private readonly styles = new Map<string, StyleInfo>();

  constructor() {
    this.creditBalances.set("default", 10n);
  }

  setCredits(address: string, credits: bigint): void {
    this.creditBalances.set(address.toLowerCase(), credits);
  }

  setStyle(tokenId: string, style: StyleInfo): void {
    this.styles.set(tokenId, style);
  }

  mintStyleIntent(input: MintStyleInput): TransactionIntent {
    return { to: "mock-style-registry", data: JSON.stringify(input), value: "0", description: "mintStyle" };
  }

  async buyCreditsIntent(amount: bigint): Promise<TransactionIntent> {
    return { to: "mock-credit-system", data: amount.toString(), value: "0", description: "buyCredits" };
  }

  spendCreditIntent(tokenId: string): TransactionIntent {
    return { to: "mock-credit-system", data: tokenId, value: "0", description: "spendCredit" };
  }

  async credits(address: string): Promise<bigint> {
    return this.creditBalances.get(address.toLowerCase()) ?? this.creditBalances.get("default") ?? 0n;
  }

  async creditPrice(): Promise<bigint> {
    return 0n;
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

  spendCreditIntent(tokenId: string): TransactionIntent {
    return {
      to: this.creditSystem.target.toString(),
      data: this.creditInterface.encodeFunctionData("spendCredit", [tokenId]),
      value: "0",
      description: "CreditSystem.spendCredit"
    };
  }

  async credits(address: string): Promise<bigint> {
    return this.creditSystem.credits(address) as Promise<bigint>;
  }

  async creditPrice(): Promise<bigint> {
    return this.creditSystem.creditPriceWei() as Promise<bigint>;
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

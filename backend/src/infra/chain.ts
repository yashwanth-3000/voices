import { ethers } from "ethers";
import { optionalEnv } from "../config.js";
import { AgentChain, MintStyleInput, ReceiptVerification, StyleInfo, TransactionIntent } from "./types.js";

const STYLE_REGISTRY_ABI = [
  "event StyleMinted(uint256 indexed tokenId,address indexed creator,uint256 royaltyWei,string encryptedSamplesURI,bytes32 metadataHash)",
  "function mintStyle(string,string,string,bytes32,bytes,uint256,uint32,string,string,string) returns (uint256)",
  "function styleOf(uint256) view returns (tuple(address creator,uint256 royaltyWei,uint256 totalEarnings,uint32 sampleCount,bool listed,string encryptedSamplesURI,string profileURI,string language,string genres,string attestationURI,bytes32 metadataHash))",
  "function creatorOf(uint256) view returns (address)",
  "function royaltyOf(uint256) view returns (uint256)"
];

const CREDIT_SYSTEM_ABI = [
  "event CreditsPurchased(address indexed buyer,uint256 credits,uint256 paid)",
  "event CreditSpent(address indexed user,uint256 indexed tokenId,address indexed creator,uint256 royaltyWei)",
  "function buyCredits(uint256 amount) payable",
  "function spendCredit(uint256 tokenId)",
  "function credits(address) view returns (uint256)",
  "function creditPriceWei() view returns (uint256)"
];

const ROYALTY_VAULT_ABI = [
  "event RoyaltyDeposited(address indexed creator,uint256 indexed tokenId,address indexed payer,uint256 amount)"
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

  async verifyMintReceipt(txHash: string, expected: { tokenId: string; creator: string }): Promise<ReceiptVerification> {
    return mockVerification(txHash, "StyleRegistry", "StyleMinted", expected);
  }

  async verifyCreditPurchaseReceipt(txHash: string, expected: { buyer: string; amount: string }): Promise<ReceiptVerification> {
    return mockVerification(txHash, "CreditSystem", "CreditsPurchased", {
      buyer: expected.buyer,
      credits: expected.amount
    });
  }

  async verifySettlementReceipt(txHash: string, expected: { consumer: string; tokenId: string }): Promise<ReceiptVerification> {
    return {
      txHash,
      events: [
        {
          contract: "CreditSystem",
          name: "CreditSpent",
          args: {
            user: expected.consumer,
            tokenId: expected.tokenId,
            creator: "0x0000000000000000000000000000000000000001",
            royaltyWei: "0"
          }
        },
        {
          contract: "RoyaltyVault",
          name: "RoyaltyDeposited",
          args: {
            creator: "0x0000000000000000000000000000000000000001",
            payer: "mock-credit-system",
            tokenId: expected.tokenId,
            amount: "0"
          }
        }
      ]
    };
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
  private readonly provider: ethers.JsonRpcProvider;
  private readonly styleRegistry: ethers.Contract;
  private readonly creditSystem: ethers.Contract;
  private readonly styleInterface = new ethers.Interface(STYLE_REGISTRY_ABI);
  private readonly creditInterface = new ethers.Interface(CREDIT_SYSTEM_ABI);
  private readonly royaltyInterface = new ethers.Interface(ROYALTY_VAULT_ABI);

  constructor() {
    this.provider = new ethers.JsonRpcProvider(optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai"));
    this.styleRegistry = new ethers.Contract(requiredAddress("STYLE_REGISTRY_ADDRESS"), STYLE_REGISTRY_ABI, this.provider);
    this.creditSystem = new ethers.Contract(requiredAddress("CREDIT_SYSTEM_ADDRESS"), CREDIT_SYSTEM_ABI, this.provider);
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

  async verifyMintReceipt(txHash: string, expected: { tokenId: string; creator: string }): Promise<ReceiptVerification> {
    const receipt = await this.requireSuccessfulReceipt(txHash);
    const events = this.parseKnownEvents(receipt);
    const mint = events.find((event) => event.name === "StyleMinted");
    if (!mint) {
      throw new Error("Mint receipt did not include StyleMinted");
    }
    if (mint.args.tokenId !== BigInt(expected.tokenId).toString()) {
      throw new Error(`Mint receipt tokenId mismatch: expected ${expected.tokenId}, got ${mint.args.tokenId}`);
    }
    if (mint.args.creator.toLowerCase() !== expected.creator.toLowerCase()) {
      throw new Error(`Mint receipt creator mismatch: expected ${expected.creator}, got ${mint.args.creator}`);
    }
    return { txHash, blockNumber: receipt.blockNumber, events };
  }

  async verifyCreditPurchaseReceipt(txHash: string, expected: { buyer: string; amount: string }): Promise<ReceiptVerification> {
    const receipt = await this.requireSuccessfulReceipt(txHash);
    const events = this.parseKnownEvents(receipt);
    const purchase = events.find((event) => event.name === "CreditsPurchased");
    if (!purchase) {
      throw new Error("Credit purchase receipt did not include CreditsPurchased");
    }
    if (purchase.args.buyer.toLowerCase() !== expected.buyer.toLowerCase()) {
      throw new Error(`Credit purchase buyer mismatch: expected ${expected.buyer}, got ${purchase.args.buyer}`);
    }
    if (purchase.args.credits !== BigInt(expected.amount).toString()) {
      throw new Error(`Credit purchase amount mismatch: expected ${expected.amount}, got ${purchase.args.credits}`);
    }
    return { txHash, blockNumber: receipt.blockNumber, events };
  }

  async verifySettlementReceipt(txHash: string, expected: { consumer: string; tokenId: string }): Promise<ReceiptVerification> {
    const receipt = await this.requireSuccessfulReceipt(txHash);
    const events = this.parseKnownEvents(receipt);
    const spent = events.find((event) => event.name === "CreditSpent");
    const royalty = events.find((event) => event.name === "RoyaltyDeposited");
    if (!spent) {
      throw new Error("Settlement receipt did not include CreditSpent");
    }
    if (!royalty) {
      throw new Error("Settlement receipt did not include RoyaltyDeposited");
    }
    if (spent.args.user.toLowerCase() !== expected.consumer.toLowerCase()) {
      throw new Error(`Settlement consumer mismatch: expected ${expected.consumer}, got ${spent.args.user}`);
    }
    if (spent.args.tokenId !== BigInt(expected.tokenId).toString()) {
      throw new Error(`Settlement tokenId mismatch: expected ${expected.tokenId}, got ${spent.args.tokenId}`);
    }
    if (royalty.args.tokenId !== BigInt(expected.tokenId).toString()) {
      throw new Error(`Royalty tokenId mismatch: expected ${expected.tokenId}, got ${royalty.args.tokenId}`);
    }
    if (royalty.args.creator.toLowerCase() !== spent.args.creator.toLowerCase()) {
      throw new Error(`Royalty creator mismatch: expected ${spent.args.creator}, got ${royalty.args.creator}`);
    }
    if (royalty.args.amount !== spent.args.royaltyWei) {
      throw new Error(`Royalty amount mismatch: expected ${spent.args.royaltyWei}, got ${royalty.args.amount}`);
    }
    const expectedRoyaltyCaller = this.creditSystem.target.toString().toLowerCase();
    if (royalty.args.payer.toLowerCase() !== expectedRoyaltyCaller) {
      throw new Error(`Royalty payer mismatch: expected CreditSystem ${this.creditSystem.target.toString()}, got ${royalty.args.payer}`);
    }
    return { txHash, blockNumber: receipt.blockNumber, events };
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

  private async requireSuccessfulReceipt(txHash: string): Promise<ethers.TransactionReceipt> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(`Transaction receipt not found: ${txHash}`);
    }
    if (receipt.status !== 1) {
      throw new Error(`Transaction failed: ${txHash}`);
    }
    return receipt;
  }

  private parseKnownEvents(receipt: ethers.TransactionReceipt): ReceiptVerification["events"] {
    const contracts = [
      { address: this.styleRegistry.target.toString().toLowerCase(), name: "StyleRegistry", iface: this.styleInterface },
      { address: this.creditSystem.target.toString().toLowerCase(), name: "CreditSystem", iface: this.creditInterface },
      { address: requiredAddress("ROYALTY_VAULT_ADDRESS").toLowerCase(), name: "RoyaltyVault", iface: this.royaltyInterface }
    ];
    const events: ReceiptVerification["events"] = [];
    for (const log of receipt.logs) {
      const candidate = contracts.find((contract) => contract.address === log.address.toLowerCase());
      if (!candidate) {
        continue;
      }
      try {
        const parsed = candidate.iface.parseLog(log);
        if (!parsed) {
          continue;
        }
        events.push({
          contract: candidate.name,
          name: parsed.name,
          args: Object.fromEntries(
            parsed.fragment.inputs.map((input, index) => [input.name || String(index), stringifyArg(parsed.args[index])])
          )
        });
      } catch {
        continue;
      }
    }
    return events;
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

function mockVerification(
  txHash: string,
  contract: string,
  name: string,
  args: Record<string, string>
): ReceiptVerification {
  return {
    txHash,
    events: [{ contract, name, args }]
  };
}

function stringifyArg(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

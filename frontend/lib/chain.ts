export const OG_CHAIN_ID = 16602;
export const OG_CHAIN_ID_HEX = "0x40DA";

export const OG_NETWORK = {
  chainId: OG_CHAIN_ID_HEX,
  chainName: "0G Galileo",
  nativeCurrency: { name: "0G", symbol: "OG", decimals: 18 },
  rpcUrls: ["https://evmrpc-testnet.0g.ai"],
  blockExplorerUrls: ["https://chainscan-galileo.0g.ai"],
} as const;

export const CREDIT_SYSTEM_ADDRESS = "0x3e005e11E5420fD7D720F66455B4d303f3Ae4c58";

export const CREDIT_SYSTEM_ABI = [
  "function credits(address account) view returns (uint256)",
  "function creditPriceWei() view returns (uint256)",
] as const;

export const OG_CHAIN_ID = 16602;
export const OG_CHAIN_ID_HEX = "0x40DA";

export const OG_NETWORK = {
  chainId: OG_CHAIN_ID_HEX,
  chainName: "0G Galileo",
  nativeCurrency: { name: "0G", symbol: "OG", decimals: 18 },
  rpcUrls: ["https://evmrpc-testnet.0g.ai"],
  blockExplorerUrls: ["https://chainscan-galileo.0g.ai"],
} as const;

export const STYLE_REGISTRY_ADDRESS = "0x74b904E4097eEE8233a2202e549983F6598Ea5BD";
export const CREDIT_SYSTEM_ADDRESS = "0x3e005e11E5420fD7D720F66455B4d303f3Ae4c58";
export const ROYALTY_VAULT_ADDRESS = "0x977254e51EDec8e8840f11F3d30d3a752EED4933";

export const OG_EXPLORER_URL = "https://chainscan-galileo.0g.ai";

export const CREDIT_SYSTEM_ABI = [
  "function credits(address account) view returns (uint256)",
  "function creditPriceWei() view returns (uint256)",
] as const;

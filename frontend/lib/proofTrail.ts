import {
  CREDIT_SYSTEM_ADDRESS,
  OG_EXPLORER_URL,
  ROYALTY_VAULT_ADDRESS,
  STYLE_REGISTRY_ADDRESS
} from "./chain";

export const CONTRACTS = [
  { label: "StyleRegistry", address: STYLE_REGISTRY_ADDRESS },
  { label: "CreditSystem", address: CREDIT_SYSTEM_ADDRESS },
  { label: "RoyaltyVault", address: ROYALTY_VAULT_ADDRESS }
] as const;

export function explorerAddressUrl(address: string) {
  return `${OG_EXPLORER_URL}/address/${address}`;
}

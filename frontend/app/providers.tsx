"use client";

import { WalletProvider } from "../context/WalletContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ethers } from "ethers";
import {
  CREDIT_SYSTEM_ABI,
  CREDIT_SYSTEM_ADDRESS,
  OG_CHAIN_ID,
  OG_CHAIN_ID_HEX,
  OG_NETWORK,
} from "../lib/chain";

const { Contract, JsonRpcProvider, formatEther } = ethers;

// ─── EIP-6963 types ───────────────────────────────────────────────────────────
export interface EIP1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

export interface DetectedWallet {
  rdns: string;   // e.g. "io.metamask", "app.phantom"
  name: string;
  icon: string;   // data: URI
  provider: EIP1193Provider;
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isMetaMask?: boolean };
    phantom?: { ethereum?: EIP1193Provider };
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<{
      info: { rdns: string; uuid: string; name: string; icon: string };
      provider: EIP1193Provider;
    }>;
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
const ADDR_KEY  = "voices.wallet.addr.v2";
const CHAIN_KEY = "voices.wallet.chain.v2";
const RDNS_KEY  = "voices.wallet.rdns.v2";

const ls = {
  addr:  () => { try { return typeof window !== "undefined" ? localStorage.getItem(ADDR_KEY)  : null; } catch { return null; } },
  chain: () => { try { const v = parseInt(typeof window !== "undefined" ? localStorage.getItem(CHAIN_KEY) ?? "" : "", 10); return isNaN(v) ? null : v; } catch { return null; } },
  rdns:  () => { try { return typeof window !== "undefined" ? localStorage.getItem(RDNS_KEY)  : null; } catch { return null; } },
  save: (addr: string, cid: number, rdns: string) => {
    try { localStorage.setItem(ADDR_KEY, addr); localStorage.setItem(CHAIN_KEY, String(cid)); localStorage.setItem(RDNS_KEY, rdns); } catch {}
  },
  clear: () => { try { [ADDR_KEY, CHAIN_KEY, RDNS_KEY].forEach(k => localStorage.removeItem(k)); } catch {} },
};

// ─── Context type ─────────────────────────────────────────────────────────────
export type WalletState = {
  address: string | null;
  balance: string | null;
  credits: number | null;
  chainId: number | null;
  connectedWalletName: string | null;
  isOnCorrectNetwork: boolean;
  isInitializing: boolean;
  isConnecting: boolean;
  error: string | null;
  availableWallets: DetectedWallet[];
  connect: (wallet: DetectedWallet) => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

// ─── 0G RPC helpers ───────────────────────────────────────────────────────────
const OG_RPC = "https://evmrpc-testnet.0g.ai";

function firstAccount(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const account = raw.find((item): item is string => typeof item === "string" && item.length > 0);
  return account ?? null;
}

async function fetchBalance(addr: string): Promise<string | null> {
  try { return parseFloat(formatEther(await new JsonRpcProvider(OG_RPC).getBalance(addr))).toFixed(4); }
  catch { return null; }
}

async function fetchCredits(addr: string): Promise<number | null> {
  try { return Number(await new Contract(CREDIT_SYSTEM_ADDRESS, CREDIT_SYSTEM_ABI, new JsonRpcProvider(OG_RPC)).credits(addr) as bigint); }
  catch { return null; }
}

// ─── Provider helpers ─────────────────────────────────────────────────────────
async function getChainId(p: EIP1193Provider): Promise<number | null> {
  try { return parseInt(await p.request({ method: "eth_chainId" }) as string, 16); }
  catch { return null; }
}

async function switchToOg(p: EIP1193Provider): Promise<void> {
  if (await getChainId(p) === OG_CHAIN_ID) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: OG_CHAIN_ID_HEX }] });
  } catch (e: unknown) {
    if ((e as { code?: number }).code === 4902)
      await p.request({ method: "wallet_addEthereumChain", params: [OG_NETWORK] });
    else throw e;
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────
export function WalletProvider({ children }: { children: React.ReactNode }) {
  // Start null on both server and client to avoid SSR/hydration mismatch.
  // localStorage is read in useEffect (client-only) after hydration.
  const [address,  setAddress]  = useState<string | null>(null);
  const [chainId,  setChainId]  = useState<number | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [balance,  setBalance]  = useState<string | null>(null);
  const [credits,  setCredits]  = useState<number | null>(null);
  const [connectedWalletName, setConnectedWalletName] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<DetectedWallet[]>([]);

  // Active provider ref — set on connect, used for switchNetwork
  const activeProvider = useRef<EIP1193Provider | null>(null);

  const isOnCorrectNetwork = chainId === null ? true : chainId === OG_CHAIN_ID;

  // ── Restore from localStorage after hydration ─────────────────────────────
  useEffect(() => {
    const addr = ls.addr();
    const cid  = ls.chain();
    if (addr) setAddress(addr);
    if (cid)  setChainId(cid);
    setIsInitializing(false);
  }, []);

  // ── EIP-6963 wallet discovery — purely passive, no popups ──────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    const seen = new Map<string, DetectedWallet>();

    function onAnnounce(e: CustomEvent<{
      info: { rdns: string; uuid: string; name: string; icon: string };
      provider: EIP1193Provider;
    }>) {
      const { info, provider } = e.detail;
      seen.set(info.rdns, { rdns: info.rdns, name: info.name, icon: info.icon, provider });
      setAvailableWallets([...seen.values()]);

      // Restore active provider if this is the last-used wallet
      if (info.rdns === ls.rdns() && !activeProvider.current) {
        activeProvider.current = provider;
        setConnectedWalletName(info.name);
      }
    }

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    // Ask wallets to announce themselves
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // Fallback: older wallets that don't support EIP-6963
    setTimeout(() => {
      if (seen.size === 0 && window.ethereum) {
        const name = window.ethereum.isMetaMask ? "MetaMask" : "Browser Wallet";
        const fallback: DetectedWallet = {
          rdns: "injected",
          name,
          icon: "",
          provider: window.ethereum,
        };
        seen.set("injected", fallback);
        setAvailableWallets([...seen.values()]);
        if (!activeProvider.current) {
          activeProvider.current = window.ethereum;
          setConnectedWalletName(fallback.name);
        }
      }
    }, 100);

    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  // ── Balance / credits — fetched from 0G RPC, no MetaMask needed ────────────
  useEffect(() => {
    if (!address) { setBalance(null); setCredits(null); return; }
    let live = true;
    fetchBalance(address).then(b => { if (live && b !== null) setBalance(b); });
    fetchCredits(address).then(c => { if (live && c !== null) setCredits(c); });
    return () => { live = false; };
  }, [address]);

  // ── Passive MetaMask event listeners — no request calls ────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const eth = window.ethereum;
    const rdns = ls.rdns() ?? "injected";

    function onAccountsChanged(raw: unknown) {
      const account = firstAccount(raw);
      if (!account) {
        setAddress(null);
        setBalance(null);
        setCredits(null);
        setChainId(null);
        setConnectedWalletName(null);
        ls.clear();
        return;
      }
      setAddress(account);
      void getChainId(eth).then((cid) => {
        const nextChainId = cid ?? OG_CHAIN_ID;
        setChainId(nextChainId);
        ls.save(account, nextChainId, rdns);
      });
    }
    function onChainChanged(hex: unknown) {
      const cid = parseInt(hex as string, 16);
      setChainId(cid);
      const currentAddress = address ?? ls.addr();
      if (currentAddress) ls.save(currentAddress, cid, rdns);
    }

    eth.on("accountsChanged", onAccountsChanged);
    eth.on("chainChanged",    onChainChanged);
    return () => {
      eth.removeListener("accountsChanged", onAccountsChanged);
      eth.removeListener("chainChanged",    onChainChanged);
    };
  }, [address]);

  // ── Connect — the only place we call wallet.request() ──────────────────────
  const connect = useCallback(async (wallet: DetectedWallet) => {
    setIsConnecting(true);
    setError(null);
    try {
      const accs = (await wallet.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accs.length) { setError("No accounts returned."); return; }

      await switchToOg(wallet.provider);

      const addr = accs[0];
      const cid  = await getChainId(wallet.provider) ?? OG_CHAIN_ID;

      activeProvider.current = wallet.provider;
      setAddress(addr);
      setChainId(cid);
      setConnectedWalletName(wallet.name);
      ls.save(addr, cid, wallet.rdns);
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string };
      setError(err.code === 4001
        ? "Connection rejected — please approve in your wallet."
        : (err.message ?? "Failed to connect."));
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null); setBalance(null); setCredits(null);
    setChainId(null); setError(null); setConnectedWalletName(null);
    activeProvider.current = null;
    ls.clear();
  }, []);

  const switchNetwork = useCallback(async () => {
    const p = activeProvider.current ?? window.ethereum;
    if (!p) return;
    setError(null);
    try {
      await switchToOg(p);
      const cid = await getChainId(p);
      if (cid !== null) { setChainId(cid); localStorage.setItem(CHAIN_KEY, String(cid)); }
    } catch (e: unknown) {
      setError((e as { message?: string }).message ?? "Failed to switch network.");
    }
  }, []);

  return (
    <WalletContext.Provider value={{
      address, balance, credits, chainId, connectedWalletName,
      isOnCorrectNetwork, isInitializing, isConnecting, error, availableWallets,
      connect, disconnect, switchNetwork,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

function GitHubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.21.09 1.85 1.25 1.85 1.25 1.07 1.83 2.82 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02.01 2.05.14 3.01.4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.23v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

const WALLET_KEY = "voices.wallet.v1";

type WalletStore = {
  address: string;
  balance0g: string;
  credits: number;
};

function readWalletState(): WalletStore | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as
      | { address?: string; balance0g?: string; credits?: number }
      | null;
    if (!parsed?.address) return null;
    return {
      address: parsed.address,
      balance0g: typeof parsed.balance0g === "string" ? parsed.balance0g : "0.42",
      credits: typeof parsed.credits === "number" ? parsed.credits : 12,
    };
  } catch {
    return null;
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function avatarFromAddress(address: string) {
  let hash = 0;
  for (let i = 0; i < address.length; i++) hash = (hash * 31 + address.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 72%, 58%)`;
}

export function Navbar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [wallet, setWallet] = useState<WalletStore | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setWallet(readWalletState());
  }, []);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === WALLET_KEY) setWallet(readWalletState());
    }
    function onClickOutside(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("storage", onStorage);
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  const returnTo = useMemo(() => {
    const qs = searchParams?.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }, [pathname, searchParams]);

  function copyAddress() {
    if (!wallet?.address) return;
    navigator.clipboard.writeText(wallet.address).catch(() => {});
  }

  function disconnect() {
    localStorage.removeItem(WALLET_KEY);
    setWallet(null);
    setOpen(false);
  }

  return (
    <header className="topbar">
      <nav className="topbarInner" aria-label="Primary">
        <a className="navBrand" href="/" aria-label="Go to home">
          Voices
        </a>

        <div className="navLinks hideMobile" aria-label="Primary links">
          <a href="/styles">Styles</a>
          <a href="/wallet">Upload</a>
          <a href="/#creators">Creators</a>
          <a href="/#how">About</a>
        </div>

        <span className="navDivider hideMobile" aria-hidden="true" />
        <a
          className="navIconLink hideMobile"
          href="https://github.com/yashwanth-3000/voices"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
        >
          <GitHubIcon />
        </a>
        <span className="navDivider hideMobile" aria-hidden="true" />

        <div className="navWalletArea" ref={menuRef}>
          {!wallet ? (
            <a
              className="btn btnDark navWalletConnectBtn"
              href={`/wallet?returnTo=${encodeURIComponent(returnTo)}`}
              aria-label="Connect wallet"
            >
              Connect Wallet
            </a>
          ) : (
            <>
              <button
                type="button"
                className="navWalletChip"
                aria-label="Open wallet menu"
                onClick={() => setOpen((v) => !v)}
              >
                <span
                  className="navWalletAvatar"
                  style={{ background: avatarFromAddress(wallet.address) }}
                  aria-hidden="true"
                />
                <span className="navWalletAddress">{shortAddress(wallet.address)}</span>
              </button>

              <div className={`navWalletMenu ${open ? "navWalletMenuOpen" : ""}`}>
                <div className="navWalletMenuHead">
                  <div className="navWalletMenuLabel">Wallet</div>
                  <button type="button" className="navWalletCopyBtn" onClick={copyAddress}>
                    Copy
                  </button>
                </div>
                <div className="navWalletFullAddress">{wallet.address}</div>

                <div className="navWalletBalances">
                  <div className="navWalletBalanceRow">
                    <span>0G balance</span>
                    <strong>{wallet.balance0g} 0G</strong>
                  </div>
                  <div className="navWalletBalanceRow">
                    <span>Credits</span>
                    <strong>{wallet.credits} credits</strong>
                  </div>
                </div>

                <button type="button" className="navWalletBuyBtn">
                  Buy credits
                </button>

                <div className="navWalletDivider" />

                <button type="button" className="navWalletActionBtn">
                  View dashboard
                </button>
                <button type="button" className="navWalletActionBtn" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

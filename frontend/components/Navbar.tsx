"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "../context/WalletContext";

function GitHubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.21.09 1.85 1.25 1.85 1.25 1.07 1.83 2.82 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02.01 2.05.14 3.01.4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.23v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
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
  const [queryString, setQueryString] = useState("");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const { address, balance, credits, isOnCorrectNetwork, connectedWalletName, disconnect } = useWallet();

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  useEffect(() => {
    setQueryString(window.location.search.replace(/^\?/, ""));
  }, [pathname]);

  const returnTo = useMemo(() => {
    return queryString ? `${pathname}?${queryString}` : pathname;
  }, [pathname, queryString]);

  function copyAddress() {
    if (!address) return;
    navigator.clipboard.writeText(address).catch(() => {});
  }

  return (
    <header className="topbar">
      <nav className="topbarInner" aria-label="Primary">
        <Link className="navBrand" href="/" aria-label="Go to home">
          Voices
        </Link>

        <div className="navLinks hideMobile" aria-label="Primary links">
          <Link href="/styles">Styles</Link>
          <Link href="/upload">Upload</Link>
          <Link href="/#creators">Creators</Link>
          <Link href="/#how">About</Link>
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
          {!address ? (
            <Link
              className="btn btnDark navWalletConnectBtn"
              href={`/wallet?returnTo=${encodeURIComponent(returnTo)}`}
              aria-label="Connect wallet"
            >
              Connect Wallet
            </Link>
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
                  style={{ background: avatarFromAddress(address) }}
                  aria-hidden="true"
                />
                <span className="navWalletAddress">{shortAddress(address)}</span>
                {!isOnCorrectNetwork && (
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: 10,
                      color: "#c0392b",
                      fontWeight: 700,
                      background: "rgba(192,57,43,.1)",
                      borderRadius: 6,
                      padding: "1px 5px",
                    }}
                  >
                    wrong network
                  </span>
                )}
              </button>

              <div className={`navWalletMenu ${open ? "navWalletMenuOpen" : ""}`} role="dialog" aria-label="Wallet details">

                {/* ── Header ── */}
                <div className="navWalletMenuHeader">
                  <span
                    className="navWalletMenuAvatarLg"
                    style={{ background: avatarFromAddress(address) }}
                    aria-hidden="true"
                  />
                  <div className="navWalletMenuAddressBlock">
                    <div className={`navWalletMenuNetwork ${!isOnCorrectNetwork ? "navWalletMenuNetworkBad" : ""}`}>
                      {isOnCorrectNetwork ? "0G Galileo" : "⚠ Wrong Network"}
                    </div>
                    <div className="navWalletMenuShortAddr">{shortAddress(address)}</div>
                    {connectedWalletName && (
                      <div className="navWalletMenuWalletName">via {connectedWalletName}</div>
                    )}
                  </div>
                  <button type="button" className="navWalletCopyBtn" onClick={copyAddress}>
                    Copy
                  </button>
                </div>

                {/* ── Full address ── */}
                <div className="navWalletFullAddress">{address}</div>

                {/* ── Stats ── */}
                <div className="navWalletStats">
                  <div className="navWalletStatCell">
                    <div className="navWalletStatLabel">Balance</div>
                    <div className="navWalletStatValue">{balance ?? "—"}</div>
                    <div className="navWalletStatUnit">OG</div>
                  </div>
                  <div className="navWalletStatCell">
                    <div className="navWalletStatLabel">Credits</div>
                    <div className="navWalletStatValue">{credits ?? "—"}</div>
                    <div className="navWalletStatUnit">credits</div>
                  </div>
                </div>

                {/* ── Actions ── */}
                <div className="navWalletActions">
                  {!isOnCorrectNetwork && (
                    <Link
                      href="/wallet"
                      className="navWalletActionBtn"
                      style={{ color: "#c0392b" }}
                      onClick={() => setOpen(false)}
                    >
                      Switch to 0G Galileo
                    </Link>
                  )}
                  <Link
                    href="/dashboard"
                    className="navWalletActionBtn"
                    onClick={() => setOpen(false)}
                  >
                    View dashboard
                  </Link>
                  <Link
                    href={`/wallet?returnTo=${encodeURIComponent(returnTo)}&switch=1`}
                    className="navWalletActionBtn"
                    onClick={() => setOpen(false)}
                  >
                    Switch wallet
                  </Link>
                  <button
                    type="button"
                    className={`navWalletActionBtn navWalletActionDanger`}
                    onClick={() => { disconnect(); setOpen(false); }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}

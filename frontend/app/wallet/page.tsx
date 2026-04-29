"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { useWallet } from "../../context/WalletContext";
import type { DetectedWallet } from "../../context/WalletContext";

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function WalletIcon({ wallet }: { wallet: DetectedWallet }) {
  if (wallet.icon) {
    return (
      <img
        src={wallet.icon}
        alt={wallet.name}
        width={32}
        height={32}
        style={{ borderRadius: 8, flexShrink: 0 }}
      />
    );
  }
  // Generic placeholder when icon isn't available
  return (
    <div
      style={{
        width: 32, height: 32, borderRadius: 8, flexShrink: 0,
        background: "linear-gradient(135deg,#6ee7ff,#a78bfa)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14, fontWeight: 800, color: "#fff",
      }}
    >
      {wallet.name[0]}
    </div>
  );
}

export default function WalletPage() {
  const router = useRouter();
  const {
    address,
    balance,
    credits,
    isOnCorrectNetwork,
    isInitializing,
    isConnecting,
    error,
    availableWallets,
    connect,
    switchNetwork,
  } = useWallet();

  const [queryState, setQueryState] = useState({
    returnTo: "/upload",
    isDashboardMode: false,
    isSwitchMode: false,
    ready: false,
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQueryState({
      returnTo: params.get("returnTo") ?? "/upload",
      isDashboardMode: params.get("dashboard") === "1",
      isSwitchMode: params.get("switch") === "1",
      ready: true,
    });
  }, []);

  const { returnTo, isDashboardMode, isSwitchMode, ready: queryReady } = queryState;

  // Auto-skip when already connected (normal flow)
  // In switch mode: only redirect after the user actively picks a new wallet (isConnecting just finished)
  const [didConnect, setDidConnect] = useState(false);
  useEffect(() => {
    if (isConnecting) setDidConnect(true);
  }, [isConnecting]);

  useEffect(() => {
    if (queryReady && !isDashboardMode && !isInitializing && address && isOnCorrectNetwork) {
      if (!isSwitchMode || didConnect) router.replace(returnTo);
    }
  }, [queryReady, isDashboardMode, isSwitchMode, didConnect, isInitializing, address, isOnCorrectNetwork, returnTo, router]);

  const statusLabel = address
    ? isOnCorrectNetwork ? `Connected · ${shortAddress(address)}` : "Wrong network"
    : "Not connected";
  const walletTitle = isDashboardMode
    ? "Wallet dashboard"
    : isSwitchMode
      ? "Switch wallet"
      : address
        ? "Wallet connected"
        : "Choose your wallet";
  const walletSubtitle = isDashboardMode
    ? address
      ? isOnCorrectNetwork
        ? "Review your 0G balance, credits, and connected wallet."
        : "Switch networks to keep using Voices."
      : availableWallets.length === 0
        ? "Detecting wallets..."
        : `${availableWallets.length} wallet${availableWallets.length > 1 ? "s" : ""} detected`
    : isSwitchMode
      ? "Pick a different wallet to connect with."
      : address
        ? isOnCorrectNetwork
          ? "Connected to 0G Galileo - redirecting..."
          : "Connected but on the wrong network."
        : availableWallets.length === 0
          ? "Detecting wallets..."
          : `${availableWallets.length} wallet${availableWallets.length > 1 ? "s" : ""} detected`;

  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="walletHero">
              <div className="kicker">Wallet</div>
              <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                {isDashboardMode ? "Wallet dashboard" : "Connect your wallet"}
              </h1>
              <p className="sectionSub">
                {isDashboardMode
                  ? "Review your connected wallet, network, balance, and generation credits."
                  : "Choose a wallet to connect. We'll switch you to the 0G Galileo network automatically."}
              </p>
            </div>

            <div className="walletGlassCard" role="region" aria-label="Wallet connection">
              <div className="walletCardTop">
                <div>
                  <div className="walletCardTitle">{walletTitle}</div>
                  <div className="walletCardSubtitle">{walletSubtitle}</div>
                </div>
                <div className={`walletStatusPill ${address ? "walletStatusOk" : ""}`}>
                  {statusLabel}
                </div>
              </div>

              {/* Connected info — hide in switch mode so the wallet list shows */}
              {address && !isSwitchMode && (
                <div className="walletStatsGrid" style={{ marginTop: 14 }}>
                  <div className="walletStat">
                    <div className="walletStatLabel">Address</div>
                    <div className="walletStatValue" title={address}>{shortAddress(address)}</div>
                  </div>
                  <div className="walletStat">
                    <div className="walletStatLabel">0G Balance</div>
                    <div className="walletStatValue">{balance !== null ? `${balance} OG` : "…"}</div>
                  </div>
                  <div className="walletStat">
                    <div className="walletStatLabel">Credits</div>
                    <div className="walletStatValue">{credits !== null ? credits : "…"}</div>
                  </div>
                </div>
              )}

              {/* Wrong network */}
              {address && !isOnCorrectNetwork && (
                <button type="button" className="walletOption" onClick={switchNetwork} style={{ marginTop: 14 }}>
                  <div className="walletOptionLeft">
                    <div className="walletOptionName">Switch to 0G Galileo</div>
                    <div className="walletOptionSub">Required network for Voices</div>
                  </div>
                  <div className="walletOptionRight">Switch</div>
                </button>
              )}

              {isDashboardMode && address && (
                <div className="walletDashboardActions">
                  <a href={returnTo} className="walletOption">
                    <div className="walletOptionLeft">
                      <div className="walletOptionName">Back to app</div>
                      <div className="walletOptionSub">Return to the page you opened this from</div>
                    </div>
                    <div className="walletOptionRight">Open</div>
                  </a>
                  <a href={`/wallet?returnTo=${encodeURIComponent(returnTo)}&switch=1`} className="walletOption">
                    <div className="walletOptionLeft">
                      <div className="walletOptionName">Switch wallet</div>
                      <div className="walletOptionSub">Connect with a different wallet provider</div>
                    </div>
                    <div className="walletOptionRight">Switch</div>
                  </a>
                </div>
              )}

              {/* Wallet list — shown when not connected OR in switch mode */}
              {(!address || isSwitchMode) && (
                <>
                  {availableWallets.length === 0 ? (
                    <div className="walletFinePrint" style={{ marginTop: 16 }}>
                      No wallets detected. Install{" "}
                      <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">MetaMask</a>
                      {" "}or another EVM-compatible wallet extension.
                    </div>
                  ) : (
                    availableWallets.map((wallet) => (
                      <button
                        key={wallet.rdns}
                        type="button"
                        className="walletOption"
                        onClick={() => connect(wallet)}
                        disabled={isConnecting}
                        aria-label={`Connect with ${wallet.name}`}
                      >
                        <div className="walletOptionLeft" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <WalletIcon wallet={wallet} />
                          <div>
                            <div className="walletOptionName">{wallet.name}</div>
                            <div className="walletOptionSub">Connect using {wallet.name}</div>
                          </div>
                        </div>
                        <div className="walletOptionRight">
                          {isConnecting ? "Connecting…" : "Connect"}
                        </div>
                      </button>
                    ))
                  )}
                </>
              )}

              {/* In switch mode with a wallet already connected, offer a way back */}
              {isSwitchMode && address && (
                <div style={{ marginTop: 10 }}>
                  <a
                    href={returnTo}
                    className="walletFinePrint"
                    style={{ color: "var(--muted2)", textDecoration: "underline", cursor: "pointer" }}
                  >
                    Keep current wallet and go back
                  </a>
                </div>
              )}

              {error && (
                <div className="walletFinePrint" style={{ color: "#c0392b", marginTop: 10 }}>
                  {error}
                </div>
              )}

              <div className="walletFinePrint">
                {isDashboardMode && address
                  ? "Wallet dashboard is open."
                  : !isSwitchMode && address && isOnCorrectNetwork
                    ? "Redirecting..."
                  : "Your wallet will ask for approval before connecting."}
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";

const WALLET_KEY = "voices.wallet.v1";

function safeReadWallet(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { address?: string };
    return typeof parsed?.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

function shortAddress(addr: string) {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

export default function WalletPage() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasWallet = Boolean(address);

  useEffect(() => {
    setAddress(safeReadWallet());
  }, []);

  const fakeAddress = useMemo(
    () => "0x7B6a3cD9a2F4aA1B5c8E90bB1d0C2fF4aB9e12a3",
    [],
  );

  function connectDummyWallet() {
    setBusy(true);
    setTimeout(() => {
      localStorage.setItem(WALLET_KEY, JSON.stringify({ address: fakeAddress }));
      setAddress(fakeAddress);
      setBusy(false);
    }, 650);
  }

  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="walletHero">
              <div className="kicker">Wallet</div>
              <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                Connect to upload your style
              </h1>
              <p className="sectionSub">
                This demo uses a dummy wallet connection. No real authentication or
                on-chain calls are made.
              </p>
            </div>

            <div className="walletGlassCard" role="region" aria-label="Wallet connection">
              <div className="walletCardTop">
                <div>
                  <div className="walletCardTitle">Connection</div>
                  <div className="walletCardSubtitle">Secure, encrypted, and ready (mock)</div>
                </div>
                <div className={`walletStatusPill ${hasWallet ? "walletStatusOk" : ""}`}>
                  {hasWallet ? "Connected" : "Not connected"}
                </div>
              </div>

              <div className="walletStatsGrid" aria-label="Wallet stats">
                <div className="walletStat">
                  <div className="walletStatLabel">Address</div>
                  <div className="walletStatValue">
                    {hasWallet ? shortAddress(address!) : "—"}
                  </div>
                </div>
                <div className="walletStat">
                  <div className="walletStatLabel">Network</div>
                  <div className="walletStatValue">Testnet</div>
                </div>
                <div className="walletStat">
                  <div className="walletStatLabel">Credits</div>
                  <div className="walletStatValue">{hasWallet ? "Ready" : "—"}</div>
                </div>
              </div>

              <div className="walletActions">
                <Button
                  variant="primary"
                  onClick={connectDummyWallet}
                  ariaLabel="Connect dummy wallet"
                  disabled={busy || hasWallet}
                >
                  {busy ? "Connecting…" : hasWallet ? "Wallet connected" : "Connect wallet"}
                </Button>
                <Button
                  variant="secondary"
                  ariaLabel="Continue to upload"
                  href={hasWallet ? "/upload" : undefined}
                  onClick={!hasWallet ? connectDummyWallet : undefined}
                  disabled={busy}
                >
                  {hasWallet ? "Continue" : busy ? "Connecting…" : "Connect to upload"}
                </Button>
              </div>

              <div className="walletFinePrint">
                Your dummy wallet address is stored locally so you can continue to the
                upload page.
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}


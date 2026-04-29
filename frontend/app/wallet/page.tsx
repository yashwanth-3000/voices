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
    const existing = safeReadWallet();
    setAddress(existing);
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
      router.replace("/upload");
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
                Connect your wallet
              </h1>
              <p className="sectionSub">Connect to continue to style upload.</p>
            </div>

            <div className="walletGlassCard" role="region" aria-label="Wallet connection">
              <div className="walletCardTop">
                <div>
                  <div className="walletCardTitle">Connect to your wallet</div>
                  <div className="walletCardSubtitle">
                    Choose a wallet to connect.
                  </div>
                </div>
                <div className={`walletStatusPill ${hasWallet ? "walletStatusOk" : ""}`}>
                  {hasWallet ? `Connected · ${shortAddress(address!)}` : "Not connected"}
                </div>
              </div>

              <button
                type="button"
                className="walletOption"
                onClick={connectDummyWallet}
                disabled={busy}
                aria-label="Connect with MetaMask"
              >
                <div className="walletOptionLeft">
                  <div className="walletOptionName">MetaMask</div>
                  <div className="walletOptionSub">Connect using browser wallet</div>
                </div>
                <div className="walletOptionRight">
                  {busy ? "Connecting…" : hasWallet ? "Connected" : "Connect"}
                </div>
              </button>

              <div className="walletFinePrint">
                After connecting, you’ll be redirected to upload your style.
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}


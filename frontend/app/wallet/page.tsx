"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";

const WALLET_KEY = "voices.wallet.v1";

function readWalletAddress(): string | null {
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
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export default function WalletPage() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasWallet = Boolean(address);

  useEffect(() => {
    setAddress(readWalletAddress());
  }, []);

  const fakeAddress = useMemo(() => {
    return "0x7B6a3cD9a2F4aA1B5c8E90bB1d0C2fF4aB9e12a3";
  }, []);

  function connectDummyWallet() {
    setBusy(true);
    setTimeout(() => {
      const payload = JSON.stringify({ address: fakeAddress });
      localStorage.setItem(WALLET_KEY, payload);
      setAddress(fakeAddress);
      setBusy(false);
      router.replace("/upload");
    }, 600);
  }

  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="kicker">Wallet</div>
            <h1 className="sectionTitle" style={{ marginTop: 10 }}>
              Connect to upload your style
            </h1>
            <p className="sectionSub">
              This demo uses a dummy wallet connection. No real authentication or
              on-chain wallet calls are made.
            </p>

            <div className="grid twoCol" style={{ marginTop: 18 }}>
              <div className="panel">
                <div className="panelHeader">
                  <h2 className="panelTitle" style={{ marginTop: 8 }}>
                    Step 1: connect
                  </h2>
                  <p className="panelSub">
                    Required to mint and show an explorer-ready creator address.
                  </p>
                </div>
                <div className="panelBody">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="muted" style={{ fontSize: 14 }}>
                      {hasWallet ? (
                        <>
                          Connected: <strong>{shortAddress(address!)}</strong>
                        </>
                      ) : (
                        "Not connected"
                      )}
                    </span>
                    <Button
                      variant="primary"
                      onClick={() => connectDummyWallet()}
                      ariaLabel="Connect dummy wallet"
                      disabled={busy}
                    >
                      {busy ? "Connecting…" : "Connect wallet"}
                    </Button>
                  </div>

                  <div className="divider" style={{ margin: "18px 0" }} />

                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <Button
                      variant="secondary"
                      href={hasWallet ? "/upload" : "/wallet"}
                      ariaLabel="Continue"
                    >
                      Continue
                    </Button>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panelHeader">
                  <h2 className="panelTitle" style={{ marginTop: 8 }}>
                    What you’ll do next
                  </h2>
                  <p className="panelSub">
                    You’ll create a style using drag-and-drop and text paste. Then
                    we’ll simulate a mint transaction and show a style ID.
                  </p>
                </div>
                <div className="panelBody">
                  <div className="chips">
                    <span className="chip">Drag & drop files</span>
                    <span className="chip">Live preview</span>
                    <span className="chip">Mint simulation</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}


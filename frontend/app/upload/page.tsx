"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";
import type { StyleModel } from "../../lib/styles";
import { upsertMintedStyle } from "../../lib/mintedStyles";

const WALLET_KEY = "voices.wallet.v1";

const MIN_CHARS = 200;
const MAX_CHARS = 5000;

const ROYALTY_MIN = 0.0001;
const ROYALTY_MAX = 0.002;
const ROYALTY_STEP = 0.0001;

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

function clampText(text: string) {
  return text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);
}

function makeFakeTxHash() {
  const hex = Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `0x${hex}`;
}

function makeFakeStyleId() {
  const a = Math.random().toString(16).slice(2, 8);
  const b = Date.now().toString(16).slice(-6);
  return `uploaded-${a}-${b}`;
}

async function extractMockText(file: File): Promise<string> {
  const name = file.name || "file";
  const lower = name.toLowerCase();
  const isPdf = lower.endsWith(".pdf") || file.type.includes("pdf");
  const isTxt = lower.endsWith(".txt");
  const isMd = lower.endsWith(".md") || lower.endsWith(".markdown");

  if (isPdf) {
    return `\n[Mock PDF extract: ${name}]\nThis is mocked extracted content from a PDF upload.\n\n`;
  }

  if (isTxt || isMd) {
    const txt = await file.text();
    return `\n[${isMd ? "Mock Markdown" : "Text"}: ${name}]\n${txt}\n\n`;
  }

  return `\n[Unsupported file type (mocked): ${name}]\n`;
}

type MintPhase = "idle" | "processing" | "ready" | "confirming" | "success";

type MintStep = {
  key: string;
  label: string;
};

export default function UploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [checkingWallet, setCheckingWallet] = useState(true);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [styleName, setStyleName] = useState("");
  const [royalty, setRoyalty] = useState<number>(0.0005);

  const [mintPhase, setMintPhase] = useState<MintPhase>("idle");
  const [mintStepIndex, setMintStepIndex] = useState(0);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [mintedStyleId, setMintedStyleId] = useState<string | null>(null);

  const mintSteps: MintStep[] = useMemo(
    () => [
      { key: "verify", label: "Verifying input" },
      { key: "process", label: "Processing samples" },
      { key: "profile", label: "Generating style profile" },
      { key: "prepare", label: "Preparing mint transaction" },
    ],
    [],
  );

  useEffect(() => {
    const addr = safeReadWallet();
    setWalletAddress(addr);
    setCheckingWallet(false);

    if (!addr) router.replace("/wallet");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const charCount = content.length;
  const charHint = useMemo(() => {
    if (charCount < MIN_CHARS) {
      const remaining = Math.max(0, MIN_CHARS - charCount);
      return `Add ${remaining} more characters (min ${MIN_CHARS}).`;
    }
    if (charCount > MAX_CHARS) return `Max ${MAX_CHARS} characters.`;
    return "Looks detailed enough for a convincing voice.";
  }, [charCount]);

  const previewText = useMemo(() => {
    const t = content.trim();
    if (!t) return "Paste writing samples to generate a live voice preview.";
    const snippet = t.slice(0, 200);
    return t.length > 200 ? `${snippet}…` : snippet;
  }, [content]);

  const previewRoyalty = useMemo(() => `${royalty.toFixed(4)} / use`, [royalty]);

  const canMint =
    Boolean(walletAddress) && content.trim().length >= MIN_CHARS && styleName.trim().length > 0;

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;

    const arr = Array.from(files);
    const accepted = arr.filter((f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".txt") || n.endsWith(".md") || n.endsWith(".pdf");
    });
    if (!accepted.length) return;

    const nextFileNames = accepted.map((f) => f.name);
    setUploadedFiles((prev) => [...prev, ...nextFileNames]);

    let combined = content;
    for (const f of accepted) {
      const extracted = await extractMockText(f);
      combined = clampText(combined + extracted);
      if (combined.length >= MAX_CHARS) break;
    }
    setContent(combined);
  }

  function triggerFilePicker() {
    fileInputRef.current?.click();
  }

  async function startMintPipeline() {
    if (!canMint || mintPhase !== "idle") return;

    setMintPhase("processing");
    setMintStepIndex(0);
    setTxHash(null);
    setMintedStyleId(null);

    for (let i = 0; i < mintSteps.length; i++) {
      // Steps appear one-by-one with small delays.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 520 + i * 160));
      setMintStepIndex(i + 1);
    }

    setMintPhase("ready");
  }

  async function confirmMint() {
    if (mintPhase !== "ready") return;

    setMintPhase("confirming");
    await new Promise((r) => setTimeout(r, 900));

    const newTx = makeFakeTxHash();
    const newStyleId = makeFakeStyleId();
    const trimmed = content.trim();

    const sampleA = trimmed.slice(0, 220);
    const sampleB = trimmed.slice(220, 440);
    const computedTitle = styleName.trim() || "Untitled style";
    const creatorHandle = (walletAddress ?? "creator").replace(/^0x/i, "").slice(0, 10);

    const newStyle: StyleModel = {
      id: newStyleId,
      title: computedTitle,
      creatorName: "Creator",
      creatorHandle: creatorHandle || "creator",
      price: `$${royalty.toFixed(4)} / use`,
      tags: ["uploaded"],
      blurb: trimmed
        ? `Based on your samples: “${trimmed.slice(0, 90)}${trimmed.length > 90 ? "…" : ""}”`
        : "Based on your samples.",
      about:
        "A reusable writing voice built from your uploaded samples. This is a UI prototype, so generation and minting are simulated.",
      bestFor: ["Posts", "Memos", "Landing page copy", "Thread replies"],
      traits: [
        { label: "Tone", value: content.includes("?") ? "Curious, conversational" : "Clear, polished" },
        {
          label: "Cadence",
          value: content.length > 2000 ? "Structured, confident pacing" : "Tight, punchy flow",
        },
        { label: "Signature", value: "Creator-first phrasing with consistent rhythm" },
      ],
      samples: [
        { label: "Style sample", text: sampleA || "—" },
        { label: "Alt angle", text: sampleB ? sampleB : sampleA ? `Alt angle:\n${sampleA}` : "—" },
      ],
    };

    upsertMintedStyle(newStyle);

    setTxHash(newTx);
    setMintedStyleId(newStyleId);
    setMintPhase("success");
  }

  function resetAll() {
    setMintPhase("idle");
    setMintStepIndex(0);
    setTxHash(null);
    setMintedStyleId(null);
    setUploadedFiles([]);
    setContent("");
    setStyleName("");
    setRoyalty(0.0005);
  }

  if (checkingWallet) {
    return (
      <div>
        <Navbar />
        <main className="siteShell">
          <section className="section">
            <div className="container">
              <div className="kicker">Loading</div>
              <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                Checking wallet…
              </h1>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="kicker">Create your style</div>
            <h1 className="sectionTitle" style={{ marginTop: 10 }}>
              Turn writing into a reusable voice
            </h1>
            <p className="sectionSub">
              Upload a few samples and configure a royalty. We’ll simulate extraction + minting so you
              can preview the flow end-to-end.
            </p>

            <div className="grid twoCol uploadGridTight" style={{ marginTop: 16 }}>
              {/* Left */}
              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">Inputs</div>
                  <h2 className="panelTitle" style={{ marginTop: 10 }}>
                    Upload samples + paste text
                  </h2>
                  <p className="panelSub">
                    File text extraction is mocked for this UI demo.
                  </p>
                </div>
                <div className="panelBody uploadPanelBody">
                  <div className="uploadTopRow">
                    <Button
                      variant="primary"
                      onClick={triggerFilePicker}
                      ariaLabel="Upload files"
                    >
                      Upload files
                    </Button>
                    <span className="muted" style={{ fontSize: 13 }}>
                      Accepts .txt, .md, .pdf
                    </span>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.pdf"
                    style={{ display: "none" }}
                    onChange={(e) => handleFilesSelected(e.target.files)}
                  />

                  {uploadedFiles.length > 0 ? (
                    <div style={{ marginTop: 10 }}>
                      <div className="kicker" style={{ marginBottom: 8 }}>
                        Uploaded
                      </div>
                      <div className="chips">
                        {uploadedFiles.slice(-6).map((name, idx) => (
                          <span className="chip" key={`${name}-${idx}`}>
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ marginTop: 14 }}>
                    <textarea
                      className="textArea uploadTextArea"
                      value={content}
                      onChange={(e) => setContent(clampText(e.target.value))}
                      placeholder="Paste your writing samples here…"
                      aria-label="Pasted style content"
                    />
                    <div className="uploadCharRow">
                      <div className="muted" style={{ fontSize: 13 }}>
                        {charCount} / {MAX_CHARS} chars
                      </div>
                      <div className="uploadCharHint">{charHint}</div>
                    </div>
                  </div>

                  <div className="trustBox">
                    <div className="trustTitle">Your content stays private</div>
                    <div className="trustText">
                      In the real product we’d encrypt and store your samples securely and never expose
                      them publicly. This demo is UI-only.
                    </div>
                  </div>

                  <div className="styleSettingsCompact">
                    <div className="field">
                      <div className="fieldLabel">Style name</div>
                      <input
                        className="textInput"
                        value={styleName}
                        onChange={(e) => setStyleName(e.target.value.slice(0, 60))}
                        placeholder="e.g., Witty founder notes"
                        aria-label="Style name"
                      />
                    </div>

                    <div className="field">
                      <div className="fieldLabel">Royalty per use</div>
                      <div className="rangeRow" aria-label="Royalty slider">
                        <input
                          type="range"
                          className="rangeInput"
                          min={ROYALTY_MIN}
                          max={ROYALTY_MAX}
                          step={ROYALTY_STEP}
                          value={royalty}
                          onChange={(e) => setRoyalty(Number(e.target.value))}
                        />
                        <div className="rangeValue">{previewRoyalty}</div>
                      </div>
                      <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                        Min {ROYALTY_MIN.toFixed(4)} → Max {ROYALTY_MAX.toFixed(4)}
                      </div>
                    </div>

                    <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
                      <span className="muted" style={{ fontSize: 13 }}>
                        {content.trim().length < MIN_CHARS
                          ? `Need at least ${MIN_CHARS} characters to mint.`
                          : walletAddress
                            ? "Ready when your style name is set."
                            : "Connect wallet to mint."}
                      </span>
                      <Button
                        variant="primary"
                        onClick={startMintPipeline}
                        ariaLabel="Mint this style"
                        disabled={!canMint || mintPhase !== "idle"}
                      >
                        Mint this style
                      </Button>
                    </div>
                  </div>

                  {mintPhase !== "idle" ? (
                    <div className="mintActivity">
                      <div className="kicker">Mint simulation</div>
                      <div className="mintSteps" aria-label="Mint activity steps">
                        {mintSteps.map((s, idx) => {
                          const done = idx < mintStepIndex;
                          const active = idx === mintStepIndex;
                          return (
                            <div
                              key={s.key}
                              className={`mintStep ${done ? "mintStepDone" : "mintStepPending"} ${
                                active ? "mintStepActive" : ""
                              }`}
                            >
                              <span className="mintBullet" aria-hidden="true">
                                {done ? "✓" : active ? "…" : " "}
                              </span>
                              <div className="mintStepLabel">{s.label}</div>
                            </div>
                          );
                        })}
                      </div>

                      {mintPhase === "ready" ? (
                        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
                          <Button
                            variant="primary"
                            onClick={confirmMint}
                            ariaLabel="Confirm mint"
                          >
                            Confirm mint
                          </Button>
                        </div>
                      ) : null}

                      {mintPhase === "confirming" ? (
                        <div className="muted" style={{ marginTop: 14 }}>
                          Submitting transaction… (simulated)
                        </div>
                      ) : null}

                      {mintPhase === "success" && txHash && mintedStyleId ? (
                        <div className="mintSuccess">
                          <div className="kicker">Success</div>
                          <h2 className="panelTitle" style={{ marginTop: 10 }}>
                            Your style is live (mock)
                          </h2>
                          <p className="panelSub">
                            Transaction hash:{" "}
                            <span className="mono" style={{ color: "var(--text)" }}>
                              {txHash}
                            </span>
                          </p>
                          <p className="panelSub">
                            Style ID:{" "}
                            <span className="mono" style={{ color: "var(--text)" }}>
                              {mintedStyleId}
                            </span>
                          </p>

                          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                            <Button variant="primary" onClick={resetAll} ariaLabel="Create another style">
                              Create another style
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Right: compact voice preview */}
              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">Live preview</div>
                  <h2 className="panelTitle" style={{ marginTop: 10 }}>
                    Voice preview
                  </h2>
                  <p className="panelSub">A lightweight preview (not the marketplace card yet).</p>
                </div>
                <div className="panelBody">
                  <div className="voicePreviewCard">
                    <div className="voicePreviewTop">
                      <div>
                        <div className="voicePreviewTitle">
                          {styleName.trim() ? styleName.trim() : "Untitled style"}
                        </div>
                        <div className="voicePreviewMeta">
                          by {walletAddress ? shortAddress(walletAddress) : "0xCREATOR…"}
                        </div>
                      </div>
                      <div className="voicePreviewRoyalty">{previewRoyalty}</div>
                    </div>

                    <div className="voicePreviewText mono">{previewText}</div>
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


"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";
import type { StyleModel } from "../../lib/styles";
import { upsertMintedStyle } from "../../lib/mintedStyles";

type MintStep = {
  key: string;
  label: string;
};

const WALLET_KEY = "voices.wallet.v1";
const MAX_CHARS = 5000;
const MIN_CHARS = 200;

const ROYALTY_OPTIONS = [0.0001, 0.0005, 0.001, 0.002];

function safeReadWallet(): string | null {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { address?: string };
    return typeof parsed?.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

function truncateAddress(addr: string) {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

function clampText(text: string) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS);
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
    // No real PDF parsing; just simulate.
    const hint = [
      "This is mocked extracted content from a PDF upload.",
      "In the real app, we’d OCR/text-extract and normalize paragraphs.",
    ].join(" ");
    return `\n[Mock PDF extract: ${name}]\n${hint}\n`;
  }

  if (isTxt || isMd) {
    const txt = await file.text();
    return `\n[${isMd ? "Mock Markdown" : "Text"}: ${name}]\n${txt}\n`;
  }

  return `\n[Unsupported file type (mocked): ${name}]\n`;
}

export default function UploadPage() {
  const router = useRouter();

  const [checkingWallet, setCheckingWallet] = useState(true);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);
  const [filesInfo, setFilesInfo] = useState<{ name: string; addedChars: number }[]>([]);

  const [content, setContent] = useState("");

  const [styleName, setStyleName] = useState("");
  const [royalty, setRoyalty] = useState<number>(ROYALTY_OPTIONS[1] ?? 0.0005);
  const [isPublic, setIsPublic] = useState(true);

  const [mintStepIndex, setMintStepIndex] = useState(0);
  const [mintPhase, setMintPhase] = useState<"idle" | "processing" | "ready" | "confirming" | "success">("idle");
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

    if (!addr) {
      // Route creators through the wallet gate.
      router.replace("/wallet");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const charCount = content.length;
  const charHint = useMemo(() => {
    if (charCount < MIN_CHARS) {
      const remaining = Math.max(0, MIN_CHARS - charCount);
      return `Add ${remaining} more characters to capture your voice (min ${MIN_CHARS}).`;
    }
    if (charCount > MAX_CHARS) {
      return `Max ${MAX_CHARS} characters.`;
    }
    if (charCount >= MIN_CHARS && charCount <= MAX_CHARS) {
      return "Looks detailed enough for a convincing style profile.";
    }
    return "";
  }, [charCount]);

  const previewTitle = styleName.trim() ? styleName.trim() : "Untitled style";
  const previewCreator = walletAddress ? truncateAddress(walletAddress) : "0xCREATOR…";
  const previewRoyalty = `Royalty ${royalty}`;

  const previewText = useMemo(() => {
    const t = content.trim();
    if (!t) return "Paste writing samples to see a marketplace preview.";
    const snippet = t.slice(0, 190);
    return t.length > 190 ? `${snippet}…` : snippet;
  }, [content]);

  const canMint = walletAddress && content.trim().length >= MIN_CHARS && styleName.trim().length > 0;

  async function onFilesAdded(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (!files.length) return;

    const accepted = files.filter((f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".txt") || n.endsWith(".md") || n.endsWith(".pdf");
    });

    if (!accepted.length) return;

    const nextInfo: { name: string; addedChars: number }[] = [];
    let combined = content;

    for (const f of accepted) {
      const extracted = await extractMockText(f);
      const beforeLen = combined.length;
      combined = clampText(combined + extracted);
      nextInfo.push({ name: f.name, addedChars: Math.max(0, combined.length - beforeLen) });
      if (combined.length >= MAX_CHARS) break;
    }

    setFilesInfo((prev) => [...prev, ...nextInfo]);
    setContent(combined);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length) onFilesAdded(files);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
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
      await new Promise((r) => setTimeout(r, 650 + i * 200));
      setMintStepIndex(i + 1);
    }

    setMintPhase("ready");
  }

  async function confirmMint() {
    if (mintPhase !== "ready") return;
    setMintPhase("confirming");

    await new Promise((r) => setTimeout(r, 950));

    const newTx = makeFakeTxHash();
    const newStyleId = makeFakeStyleId();

    const trimmed = content.trim();
    const sampleA = trimmed.slice(0, 220);
    const sampleB = trimmed.slice(220, 440);
    const computedTitle = styleName.trim() || "Untitled style";
    const computedHandle = walletAddress ? truncateAddress(walletAddress).toLowerCase() : "creator";

    const newStyle: StyleModel = {
      id: newStyleId,
      title: computedTitle,
      creatorName: "Creator",
      creatorHandle: computedHandle.replace(/[^a-z0-9_.-]/g, "").slice(0, 18) || "creator",
      price: `$${royalty} / use`,
      tags: [
        isPublic ? "public" : "private",
        "uploaded",
      ],
      blurb: trimmed
        ? `Based on your samples: “${trimmed.slice(0, 90)}${trimmed.length > 90 ? "…" : ""}”`
        : "Based on your samples.",
      about:
        "A reusable writing voice built from your uploaded samples. This is a UI prototype, so generation and minting are simulated.",
      bestFor: ["Posts", "Memos", "Landing page copy", "Thread replies"].slice(
        0,
        isPublic ? 4 : 3,
      ),
      traits: [
        { label: "Tone", value: content.includes("?") ? "Curious, conversational" : "Clear, polished" },
        { label: "Cadence", value: content.length > 2000 ? "Structured, confident pacing" : "Tight, punchy flow" },
        { label: "Signature", value: isPublic ? "Creator-first phrasing + gentle hooks" : "Quiet, controlled voice" },
      ],
      samples: [
        {
          label: "Style sample",
          text: sampleA || "—",
        },
        {
          label: "Alt angle",
          text: sampleB
            ? sampleB
            : sampleA
              ? `Alt angle:\n${sampleA}`
              : "—",
        },
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
    setFilesInfo([]);
    setContent("");
    setStyleName("");
    setRoyalty(ROYALTY_OPTIONS[1] ?? 0.0005);
    setIsPublic(true);
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
            <div className="kicker">Upload</div>
            <h1 className="sectionTitle" style={{ marginTop: 10 }}>
              Create your style
            </h1>
            <p className="sectionSub">
              Turn your writing into a reusable voice that others can license and
              generate from.
            </p>

            <div className="grid twoCol" style={{ marginTop: 18 }}>
              {/* Left column */}
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="panel">
                  <div className="panelHeader">
                    <div className="kicker">Samples</div>
                    <h2 className="panelTitle" style={{ marginTop: 10 }}>
                      Upload writing files
                    </h2>
                    <p className="panelSub">
                      Drag-and-drop <strong>.txt</strong>, <strong>.md</strong>, or{" "}
                      <strong>.pdf</strong> files. We’ll mock “extracted” text and
                      combine everything with your pasted content.
                    </p>
                  </div>
                  <div className="panelBody">
                    <div
                      className={`dropzone ${dragOver ? "dropzoneActive" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-label="Upload your writing samples"
                      onDragEnter={() => setDragOver(true)}
                      onDragLeave={() => setDragOver(false)}
                      onDragOver={onDragOver}
                      onDrop={onDrop}
                    >
                      <div className="dropzoneTitle">
                        Drop files here
                        <div className="dropzoneSub">or click to browse (mock)</div>
                      </div>
                      <div className="dropzoneAccept">Accepts: .txt · .md · .pdf</div>
                    </div>

                    {filesInfo.length > 0 ? (
                      <div style={{ marginTop: 12 }}>
                        <div className="kicker" style={{ marginBottom: 8 }}>
                          Uploaded
                        </div>
                        <div className="chips">
                          {filesInfo.map((f, idx) => (
                            <span className="chip" key={`${f.name}-${idx}`}>
                              {f.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div style={{ marginTop: 14 }}>
                      <textarea
                        className="textArea"
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

                    <div className="row" style={{ marginTop: 14, justifyContent: "space-between" }}>
                      <span className="muted" style={{ fontSize: 13 }}>
                        We’ll use your samples to generate a consistent voice.
                      </span>
                      <span className="chip">{isPublic ? "Public" : "Private"}</span>
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panelHeader">
                    <div className="kicker">Trust</div>
                    <h2 className="panelTitle" style={{ marginTop: 10 }}>
                      Your content stays safe
                    </h2>
                    <p className="panelSub">
                      This is UI copy only. In the real product, your samples would be encrypted,
                      stored securely, and never exposed publicly.
                    </p>
                  </div>
                </div>

                <div className="panel">
                  <div className="panelHeader">
                    <div className="kicker">Configure</div>
                    <h2 className="panelTitle" style={{ marginTop: 10 }}>
                      Style settings
                    </h2>
                    <p className="panelSub">These update your live marketplace preview instantly.</p>
                  </div>
                  <div className="panelBody">
                    <div className="grid" style={{ gap: 14 }}>
                      <div className="field">
                        <div className="fieldLabel">Style name</div>
                        <input
                          className="textInput"
                          value={styleName}
                          onChange={(e) => setStyleName(e.target.value.slice(0, 60))}
                          placeholder="e.g., “Witty founder notes”"
                          aria-label="Style name"
                        />
                      </div>

                      <div className="field">
                        <div className="fieldLabel">Royalty per use</div>
                        <div className="segmented" role="group" aria-label="Royalty options">
                          {ROYALTY_OPTIONS.map((v) => {
                            const active = v === royalty;
                            return (
                              <button
                                key={v}
                                type="button"
                                className={`segment ${active ? "segmentActive" : ""}`}
                                onClick={() => setRoyalty(v)}
                              >
                                {v}
                              </button>
                            );
                          })}
                        </div>
                        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                          Selected: <strong>{royalty}</strong>
                        </div>
                      </div>

                      <div className="field">
                        <div className="fieldLabel">Visibility</div>
                        <div className="toggleRow">
                          <button
                            type="button"
                            className={`toggleBtn ${isPublic ? "toggleBtnOn" : ""}`}
                            onClick={() => setIsPublic(true)}
                          >
                            Public
                          </button>
                          <button
                            type="button"
                            className={`toggleBtn ${!isPublic ? "toggleBtnOn" : ""}`}
                            onClick={() => setIsPublic(false)}
                          >
                            Private
                          </button>
                        </div>
                        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                          {isPublic
                            ? "Public styles can be discovered in the marketplace."
                            : "Private styles are hidden from the marketplace (demo)."}
                        </div>
                      </div>
                    </div>

                    <div className="row" style={{ marginTop: 18, justifyContent: "space-between" }}>
                      <span className="muted" style={{ fontSize: 13 }}>
                        {content.trim().length < MIN_CHARS
                          ? `Need at least ${MIN_CHARS} characters to mint.`
                          : "Ready to mint when you are."}
                      </span>
                      <Button
                        variant="primary"
                        onClick={() => startMintPipeline()}
                        ariaLabel="Mint this style"
                        disabled={!canMint || mintPhase !== "idle"}
                      >
                        Mint this style
                      </Button>
                    </div>

                    {mintPhase !== "idle" ? (
                      <div className="mintActivity">
                        <div className="kicker">Mint activity</div>
                        <div className="mintSteps" aria-label="Mint activity steps">
                          {mintSteps.map((s, idx) => {
                            const done = idx < mintStepIndex;
                            return (
                              <div
                                key={s.key}
                                className={`mintStep ${done ? "mintStepDone" : "mintStepPending"}`}
                              >
                                <span className="mintBullet" aria-hidden="true">
                                  {done ? "✓" : idx === mintStepIndex ? "…" : " "}
                                </span>
                                <div className="mintStepLabel">{s.label}</div>
                              </div>
                            );
                          })}
                        </div>

                        {mintPhase === "ready" ? (
                          <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
                            <Button variant="primary" onClick={() => confirmMint()} ariaLabel="Confirm mint">
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
                              Your style is live
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

                            <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                              <Button
                                variant="secondary"
                                href={`/styles/${mintedStyleId ?? ""}`}
                                ariaLabel="View in marketplace"
                              >
                          View in marketplace
                              </Button>
                              <Button variant="primary" onClick={() => resetAll()} ariaLabel="Create another style">
                                Create another one
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Right column */}
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="panel">
                  <div className="panelHeader">
                    <div className="kicker">Live preview</div>
                    <h2 className="panelTitle" style={{ marginTop: 10 }}>
                      Marketplace listing
                    </h2>
                    <p className="panelSub">
                      This preview mirrors how others will see your style card.
                    </p>
                  </div>

                  <div className="panelBody">
                    <div className="styleListing uploadPreviewCard" aria-label="Style preview">
                      <div className="styleListingTop">
                        <div>
                          <div className="styleListingTitle">{previewTitle}</div>
                          <div className="styleListingMeta">{previewCreator}</div>
                        </div>
                        <div className="styleListingPrice">{previewRoyalty}</div>
                      </div>

                      <div className="styleListingBlurb">“{previewText}”</div>
                      <div className="styleListingFill">
                        {isPublic ? "Public style · ready for explorers" : "Private style · hidden from marketplace"}
                      </div>

                      <div className="chips styleListingTags" aria-label="Style tags">
                        <span className="chip">royalty:{royalty}</span>
                        <span className="chip">{isPublic ? "public" : "private"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panelHeader">
                    <div className="kicker">Quick checks</div>
                    <h2 className="panelTitle" style={{ marginTop: 10 }}>
                      Mint readiness
                    </h2>
                  </div>
                  <div className="panelBody">
                    <div className="mintChecks">
                      <div className="checkRow">
                        <span className={`checkDot ${styleName.trim() ? "checkDotOn" : ""}`} />
                        <span className="muted">Style name set</span>
                      </div>
                      <div className="checkRow">
                        <span className={`checkDot ${content.trim().length >= MIN_CHARS ? "checkDotOn" : ""}`} />
                        <span className="muted">Min {MIN_CHARS} chars</span>
                      </div>
                      <div className="checkRow">
                        <span className={`checkDot ${walletAddress ? "checkDotOn" : ""}`} />
                        <span className="muted">Wallet connected</span>
                      </div>
                    </div>
                    <div className="muted" style={{ fontSize: 13, marginTop: 10, lineHeight: 1.6 }}>
                      Minting is simulated. No real files are stored or minted on-chain in this demo.
                    </div>
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


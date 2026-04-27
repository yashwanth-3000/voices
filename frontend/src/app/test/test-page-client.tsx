"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Interface, TransactionRequest, ethers } from "ethers";
import "./test-page.css";

type AgentEvent = {
  id: string;
  type: string;
  timestamp: number;
  actor: string;
  styleId?: string;
  consumerAddress?: string;
  payload: Record<string, unknown>;
};

type TransactionIntent = {
  to: string;
  data: string;
  value: string;
  description: string;
};

type StepState = "waiting" | "running" | "done" | "error";
type FlowStep = { label: string; state: StepState; detail?: string };

const GALILEO_CHAIN_ID_HEX = "0x40da";
const GALILEO_EXPLORER = "https://chainscan-galileo.0g.ai";
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const STYLE_UPLOAD_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_WRITING_SAMPLE = [
  "The handoff matters more than the headline. A real agent workflow should leave evidence behind it: who asked for work, which style profile was used, what was generated, what changed after feedback, and which transaction moved value on-chain. Without that trail, the demo is just a button calling a model.",
  "Voices is built around that trail. The creator starts with private writing samples, not a public prompt. The backend encrypts those samples, stores them through 0G Storage, asks 0G Compute to extract a structured voice profile, and prepares a mint transaction for the creator to sign. The important detail is that the server does not pretend it owns the creator wallet. It creates the intent. The wallet signs the mint.",
  "The consumer side follows the same rule. The Content Creator agent reads the confirmed style token, checks credits, pulls the profile, and drafts once. It does not publish directly. It writes an event. The Distribution Manager sees that event, tunes the draft for each platform, and prepares the spend-credit settlement transaction. The UI should show each step because the architecture is the product.",
  "The voice should be practical, skeptical, and builder-first. Use direct sentences. Prefer concrete nouns like profile hash, encrypted sample, request id, credit spend, royalty settlement, and feedback event. Avoid launch fog. Do not say the system is fully decentralized when the demo still uses server-side conveniences. Say what is live, what is pending, and what production would harden.",
  "That honesty makes the workflow stronger. Judges can follow the moving parts, creators can see where ownership lives, and developers can inspect the same event log the agents use to coordinate. The claim is simple: writing style becomes an ownable agent asset, and every useful action leaves a verifiable trace."
].join("\n\n");
const STYLE_REGISTRY_IFACE = new Interface([
  "event StyleMinted(uint256 indexed tokenId,address indexed creator,uint256 royaltyWei,string encryptedSamplesURI,bytes32 metadataHash)"
]);

export function TestPageClient() {
  const [walletAddress, setWalletAddress] = useState("");
  const [chainId, setChainId] = useState("");
  const [samplesText, setSamplesText] = useState(DEFAULT_WRITING_SAMPLE);
  const [attestationMessage, setAttestationMessage] = useState("");
  const [attestationSignature, setAttestationSignature] = useState("");
  const [resumeRequestId, setResumeRequestId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [feedback, setFeedback] = useState("");
  const [platforms, setPlatforms] = useState(["x", "linkedin", "instagram"]);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [steps, setSteps] = useState<FlowStep[]>(initialSteps);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [requestIds, setRequestIds] = useState<string[]>([]);
  const [styleId, setStyleId] = useState("");
  const [pendingStyleId, setPendingStyleId] = useState("");
  const [mintIntent, setMintIntent] = useState<TransactionIntent | null>(null);
  const [spendIntent, setSpendIntent] = useState<TransactionIntent | null>(null);
  const [creditBalance, setCreditBalance] = useState("");
  const [creditPriceWei, setCreditPriceWei] = useState("");
  const [lastTxHash, setLastTxHash] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const streams = useRef<Map<string, EventSource>>(new Map());
  const eventsRef = useRef<AgentEvent[]>([]);

  const busy = busyAction.length > 0;
  const sampleCharacters = samplesText.trim().length;
  const runtime = health?.runtime as Record<string, string> | undefined;
  const latestMinted = [...events].reverse().find((event) => event.type === "style.minted");
  const latestDraft = [...events].reverse().find((event) => event.type === "generation.drafted");
  const latestPublished = [...events].reverse().find((event) => event.type === "generation.published");
  const latestRefined = [...events].reverse().find((event) => event.type === "style.refined");
  const generatedDraft = payloadString(latestDraft, "draft");
  const platformVariants = payloadRecord(latestPublished, "variants");
  const eventGroups = useMemo(() => {
    return requestIds.map((requestId) => ({
      requestId,
      events: events.filter((event) => requestIdFromEvent(event) === requestId || event.id === requestId)
    }));
  }, [events, requestIds]);

  useEffect(() => {
    void checkHealth();
    return () => {
      for (const source of streams.current.values()) source.close();
      streams.current.clear();
    };
  }, []);

  useEffect(() => {
    eventsRef.current = events;
    const latestIntent = [...events].reverse().find((event) => event.type === "style.mint.intent.created");
    const intent = payloadIntent(latestIntent, "transactionIntent");
    if (latestIntent?.styleId && intent && (!mintIntent || pendingStyleId !== latestIntent.styleId)) {
      setPendingStyleId(latestIntent.styleId);
      setMintIntent(intent);
      markStep(0, "running", "Mint intent ready. Sign it with MetaMask.");
      setError((current) => (current.includes("style.mint.intent") ? "" : current));
    }

    const latestPublish = [...events].reverse().find((event) => event.type === "generation.published");
    const latestSpendIntent = payloadIntent(latestPublish, "spendIntent");
    if (latestSpendIntent && !spendIntent) {
      setSpendIntent(latestSpendIntent);
      markStep(1, "done", "Draft generated");
      markStep(2, "running", "Settlement transaction ready");
    }
  }, [events, mintIntent, pendingStyleId, spendIntent]);

  async function connectWallet() {
    await runAction("wallet", async () => {
      const provider = await getBrowserProvider();
      await provider.send("wallet_addEthereumChain", [
        {
          chainId: GALILEO_CHAIN_ID_HEX,
          chainName: "0G-Galileo-Testnet",
          nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
          rpcUrls: ["https://evmrpc-testnet.0g.ai"],
          blockExplorerUrls: [GALILEO_EXPLORER]
        }
      ]);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      setWalletAddress(await signer.getAddress());
      const network = await provider.getNetwork();
      setChainId(network.chainId.toString());
      await refreshCredits(await signer.getAddress());
    });
  }

  async function signAttestation() {
    await runAction("sign", async () => {
      const provider = await getBrowserProvider();
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const sampleHash = ethers.id(requireValue(samplesText, "Writing samples"));
      const message = [
        "I confirm these writing samples are mine and may be used to mint a Voices style iNFT.",
        `Creator: ${address}`,
        `Sample hash: ${sampleHash}`,
        `Timestamp: ${new Date().toISOString()}`
      ].join("\n");
      setWalletAddress(address);
      setAttestationMessage(message);
      setAttestationSignature(await signer.signMessage(message));
    });
  }

  async function uploadStyle() {
    await runAction("upload", async () => {
      resetRunState();
      markStep(0, "running", "Profiling style and preparing mint transaction");
      const upload = await apiPost<{ requestId: string }>("/styles/upload", {
        walletAddress: requireValue(walletAddress, "Wallet"),
        samples: parseSamples(samplesText),
        attestationMessage: requireValue(attestationMessage, "Attestation message"),
        attestationSignature: requireValue(attestationSignature, "Attestation signature"),
        language: "en",
        genres: ["creator-style"]
      });
      rememberRequest(upload.requestId);
      markStep(0, "running", "Live 0G storage and compute are running. This can take 30-90 seconds.");
      const intentEvent = await waitForAny(upload.requestId, ["style.mint.intent.created", "style.failed"], {
        timeoutMs: STYLE_UPLOAD_TIMEOUT_MS
      });
      if (intentEvent.type === "style.failed") {
        throw new Error(String(intentEvent.payload.reason ?? intentEvent.payload.error ?? "Style profiling failed"));
      }
      const intent = payloadIntent(intentEvent, "transactionIntent");
      if (!intent || !intentEvent.styleId) throw new Error("Mint intent was not returned by the backend");
      setPendingStyleId(intentEvent.styleId);
      setMintIntent(intent);
      markStep(0, "running", "Mint intent ready. Sign it with MetaMask.");
    });
  }

  async function mintOnChain() {
    await runAction("mint", async () => {
      if (!mintIntent) throw new Error("Upload style first to create a mint transaction");
      markStep(0, "running", "Waiting for on-chain mint confirmation");
      const receipt = await sendIntent(mintIntent);
      const tokenId = tokenIdFromMintReceipt(receipt, mintIntent.to);
      await apiPost("/styles/confirm-mint", {
        requestId: requestIds[requestIds.length - 1],
        walletAddress: requireValue(walletAddress, "Wallet"),
        pendingStyleId,
        tokenId,
        txHash: receipt.hash
      });
      setStyleId(tokenId);
      setLastTxHash(receipt.hash);
      markStep(0, "done", `Minted token ${tokenId}`);
      await refreshCredits(walletAddress);
    });
  }

  async function resumeRequest() {
    await runAction("resume", async () => {
      const requestId = requireValue(resumeRequestId, "Request ID");
      rememberRequest(requestId);
      const data = await apiGet<{ events: AgentEvent[] }>(`/events/${requestId}`);
      setEvents((current) => mergeEvents(current, data.events));

      const mintEvent = [...data.events].reverse().find((event) => event.type === "style.mint.intent.created");
      const mint = payloadIntent(mintEvent, "transactionIntent");
      if (mintEvent?.styleId && mint) {
        setPendingStyleId(mintEvent.styleId);
        setMintIntent(mint);
        markStep(0, "running", "Mint intent loaded. Sign it with MetaMask.");
        return;
      }

      const failure = [...data.events].reverse().find((event) => event.type.endsWith(".failed"));
      if (failure) {
        throw new Error(String(failure.payload.reason ?? failure.payload.error ?? "Request failed"));
      }
      throw new Error("No mint intent found for that request yet");
    });
  }

  async function buyOneCredit() {
    await runAction("credit", async () => {
      const buy = await apiPost<{ requestId: string; intent: TransactionIntent }>("/credits/buy-intent", {
        walletAddress: requireValue(walletAddress, "Wallet"),
        amount: "1"
      });
      rememberRequest(buy.requestId);
      const receipt = await sendIntent(buy.intent);
      await apiPost("/credits/confirm-purchase", {
        requestId: buy.requestId,
        walletAddress,
        amount: "1",
        txHash: receipt.hash
      });
      setLastTxHash(receipt.hash);
      await refreshCredits(walletAddress);
    });
  }

  async function generateContent() {
    await runAction("generate", async () => {
      markStep(1, "running", "Waiting for draft");
      const generated = await apiPost<{ requestId: string }>("/generate", {
        walletAddress: requireValue(walletAddress, "Wallet"),
        styleId: requireValue(styleId, "Confirmed style token ID"),
        prompt: requireValue(prompt, "Generation prompt"),
        platforms
      });
      rememberRequest(generated.requestId);
      const firstTerminal = await waitForAny(generated.requestId, [
        "generation.published",
        "credit.low",
        "generation.failed"
      ], { timeoutMs: DEFAULT_WAIT_TIMEOUT_MS });
      if (firstTerminal.type === "credit.low") {
        markStep(1, "error", "Buy a credit before generating");
        return;
      }
      if (firstTerminal.type === "generation.failed") {
        throw new Error(String(firstTerminal.payload.reason ?? "Generation failed"));
      }
      markStep(1, "done", "Draft generated");
      markStep(2, "running", "Settlement transaction ready");
      const intent = payloadIntent(firstTerminal, "spendIntent");
      if (intent) setSpendIntent(intent);
    });
  }

  async function settleOnChain() {
    await runAction("settle", async () => {
      if (!spendIntent) throw new Error("Generate content first to create a spend-credit transaction");
      const receipt = await sendIntent(spendIntent);
      await apiPost("/settlement/confirm", {
        requestId: requestIds[requestIds.length - 1],
        walletAddress,
        styleId,
        txHash: receipt.hash
      });
      setLastTxHash(receipt.hash);
      markStep(2, "done", "Credit spent and royalty settled on-chain");
      await refreshCredits(walletAddress);
    });
  }

  async function sendFeedback() {
    await runAction("feedback", async () => {
      markStep(3, "running", "Waiting for style refinement");
      const feedbackResult = await apiPost<{ requestId: string }>("/feedback", {
        walletAddress: requireValue(walletAddress, "Wallet"),
        styleId: requireValue(styleId, "Confirmed style token ID"),
        feedback: requireValue(feedback, "Feedback")
      });
      rememberRequest(feedbackResult.requestId);
      await waitFor(feedbackResult.requestId, "style.refined");
      markStep(3, "done", "Profile refined from feedback");
    });
  }

  async function refreshCredits(address = walletAddress) {
    if (!address) return;
    const data = await apiGet<{ credits: string; creditPriceWei: string }>(`/credits/${address}`);
    setCreditBalance(data.credits);
    setCreditPriceWei(data.creditPriceWei);
  }

  async function checkHealth() {
    try {
      setHealth(await apiGet("/admin/health"));
    } catch (flowError) {
      setError(errorMessage(flowError));
    }
  }

  async function sendIntent(intent: TransactionIntent) {
    const provider = await getBrowserProvider();
    const signer = await provider.getSigner();
    const tx: TransactionRequest = {
      to: intent.to,
      data: intent.data,
      value: BigInt(intent.value || "0")
    };
    const response = await signer.sendTransaction(tx);
    setLastTxHash(response.hash);
    const receipt = await response.wait();
    if (!receipt) throw new Error(`Transaction ${response.hash} was not confirmed`);
    return receipt;
  }

  async function runAction<T>(name: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusyAction(name);
    setError("");
    try {
      return await action();
    } catch (flowError) {
      setError(errorMessage(flowError));
      setSteps((current) => current.map((step) => (step.state === "running" ? { ...step, state: "error" } : step)));
      return undefined;
    } finally {
      setBusyAction("");
    }
  }

  async function waitFor(requestId: string, type: string): Promise<AgentEvent> {
    return waitForAny(requestId, [type]);
  }

  async function waitForAny(
    requestId: string,
    types: string[],
    options: { timeoutMs?: number } = {}
  ): Promise<AgentEvent> {
    openEventStream(requestId);
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const localFound = eventsRef.current.find(
        (event) => belongsToRequest(event, requestId) && types.includes(event.type)
      );
      if (localFound) return localFound;

      const data = await apiGet<{ events: AgentEvent[] }>(`/events/${requestId}`);
      setEvents((current) => mergeEvents(current, data.events));
      const found = data.events.find((event) => types.includes(event.type));
      if (found) return found;
      await sleep(POLL_INTERVAL_MS);
    }

    const data = await apiGet<{ events: AgentEvent[] }>(`/events/${requestId}`);
    setEvents((current) => mergeEvents(current, data.events));
    const found = data.events.find((event) => types.includes(event.type));
    if (found) return found;

    throw new Error(`Timed out waiting for ${types.join(" or ")}`);
  }

  function openEventStream(requestId: string) {
    if (streams.current.has(requestId)) return;
    const source = new EventSource(`/api/backend/events/stream/${requestId}`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      setEvents((current) => mergeEvents(current, [event]));
    };
    source.onerror = () => source.close();
    streams.current.set(requestId, source);
  }

  function rememberRequest(requestId: string) {
    setRequestIds((current) => (current.includes(requestId) ? current : [...current, requestId]));
    openEventStream(requestId);
  }

  function resetRunState() {
    setEvents([]);
    setRequestIds([]);
    setStyleId("");
    setPendingStyleId("");
    setMintIntent(null);
    setSpendIntent(null);
    setSteps(initialSteps);
  }

  function markStep(index: number, state: StepState, detail?: string) {
    setSteps((current) => current.map((step, stepIndex) => (stepIndex === index ? { ...step, state, detail } : step)));
  }

  function togglePlatform(platform: string) {
    setPlatforms((current) => (current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform]));
  }

  return (
    <main className="test-shell">
      <section className="test-header">
        <div>
          <p className="eyebrow">Voices live console</p>
          <h1>On-chain 0G agent workflow</h1>
          <p className="header-copy">Wallet-signed style upload, live agent events, on-chain minting, credit spend, and royalty settlement.</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={checkHealth} disabled={busy}>Health</button>
          <button type="button" className="primary" onClick={connectWallet} disabled={busy}>{walletAddress ? "Wallet connected" : "Connect wallet"}</button>
        </div>
      </section>

      <section className="cost-strip">
        <div>
          <strong>{runtime?.costProfile === "live_0g" ? "Live 0G mode" : "Not live yet"}</strong>
          <span>{runtime?.costProfile === "live_0g" ? "This can spend OG. Every on-chain step is signed in MetaMask." : "Start backend with 0G modes before expecting on-chain writes."}</span>
        </div>
        <div>
          <strong>Backend modes</strong>
          <span>storage {runtime?.storage ?? "unknown"} / compute {runtime?.compute ?? "unknown"} / chain {runtime?.chain ?? "unknown"}</span>
        </div>
        <div>
          <strong>Wallet</strong>
          <span>{walletAddress ? `${short(walletAddress)} on chain ${chainId || "unknown"}` : "Connect MetaMask on 0G Galileo"}</span>
        </div>
      </section>

      <section className="main-grid">
        <div className="stack">
          <div className="panel controls-panel">
            <div className="panel-heading">
              <div>
                <div className="panel-title">1. Style upload</div>
                <p>Paste real samples, sign the attestation, then let the backend store/profile them before you mint.</p>
              </div>
            </div>
            <label>Writing samples<textarea className="sample-textarea" placeholder="Paste creator-owned writing samples here. Minimum about 1KB." value={samplesText} onChange={(event) => setSamplesText(event.target.value)} /></label>
            <div className="meter-row"><span>{sampleCharacters.toLocaleString()} characters</span><span>{sampleCharacters < 1024 ? "Need at least about 1KB" : "Enough for upload"}</span></div>
            <label>Attestation message<textarea value={attestationMessage} onChange={(event) => setAttestationMessage(event.target.value)} /></label>
            <label>Attestation signature<input value={attestationSignature} onChange={(event) => setAttestationSignature(event.target.value)} /></label>
            <div className="button-row multi-actions">
              <button type="button" onClick={signAttestation} disabled={busy || !walletAddress || !samplesText}>Sign attestation</button>
              <button type="button" className="primary" onClick={uploadStyle} disabled={busy || !attestationSignature}>{busyAction === "upload" ? "Uploading..." : "Upload + profile"}</button>
              <button type="button" className="primary" onClick={mintOnChain} disabled={busy || !mintIntent}>{busyAction === "mint" ? "Minting..." : "Mint on-chain"}</button>
            </div>
            <div className="resume-row">
              <input placeholder="Paste request ID to resume without uploading again" value={resumeRequestId} onChange={(event) => setResumeRequestId(event.target.value)} />
              <button type="button" onClick={resumeRequest} disabled={busy || !resumeRequestId}>Load request</button>
            </div>
            <div className="field-row"><span>Style ID</span><code>{styleId || pendingStyleId || "waiting"}</code></div>
          </div>

          <div className="panel controls-panel">
            <div className="panel-heading"><div><div className="panel-title">2. Credits + generation</div><p>Generation only runs when the connected wallet has credits in the deployed CreditSystem.</p></div></div>
            <div className="result-list">
              <div><span>Credits</span><strong>{creditBalance || "unknown"}</strong></div>
              <div><span>Credit price</span><strong>{creditPriceWei ? `${ethers.formatEther(creditPriceWei)} OG` : "unknown"}</strong></div>
            </div>
            <div className="button-row multi-actions">
              <button type="button" onClick={() => refreshCredits()} disabled={busy || !walletAddress}>Refresh credits</button>
              <button type="button" onClick={buyOneCredit} disabled={busy || !walletAddress}>{busyAction === "credit" ? "Buying..." : "Buy 1 credit"}</button>
            </div>
            <label>Generation prompt<textarea placeholder="What should the agent write?" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
            <div className="checkbox-row">{["x", "linkedin", "instagram"].map((platform) => <label className="checkbox-label" key={platform}><input checked={platforms.includes(platform)} onChange={() => togglePlatform(platform)} type="checkbox" />{platform}</label>)}</div>
            <div className="button-row multi-actions">
              <button type="button" className="primary" onClick={generateContent} disabled={busy || !styleId}>{busyAction === "generate" ? "Generating..." : "Generate"}</button>
              <button type="button" className="primary" onClick={settleOnChain} disabled={busy || !spendIntent}>{busyAction === "settle" ? "Settling..." : "Spend credit + settle royalty"}</button>
            </div>
          </div>

          <div className="panel controls-panel">
            <div className="panel-heading"><div><div className="panel-title">3. Feedback refinement</div><p>Feedback writes an event. The Style Curator refines the profile from that event.</p></div></div>
            <label>Feedback<textarea placeholder="Tell the agent what was off about the generated voice." value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
            <div className="button-row"><button type="button" className="primary" onClick={sendFeedback} disabled={busy || !styleId || !feedback}>{busyAction === "feedback" ? "Sending..." : "Send feedback"}</button></div>
            {error ? <div className="error-box">{error}</div> : null}
          </div>
        </div>

        <div className="stack sticky-stack">
          <div className="panel"><div className="panel-title">What happened</div><div className="explain-list">
            <Explain done={Boolean(latestMinted)} title="Style minted" waiting="Upload, sign, then mint the iNFT on-chain." doneText="The style profile exists and the wallet confirmed the iNFT mint on-chain." />
            <Explain done={Boolean(latestDraft)} title="Draft generated" waiting="Buy credits, then generate." doneText="The Content Creator produced a draft from the confirmed style token." />
            <Explain done={Boolean(latestPublished && spendIntent)} title="Settlement ready" waiting="Generate to create a spend-credit transaction." doneText="A real CreditSystem.spendCredit transaction is ready for MetaMask." />
            <Explain done={Boolean(latestRefined)} title="Feedback refined" waiting="Send feedback after generation." doneText="The Style Curator refined the profile from a feedback event." />
          </div></div>

          <div className="panel"><div className="panel-title">Lifecycle</div><div className="steps">{steps.map((step) => <div className="step" data-state={step.state} key={step.label}><span className="step-dot" /><div><strong>{step.label}</strong><span>{step.detail ?? step.state}</span></div></div>)}</div></div>

          <div className="panel"><div className="panel-title">Latest on-chain tx</div><div className="output-box">{lastTxHash ? <a href={`${GALILEO_EXPLORER}/tx/${lastTxHash}`} rel="noreferrer" target="_blank">{lastTxHash}</a> : "No transaction sent yet."}</div></div>
          <div className="panel"><div className="panel-title">Agents</div><pre className="json-box">{health ? JSON.stringify(health, null, 2) : "No health check yet."}</pre></div>
        </div>
      </section>

      <section className="output-grid">
        <div className="panel"><div className="panel-title">Generated draft</div><div className="output-box">{generatedDraft || "No draft yet."}</div></div>
        <div className="panel"><div className="panel-title">Platform variants</div>{Object.keys(platformVariants).length === 0 ? <p className="muted">No variants yet.</p> : <div className="variant-list">{Object.entries(platformVariants).map(([platform, variant]) => <div key={platform}><strong>{platform}</strong><p>{variant}</p></div>)}</div>}</div>
      </section>

      <section className="panel events-panel">
        <div className="panel-title">Real-time event log</div>
        <div className="event-list">{eventGroups.length === 0 ? <p className="muted">No events yet.</p> : null}{eventGroups.map((group) => <div className="event-group" key={group.requestId}><code>{group.requestId}</code>{group.events.map((event) => <div className="event-row" key={event.id}><span>{event.type}</span><small>{eventExplanation(event)}</small></div>)}</div>)}</div>
      </section>
    </main>
  );
}

function Explain({ done, title, waiting, doneText }: { done: boolean; title: string; waiting: string; doneText: string }) {
  return <div data-state={done ? "done" : "waiting"}><strong>{title}</strong><span>{done ? doneText : waiting}</span></div>;
}

const initialSteps: FlowStep[] = [
  { label: "Style upload/profile", state: "waiting" },
  { label: "Draft generation", state: "waiting" },
  { label: "On-chain settlement", state: "waiting" },
  { label: "Feedback refinement", state: "waiting" }
];

declare global {
  interface Window {
    ethereum?: unknown;
  }
}

async function getBrowserProvider(): Promise<BrowserProvider> {
  if (!window.ethereum) throw new Error("MetaMask is required for real on-chain testing");
  return new BrowserProvider(window.ethereum as ethers.Eip1193Provider);
}

async function apiGet<T = Record<string, unknown>>(path: string): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { cache: "no-store" });
  return parseResponse<T>(response);
}

async function apiPost<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/backend${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.message ?? data.error ?? `Request failed with ${response.status}`);
  return data as T;
}

function parseSamples(samplesText: string): string[] {
  return samplesText.split(/\n-{3,}\n/g).map((sample) => sample.trim()).filter(Boolean);
}

function payloadIntent(event: AgentEvent | undefined, key: string): TransactionIntent | null {
  const value = event?.payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Partial<TransactionIntent>;
  return intent.to && intent.data && typeof intent.value === "string" ? (intent as TransactionIntent) : null;
}

function payloadString(event: AgentEvent | undefined, key: string): string {
  const value = event?.payload[key];
  return typeof value === "string" ? value : "";
}

function payloadRecord(event: AgentEvent | undefined, key: string): Record<string, string> {
  const value = event?.payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function tokenIdFromMintReceipt(receipt: ethers.TransactionReceipt | null, styleRegistryAddress: string): string {
  if (!receipt) throw new Error("Mint transaction did not return a receipt");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== styleRegistryAddress.toLowerCase()) continue;
    try {
      const parsed = STYLE_REGISTRY_IFACE.parseLog(log);
      if (parsed?.name === "StyleMinted") return parsed.args.tokenId.toString();
    } catch {
      continue;
    }
  }
  throw new Error("Could not find StyleMinted event in mint receipt");
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function requestIdFromEvent(event: AgentEvent): string | undefined {
  return typeof event.payload.requestId === "string" ? event.payload.requestId : undefined;
}

function belongsToRequest(event: AgentEvent, requestId: string): boolean {
  return requestIdFromEvent(event) === requestId || event.id === requestId;
}

function eventExplanation(event: AgentEvent): string {
  if (event.type.endsWith(".failed")) return String(event.payload.reason ?? event.payload.error ?? "Agent reported failure");
  if (event.type === "style.mint.intent.created") return "Backend prepared a real StyleRegistry.mintStyle transaction.";
  if (event.type === "style.minted") return `On-chain mint confirmed: token ${event.styleId}.`;
  if (event.type === "credit.purchase.intent.created") return "Credit purchase transaction created for MetaMask.";
  if (event.type === "credit.purchased") return "Credit purchase confirmed on-chain.";
  if (event.type === "generation.published") return "Variants created; spend-credit transaction is ready.";
  if (event.type === "settlement.intent.created") return "Credit spend and royalty settlement transaction created.";
  if (event.type === "credit.deducted") return "Credit spend confirmed on-chain.";
  if (event.type === "royalty.settled") return "Royalty settlement confirmed on-chain.";
  if (event.type === "style.refined") return "Style profile refined from feedback.";
  return event.styleId ?? event.consumerAddress ?? event.actor;
}

function requireValue(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function short(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

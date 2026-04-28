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

type AutoRefillStatus = {
  maxBudget: string;
  spent: string;
  remainingBudget: string;
  threshold: string;
  perRefill: string;
  enabled: boolean;
  supported: boolean;
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
  const [autoRefill, setAutoRefill] = useState<AutoRefillStatus | null>(null);
  const [autoBudgetOg, setAutoBudgetOg] = useState("0.01");
  const [autoThreshold, setAutoThreshold] = useState("1");
  const [autoPerRefill, setAutoPerRefill] = useState("5");
  const [lastTxHash, setLastTxHash] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [streamStatus, setStreamStatus] = useState<Record<string, "connecting" | "open" | "closed" | "error">>({});
  const [selectedEventId, setSelectedEventId] = useState("");
  const streams = useRef<Map<string, EventSource>>(new Map());
  const eventsRef = useRef<AgentEvent[]>([]);

  const busy = busyAction.length > 0;
  const sampleCharacters = samplesText.trim().length;
  const runtime = health?.runtime as Record<string, string> | undefined;
  const latestMinted = [...events].reverse().find((event) => event.type === "style.minted");
  const latestDraft = [...events].reverse().find((event) => event.type === "generation.drafted");
  const latestPublished = [...events].reverse().find((event) => event.type === "generation.published");
  const latestRefined = [...events].reverse().find((event) => event.type === "style.refined");
  const latestAutoRefillConfigured = [...events].reverse().find((event) => event.type === "credit.auto_refill.configured");
  const latestAutoRefill = [...events].reverse().find((event) => event.type === "credit.replenished");
  const latestAutoRefillFailure = [...events].reverse().find((event) => event.type === "credit.replenish_failed");
  const liveMode = runtime?.costProfile === "live_0g";
  const keeperhub = health?.keeperhub as { supported?: boolean; reason?: string; network?: string; supportedChains?: string[] } | undefined;
  const walletReady = Boolean(walletAddress && chainId === "16602");
  const signedReady = Boolean(attestationMessage && attestationSignature);
  const uploadReady = walletReady && signedReady && sampleCharacters >= 1024;
  const creditCount = parseBigIntSafe(creditBalance);
  const hasCredits = creditCount !== null && creditCount > BigInt(0);
  const nextAction = getNextAction({
    liveMode,
    walletReady,
    signedReady,
    uploadReady,
    mintIntentReady: Boolean(mintIntent),
    styleReady: Boolean(styleId),
    hasCredits,
    promptReady: Boolean(prompt.trim()),
    spendIntentReady: Boolean(spendIntent),
    hasDraft: Boolean(latestDraft),
    feedbackReady: Boolean(feedback.trim()),
    refined: Boolean(latestRefined)
  });
  const generatedDraft = payloadString(latestDraft, "draft");
  const platformVariants = payloadRecord(latestPublished, "variants");
  const eventGroups = useMemo(() => {
    return requestIds.map((requestId) => ({
      requestId,
      events: events.filter((event) => requestIdFromEvent(event) === requestId || event.id === requestId)
    }));
  }, [events, requestIds]);
  const activityEvents = useMemo(
    () => events.filter((event) => event.type === "agent.activity").reverse(),
    [events]
  );
  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

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

  async function enableAutoRefill() {
    await runAction("auto-refill", async () => {
      const status = await apiGet<{ credits: string; creditPriceWei: string; autoRefill?: AutoRefillStatus }>(
        `/credits/${requireValue(walletAddress, "Wallet")}`
      );
      setCreditBalance(status.credits);
      setCreditPriceWei(status.creditPriceWei);
      setAutoRefill(status.autoRefill ?? null);
      if (status.autoRefill?.supported === false) {
        throw new Error("This deployed CreditSystem does not expose auto-refill yet. Redeploy the upgraded CreditSystem before enabling it.");
      }
      const budgetWei = ethers.parseEther(requireValue(autoBudgetOg, "Auto-refill budget")).toString();
      const setup = await apiPost<{ requestId: string; intent: TransactionIntent }>("/credits/auto-refill-intent", {
        walletAddress: requireValue(walletAddress, "Wallet"),
        maxBudgetWei: budgetWei,
        threshold: requireValue(autoThreshold, "Refill threshold"),
        perRefill: requireValue(autoPerRefill, "Per-refill credits")
      });
      rememberRequest(setup.requestId);
      const receipt = await sendIntent(setup.intent);
      await apiPost("/credits/confirm-auto-refill", {
        requestId: setup.requestId,
        walletAddress,
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
    const data = await apiGet<{ credits: string; creditPriceWei: string; autoRefill?: AutoRefillStatus }>(`/credits/${address}`);
    setCreditBalance(data.credits);
    setCreditPriceWei(data.creditPriceWei);
    setAutoRefill(data.autoRefill ?? null);
  }

  async function checkHealth() {
    try {
      setHealth(await apiGet("/admin/health"));
    } catch (flowError) {
      setHealth(null);
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

    const latestEvent = [...eventsRef.current]
      .reverse()
      .find((event) => belongsToRequest(event, requestId));
    throw new Error(
      `Timed out waiting for ${types.join(" or ")}. Latest event for this request: ${latestEvent?.type ?? "none"}.`
    );
  }

  function openEventStream(requestId: string) {
    if (streams.current.has(requestId)) return;
    setStreamStatus((current) => ({ ...current, [requestId]: "connecting" }));
    const source = new EventSource(`/api/backend/events/stream/${requestId}`);
    source.onopen = () => {
      setStreamStatus((current) => ({ ...current, [requestId]: "open" }));
    };
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as AgentEvent;
      setStreamStatus((current) => ({ ...current, [requestId]: "open" }));
      setEvents((current) => mergeEvents(current, [event]));
    };
    source.onerror = () => {
      setStreamStatus((current) => ({ ...current, [requestId]: "error" }));
    };
    streams.current.set(requestId, source);
  }

  function rememberRequest(requestId: string) {
    setRequestIds((current) => (current.includes(requestId) ? current : [...current, requestId]));
    openEventStream(requestId);
  }

  function resetRunState() {
    for (const source of streams.current.values()) source.close();
    streams.current.clear();
    setStreamStatus({});
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
      <section className="console-topbar">
        <div className="brand-block">
          <p className="eyebrow">Voices test bench</p>
          <h1 className="console-title">0G LangGraph swarm console</h1>
          <p className="header-copy">Run the real creator-to-consumer flow, inspect every agent step, and verify the on-chain transaction trail.</p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={checkHealth} disabled={busy}>Health</button>
          <button type="button" className="primary" onClick={connectWallet} disabled={busy}>{walletAddress ? "Wallet connected" : "Connect wallet"}</button>
        </div>
      </section>

      <section className="command-center">
        <div className="next-action-card">
          <span>Next action</span>
          <strong>{nextAction}</strong>
          {error ? <p className="inline-error">{error}</p> : <p>Work left to right. The right rail shows the agent evidence and raw payload for anything you click.</p>}
        </div>
        <div className="readiness-grid">
          <ReadinessItem ok={liveMode} label="Backend" detail={liveMode ? "0G storage / compute / chain" : "Not in live 0G mode"} />
          <ReadinessItem ok={walletReady} label="Wallet" detail={walletReady ? `${short(walletAddress)} on Galileo` : "Connect chain 16602"} />
          <ReadinessItem ok={sampleCharacters >= 1024} label="Samples" detail={`${sampleCharacters.toLocaleString()} characters`} />
          <ReadinessItem ok={signedReady} label="Attestation" detail={signedReady ? "Signed by wallet" : "Signature needed"} />
          <ReadinessItem ok={Boolean(styleId)} label="Style token" detail={styleId ? `iNFT #${styleId}` : pendingStyleId || "Waiting"} />
          <ReadinessItem ok={hasCredits} label="Credits" detail={creditBalance ? `${creditBalance} available` : "Unknown"} />
        </div>
      </section>

      <section className="workflow-layout">
        <div className="operator-column">
          <article className="workflow-card">
            <div className="workflow-head">
              <span className="step-number">01</span>
              <div>
                <h2>Creator style setup</h2>
                <p>Paste creator-owned samples, sign the attestation, profile with 0G Compute, then mint the style iNFT.</p>
              </div>
            </div>
            <label>Writing samples<textarea className="sample-textarea" placeholder="Paste creator-owned writing samples here. Minimum about 1KB." value={samplesText} onChange={(event) => setSamplesText(event.target.value)} /></label>
            <div className="meter-row"><span>{sampleCharacters.toLocaleString()} characters</span><span>{sampleCharacters < 1024 ? "Need about 1KB" : "Enough for upload"}</span></div>
            <div className="two-field-grid">
              <label>Attestation message<textarea value={attestationMessage} onChange={(event) => setAttestationMessage(event.target.value)} /></label>
              <label>Attestation signature<input value={attestationSignature} onChange={(event) => setAttestationSignature(event.target.value)} /></label>
            </div>
            <div className="action-row">
              <button type="button" onClick={signAttestation} disabled={busy || !walletAddress || !samplesText}>Sign attestation</button>
              <button type="button" className="primary" onClick={uploadStyle} disabled={busy || !uploadReady}>{busyAction === "upload" ? "Profiling..." : "Upload + profile"}</button>
              <button type="button" className="primary" onClick={mintOnChain} disabled={busy || !mintIntent}>{busyAction === "mint" ? "Minting..." : "Mint on-chain"}</button>
            </div>
            <div className="resume-row">
              <input placeholder="Paste request ID to resume a prior upload" value={resumeRequestId} onChange={(event) => setResumeRequestId(event.target.value)} />
              <button type="button" onClick={resumeRequest} disabled={busy || !resumeRequestId}>Load request</button>
            </div>
            <div className="key-value-row"><span>Style ID</span><code>{styleId || pendingStyleId || "waiting"}</code></div>
          </article>

          <article className="workflow-card compact-card">
            <div className="workflow-head">
              <span className="step-number">02</span>
              <div>
                <h2>Credits and autonomous refill</h2>
                <p>Generation is gated by on-chain credits. Optional auto-refill pre-funds a budget for the Distribution Manager path.</p>
              </div>
            </div>
            <div className="metric-grid">
              <div><span>Credits</span><strong>{creditBalance || "unknown"}</strong></div>
              <div><span>Credit price</span><strong>{creditPriceWei ? `${ethers.formatEther(creditPriceWei)} OG` : "unknown"}</strong></div>
              <div><span>KeeperHub</span><strong>{keeperhub?.supported ? keeperhub.network ?? "supported" : "not on Galileo"}</strong></div>
            </div>
            <div className="action-row">
              <button type="button" onClick={() => refreshCredits()} disabled={busy || !walletAddress}>Refresh credits</button>
              <button type="button" onClick={buyOneCredit} disabled={busy || !walletAddress}>{busyAction === "credit" ? "Buying..." : "Buy 1 credit"}</button>
            </div>
            <div className="auto-refill-box" data-state={autoRefill?.enabled ? "enabled" : "waiting"}>
              <div className="auto-refill-head">
                <div>
                  <strong>Auto-refill rule</strong>
                  <span>
                    {autoRefill?.supported === false
                      ? "The upgraded contract path is present, but KeeperHub does not currently list 0G Galileo."
                      : autoRefill?.enabled
                        ? "Enabled on-chain. The agent can request a refill when credits are low."
                        : "Pre-fund once, then the agent can refill without another wallet click."}
                  </span>
                </div>
              </div>
              <div className="auto-refill-grid">
                <label>Budget<input value={autoBudgetOg} onChange={(event) => setAutoBudgetOg(event.target.value)} inputMode="decimal" /></label>
                <label>Threshold<input value={autoThreshold} onChange={(event) => setAutoThreshold(event.target.value)} inputMode="numeric" /></label>
                <label>Per refill<input value={autoPerRefill} onChange={(event) => setAutoPerRefill(event.target.value)} inputMode="numeric" /></label>
              </div>
              <div className="metric-grid compact-results">
                <div><span>Enabled</span><strong>{autoRefill?.enabled ? "yes" : "no"}</strong></div>
                <div><span>Remaining</span><strong>{autoRefill ? `${ethers.formatEther(autoRefill.remainingBudget || "0")} OG` : "unknown"}</strong></div>
                <div><span>Rule</span><strong>{autoRefill?.enabled ? `<= ${autoRefill.threshold} then +${autoRefill.perRefill}` : "not configured"}</strong></div>
              </div>
              <div className="action-row">
                <button type="button" className="primary" onClick={enableAutoRefill} disabled={busy || !walletAddress || autoRefill?.supported === false}>
                  {busyAction === "auto-refill" ? "Configuring..." : "Enable auto-refill"}
                </button>
              </div>
              {keeperhub?.supported === false ? <p className="status-note">KeeperHub does not list 0G Galileo chain 16602 yet. The UI shows this honestly so the demo does not pretend an unsupported workflow ran.</p> : null}
              {latestAutoRefillFailure ? <p className="status-note danger-note">Latest refill attempt: {String(latestAutoRefillFailure.payload.reason ?? "failed")}</p> : null}
            </div>
          </article>

          <article className="workflow-card">
            <div className="workflow-head">
              <span className="step-number">03</span>
              <div>
                <h2>Generate and settle</h2>
                <p>The Content Creator drafts from the minted style. Distribution Manager tunes variants and prepares settlement.</p>
              </div>
            </div>
            <label>Generation prompt<textarea placeholder="What should the agent write?" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
            <div className="checkbox-row">{["x", "linkedin", "instagram"].map((platform) => <label className="checkbox-label" key={platform}><input checked={platforms.includes(platform)} onChange={() => togglePlatform(platform)} type="checkbox" />{platform}</label>)}</div>
            <div className="action-row">
              <button type="button" className="primary" onClick={generateContent} disabled={busy || !styleId || !prompt.trim()}>{busyAction === "generate" ? "Generating..." : "Generate"}</button>
              <button type="button" className="primary" onClick={settleOnChain} disabled={busy || !spendIntent}>{busyAction === "settle" ? "Settling..." : "Spend credit + settle royalty"}</button>
            </div>
          </article>

          <article className="workflow-card compact-card">
            <div className="workflow-head">
              <span className="step-number">04</span>
              <div>
                <h2>Feedback refinement</h2>
                <p>Feedback writes an event. The Style Curator refines the style profile from that event.</p>
              </div>
            </div>
            <label>Feedback<textarea placeholder="Tell the agent what was off about the generated voice." value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
            <div className="action-row"><button type="button" className="primary" onClick={sendFeedback} disabled={busy || !styleId || !feedback}>{busyAction === "feedback" ? "Sending..." : "Send feedback"}</button></div>
          </article>
        </div>

        <aside className="observability-rail">
          {error ? (
            <div className="panel error-panel">
              <div className="panel-title">Action error</div>
              <p>{error}</p>
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-heading-line">
              <div className="panel-title">Run state</div>
              <span className="tiny-pill">{busyAction || "idle"}</span>
            </div>
            <div className="steps">{steps.map((step) => <div className="step" data-state={step.state} key={step.label}><span className="step-dot" /><div><strong>{step.label}</strong><span>{step.detail ?? step.state}</span></div></div>)}</div>
          </div>

          <div className="panel">
            <div className="panel-title">Milestones</div>
            <div className="explain-list">
              <Explain done={Boolean(latestMinted)} title="Style minted" waiting="Upload, sign, then mint on-chain." doneText="The style profile exists and the wallet confirmed the iNFT." />
              <Explain done={Boolean(latestDraft)} title="Draft generated" waiting="Buy credits, then generate." doneText="The Content Creator produced a style-conditioned draft." />
              <Explain done={Boolean(latestPublished && spendIntent)} title="Settlement ready" waiting="Generate to create a spend-credit transaction." doneText="A real CreditSystem.spendCredit transaction is ready." />
              <Explain done={Boolean(latestAutoRefillConfigured || latestAutoRefill)} title="Auto-refill" waiting="Optional: pre-fund a refill budget." doneText={latestAutoRefill ? "The autonomous refill path emitted an event." : "Auto-refill budget is configured on-chain."} />
              <Explain done={Boolean(latestRefined)} title="Feedback refined" waiting="Send feedback after generation." doneText="The Style Curator refined the profile from feedback." />
            </div>
          </div>

          <div className="panel activity-panel">
            <div className="panel-heading-line">
              <div className="panel-title">Live agent activity</div>
              <span className="tiny-pill">{activityEvents.length} events</span>
            </div>
            <div className="activity-list">
              {activityEvents.length === 0 ? <p className="muted">No agent activity yet. Start upload or generation.</p> : null}
              {activityEvents.map((event) => (
                <button
                  aria-pressed={selectedEventId === event.id}
                  className="activity-row"
                  data-selected={selectedEventId === event.id}
                  data-state={String(event.payload.status ?? "completed")}
                  key={event.id}
                  onClick={() => setSelectedEventId(event.id)}
                  type="button"
                >
                  <div>
                    <strong>{String(event.payload.agentLabel ?? event.payload.agent ?? "Agent")}</strong>
                    <span>{String(event.payload.tool ?? "tool")}</span>
                  </div>
                  <p>{String(event.payload.message ?? eventExplanation(event))}</p>
                  <time>{formatTime(event.timestamp)}</time>
                </button>
              ))}
            </div>
          </div>

          <div className="panel raw-panel">
            <div className="panel-heading-line">
              <div className="panel-title">Raw inspector</div>
              {selectedEvent ? <button type="button" className="ghost-small" onClick={() => setSelectedEventId("")}>Clear</button> : null}
            </div>
            {selectedEvent ? (
              <div className="raw-content">
                <div className="raw-meta">
                  <span>{selectedEvent.type}</span>
                  <code>{selectedEvent.id}</code>
                </div>
                <pre className="json-box raw-json">{JSON.stringify(selectedEvent, null, 2)}</pre>
              </div>
            ) : (
              <p className="muted">Click any activity row or ledger row to expand the exact event envelope and payload.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">Transaction intents</div>
            <div className="intent-list">
              <IntentPreview title="Mint iNFT" intent={mintIntent} readyLabel={pendingStyleId || "Ready after upload"} />
              <IntentPreview title="Spend credit" intent={spendIntent} readyLabel={styleId ? `Style ${styleId}` : "Ready after generation"} />
            </div>
          </div>

          <div className="panel"><div className="panel-title">Latest on-chain tx</div><div className="output-box tx-box">{lastTxHash ? <a href={`${GALILEO_EXPLORER}/tx/${lastTxHash}`} rel="noreferrer" target="_blank">{lastTxHash}</a> : "No transaction sent yet."}</div></div>
          <div className="panel"><div className="panel-title">Backend health</div><pre className="json-box health-json">{health ? JSON.stringify(health, null, 2) : "No health check yet."}</pre></div>
        </aside>
      </section>

      <section className="results-board">
        <div className="panel result-panel"><div className="panel-title">Generated draft</div><div className="output-box">{generatedDraft || "No draft yet."}</div></div>
        <div className="panel result-panel"><div className="panel-title">Platform variants</div>{Object.keys(platformVariants).length === 0 ? <p className="muted">No variants yet.</p> : <div className="variant-list">{Object.entries(platformVariants).map(([platform, variant]) => <div key={platform}><strong>{platform}</strong><p>{variant}</p></div>)}</div>}</div>
      </section>

      <section className="panel events-panel">
        <div className="panel-heading-line">
          <div className="panel-title">Real-time event ledger</div>
          <span className="tiny-pill">{events.length} events</span>
        </div>
        <div className="event-list">{eventGroups.length === 0 ? <p className="muted">No events yet.</p> : null}{eventGroups.map((group) => <div className="event-group" key={group.requestId}><div className="event-group-head"><code>{group.requestId}</code><span data-state={streamStatus[group.requestId] ?? "closed"}>{streamStatus[group.requestId] ?? "closed"}</span></div>{group.events.map((event) => <button aria-pressed={selectedEventId === event.id} className="event-row" data-selected={selectedEventId === event.id} data-type={event.type === "agent.activity" ? "activity" : "event"} key={event.id} onClick={() => setSelectedEventId(event.id)} type="button"><span>{event.type}</span><small>{eventExplanation(event)}</small><time>{formatTime(event.timestamp)}</time></button>)}</div>)}</div>
      </section>
    </main>
  );
}

function ReadinessItem({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return <div className="readiness-item" data-state={ok ? "ok" : "waiting"}><span>{ok ? "Ready" : "Waiting"}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function Explain({ done, title, waiting, doneText }: { done: boolean; title: string; waiting: string; doneText: string }) {
  return <div data-state={done ? "done" : "waiting"}><strong>{title}</strong><span>{done ? doneText : waiting}</span></div>;
}

function IntentPreview({ title, intent, readyLabel }: { title: string; intent: TransactionIntent | null; readyLabel: string }) {
  return (
    <div className="intent-card" data-state={intent ? "ready" : "waiting"}>
      <div>
        <strong>{title}</strong>
        <span>{intent ? intent.description : readyLabel}</span>
      </div>
      {intent ? <dl><dt>To</dt><dd>{intent.to}</dd><dt>Value</dt><dd>{ethers.formatEther(intent.value || "0")} OG</dd></dl> : null}
    </div>
  );
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
  if (!response.ok) {
    if (data.error === "backend_unavailable") {
      throw new Error(`Backend is offline at ${data.backendUrl}. Restart it and refresh Health. Details: ${data.message ?? response.status}`);
    }
    throw new Error(data.message ?? data.error ?? `Request failed with ${response.status}`);
  }
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
  if (event.type === "agent.activity") {
    return `${String(event.payload.agentLabel ?? event.payload.agent ?? "Agent")} ${String(event.payload.status ?? "updated")}: ${String(event.payload.message ?? event.payload.tool ?? "activity")}`;
  }
  if (event.type.endsWith(".failed")) return String(event.payload.reason ?? event.payload.error ?? "Agent reported failure");
  if (event.type === "style.mint.intent.created") return "Backend prepared a real StyleRegistry.mintStyle transaction.";
  if (event.type === "style.minted") return `On-chain mint confirmed: token ${event.styleId}.`;
  if (event.type === "credit.purchase.intent.created") return "Credit purchase transaction created for MetaMask.";
  if (event.type === "credit.purchased") return "Credit purchase confirmed on-chain.";
  if (event.type === "credit.auto_refill.intent.created") return "Auto-refill configuration transaction created for MetaMask.";
  if (event.type === "credit.auto_refill.configured") return "Auto-refill budget confirmed on-chain.";
  if (event.type === "credit.replenished") return "KeeperHub confirmed an autonomous credit refill.";
  if (event.type === "credit.replenish_failed") return String(event.payload.reason ?? "KeeperHub could not refill credits.");
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

function parseBigIntSafe(value: string): bigint | null {
  try {
    return value ? BigInt(value) : null;
  } catch {
    return null;
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function getNextAction(input: {
  liveMode: boolean;
  walletReady: boolean;
  signedReady: boolean;
  uploadReady: boolean;
  mintIntentReady: boolean;
  styleReady: boolean;
  hasCredits: boolean;
  promptReady: boolean;
  spendIntentReady: boolean;
  hasDraft: boolean;
  feedbackReady: boolean;
  refined: boolean;
}): string {
  if (!input.liveMode) return "Start the backend in live 0G mode, then refresh Health.";
  if (!input.walletReady) return "Connect MetaMask on 0G Galileo.";
  if (!input.signedReady) return "Sign the writing-sample attestation.";
  if (!input.uploadReady) return "Add at least 1KB of creator-owned samples.";
  if (!input.mintIntentReady && !input.styleReady) return "Upload + profile to create the mint transaction.";
  if (input.mintIntentReady && !input.styleReady) return "Mint the style iNFT on-chain in MetaMask.";
  if (!input.hasCredits) return "Buy one credit for this wallet.";
  if (!input.promptReady) return "Enter a generation prompt.";
  if (!input.hasDraft) return "Generate the draft and platform variants.";
  if (input.spendIntentReady) return "Spend credit + settle royalty on-chain.";
  if (!input.feedbackReady) return "Add feedback to test autonomous refinement.";
  if (!input.refined) return "Send feedback and watch Style Curator refine.";
  return "Flow complete. Try another prompt or upload a new style.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

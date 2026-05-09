"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Interface, TransactionRequest, ethers } from "ethers";
import { friendlyErrorMessage } from "../../lib/friendlyErrors";
import "./test-page.css";

type AgentEvent = {
  id: string;
  type: string;
  timestamp: number;
  actor: string;
  styleId?: string;
  consumerAddress?: string;
  payload?: Record<string, unknown>;
};

type TransactionIntent = {
  to: string;
  data: string;
  value: string;
  description: string;
};

type StepState = "waiting" | "running" | "done" | "error";
type FlowStep = { label: string; state: StepState; detail?: string };
type TestPageMode = "full" | "creator" | "marketplace" | "chat";
type ChainStyleDetails = {
  tokenId: string;
  source: string;
  chain: {
    creator: string;
    royaltyWei: string;
    totalEarnings: string;
    sampleCount: number;
    listed: boolean;
    encryptedSamplesURI: string;
    profileURI: string;
    language: string;
    genres: string;
    attestationURI: string;
    metadataHash: string;
  };
  profile: Record<string, unknown> | null;
  agentBrain: Record<string, unknown> | null;
  marketplace: {
    title: string;
    status: "ready_to_generate" | "onchain_only";
    statusLabel: string;
    listed: boolean;
    summary: string;
    tags: string[];
    sampleExcerpts: string[];
    outputPreview?: string;
    outputPrompt?: string;
    outputCount: number;
    hasAgentBrain: boolean;
    hasProfile: boolean;
    updatedAt?: number;
  };
  recentOutputs: Array<{
    requestId?: string;
    prompt?: string;
    draft?: string;
    variants?: Record<string, string>;
    teeVerified?: boolean | null;
    timestamp?: number;
  }>;
  evidenceLinks: Array<{ label: string; url: string }>;
};

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

export function TestPageClient({ mode = "full" }: { mode?: TestPageMode }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [chainId, setChainId] = useState("");
  const [samplesText, setSamplesText] = useState(DEFAULT_WRITING_SAMPLE);
  const [attestationMessage, setAttestationMessage] = useState("");
  const [attestationSignature, setAttestationSignature] = useState("");
  const [resumeRequestId, setResumeRequestId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [feedback, setFeedback] = useState("");
  const [platforms, setPlatforms] = useState(["x", "thread", "instagram"]);
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
  const [streamStatus, setStreamStatus] = useState<Record<string, "connecting" | "open" | "closed" | "error">>({});
  const [selectedEventId, setSelectedEventId] = useState("");
  const [existingStyles, setExistingStyles] = useState<ChainStyleDetails[]>([]);
  const [existingStyleSource, setExistingStyleSource] = useState("");
  const [selectedExistingStyleId, setSelectedExistingStyleId] = useState("");
  const [stylesLoading, setStylesLoading] = useState(false);
  const streams = useRef<Map<string, EventSource>>(new Map());
  const eventsRef = useRef<AgentEvent[]>([]);

  const busy = busyAction.length > 0;
  const sampleCharacters = samplesText.trim().length;
  const runtime = health?.runtime as Record<string, string> | undefined;
  const zeroGHealth = (health?.["0g_health"] ?? health?.zeroG) as Record<string, unknown> | undefined;
  const latestMintIntent = [...events].reverse().find((event) => event.type === "style.mint.intent.created");
  const latestMinted = [...events].reverse().find((event) => event.type === "style.minted");
  const latestDraft = [...events].reverse().find((event) => event.type === "generation.drafted");
  const latestPublished = [...events].reverse().find((event) => event.type === "generation.published");
  const latestRefined = [...events].reverse().find((event) => event.type === "style.refined");
  const agentBrainRootHash = payloadString(latestMintIntent, "agentBrainRootHash");
  const agentBrainManifestHash = payloadString(latestMintIntent, "agentBrainManifestHash");
  const keyHash = payloadString(latestMintIntent, "keyHash");
  const keyWrapMode = payloadString(latestMintIntent, "keyWrapMode");
  const selectedExistingStyle = useMemo(
    () => existingStyles.find((style) => style.tokenId === selectedExistingStyleId) ?? existingStyles[0] ?? null,
    [existingStyles, selectedExistingStyleId]
  );
  const liveMode = runtime?.costProfile === "live_0g";
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
  const visibleEvents = useMemo(
    () => events.filter((event) => eventBelongsToMode(event, mode)),
    [events, mode]
  );
  const eventGroups = useMemo(() => {
    return requestIds.map((requestId) => ({
      requestId,
      events: visibleEvents.filter((event) => requestIdFromEvent(event) === requestId || event.id === requestId)
    }));
  }, [requestIds, visibleEvents]);
  const activityEvents = useMemo(
    () => visibleEvents.filter((event) => event.type === "agent.activity").slice(-18).reverse(),
    [visibleEvents]
  );
  const selectedEvent = useMemo(
    () => visibleEvents.find((event) => event.id === selectedEventId) ?? null,
    [selectedEventId, visibleEvents]
  );

  useEffect(() => {
    void checkHealth();
    void loadExistingStyles();
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
        const payload = eventPayload(intentEvent);
        throw new Error(String(payload.reason ?? payload.error ?? "Style profiling failed"));
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
        const payload = eventPayload(failure);
        throw new Error(String(payload.reason ?? payload.error ?? "Request failed"));
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
        throw new Error(String(eventPayload(firstTerminal).reason ?? "Generation failed"));
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
      setHealth(null);
      setError(errorMessage(flowError));
    }
  }

  async function loadExistingStyles() {
    setStylesLoading(true);
    try {
      const data = await apiGet<{ source: string; profiledCount?: number; generatedCount?: number; styles: ChainStyleDetails[] }>("/styles?max=50");
      setExistingStyleSource(`${data.source} · ${data.profiledCount ?? 0} profiled · ${data.generatedCount ?? 0} with outputs`);
      setExistingStyles(data.styles);
      setSelectedExistingStyleId((current) =>
        data.styles.some((style) => style.tokenId === current) ? current : data.styles[0]?.tokenId ?? ""
      );
    } catch (flowError) {
      setExistingStyles([]);
      setExistingStyleSource("");
      setError(errorMessage(flowError));
    } finally {
      setStylesLoading(false);
    }
  }

  function useExistingStyle(style: ChainStyleDetails) {
    setStyleId(style.tokenId);
    setPendingStyleId("");
    setMintIntent(null);
    markStep(0, "done", `Using existing style token ${style.tokenId}`);
    if (walletAddress) {
      void refreshCredits(walletAddress);
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
      source.close();
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

  const pageCopy = testPageCopy[mode];
  const showMarketplace = mode === "full" || mode === "marketplace" || mode === "chat";
  const showWorkflow = mode !== "marketplace";
  const showCreatorControls = mode === "full" || mode === "creator";
  const showChatControls = mode === "full" || mode === "chat";
  const showFeedbackControls = mode === "full" || mode === "chat";
  const showOutput = mode === "full" || mode === "chat";
  const visibleSteps = steps.filter((_step, index) => {
    if (mode === "creator") return index === 0;
    if (mode === "chat") return index !== 0;
    return true;
  });

  return (
    <main className="test-shell">
      <section className="test-header">
        <div>
          <p className="eyebrow">{pageCopy.eyebrow}</p>
          <h1>{pageCopy.title}</h1>
          <p className="header-copy">{pageCopy.description}</p>
          <div className="test-hero-stats">
            <span>{existingStyles.length} on-chain styles</span>
            <span>{existingStyles.filter((style) => style.marketplace.hasProfile).length} profiled voices</span>
            <span>{existingStyles.filter((style) => style.marketplace.outputCount > 0).length} with outputs</span>
          </div>
        </div>
        <nav className="test-nav" aria-label="Test pages">
          <Link data-active={mode === "creator"} href="/test/creator">Creator</Link>
          <Link data-active={mode === "marketplace"} href="/test/marketplace">Marketplace</Link>
          <Link data-active={mode === "chat"} href="/test/chat">Chat</Link>
          <Link data-active={mode === "full"} href="/test/full">Full lab</Link>
        </nav>
        <div className="header-actions">
          <button type="button" onClick={checkHealth} disabled={busy}>Health</button>
          <button type="button" className="primary" onClick={connectWallet} disabled={busy}>{walletAddress ? "Wallet connected" : "Connect wallet"}</button>
        </div>
      </section>

      {showMarketplace ? <section className="panel existing-styles-panel">
        <div className="panel-heading">
          <div>
            <div className="panel-title">Style marketplace</div>
            <p>Browse listed iNFT styles from the deployed registry, with profile excerpts and recent generated outputs when the backend has stored evidence for the token.</p>
          </div>
          <div className="style-count-pill">{existingStyles.length} found</div>
        </div>
        <div className="marketplace-actions">
          <button type="button" onClick={loadExistingStyles} disabled={stylesLoading}>
            {stylesLoading ? "Refreshing..." : "Refresh marketplace"}
          </button>
          <span>{existingStyleSource || "Loading registry styles"}</span>
        </div>
        <div className="existing-styles-layout">
          <div className="style-catalog-list" aria-label="Existing style list">
            {existingStyles.length === 0 ? <p className="muted">No listed on-chain styles found in the current registry scan.</p> : null}
            {existingStyles.map((style) => (
              <button
                aria-pressed={selectedExistingStyle?.tokenId === style.tokenId}
                className="style-catalog-row"
                data-selected={selectedExistingStyle?.tokenId === style.tokenId}
                data-status={style.marketplace.status}
                key={style.tokenId}
                onClick={() => setSelectedExistingStyleId(style.tokenId)}
                type="button"
              >
                <div className="style-card-top">
                  <strong>{style.marketplace.title}</strong>
                  <span>{style.marketplace.statusLabel}</span>
                </div>
                <p>{style.marketplace.summary}</p>
                <div className="style-tag-row">
                  {style.marketplace.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
                  {style.marketplace.outputCount > 0 ? <span>{style.marketplace.outputCount} output{style.marketplace.outputCount === 1 ? "" : "s"}</span> : null}
                </div>
                <small>Token {style.tokenId} · {short(style.chain.creator)} · {ethers.formatEther(style.chain.royaltyWei)} OG royalty</small>
              </button>
            ))}
          </div>
          {selectedExistingStyle ? (
            <div className="style-detail-panel">
              <div className="style-detail-head">
                <div>
                  <span>{selectedExistingStyle.marketplace.statusLabel}</span>
                  <h2>{selectedExistingStyle.marketplace.title}</h2>
                  <p>{selectedExistingStyle.marketplace.summary}</p>
                </div>
                <strong>{selectedExistingStyle.chain.listed ? "Listed" : "Unlisted"}</strong>
              </div>
              <div className="marketplace-cta-row">
                <button
                  className="primary"
                  disabled={!selectedExistingStyle.marketplace.hasProfile}
                  onClick={() => useExistingStyle(selectedExistingStyle)}
                  type="button"
                >
                  Use this style
                </button>
                <span>
                  {selectedExistingStyle.marketplace.hasProfile
                    ? `Selected token ${selectedExistingStyle.tokenId} can be used for generation.`
                    : "This legacy token has registry data but no stored voice profile for generation."}
                </span>
              </div>
              <div className="style-meta-grid">
                <ProofRow label="Creator" value={selectedExistingStyle.chain.creator} />
                <ProofRow label="Royalty" value={`${ethers.formatEther(selectedExistingStyle.chain.royaltyWei)} OG`} />
                <ProofRow label="Earnings" value={`${ethers.formatEther(selectedExistingStyle.chain.totalEarnings)} OG`} />
                <ProofRow label="Samples" value={String(selectedExistingStyle.chain.sampleCount)} />
                <ProofRow label="Language" value={selectedExistingStyle.chain.language || "not set"} />
                <ProofRow label="Genres" value={selectedExistingStyle.chain.genres || "not set"} />
              </div>
              <div className="style-meta-grid">
                <ProofRow label="Metadata hash" value={selectedExistingStyle.chain.metadataHash} />
                <ProofRow label="Profile URI" value={selectedExistingStyle.chain.profileURI || "not set"} />
                <ProofRow label="Encrypted URI" value={selectedExistingStyle.chain.encryptedSamplesURI || "not set"} />
              </div>
              <div className="style-preview-grid">
                <div>
                  <span>Sample excerpts</span>
                  {selectedExistingStyle.marketplace.sampleExcerpts.length === 0 ? (
                    <p>No creator sample excerpts were stored for this token.</p>
                  ) : (
                    selectedExistingStyle.marketplace.sampleExcerpts.map((excerpt, index) => <p key={`${selectedExistingStyle.tokenId}-excerpt-${index}`}>{excerpt}</p>)
                  )}
                </div>
                <div>
                  <span>Latest output</span>
                  <p>{selectedExistingStyle.marketplace.outputPreview || "No generated output has been recorded for this style yet."}</p>
                  {selectedExistingStyle.marketplace.outputPrompt ? <small>Prompt: {selectedExistingStyle.marketplace.outputPrompt}</small> : null}
                </div>
              </div>
              {selectedExistingStyle.recentOutputs.length > 0 ? (
                <div className="style-output-list">
                  {selectedExistingStyle.recentOutputs.map((output) => (
                    <div key={output.requestId ?? `${selectedExistingStyle.tokenId}-${output.timestamp}`}>
                      <span>{output.prompt || "Generated output"}</span>
                      {output.draft ? <p>{output.draft}</p> : null}
                      {output.variants ? (
                        <div className="mini-variants">
                          {Object.entries(output.variants).map(([platform, variant]) => (
                            <p key={platform}><strong>{platform}</strong>{variant}</p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="style-traits-grid">
                <div><span>AgentBrain root</span><strong>{agentBrainField(selectedExistingStyle, "manifestRootHash")}</strong></div>
                <div><span>Key hash</span><strong>{agentBrainField(selectedExistingStyle, "keyHash")}</strong></div>
                <div><span>Wrap mode</span><strong>{agentBrainField(selectedExistingStyle, "wrapMode")}</strong></div>
                <div><span>Profile root</span><strong>{agentBrainField(selectedExistingStyle, "profileRootHash")}</strong></div>
                <div><span>Samples root</span><strong>{agentBrainField(selectedExistingStyle, "samplesRootHash")}</strong></div>
                <div><span>Memory stream</span><strong>{agentBrainField(selectedExistingStyle, "memoryLogStream")}</strong></div>
              </div>
              <div className="style-samples-list">
                <div>
                  <span>Stored profile</span>
                  <pre className="json-box">{selectedExistingStyle.profile ? JSON.stringify(selectedExistingStyle.profile, null, 2) : "No profile found in backend storage for this token."}</pre>
                </div>
              </div>
              <div className="proof-actions">
                <a href={`/api/backend/styles/${encodeURIComponent(selectedExistingStyle.tokenId)}`} rel="noreferrer" target="_blank">Open raw style JSON</a>
                {selectedExistingStyle.agentBrain?.manifestRootHash ? (
                  <a href={`/api/backend/storage/blob?rootHash=${encodeURIComponent(String(selectedExistingStyle.agentBrain.manifestRootHash))}`} rel="noreferrer" target="_blank">
                    Open AgentBrain manifest
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section> : null}

      {showWorkflow ? <section className="workflow-overview" aria-label="Demo readiness">
        <div className="next-action-card">
          <span>Next action</span>
          <strong>{nextAction}</strong>
        </div>
        <div className="workflow-overview-stack">
          <div className="cost-strip">
            <div>
              <strong>{runtime?.costProfile === "live_0g" ? "Live 0G mode" : "Not live yet"}</strong>
              <span>{runtime?.costProfile === "live_0g" ? "This can spend OG. Every on-chain step is signed in MetaMask." : "Start backend with 0G modes before expecting on-chain writes."}</span>
            </div>
            <div>
              <strong>Backend modes</strong>
              <span>
                storage {runtime?.storage ?? "unknown"} / compute {runtime?.compute ?? "unknown"}{" "}
                {runtime?.compute_path ? `(${runtime.compute_path})` : ""} / chain {runtime?.chain ?? "unknown"} / checkpoints{" "}
                {runtime?.checkpoint_flush ?? "unknown"}
              </span>
            </div>
            <div>
              <strong>Wallet</strong>
              <span>{walletAddress ? `${short(walletAddress)} on chain ${chainId || "unknown"}` : "Connect MetaMask on 0G Galileo"}</span>
            </div>
          </div>
          <div className="readiness-grid">
            <ReadinessItem ok={liveMode} label="Backend live" detail={liveMode ? "0G storage, compute, and chain modes" : "Run backend in 0G modes"} />
            <ReadinessItem ok={walletReady} label="Wallet ready" detail={walletReady ? `${short(walletAddress)} on Galileo` : "Connect MetaMask to chain 16602"} />
            {showCreatorControls ? <ReadinessItem ok={sampleCharacters >= 1024} label="Samples ready" detail={`${sampleCharacters.toLocaleString()} characters`} /> : null}
            {showCreatorControls ? <ReadinessItem ok={signedReady} label="Attestation signed" detail={signedReady ? "Signature captured" : "Sign before upload"} /> : null}
            {showChatControls ? (
              <ReadinessItem ok={Boolean(styleId)} label="Style selected" detail={styleId ? `Token ${styleId}` : "Choose a profiled style"} />
            ) : (
              <ReadinessItem ok={Boolean(styleId)} label="iNFT minted" detail={styleId ? `Token ${styleId}` : pendingStyleId || "Waiting"} />
            )}
            {showChatControls ? <ReadinessItem ok={hasCredits} label="Credits ready" detail={creditBalance ? `${creditBalance} credit(s)` : "Refresh credits"} /> : null}
          </div>
        </div>
      </section> : null}

      {showWorkflow ? <section className="workflow-heading">
        <p className="eyebrow">Workflow lab</p>
        <h2>{pageCopy.workflowTitle}</h2>
        <p>{pageCopy.workflowDescription}</p>
      </section> : null}

      {showWorkflow ? <section className="main-grid">
        <div className="stack">
          {showCreatorControls ? <div className="panel controls-panel">
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
              <button type="button" className="primary" onClick={uploadStyle} disabled={busy || !uploadReady}>{busyAction === "upload" ? "Uploading..." : "Upload + profile"}</button>
              <button type="button" className="primary" onClick={mintOnChain} disabled={busy || !mintIntent}>{busyAction === "mint" ? "Minting..." : "Mint on-chain"}</button>
            </div>
            <div className="resume-row">
              <input placeholder="Paste request ID to resume without uploading again" value={resumeRequestId} onChange={(event) => setResumeRequestId(event.target.value)} />
              <button type="button" onClick={resumeRequest} disabled={busy || !resumeRequestId}>Load request</button>
            </div>
            <div className="field-row"><span>Style ID</span><code>{styleId || pendingStyleId || "waiting"}</code></div>
          </div> : null}

          {showChatControls ? <div className="panel controls-panel">
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
            <div className="checkbox-row">{["x", "thread", "instagram"].map((platform) => <label className="checkbox-label" key={platform}><input checked={platforms.includes(platform)} onChange={() => togglePlatform(platform)} type="checkbox" />{platform}</label>)}</div>
            <div className="button-row multi-actions">
              <button type="button" className="primary" onClick={generateContent} disabled={busy || !styleId || !prompt.trim()}>{busyAction === "generate" ? "Generating..." : "Generate"}</button>
              <button type="button" className="primary" onClick={settleOnChain} disabled={busy || !spendIntent}>{busyAction === "settle" ? "Settling..." : "Spend credit + settle royalty"}</button>
            </div>
          </div> : null}

          {showFeedbackControls ? <div className="panel controls-panel">
            <div className="panel-heading"><div><div className="panel-title">3. Feedback refinement</div><p>Feedback writes an event. The Style Curator refines the profile from that event.</p></div></div>
            <label>Feedback<textarea placeholder="Tell the agent what was off about the generated voice." value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label>
            <div className="button-row"><button type="button" className="primary" onClick={sendFeedback} disabled={busy || !styleId || !feedback}>{busyAction === "feedback" ? "Sending..." : "Send feedback"}</button></div>
            {error ? <div className="error-box">{error}</div> : null}
          </div> : null}
        </div>

        <div className="stack sticky-stack">
          <div className="panel"><div className="panel-title">What happened</div><div className="explain-list">
            {showCreatorControls ? <Explain done={Boolean(latestMinted)} title="Style minted" waiting="Upload, sign, then mint the iNFT on-chain." doneText="The style profile exists and the wallet confirmed the iNFT mint on-chain." /> : null}
            {showChatControls ? <Explain done={Boolean(latestDraft)} title="Draft generated" waiting="Buy credits, then generate." doneText="The Content Creator produced a draft from the confirmed style token." /> : null}
            {showChatControls ? <Explain done={Boolean(latestPublished && spendIntent)} title="Settlement ready" waiting="Generate to create a spend-credit transaction." doneText="A real CreditSystem.spendCredit transaction is ready for MetaMask." /> : null}
            {showFeedbackControls ? <Explain done={Boolean(latestRefined)} title="Feedback refined" waiting="Send feedback after generation." doneText="The Style Curator refined the profile from a feedback event." /> : null}
          </div></div>

          <div className="panel"><div className="panel-title">Lifecycle</div><div className="steps">{visibleSteps.map((step) => <div className="step" data-state={step.state} key={step.label}><span className="step-dot" /><div><strong>{step.label}</strong><span>{step.detail ?? step.state}</span></div></div>)}</div></div>

          <div className="panel proof-panel">
            <div className="panel-title">AgentBrain + proof</div>
            <div className="proof-list">
              <ProofRow label="AgentBrain root" value={agentBrainRootHash || "Waiting for style.mint.intent.created"} />
              <ProofRow label="Manifest hash" value={agentBrainManifestHash || "Waiting"} />
              <ProofRow label="Content key hash" value={keyHash || "Waiting"} />
              <ProofRow label="Key wrap mode" value={keyWrapMode || "Waiting"} />
              <ProofRow
                label="0G health"
                value={
                  zeroGHealth
                    ? `chain ${String(zeroGHealth.chain_reachable ?? "unknown")} / storage ${String(zeroGHealth.storage_indexer_reachable ?? "unknown")} / compute ${String(zeroGHealth.compute_provider_reachable ?? "unknown")}`
                    : "Run Health"
                }
              />
            </div>
            <div className="proof-actions">
              {requestIds.length === 0 ? <span>No request IDs yet.</span> : null}
              {requestIds.map((requestId) => (
                <a href={proofHref(requestId)} key={requestId} rel="noreferrer" target="_blank">
                  Open proof {shortRequest(requestId)}
                </a>
              ))}
              {agentBrainRootHash ? (
                <a href={`/api/backend/storage/blob?rootHash=${encodeURIComponent(agentBrainRootHash)}`} rel="noreferrer" target="_blank">
                  Open AgentBrain manifest
                </a>
              ) : null}
            </div>
          </div>

          <div className="panel activity-panel">
            <div className="panel-title">Live agent activity</div>
            <div className="activity-list">
              {activityEvents.length === 0 ? <p className="muted">No agent activity yet. Start upload or generation.</p> : null}
              {activityEvents.map((event) => {
                const payload = eventPayload(event);
                return (
                  <button
                    aria-pressed={selectedEventId === event.id}
                    className="activity-row"
                    data-selected={selectedEventId === event.id}
                    data-state={String(payload.status ?? "completed")}
                    key={event.id}
                    onClick={() => setSelectedEventId(event.id)}
                    type="button"
                  >
                    <div>
                      <strong>{String(payload.agentLabel ?? payload.agent ?? "Agent")}</strong>
                      <span>{String(payload.tool ?? "tool")}</span>
                    </div>
                    <p>{String(payload.message ?? eventExplanation(event))}</p>
                    <time>{formatTime(event.timestamp)}</time>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="panel raw-panel">
            <div className="raw-heading">
              <div className="panel-title">Raw selected log</div>
              {selectedEvent ? <button type="button" onClick={() => setSelectedEventId("")}>Clear</button> : null}
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
              <p className="muted">Click any activity row or event log row to inspect the exact raw event payload.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">Transaction intents</div>
            <div className="intent-list">
              {showCreatorControls ? <IntentPreview title="Mint iNFT" intent={mintIntent} readyLabel={pendingStyleId || "Ready after upload"} /> : null}
              {showChatControls ? <IntentPreview title="Spend credit" intent={spendIntent} readyLabel={styleId ? `Style ${styleId}` : "Ready after generation"} /> : null}
            </div>
          </div>

          <div className="panel"><div className="panel-title">Latest on-chain tx</div><div className="output-box">{lastTxHash ? <a href={`${GALILEO_EXPLORER}/tx/${lastTxHash}`} rel="noreferrer" target="_blank">{lastTxHash}</a> : "No transaction sent yet."}</div></div>
          <div className="panel"><div className="panel-title">Agents</div><pre className="json-box">{health ? JSON.stringify(health, null, 2) : "No health check yet."}</pre></div>
        </div>
      </section> : null}

      {showOutput ? <section className="output-grid">
        <div className="panel"><div className="panel-title">Generated draft</div><div className="output-box">{generatedDraft || "No draft yet."}</div></div>
        <div className="panel"><div className="panel-title">Platform variants</div>{Object.keys(platformVariants).length === 0 ? <p className="muted">No variants yet.</p> : <div className="variant-list">{Object.entries(platformVariants).map(([platform, variant]) => <div key={platform}><strong>{platform}</strong><p>{variant}</p></div>)}</div>}</div>
      </section> : null}

      {showWorkflow ? <section className="panel events-panel">
        <div className="panel-title">Real-time event log</div>
        <div className="event-list">{eventGroups.length === 0 ? <p className="muted">No events yet.</p> : null}{eventGroups.map((group) => <div className="event-group" key={group.requestId}><div className="event-group-head"><code>{group.requestId}</code><div><a href={proofHref(group.requestId)} rel="noreferrer" target="_blank">Proof</a><span data-state={streamStatus[group.requestId] ?? "closed"}>{streamStatus[group.requestId] ?? "closed"}</span></div></div>{group.events.map((event) => <button aria-pressed={selectedEventId === event.id} className="event-row" data-selected={selectedEventId === event.id} data-type={event.type === "agent.activity" ? "activity" : "event"} key={event.id} onClick={() => setSelectedEventId(event.id)} type="button"><span>{event.type}</span><small>{eventExplanation(event)}</small><time>{formatTime(event.timestamp)}</time></button>)}</div>)}</div>
      </section> : null}
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

function ProofRow({ label, value }: { label: string; value: string }) {
  return <div className="proof-row"><span>{label}</span><code>{value}</code></div>;
}

function eventPayload(event: AgentEvent | undefined): Record<string, unknown> {
  const payload = event?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function eventBelongsToMode(event: AgentEvent, mode: TestPageMode): boolean {
  if (mode === "full") return true;
  if (mode === "marketplace") return false;

  const payload = eventPayload(event);
  const tool = typeof payload.tool === "string" ? payload.tool : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  const type = event.type;

  const creatorTools = new Set([
    "verify_attestation",
    "encrypt_and_store_samples",
    "extract_style_profile",
    "build_and_upload_agent_brain",
    "mint_inft"
  ]);
  const chatTools = new Set([
    "check_credit_balance",
    "read_style_profile",
    "pull_relevant_samples",
    "generate_with_voice",
    "log_draft",
    "handoff_to_distribution",
    "tune_for_platform",
    "prepare_credit_topup",
    "handoff_to_curator",
    "refine_profile_from_feedback"
  ]);

  if (mode === "creator") {
    if (type === "style.uploaded" || type === "style.failed" || type === "style.mint.intent.created" || type === "style.minted") return true;
    if (type !== "agent.activity") return false;
    return creatorTools.has(tool) || (tool === "langgraph.invoke" && message.includes("style.uploaded"));
  }

  if (type === "generation.requested" || type === "generation.drafted" || type === "generation.published") return true;
  if (type === "feedback.received" || type === "style.refined") return true;
  if (type === "credit.low" || type === "credit.purchased" || type === "credit.deducted" || type === "royalty.settled" || type === "settlement.intent.created") return true;
  if (type !== "agent.activity") return false;
  return chatTools.has(tool) || (tool === "langgraph.invoke" && !message.includes("style.uploaded"));
}

function agentBrainField(style: ChainStyleDetails, field: string): string {
  const value = style.agentBrain?.[field];
  return typeof value === "string" && value.length > 0 ? value : "not found";
}

const testPageCopy: Record<TestPageMode, {
  eyebrow: string;
  title: string;
  description: string;
  workflowTitle: string;
  workflowDescription: string;
}> = {
  full: {
    eyebrow: "Voices full lab",
    title: "Test the complete live workflow",
    description: "Browse on-chain creator styles, mint a new voice, generate with the agent swarm, and inspect every 0G proof trail from one workspace.",
    workflowTitle: "Mint, generate, and prove the selected voice",
    workflowDescription: "Use an existing marketplace style for generation, or create a fresh iNFT style and follow the live agent events, transaction intents, and proof links from the same workspace."
  },
  creator: {
    eyebrow: "Style creator",
    title: "Create and mint a real voice iNFT",
    description: "Paste creator-owned samples, sign the attestation, run the Style Curator, and mint the resulting AgentBrain-backed style on-chain.",
    workflowTitle: "Upload, profile, and mint",
    workflowDescription: "This page isolates the creator flow so you can test sample encryption, AgentBrain manifest creation, mint intent generation, and the final wallet-signed iNFT mint."
  },
  marketplace: {
    eyebrow: "Style marketplace",
    title: "Browse real on-chain styles",
    description: "Inspect deployed StyleRegistry tokens with the actual creator metadata, stored voice profile, AgentBrain evidence, and recent generated outputs.",
    workflowTitle: "",
    workflowDescription: ""
  },
  chat: {
    eyebrow: "Use style chat",
    title: "Generate with a selected creator voice",
    description: "Choose a profiled marketplace style, run generation through the backend agents, and settle credits and royalties from a focused chat workspace.",
    workflowTitle: "Pick a style and generate",
    workflowDescription: "Use the marketplace selector above, then test credits, generation, platform variants, settlement, feedback, and proof links without the style-creation form in the way."
  }
};

const initialSteps: FlowStep[] = [
  { label: "Style upload/profile", state: "waiting" },
  { label: "Draft generation", state: "waiting" },
  { label: "On-chain settlement", state: "waiting" },
  { label: "Feedback refinement", state: "waiting" }
];

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
  let data: { message?: string; error?: string; backendUrl?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as { message?: string; error?: string; backendUrl?: string };
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) {
    if (data.error === "backend_unavailable") {
      throw new Error(friendlyErrorMessage(`Backend is offline at ${data.backendUrl}. Restart it and refresh Health. Details: ${data.message ?? response.status}`));
    }
    throw new Error(friendlyErrorMessage(data.message ?? data.error ?? `Request failed with ${response.status}`));
  }
  return data as T;
}

function parseSamples(samplesText: string): string[] {
  return samplesText.split(/\n-{3,}\n/g).map((sample) => sample.trim()).filter(Boolean);
}

function payloadIntent(event: AgentEvent | undefined, key: string): TransactionIntent | null {
  const value = eventPayload(event)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Partial<TransactionIntent>;
  return intent.to && intent.data && typeof intent.value === "string" ? (intent as TransactionIntent) : null;
}

function payloadString(event: AgentEvent | undefined, key: string): string {
  const value = eventPayload(event)[key];
  return typeof value === "string" ? value : "";
}

function payloadRecord(event: AgentEvent | undefined, key: string): Record<string, string> {
  const value = eventPayload(event)[key];
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
  const payload = eventPayload(event);
  return typeof payload.requestId === "string" ? payload.requestId : undefined;
}

function belongsToRequest(event: AgentEvent, requestId: string): boolean {
  return requestIdFromEvent(event) === requestId || event.id === requestId;
}

function eventExplanation(event: AgentEvent): string {
  const payload = eventPayload(event);
  if (event.type === "agent.activity") {
    return `${String(payload.agentLabel ?? payload.agent ?? "Agent")} ${String(payload.status ?? "updated")}: ${String(payload.message ?? payload.tool ?? "activity")}`;
  }
  if (event.type.endsWith(".failed")) return String(payload.reason ?? payload.error ?? "Agent reported failure");
  if (event.type === "style.mint.intent.created") {
    const root = payloadString(event, "agentBrainRootHash");
    const key = payloadString(event, "keyHash");
    return root && key ? `Mint intent includes AgentBrain ${shortHash(root)} and key hash ${shortHash(key)}.` : "Backend prepared a real StyleRegistry.mintStyle transaction.";
  }
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

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

function shortRequest(value: string): string {
  return value.length > 10 ? `${value.slice(0, 5)}...${value.slice(-4)}` : value;
}

function proofHref(requestId: string): string {
  return `/api/backend/proof/${encodeURIComponent(requestId)}`;
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
  return friendlyErrorMessage(error);
}

"use client";

import { BrowserProvider } from "ethers";
import Link from "next/link";
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TransactionRequest } from "ethers";
import { Navbar } from "../../../../components/Navbar";
import { useWallet } from "../../../../context/WalletContext";
import { ChainStyleDetails, parseJsonResponse, registryStyleToModel, shortAddress } from "../../../../lib/registryStyles";
import { readMintedStyles } from "../../../../lib/mintedStyles";
import { getStyle, StyleModel } from "../../../../lib/styles";
import { CONTRACTS, explorerAddressUrl } from "../../../../lib/proofTrail";
import { friendlyErrorMessage } from "../../../../lib/friendlyErrors";

type PageProps = { params: { slug: string } };

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
  description?: string;
};

type SentTransaction = {
  hash: string;
  from: string;
};

type SendIntentOptions = {
  onSubmitted?: (tx: SentTransaction) => void;
};

type RunStatus =
  | "submitting"
  | "running"
  | "drafted"
  | "awaiting_settlement"
  | "settling"
  | "settled"
  | "credit_low"
  | "credit_ready"
  | "failed";

type LiveRun = {
  startedAt: number;
  prompt: string;
  styleTitle: string;
  requestId?: string;
  relatedRequestIds: string[];
  events: AgentEvent[];
  status: RunStatus;
  busyAction?: "buy_credit" | "settle";
  error?: string;
  lastTxHash?: string;
};

type Msg = { id: string; role: "user" | "assistant"; text: string; liveRun?: LiveRun };
type MsgGroup = { role: "user" | "assistant"; messages: Msg[] };
type CreditState = "idle" | "loading" | "ready" | "buying" | "error";
type CreditInfo = { credits: string; creditPriceWei: string };
type RecentCreditPurchase = {
  requestId: string;
  txHash: string;
  amount: number;
  timestamp: number;
};

type GenerationPlatform = "x" | "thread" | "instagram" | "blog" | "github_readme";
type CrewAgentKey = "voice_context" | "style_writer" | "voice_critic_memory";
type CrewAgentState = "pending" | "started" | "progress" | "completed" | "failed" | "handoff";

const PLATFORM_OPTIONS: Array<{ id: GenerationPlatform; label: string; shortLabel: string; helper: string }> = [
  { id: "x", label: "Twitter / X", shortLabel: "X", helper: "Single tweet" },
  { id: "thread", label: "Tweet thread", shortLabel: "Thread", helper: "3-5 tweets" },
  { id: "instagram", label: "Instagram", shortLabel: "IG", helper: "Caption" },
  { id: "blog", label: "Blog article", shortLabel: "Blog", helper: "Markdown article" },
  { id: "github_readme", label: "GitHub README", shortLabel: "README", helper: "Markdown docs" }
];

const CREW_AGENT_STEPS: Array<{ key: CrewAgentKey; label: string; tool: string; short: string }> = [
  { key: "voice_context", label: "Voice Context", tool: "crewai.voice_context", short: "0G evidence" },
  { key: "style_writer", label: "Style Writer", tool: "crewai.style_writer", short: "0G Compute" },
  { key: "voice_critic_memory", label: "Critic + Memory", tool: "crewai.voice_critic_memory", short: "0G memory" }
];

const POLL_INTERVAL_MS = 1500;
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL_TYPES = ["generation.published", "credit.low", "generation.failed"];

function shortPrompt(v: string) {
  const n = v.replace(/\s+/g, " ").trim();
  return n.length > 64 ? `${n.slice(0, 64)}...` : n;
}

function formatTime(timestamp: number | undefined) {
  if (!timestamp) return "--:--";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function groupMessages(msgs: Msg[]): MsgGroup[] {
  return msgs.reduce<MsgGroup[]>((acc, msg) => {
    const last = acc[acc.length - 1];
    if (last && last.role === msg.role) {
      last.messages.push(msg);
      return acc;
    }
    acc.push({ role: msg.role, messages: [msg] });
    return acc;
  }, []);
}

function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconVoice() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" />
    </svg>
  );
}

function selectedPlatform(platforms: GenerationPlatform[]): GenerationPlatform {
  return platforms[0] ?? "x";
}

function LiveGeneration({
  run,
  expanded,
  onToggle,
  onBuyCredit,
  onSettle,
  onRetry,
}: {
  run: LiveRun;
  expanded: boolean;
  onToggle: () => void;
  onBuyCredit: () => void;
  onSettle: () => void;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const snapshot = deriveRun(run);
  const isBusy = Boolean(run.busyAction) || run.status === "submitting" || run.status === "running" || run.status === "settling";
  const timelineEvents = useMemo(() => [...run.events].reverse(), [run.events]);
  const crewSummary = useMemo(() => deriveCrewSummary(run.events), [run.events]);
  const durationSeconds = Math.max(1, Math.round(((run.events.at(-1)?.timestamp ?? Date.now()) - run.startedAt) / 1000));
  const rawRunJson = JSON.stringify({
    status: run.status,
    requestId: run.requestId ?? null,
    relatedRequestIds: run.relatedRequestIds,
    prompt: run.prompt,
    styleTitle: run.styleTitle,
    durationSeconds,
    summary: snapshot,
    events: run.events
  }, null, 2);

  function copyText() {
    if (!snapshot.finalText) return;
    navigator.clipboard.writeText(snapshot.finalText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <div className="tryLiveWrap">
      <div className="tryThinkingTopbar">
        <button type="button" className="tryThinkingToggle" onClick={onToggle} aria-expanded={expanded}>
          <span className={`tryThinkingDot tryThinkingDot-${snapshot.tone}${snapshot.isTerminal ? "" : " tryThinkingDotPulse"}`} aria-hidden="true" />
          <span className="tryThinkingToggleText">
            <strong>{snapshot.isTerminal ? `Thought for ${durationSeconds}s` : snapshot.label}</strong>
            <small>{run.events.length ? `${run.events.length} backend log${run.events.length === 1 ? "" : "s"}` : "Waiting for first backend log"}</small>
          </span>
          <span className={`tryChevron${expanded ? " tryChevronOpen" : ""}`} aria-hidden="true">›</span>
        </button>

        <button
          type="button"
          className={`tryRawJsonToggle${showRawJson ? " tryRawJsonToggleOpen" : ""}`}
          onClick={() => setShowRawJson((open) => !open)}
          aria-expanded={showRawJson}
        >
          Raw JSON
          <span aria-hidden="true">›</span>
        </button>
      </div>

      {showRawJson ? (
        <pre className="tryRunRawJson">{rawRunJson}</pre>
      ) : null}

      {expanded && (
        <div className="tryTracePanel">
          <div className="tryTraceToolbar">
            <div className="tryRunMeta">
              <span>{run.requestId ? `Request ${shortHash(run.requestId)}` : "Submitting request"}</span>
              <span>CrewAI voice swarm</span>
              <span>{snapshot.computeVerified}</span>
            </div>
            {run.requestId ? <a href={`/api/backend/proof/${encodeURIComponent(run.requestId)}`} target="_blank" rel="noreferrer">Proof</a> : null}
          </div>

          <div className="tryCrewPanel" aria-label="CrewAI generation agents">
            <div className="tryCrewPanelHead">
              <strong>CrewAI generation</strong>
              <span>{crewSummary.completedCount}/{CREW_AGENT_STEPS.length} complete</span>
            </div>
            <div className="tryCrewGrid">
              {crewSummary.agents.map((agent) => (
                <div key={agent.key} className="tryCrewAgent" data-state={agent.state}>
                  <span className="tryCrewAgentDot" aria-hidden="true" />
                  <div>
                    <strong>{agent.label}</strong>
                    <small>{agent.statusLabel}</small>
                  </div>
                  <em>{agent.short}</em>
                </div>
              ))}
            </div>
          </div>

          <div className="tryLogList" role="log" aria-live="polite">
            <div className="tryLogTitleRow">
              <strong>Logs</strong>
              <span>{timelineEvents.length} event{timelineEvents.length === 1 ? "" : "s"}</span>
            </div>
            {run.events.length === 0 ? (
              <div className="tryLogEmpty">Waiting for backend events from the CrewAI and 0G workflow...</div>
            ) : (
              timelineEvents.map((event, index) => <TraceEvent key={event.id} event={event} isLast={index === timelineEvents.length - 1} />)
            )}
          </div>
        </div>
      )}

      {snapshot.finalText ? (
        <div className="tryOutputCard">
          <div className="tryOutputCardHead">
            <div>
              <div className="tryOutputKicker">Generated response</div>
              <div className="tryOutputStyle">{run.styleTitle}</div>
            </div>
            <div className="tryOutputHeadRight">
              <span className={`tryOutputReadyPill tryOutputReadyPill-${snapshot.tone}`}>{snapshot.outputPill}</span>
              <button type="button" className="tryOutputCopyBtn" onClick={copyText} aria-label="Copy response">
                {copied ? <IconCheck /> : <IconCopy />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {snapshot.variantEntries.length > 1 ? (
            <div className="tryOutputVariants">
              {snapshot.variantEntries.map(([platform, text]) => (
                <div key={platform} className="tryVariantBlock">
                  <strong>{platformLabel(platform)}</strong>
                  <GeneratedOutput platform={platform} text={text} compact />
                </div>
              ))}
            </div>
          ) : (
            <GeneratedOutput platform={snapshot.variantEntries[0]?.[0]} text={snapshot.finalText} />
          )}

          <div className="trySettlementPanel" data-state={snapshot.settlementState}>
            <div>
              <strong>{snapshot.settlementTitle}</strong>
              <p>{snapshot.settlementDetail}</p>
              <span className="tryOutputPrompt">"{shortPrompt(run.prompt)}"</span>
              {run.lastTxHash ? (
                <a className="tryOutputTx" href={chainTxUrl(run.lastTxHash)} target="_blank" rel="noreferrer">
                  Submitted tx {shortHash(run.lastTxHash)}
                </a>
              ) : null}
            </div>
            <div className="trySettlementActions">
              {snapshot.canBuyCredit ? (
                <button type="button" className="tryActionButton" onClick={onBuyCredit} disabled={isBusy}>
                  {run.busyAction === "buy_credit" ? "Buying credit..." : "Buy 1 credit"}
                </button>
              ) : null}
              {snapshot.canRetry ? (
                <button type="button" className="tryActionButton tryActionButtonSecondary" onClick={onRetry} disabled={isBusy}>
                  Generate again
                </button>
              ) : null}
              {snapshot.canSettle ? (
                <button type="button" className="tryActionButton" onClick={onSettle} disabled={isBusy}>
                  {run.busyAction === "settle" || run.status === "settling" ? "Syncing..." : run.lastTxHash ? "Sync royalty" : "Pay royalty"}
                </button>
              ) : null}
              {snapshot.proofHref ? <a className="tryProofLink" href={snapshot.proofHref} target="_blank" rel="noreferrer">Open proof</a> : null}
            </div>
          </div>
        </div>
      ) : null}

      {snapshot.error ? <div className="tryErrorText">{snapshot.error}</div> : null}
    </div>
  );
}

function TraceEvent({ event, isLast }: { event: AgentEvent; isLast: boolean }) {
  const [showJson, setShowJson] = useState(false);
  const payload = eventPayload(event);
  const status = String(payload.status ?? (event.type.endsWith(".failed") ? "failed" : event.type.includes("intent") ? "ready" : "completed"));
  const title = event.type === "agent.activity" ? String(payload.agentLabel ?? payload.agent ?? "Agent") : event.type;
  const subtitle = event.type === "agent.activity" ? String(payload.tool ?? "agent.activity") : event.actor;
  const badges = traceBadges(event);
  const agentOutput = agentOutputForDisplay(event);
  return (
    <div className="tryLogEvent" data-status={status} data-crew={isCrewEvent(event) ? "true" : "false"}>
      <div className="tryLogRail" aria-hidden="true">
        <span className="tryLogDot" />
        {!isLast ? <span className="tryLogLine" /> : null}
      </div>
      <div className="tryLogCard">
        <div className="tryLogHead">
          <div className="tryLogHeadMain">
            <strong>{title}</strong>
            <time>{formatTime(event.timestamp)}</time>
          </div>
          <button
            type="button"
            className={`tryEventJsonToggle${showJson ? " tryEventJsonToggleOpen" : ""}`}
            onClick={() => setShowJson((open) => !open)}
            aria-expanded={showJson}
          >
            JSON
            <span aria-hidden="true">›</span>
          </button>
        </div>
        <div className="tryLogMessageRow">
          <p>{eventExplanation(event)}</p>
          <small>{subtitle}</small>
        </div>
        {showJson ? (
          <pre className="tryEventJsonPre">{JSON.stringify(event, null, 2)}</pre>
        ) : null}
        {badges.length ? (
          <div className="tryLogBadges">
            {badges.map((badge) => <span key={badge}>{badge}</span>)}
          </div>
        ) : null}
        {agentOutput ? (
          <details className="tryAgentOutput">
            <summary>{agentOutput.title}</summary>
            <pre>{agentOutput.text}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export default function TryStylePage({ params }: PageProps) {
  const staticStyle = useMemo(() => getStyle(params.slug), [params.slug]);
  const { address, isOnCorrectNetwork, switchNetwork } = useWallet();
  const [mintedStyle, setMintedStyle] = useState<StyleModel | undefined>(undefined);
  const [registryDetails, setRegistryDetails] = useState<ChainStyleDetails | undefined>(undefined);
  const [registryStyle, setRegistryStyle] = useState<StyleModel | undefined>(undefined);
  const [registryState, setRegistryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [registryError, setRegistryError] = useState("");
  const [mounted, setMounted] = useState(false);
  const style = staticStyle ?? mintedStyle ?? registryStyle;
  const styleId = registryDetails?.tokenId ?? style?.id ?? params.slug;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [creditState, setCreditState] = useState<CreditState>("idle");
  const [creditInfo, setCreditInfo] = useState<CreditInfo | null>(null);
  const [creditError, setCreditError] = useState("");
  const [isCreditPopoverOpen, setIsCreditPopoverOpen] = useState(false);
  const [isProofPopoverOpen, setIsProofPopoverOpen] = useState(false);
  const [creditBuyAmount, setCreditBuyAmount] = useState(1);
  const [recentCreditPurchase, setRecentCreditPurchase] = useState<RecentCreditPurchase | null>(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState<GenerationPlatform[]>(["x"]);
  const [platformTouched, setPlatformTouched] = useState(false);
  const streams = useRef<Map<string, EventSource>>(new Map());
  const pendingTransactionLocks = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const proofMenuRef = useRef<HTMLDivElement | null>(null);
  const creditMenuRef = useRef<HTMLDivElement | null>(null);

  const loadRegistryStyle = useCallback(async () => {
    setRegistryState("loading");
    setRegistryError("");
    try {
      const res = await fetch(`/api/backend/styles/${encodeURIComponent(params.slug)}`, { cache: "no-store" });
      const data = await parseJsonResponse<ChainStyleDetails>(res);
      setRegistryDetails(data);
      setRegistryStyle(registryStyleToModel(data));
      setRegistryState("ready");
    } catch (error) {
      setRegistryDetails(undefined);
      setRegistryStyle(undefined);
      setRegistryError(friendlyErrorMessage(error));
      setRegistryState("error");
    }
  }, [params.slug]);

  useEffect(() => {
    setMounted(true);
    const minted = readMintedStyles().find((s) => s.id === params.slug);
    setMintedStyle(minted);
    setRegistryDetails(undefined);
    setRegistryStyle(undefined);
    setRegistryError("");
    if (!staticStyle && !minted) void loadRegistryStyle();
    else setRegistryState("idle");
  }, [loadRegistryStyle, params.slug, staticStyle]);

  useEffect(() => {
    if (!style) return;
    setMessages([{
      id: "intro",
      role: "assistant",
      text: `You're using ${style.title} through the live Voices backend.\n\nSend a prompt and I will call the CrewAI voice swarm, stream the 0G agent logs, return the generated draft, and prepare the on-chain royalty settlement.`,
    }]);
    setPlatformTouched(false);
  }, [style?.id, style?.title]);

  useEffect(() => {
    if (!style || platformTouched) return;
    setSelectedPlatforms([recommendedPlatformForStyle(style, registryDetails?.profile)]);
  }, [platformTouched, registryDetails?.profile, style]);

  useEffect(() => {
    return () => {
      for (const source of streams.current.values()) {
        source.close();
      }
      streams.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!address) {
      setCreditState("idle");
      setCreditInfo(null);
      setCreditError("");
      setRecentCreditPurchase(null);
      return;
    }
    void refreshCredits();
  }, [address]);

  useEffect(() => {
    if (!isCreditPopoverOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!creditMenuRef.current?.contains(target)) {
        setIsCreditPopoverOpen(false);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setIsCreditPopoverOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCreditPopoverOpen]);

  useEffect(() => {
    if (!isProofPopoverOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!proofMenuRef.current?.contains(target)) {
        setIsProofPopoverOpen(false);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setIsProofPopoverOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProofPopoverOpen]);

  useEffect(() => {
    function openProofFromHash() {
      if (window.location.hash === "#proof-trail") {
        setIsProofPopoverOpen(true);
      }
    }
    openProofFromHash();
    window.addEventListener("hashchange", openProofFromHash);
    return () => window.removeEventListener("hashchange", openProofFromHash);
  }, []);

  const groups = useMemo(() => groupMessages(messages), [messages]);
  const hasBusyRun = useMemo(() => messages.some((m) => m.liveRun && isRunBusy(m.liveRun)), [messages]);
  const latestRun = useMemo(() => [...messages].reverse().find((m) => m.liveRun)?.liveRun, [messages]);
  const latestProofRequestId = latestRun?.requestId ?? registryDetails?.recentOutputs?.find((output) => output.requestId)?.requestId;
  const creditCount = parseCreditCount(creditInfo?.credits);
  const hasCredits = creditCount > 0n;
  const creditStatusLabel = creditState === "loading"
    ? "Checking credits"
    : creditState === "buying"
      ? "Buying credit"
      : creditState === "error"
        ? creditError.toLowerCase().includes("not enough og")
          ? "Not enough OG"
          : "Credit check failed"
        : !address
          ? "Wallet required"
          : hasCredits
            ? "Ready"
            : "Credit required";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, latestRun?.events.length, latestRun?.status]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !style || hasBusyRun) return;

    const walletAddress = await resolveWalletAddress(address);

    if (!walletAddress) {
      addAssistantNotice("Connect a wallet first. Generation spends one credit and the settlement transaction pays the creator royalty on 0G Chain.");
      return;
    }
    if (!isOnCorrectNetwork) {
      addAssistantNotice("Switch your wallet to 0G Galileo before generating. The backend will still stream logs, but the royalty payment needs the correct chain.");
      return;
    }
    if (creditState === "buying") {
      addAssistantNotice("Credit status is still updating. Wait for the credit gate to finish before starting generation.");
      return;
    }
    let activeCreditInfo = creditInfo;
    if (!sameAddress(walletAddress, address) || !activeCreditInfo || creditState === "loading") {
      setCreditState("loading");
      setCreditError("");
      try {
        activeCreditInfo = await apiGet<CreditInfo>(`/credits/${encodeURIComponent(walletAddress)}`);
        setCreditInfo(activeCreditInfo);
        setCreditState("ready");
      } catch (error) {
        setCreditState("error");
        const message = friendlyErrorMessage(error);
        setCreditError(message);
        addAssistantNotice(message);
        return;
      }
    }
    if (parseCreditCount(activeCreditInfo?.credits) <= 0n) {
      addAssistantNotice("Buy at least one credit before writing a prompt. This prevents the backend from starting a generation that cannot be settled.");
      return;
    }

    const now = Date.now().toString(36);
    const assistantId = `a-${now}`;
    const startedAt = Date.now();
    const userMsg: Msg = { id: `u-${now}`, role: "user", text: trimmed };
    const assistantMsg: Msg = {
      id: assistantId,
      role: "assistant",
      text: "",
      liveRun: {
        startedAt,
        prompt: trimmed,
        styleTitle: style.title,
        relatedRequestIds: [],
        events: [],
        status: "submitting"
      }
    };

    setMessages((current) => [...current, userMsg, assistantMsg]);
    setExpandedThinking((current) => ({ ...current, [assistantId]: true }));
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "44px";

    try {
      const generated = await apiPost<{ requestId: string }>("/generate", {
        walletAddress,
        styleId,
        prompt: trimmed,
        platforms: [selectedPlatform(selectedPlatforms)],
        ...(styleHintFor(style) ? { styleHint: styleHintFor(style) } : {})
      });
      updateRun(assistantId, (run) => ({
        ...run,
        requestId: generated.requestId,
        relatedRequestIds: [generated.requestId],
        status: "running"
      }));
      openEventStream(assistantId, generated.requestId);
      void monitorGeneration(assistantId, generated.requestId);
    } catch (error) {
      updateRun(assistantId, (run) => ({ ...run, status: "failed", error: friendlyErrorMessage(error) }));
    }
  }

  async function monitorGeneration(messageId: string, requestId: string) {
    try {
      await waitForAny(messageId, requestId, TERMINAL_TYPES, GENERATION_TIMEOUT_MS);
    } catch (error) {
      updateRun(messageId, (run) => ({ ...run, status: "failed", error: friendlyErrorMessage(error) }));
    }
  }

  async function buyCreditForRun(messageId: string, run: LiveRun) {
    const walletAddress = await resolveWalletAddress(address);
    if (!walletAddress) {
      updateRun(messageId, (current) => ({ ...current, error: "Connect a wallet before buying credits." }));
      return;
    }
    const lockKey = transactionLockKey("credit", messageId, walletAddress);
    if (!claimTransactionLock(lockKey)) {
      updateRun(messageId, (current) => ({ ...current, error: pendingTransactionMessage(current.lastTxHash) }));
      return;
    }
    updateRun(messageId, (current) => ({ ...current, busyAction: "buy_credit", error: undefined }));
    try {
      const buy = await apiPost<{ requestId: string; intent: TransactionIntent }>("/credits/buy-intent", {
        walletAddress,
        amount: "1"
      });
      updateRun(messageId, (current) => ({
        ...current,
        relatedRequestIds: addUnique(current.relatedRequestIds, buy.requestId)
      }));
      openEventStream(messageId, buy.requestId);
      const receipt = await sendIntent(buy.intent, {
        onSubmitted: (tx) => {
          setRecentCreditPurchase({ requestId: buy.requestId, txHash: tx.hash, amount: 1, timestamp: Date.now() });
          updateRun(messageId, (current) => ({ ...current, lastTxHash: tx.hash }));
        }
      });
      await apiPost("/credits/confirm-purchase", {
        requestId: buy.requestId,
        walletAddress: receipt.from,
        amount: "1",
        txHash: receipt.hash
      });
      setRecentCreditPurchase({
        requestId: buy.requestId,
        txHash: receipt.hash,
        amount: 1,
        timestamp: Date.now()
      });
      await fetchEvents(messageId, buy.requestId);
      await refreshCredits(receipt.from);
      updateRun(messageId, (current) => ({ ...current, busyAction: undefined, lastTxHash: receipt.hash }));
    } catch (error) {
      updateRun(messageId, (current) => ({ ...current, busyAction: undefined, error: friendlyErrorMessage(error, { action: "buy credits" }) }));
    } finally {
      releaseTransactionLock(lockKey);
    }
  }

  async function settleRun(messageId: string, run: LiveRun) {
    if (run.requestId && run.lastTxHash) {
      await confirmSettlementTx(messageId, run, run.lastTxHash);
      return;
    }

    const snapshot = deriveRun(run);
    if (!run.requestId || !snapshot.spendIntent) {
      updateRun(messageId, (current) => ({ ...current, error: "Missing request id or spend-credit transaction intent." }));
      return;
    }
    const lockKey = transactionLockKey("settlement", run.requestId, snapshot.spendIntent);
    if (!claimTransactionLock(lockKey)) {
      updateRun(messageId, (current) => ({ ...current, error: pendingTransactionMessage(current.lastTxHash) }));
      return;
    }
    updateRun(messageId, (current) => ({ ...current, busyAction: "settle", status: "settling", error: undefined }));
    let signedReceipt: SentTransaction | undefined;
    try {
      const receipt = await sendIntent(snapshot.spendIntent, {
        onSubmitted: (tx) => {
          signedReceipt = tx;
          updateRun(messageId, (current) => ({ ...current, lastTxHash: tx.hash }));
        }
      });
      signedReceipt = receipt;
      await apiPost("/settlement/confirm", {
        requestId: run.requestId,
        walletAddress: receipt.from,
        styleId,
        txHash: receipt.hash
      });
      await fetchEvents(messageId, run.requestId);
      await refreshCredits(receipt.from);
      updateRun(messageId, (current) => ({ ...current, busyAction: undefined, status: "settled", lastTxHash: receipt.hash }));
    } catch (error) {
      updateRun(messageId, (current) => ({
        ...current,
        busyAction: undefined,
        status: "awaiting_settlement",
        error: friendlyErrorMessage(error, { action: "pay the royalty" }),
        lastTxHash: signedReceipt?.hash ?? current.lastTxHash
      }));
    } finally {
      releaseTransactionLock(lockKey);
    }
  }

  async function confirmSettlementTx(messageId: string, run: LiveRun, txHash: string) {
    if (!run.requestId) {
      updateRun(messageId, (current) => ({ ...current, error: "Missing request id for settlement sync." }));
      return;
    }
    const lockKey = transactionLockKey("settlement-confirm", run.requestId, txHash);
    if (!claimTransactionLock(lockKey)) {
      updateRun(messageId, (current) => ({ ...current, error: pendingTransactionMessage(txHash) }));
      return;
    }
    updateRun(messageId, (current) => ({ ...current, busyAction: "settle", status: "settling", error: undefined }));
    try {
      const walletAddress = await resolveWalletAddress(address) ?? runConsumerAddress(run);
      if (!walletAddress) throw new Error("Connect the wallet that submitted this royalty transaction, then sync again.");
      await apiPost("/settlement/confirm", {
        requestId: run.requestId,
        walletAddress,
        styleId,
        txHash
      });
      await fetchEvents(messageId, run.requestId);
      await refreshCredits(walletAddress);
      updateRun(messageId, (current) => ({ ...current, busyAction: undefined, status: "settled", lastTxHash: txHash }));
    } catch (error) {
      updateRun(messageId, (current) => ({
        ...current,
        busyAction: undefined,
        status: "awaiting_settlement",
        error: friendlyErrorMessage(error, { action: "confirm the royalty payment" }),
        lastTxHash: txHash
      }));
    } finally {
      releaseTransactionLock(lockKey);
    }
  }

  function claimTransactionLock(key: string): boolean {
    if (pendingTransactionLocks.current.has(key)) return false;
    pendingTransactionLocks.current.add(key);
    return true;
  }

  function releaseTransactionLock(key: string) {
    pendingTransactionLocks.current.delete(key);
  }

  function updateRun(messageId: string, updater: (run: LiveRun) => LiveRun) {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId && message.liveRun
          ? { ...message, liveRun: updater(message.liveRun) }
          : message
      )
    );
  }

  function appendEventsToRun(messageId: string, events: AgentEvent[]) {
    if (!events.length) return;
    if (events.length === 1) {
      updateRun(messageId, (run) => {
        const merged = mergeEvents(run.events, events);
        return { ...run, events: merged, status: statusFromEvents(merged, run.status) };
      });
      return;
    }
    // Stagger batch events so the timeline animates in one-by-one
    events.forEach((event, i) => {
      setTimeout(() => {
        updateRun(messageId, (run) => {
          const merged = mergeEvents(run.events, [event]);
          return { ...run, events: merged, status: statusFromEvents(merged, run.status) };
        });
      }, i * 120);
    });
  }

  function openEventStream(messageId: string, requestId: string) {
    const key = `${messageId}:${requestId}`;
    if (streams.current.has(key)) return;
    const source = new EventSource(`/api/backend/events/stream/${encodeURIComponent(requestId)}`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AgentEvent;
        appendEventsToRun(messageId, [event]);
        if (TERMINAL_TYPES.includes(event.type)) {
          source.close();
          streams.current.delete(key);
        }
      } catch {
        // The polling fallback below will keep the UI accurate if a malformed SSE chunk appears.
      }
    };
    source.onerror = () => {
      source.close();
      streams.current.delete(key);
    };
    streams.current.set(key, source);
  }

  async function fetchEvents(messageId: string, requestId: string): Promise<AgentEvent[]> {
    const data = await apiGet<{ events: AgentEvent[] }>(`/events/${encodeURIComponent(requestId)}`);
    const events = Array.isArray(data.events) ? data.events : [];
    appendEventsToRun(messageId, events);
    return events;
  }

  async function refreshCredits(walletAddress = address) {
    if (!walletAddress) return;
    setCreditState((current) => (current === "buying" ? current : "loading"));
    setCreditError("");
    try {
      const data = await apiGet<CreditInfo>(`/credits/${encodeURIComponent(walletAddress)}`);
      setCreditInfo(data);
      setCreditState("ready");
    } catch (error) {
      setCreditState("error");
      setCreditError(friendlyErrorMessage(error));
    }
  }

  async function buyPreflightCredit(amountInput = creditBuyAmount) {
    const amount = clampCreditAmount(amountInput);
    setCreditBuyAmount(amount);
    const walletAddress = await resolveWalletAddress(address);
    if (!walletAddress) {
      setCreditError("Connect a wallet before buying credits.");
      return;
    }
    if (!isOnCorrectNetwork) {
      setCreditError("Switch to 0G Galileo before buying credits.");
      return;
    }
    const lockKey = transactionLockKey("credit", "preflight", walletAddress, amount.toString());
    if (!claimTransactionLock(lockKey)) {
      setCreditState("error");
      setCreditError(pendingTransactionMessage(recentCreditPurchase?.txHash));
      return;
    }
    setCreditState("buying");
    setCreditError("");
    try {
      const buy = await apiPost<{ requestId: string; intent: TransactionIntent }>("/credits/buy-intent", {
        walletAddress,
        amount: amount.toString()
      });
      const receipt = await sendIntent(buy.intent, {
        onSubmitted: (tx) => {
          setRecentCreditPurchase({ requestId: buy.requestId, txHash: tx.hash, amount, timestamp: Date.now() });
        }
      });
      await apiPost("/credits/confirm-purchase", {
        requestId: buy.requestId,
        walletAddress: receipt.from,
        amount: amount.toString(),
        txHash: receipt.hash
      });
      setRecentCreditPurchase({
        requestId: buy.requestId,
        txHash: receipt.hash,
        amount,
        timestamp: Date.now()
      });
      await refreshCredits(receipt.from);
      setIsCreditPopoverOpen(true);
    } catch (error) {
      setCreditState("error");
      setCreditError(friendlyErrorMessage(error, { action: "buy credits" }));
    } finally {
      releaseTransactionLock(lockKey);
    }
  }

  async function waitForAny(messageId: string, requestId: string, types: string[], timeoutMs: number): Promise<AgentEvent> {
    const startedAt = Date.now();
    const streamKey = `${messageId}:${requestId}`;
    while (Date.now() - startedAt < timeoutMs) {
      if (streams.current.has(streamKey)) {
        await sleep(POLL_INTERVAL_MS * 4);
        continue;
      }
      const events = await fetchEvents(messageId, requestId);
      const found = events.find((event) => types.includes(event.type));
      if (found) return found;
      await sleep(POLL_INTERVAL_MS);
    }
    const events = await fetchEvents(messageId, requestId);
    const found = events.find((event) => types.includes(event.type));
    if (found) return found;
    throw new Error(`Timed out waiting for ${types.join(" or ")}`);
  }

  function addAssistantNotice(text: string) {
    setMessages((current) => [...current, { id: `notice-${Date.now().toString(36)}`, role: "assistant", text }]);
  }

  function handleInputChange(value: string) {
    setInput(value);
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "44px";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(input);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function togglePlatform(platform: GenerationPlatform) {
    setPlatformTouched(true);
    setSelectedPlatforms([platform]);
  }

  const styleIsLoading = !style && (!mounted || registryState === "loading");

  if (!style) {
    return (
      <div className="tryRoot">
        <Navbar />
        <div className="tryNotFound">
          <div className="tryNotFoundInner">
            <p>{styleIsLoading ? "Finding style..." : "Style not found"}</p>
            {!styleIsLoading && registryError ? <small>{registryError}</small> : null}
            <Link href="/styles" className="tryNotFoundBack">Back to styles</Link>
          </div>
        </div>
      </div>
    );
  }

  const canEnterPrompt = Boolean(address && isOnCorrectNetwork && creditState === "ready" && hasCredits && !hasBusyRun);
  const composerDisabled = !canEnterPrompt || !input.trim();
  const creditBalanceLabel = address
    ? `${formatCredits(creditInfo?.credits)} credit${formatCredits(creditInfo?.credits) === "1" ? "" : "s"}`
    : "No wallet";
  const recommendedPlatform = recommendedPlatformForStyle(style, registryDetails?.profile);
  const currentPlatform = selectedPlatform(selectedPlatforms);
  const selectedPlatformText = platformLabel(currentPlatform);
  const recommendationLabel = platformRecommendationLabel(recommendedPlatform);
  const recommendationTone = isRecommendedPlatformFit(currentPlatform, recommendedPlatform) ? "strong" : "warning";
  const showPlatformPicker = !hasBusyRun;
  const creditPopoverDescription = creditPanelText({ address, isOnCorrectNetwork, creditState, hasCredits, creditInfo, creditError });
  const composerHint = !address
    ? "Connect a wallet before generating."
    : !isOnCorrectNetwork
      ? "Switch to 0G Galileo before signing settlement transactions."
      : creditState === "loading"
        ? "Checking your credit balance before generation."
        : creditState === "buying"
          ? "Waiting for credit purchase confirmation."
          : !hasCredits
            ? "Buy at least one credit before entering a prompt."
            : hasBusyRun
              ? "Waiting for the current backend workflow."
              : "Press Enter to send. Shift+Enter adds a new line.";

  return (
    <div className="tryRoot">
      <div className="tryChatHeader">
        <div className="tryChatHeaderInner">
          <div className="tryChatHeaderLeft">
            <Link href={`/styles/${style.id}`} className="tryBackLink">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
              </svg>
              Back
            </Link>

            <div className="tryChatHeaderCenter">
              <div className="tryChatHeaderIcon" aria-hidden="true"><IconVoice /></div>
              <div>
                <div className="tryChatHeaderTitle">{style.title}</div>
                <div className="tryChatHeaderSub">
                  by {registryDetails ? shortAddress(registryDetails.chain.creator) : style.creatorName} · token {styleId}
                </div>
              </div>
            </div>
          </div>

          <div className="tryChatHeaderNav" aria-label="Try page navigation">
            <Navbar variant="inline" />
          </div>

          <div className="tryHeaderActions">
            <div className="tryChatHeaderPrice">{style.price}</div>
            {registryDetails ? (
              <TryProofTrail
                style={registryDetails}
                latestProofRequestId={latestProofRequestId}
                open={isProofPopoverOpen}
                menuRef={proofMenuRef}
                onToggle={() => {
                  setIsCreditPopoverOpen(false);
                  setIsProofPopoverOpen((open) => !open);
                }}
                onClose={() => setIsProofPopoverOpen(false)}
              />
            ) : null}
            <div className="tryCreditMenu" ref={creditMenuRef}>
              <button
                type="button"
                className="tryCreditCompact"
                data-state={creditState}
                data-ready={hasCredits ? "true" : "false"}
                aria-haspopup="dialog"
                aria-expanded={isCreditPopoverOpen}
                onClick={() => setIsCreditPopoverOpen((open) => !open)}
                title={creditPopoverDescription}
              >
                <span className="tryCreditCompactIcon" aria-hidden="true"><IconLayers /></span>
                <span className="tryCreditCompactText">
                  <strong>{creditBalanceLabel}</strong>
                  <small>{creditStatusLabel}</small>
                </span>
              </button>

              {isCreditPopoverOpen ? (
                <div className="tryCreditPopover" role="dialog" aria-label="Generation credits">
                  <div className="tryCreditPopoverHead">
                    <div>
                      <strong>Generation credits</strong>
                      <p>{creditPopoverDescription}</p>
                    </div>
                    <button type="button" onClick={() => setIsCreditPopoverOpen(false)}>Close</button>
                  </div>

                  <div className="tryCreditStats">
                    <div>
                      <span>Balance</span>
                      <strong>{creditBalanceLabel}</strong>
                    </div>
                    <div>
                      <span>Price</span>
                      <strong>{formatCreditPrice(creditInfo?.creditPriceWei)} / credit</strong>
                    </div>
                    <div>
                      <span>Status</span>
                      <strong>{creditStatusLabel}</strong>
                    </div>
                  </div>

                  {creditError ? <p className="tryCreditError">{creditError}</p> : null}

                  <label className="tryCreditAmount">
                    <span>Buy credits</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      step={1}
                      value={creditBuyAmount}
                      onChange={(event) => setCreditBuyAmount(clampCreditAmount(Number(event.target.value)))}
                      disabled={!address || !isOnCorrectNetwork || creditState === "buying"}
                    />
                  </label>

                  <div className="tryCreditQuickAmounts" aria-label="Quick credit amounts">
                    {[1, 5, 10, 25, 50].map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        className={creditBuyAmount === amount ? "tryCreditQuickAmountActive" : ""}
                        onClick={() => setCreditBuyAmount(amount)}
                        disabled={creditState === "buying"}
                      >
                        {amount}
                      </button>
                    ))}
                  </div>

                  <div className="tryCreditPopoverActions">
                    <button type="button" onClick={() => void refreshCredits()} disabled={!address || creditState === "loading" || creditState === "buying"}>
                      Refresh balance
                    </button>
                    <button
                      type="button"
                      className="tryCreditBuyButton"
                      onClick={() => void buyPreflightCredit(creditBuyAmount)}
                      disabled={!address || !isOnCorrectNetwork || creditState === "buying"}
                    >
                      {creditState === "buying" ? "Buying..." : `Buy ${creditBuyAmount} credit${creditBuyAmount === 1 ? "" : "s"}`}
                    </button>
                  </div>

                  <div className="tryCreditRecent">
                    <span>Recent transaction</span>
                    {recentCreditPurchase ? (
                      <div>
                        <strong>{recentCreditPurchase.amount} credit{recentCreditPurchase.amount === 1 ? "" : "s"} bought</strong>
                        <p>{shortHash(recentCreditPurchase.txHash)} · {formatTime(recentCreditPurchase.timestamp)}</p>
                        <div className="tryCreditRecentLinks">
                          <a href={chainTxUrl(recentCreditPurchase.txHash)} target="_blank" rel="noreferrer">Tx</a>
                          <a href={`/api/backend/proof/${encodeURIComponent(recentCreditPurchase.requestId)}`} target="_blank" rel="noreferrer">Proof</a>
                        </div>
                      </div>
                    ) : (
                      <p>No credit purchase from this page yet.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <main className="tryChatMain">
        <div className="tryChatScroller">
          <div className="tryChatInner">
            {groups.map((group, gi) => (
              <div key={`${group.role}-${gi}`} className={`tryMsgGroup${group.role === "user" ? " tryMsgGroupUser" : ""}`}>
                <div className={`tryAvatar${group.role === "user" ? " tryAvatarUser" : " tryAvatarAi"}`} aria-hidden="true">
                  {group.role === "user"
                    ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                    : <IconVoice />
                  }
                </div>

                <div className={`tryBubbleStack${group.role === "user" ? " tryBubbleStackUser" : ""}${group.messages.some((m) => m.liveRun) ? " tryBubbleStackLive" : ""}`}>
                  {group.messages.map((m) => (
                    <div key={m.id} className={m.role === "user" ? "tryBubble tryBubbleUser" : `tryBubble tryBubbleAi${m.liveRun ? " tryBubbleLive" : ""}`}>
                      {m.liveRun ? (
                        <LiveGeneration
                          run={m.liveRun}
                          expanded={expandedThinking[m.id] ?? true}
                          onToggle={() => setExpandedThinking((current) => ({ ...current, [m.id]: !(current[m.id] ?? true) }))}
                          onBuyCredit={() => void buyCreditForRun(m.id, m.liveRun!)}
                          onSettle={() => void settleRun(m.id, m.liveRun!)}
                          onRetry={() => void send(m.liveRun!.prompt)}
                        />
                      ) : (
                        <span style={{ whiteSpace: "pre-wrap" }}>{m.text}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div ref={bottomRef} style={{ height: 8 }} />
          </div>
        </div>

        <div className="tryComposerWrap">
          {!isOnCorrectNetwork && address ? (
            <button type="button" className="tryNetworkButton" onClick={() => void switchNetwork()}>
              Switch to 0G Galileo
            </button>
          ) : null}
          {showPlatformPicker ? (
            <div className="tryPlatformPicker" aria-label="Output format selector">
              <div className="tryPlatformPickerHead">
                <span>Generate as</span>
                <strong>{selectedPlatformText}</strong>
                <small>Choose one</small>
              </div>
              <div className="tryPlatformOptions">
                {PLATFORM_OPTIONS.map((option) => {
                  const active = currentPlatform === option.id;
                  const recommended = isRecommendedPlatformFit(option.id, recommendedPlatform);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`tryPlatformOption${active ? " tryPlatformOptionActive" : ""}${recommended ? " tryPlatformOptionRecommended" : ""}`}
                      aria-pressed={active}
                      onClick={() => togglePlatform(option.id)}
                      title={option.helper}
                    >
                      <span>{option.label}</span>
                      {recommended ? <em>best fit</em> : <em>{option.helper}</em>}
                    </button>
                  );
                })}
              </div>
              <p className={`tryPlatformRecommendation tryPlatformRecommendation-${recommendationTone}`}>
                This voice is strongest for {recommendationLabel}. {recommendationTone === "warning" ? `Switch to ${recommendationLabel} for the closest match.` : "Good choice for this style."}
              </p>
            </div>
          ) : null}
          <form className="tryComposer" onSubmit={handleSubmit}>
            <textarea
              ref={inputRef}
              className="tryComposerInput"
              value={input}
              rows={1}
              autoFocus
              disabled={!canEnterPrompt}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={canEnterPrompt ? `Ask ${style.title} to write something...` : "Credits are required before writing a prompt"}
              aria-label="Message input"
            />
            <button
              type="submit"
              className={`tryComposerSend${composerDisabled ? " tryComposerSendDisabled" : ""}`}
              disabled={composerDisabled}
              aria-label="Send"
            >
              <IconArrow />
            </button>
          </form>
          <p className="tryComposerHint">{composerHint}</p>
        </div>
      </main>
    </div>
  );
}

function TryProofTrail({
  style,
  latestProofRequestId,
  open,
  menuRef,
  onToggle,
  onClose
}: {
  style: ChainStyleDetails;
  latestProofRequestId?: string;
  open: boolean;
  menuRef: RefObject<HTMLDivElement>;
  onToggle: () => void;
  onClose: () => void;
}) {
  const agentBrain = recordValue(style.agentBrain);
  const manifestRoot = stringValue(agentBrain.manifestRootHash);
  const memoryLogStream = stringValue(agentBrain.memoryLogStream);
  const proofHref = latestProofRequestId ? `/api/backend/proof/${encodeURIComponent(latestProofRequestId)}` : undefined;

  return (
    <div className="tryProofMenu" id="proof-trail" ref={menuRef}>
      <button
        type="button"
        className="tryProofCompact"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
        title="Open Proof Trail"
      >
        <span className="tryProofCompactIcon" aria-hidden="true"><IconCheck /></span>
        <span className="tryProofCompactText">
          <strong>Proof Trail</strong>
          <small>{latestProofRequestId ? "ready" : "agent proof"}</small>
        </span>
      </button>

      {open ? (
        <div className="tryProofPopover" role="dialog" aria-label="Proof Trail details">
          <div className="tryProofPopoverHead">
            <div>
              <strong>Proof Trail</strong>
            </div>
            <button type="button" onClick={onClose}>Close</button>
          </div>
          <div className="tryProofGrid">
            <TryProofFact label="AgentBrain manifest root" value={manifestRoot} />
            <TryProofFact label="Profile KV key" value={style.profileKey || style.chain.profileURI} />
            <TryProofFact label="Memory log stream" value={memoryLogStream} />
            <TryProofFact label="Latest generation proof" value={latestProofRequestId} href={proofHref} />
            {CONTRACTS.map((contract) => (
              <TryProofFact
                key={contract.label}
                label={contract.label}
                value={contract.address}
                href={explorerAddressUrl(contract.address)}
              />
            ))}
          </div>
          <div className="tryProofPopoverActions">
            <Link href={`/dashboard/styles/${style.tokenId}/agent-brain`}>AgentBrain inspector</Link>
            {proofHref ? <a href={proofHref} target="_blank" rel="noreferrer">Latest proof page</a> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TryProofFact({ label, value, href }: { label: string; value?: string; href?: string }) {
  return (
    <div className="tryProofFact">
      <span>{label}</span>
      {href && value ? (
        <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined} title={value}>
          {value}
        </a>
      ) : (
        <strong title={value}>{value || "Not recorded"}</strong>
      )}
    </div>
  );
}

function GeneratedOutput({ platform, text, compact = false }: { platform?: string; text: string; compact?: boolean }) {
  if (isMarkdownOutput(platform, text)) {
    return <div className={`tryMarkdownOutput${compact ? " tryMarkdownOutputCompact" : ""}`}>{renderMarkdownBlocks(text)}</div>;
  }
  return <div className={compact ? "tryPlainOutputCompact" : "tryOutputText"}>{text}</div>;
}

function isMarkdownOutput(platform: string | undefined, text: string): boolean {
  const normalized = platform?.toLowerCase();
  if (normalized === "blog" || normalized === "github_readme" || normalized === "readme") {
    return true;
  }
  return /(^|\n)#{1,3}\s+\S/.test(text) || /(^|\n)(?:[-*]|\d+\.)\s+\S/.test(text);
}

function renderMarkdownBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ol" | "ul" | null = null;
  let codeLines: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    nodes.push(<p key={`p-${nodes.length}`}>{renderInlineMarkdown(paragraph.join(" "))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    const ListTag = listType;
    nodes.push(
      <ListTag key={`list-${nodes.length}`}>
        {listItems.map((item, index) => <li key={`${index}-${item.slice(0, 20)}`}>{renderInlineMarkdown(item)}</li>)}
      </ListTag>
    );
    listItems = [];
    listType = null;
  };
  const flushCode = () => {
    if (codeLines.length === 0) return;
    nodes.push(<pre key={`code-${nodes.length}`}><code>{codeLines.join("\n")}</code></pre>);
    codeLines = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      nodes.push(level === 1
        ? <h1 key={`h-${nodes.length}`}>{content}</h1>
        : level === 2
          ? <h2 key={`h-${nodes.length}`}>{content}</h2>
          : <h3 key={`h-${nodes.length}`}>{content}</h3>);
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType && listType !== nextType) {
        flushList();
      }
      listType = nextType;
      listItems.push((ordered?.[1] ?? unordered?.[1] ?? "").trim());
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }

  flushCode();
  flushParagraph();
  flushList();
  return nodes;
}

function renderInlineMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(value.slice(lastIndex, index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`code-${index}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`strong-${index}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = index + token.length;
  }
  if (lastIndex < value.length) {
    nodes.push(value.slice(lastIndex));
  }
  return nodes;
}

function deriveRun(run: LiveRun) {
  const failed = [...run.events].reverse().find((event) => event.type.endsWith(".failed"));
  const settled = latestEvent(run.events, "royalty.settled");
  const creditPurchased = latestEvent(run.events, "credit.purchased");
  const creditLow = latestEvent(run.events, "credit.low");
  const published = latestEvent(run.events, "generation.published");
  const drafted = latestEvent(run.events, "generation.drafted");
  const variants = payloadRecord(published, "variants");
  const variantEntries = Object.entries(variants);
  const finalText = variantEntries[0]?.[1] ?? "";
  const spendIntent = payloadIntent(published, "spendIntent") ?? payloadIntent(latestEvent(run.events, "settlement.intent.created"), "spendIntent");
  const compute = payloadRecordObject(published, "compute") ?? payloadRecordObject(drafted, "compute");
  const teeVerified = booleanOrNull(payloadValue(published, "teeVerified") ?? payloadValue(drafted, "teeVerified") ?? compute?.teeVerified ?? compute?.verified);
  const proofHref = run.requestId ? `/api/backend/proof/${encodeURIComponent(run.requestId)}` : undefined;
  const status = statusFromEvents(run.events, run.status);
  const error = run.error ?? (failed ? eventExplanation(failed) : undefined);
  const evidenceStatus = runEvidenceStatus(run.events, teeVerified, Boolean(compute));

  if (status === "failed") {
    return {
      label: "Backend workflow failed",
      tone: "warning" as const,
      isTerminal: true,
      finalText,
      variantEntries,
      outputPill: "Needs review",
      settlementState: "failed",
      settlementTitle: "Workflow failed",
      settlementDetail: error ?? "The backend reported a failure.",
      canSettle: false,
      canBuyCredit: false,
      canRetry: true,
      spendIntent,
      proofHref,
      computeVerified: teeVerified === true ? "TEE verified" : teeVerified === false ? "TEE not verified" : Boolean(compute) ? "Compute recorded" : "Compute failed",
      error
    };
  }

  if (status === "credit_low") {
    return {
      label: "Credit needed before generation",
      tone: "warning" as const,
      isTerminal: false,
      finalText: "This wallet has no generation credits yet. Buy one credit on-chain, then retry this prompt.",
      variantEntries: [],
      outputPill: "Credit needed",
      settlementState: "credit_low",
      settlementTitle: "No credits available",
      settlementDetail: "The Content Creator checked CreditSystem and stopped before generation so no royalty was charged.",
      canSettle: false,
      canBuyCredit: true,
      canRetry: false,
      spendIntent,
      proofHref,
      computeVerified: "No compute charged",
      error
    };
  }

  if (status === "credit_ready") {
    return {
      label: "Credit purchased",
      tone: "success" as const,
      isTerminal: true,
      finalText: "Credit purchase confirmed. Run the prompt again to generate and prepare royalty settlement.",
      variantEntries: [],
      outputPill: "Credit ready",
      settlementState: "credit_ready",
      settlementTitle: "Credit ready",
      settlementDetail: `Credit purchase confirmed${payloadString(creditPurchased, "txHash") ? ` in ${shortHash(payloadString(creditPurchased, "txHash"))}` : ""}.`,
      canSettle: false,
      canBuyCredit: false,
      canRetry: true,
      spendIntent,
      proofHref,
      computeVerified: "Credit confirmed",
      error
    };
  }

  if (status === "settled") {
    return {
      label: "Royalty settled on-chain",
      tone: "success" as const,
      isTerminal: true,
      finalText,
      variantEntries,
      outputPill: "Settled",
      settlementState: "settled",
      settlementTitle: "Creator royalty paid",
      settlementDetail: `Credit spend and royalty settlement are confirmed${payloadString(settled, "txHash") ? ` in ${shortHash(payloadString(settled, "txHash"))}` : ""}.`,
      canSettle: false,
      canBuyCredit: false,
      canRetry: false,
      spendIntent,
      proofHref,
      computeVerified: evidenceStatus,
      error
    };
  }

  if (status === "awaiting_settlement" || status === "settling") {
    const hasSubmittedSettlement = Boolean(run.lastTxHash);
    return {
      label: status === "settling"
        ? hasSubmittedSettlement ? "Syncing royalty settlement..." : "Paying creator royalty..."
        : hasSubmittedSettlement ? "Royalty tx submitted, sync pending" : "CrewAI generation ready, royalty pending",
      tone: status === "settling" ? "warning" as const : "success" as const,
      isTerminal: false,
      finalText,
      variantEntries,
      outputPill: "Generated",
      settlementState: status,
      settlementTitle: hasSubmittedSettlement ? "Royalty transaction submitted" : "Royalty payment ready",
      settlementDetail: hasSubmittedSettlement
        ? "The spend-credit transaction is on-chain. Sync backend verification to mark the creator royalty as settled."
        : "The CrewAI draft passed critic review. Sign the spend-credit transaction to deduct one credit and pay the creator.",
      canSettle: Boolean(spendIntent || run.lastTxHash) && status !== "settling",
      canBuyCredit: false,
      canRetry: false,
      spendIntent,
      proofHref,
      computeVerified: evidenceStatus,
      error
    };
  }

  if (status === "drafted") {
    return {
      label: "CrewAI draft written, formatting output...",
      tone: "accent" as const,
      isTerminal: false,
      finalText,
      variantEntries,
      outputPill: "Draft",
      settlementState: "running",
      settlementTitle: "Distribution pending",
      settlementDetail: "The CrewAI critic returned memory feedback. Waiting for Distribution Manager to prepare the selected output and settlement.",
      canSettle: false,
      canBuyCredit: false,
      canRetry: false,
      spendIntent,
      proofHref,
      computeVerified: evidenceStatus,
      error
    };
  }

  if (crewIsComplete(run.events)) {
    const draftPreview = crewDraftPreview(run.events);
    return {
      label: "CrewAI complete, backend finalizing...",
      tone: "accent" as const,
      isTerminal: false,
      finalText: draftPreview,
      variantEntries: [],
      outputPill: "CrewAI draft",
      settlementState: "running",
      settlementTitle: "Backend handoff in progress",
      settlementDetail: "CrewAI finished the writer and critic pass. Waiting for the Content Creator tool to emit generation.drafted and hand off to settlement.",
      canSettle: false,
      canBuyCredit: false,
      canRetry: false,
      spendIntent,
      proofHref,
      computeVerified: evidenceStatus,
      error
    };
  }

  return {
    label: run.status === "submitting" ? "Submitting to backend..." : "CrewAI agents thinking...",
    tone: "accent" as const,
    isTerminal: false,
    finalText,
    variantEntries,
    outputPill: "Running",
    settlementState: "running",
    settlementTitle: "Generation running",
    settlementDetail: "The backend is checking credits, loading 0G voice evidence, running the CrewAI writer and critic, then preparing settlement evidence.",
    canSettle: false,
    canBuyCredit: false,
    canRetry: false,
    spendIntent,
    proofHref,
    computeVerified: evidenceStatus,
    error
  };
}

function statusFromEvents(events: AgentEvent[], fallback: RunStatus): RunStatus {
  if (events.some((event) => event.type.endsWith(".failed"))) return "failed";
  if (events.some((event) => event.type === "royalty.settled")) return "settled";
  if (events.some((event) => event.type === "generation.published")) {
    if (fallback === "settling" || fallback === "settled") return fallback;
    return "awaiting_settlement";
  }
  if (events.some((event) => event.type === "credit.purchased") && events.some((event) => event.type === "credit.low")) return "credit_ready";
  if (events.some((event) => event.type === "credit.low")) return "credit_low";
  if (events.some((event) => event.type === "generation.drafted")) return "drafted";
  return fallback;
}

function deriveCrewSummary(events: AgentEvent[]) {
  const agents = CREW_AGENT_STEPS.map((step) => {
    const matchingEvents = events.filter((event) => {
      const payload = eventPayload(event);
      return event.type === "agent.activity" && (payload.tool === step.tool || payload.agent === step.key);
    });
    const latestTerminal = [...matchingEvents].reverse().find((event) => {
      const status = eventPayload(event).status;
      return status === "completed" || status === "failed";
    });
    const latest = latestTerminal ?? matchingEvents.at(-1);
    const payload = eventPayload(latest);
    const state = normalizeCrewState(payload.status);
    return {
      ...step,
      state,
      statusLabel: crewStatusLabel(state, latest ? String(payload.message ?? "") : "")
    };
  });
  return {
    agents,
    completedCount: agents.filter((agent) => agent.state === "completed").length
  };
}

function crewIsComplete(events: AgentEvent[]): boolean {
  return CREW_AGENT_STEPS.every((step) =>
    events.some((event) => {
      const payload = eventPayload(event);
      return event.type === "agent.activity" && (payload.tool === step.tool || payload.agent === step.key) && payload.status === "completed";
    })
  );
}

function crewDraftPreview(events: AgentEvent[]): string {
  const writerCompleted = [...events].reverse().find((event) => {
    const payload = eventPayload(event);
    return event.type === "agent.activity" && payload.tool === "crewai.style_writer" && payload.status === "completed";
  });
  const payload = eventPayload(writerCompleted);
  const preview = payload.draftPreview;
  if (typeof preview === "string" && preview.trim()) return preview;
  const output = recordish(payload.output);
  const draft = output ? output.draft : undefined;
  return typeof draft === "string" ? draft.slice(0, 220) : "";
}

function normalizeCrewState(value: unknown): CrewAgentState {
  if (value === "started" || value === "progress" || value === "completed" || value === "failed" || value === "handoff") {
    return value;
  }
  return "pending";
}

function crewStatusLabel(state: CrewAgentState, message: string): string {
  if (state === "pending") return "Waiting";
  if (state === "started") return message || "Working";
  if (state === "progress") return message || "Still working";
  if (state === "completed") return message || "Done";
  if (state === "handoff") return message || "Handing off";
  return message || "Failed";
}

function isRunBusy(run: LiveRun): boolean {
  const status = statusFromEvents(run.events, run.status);
  return Boolean(run.busyAction) || status === "submitting" || status === "running" || status === "drafted" || status === "settling";
}

async function getBrowserProvider(): Promise<BrowserProvider> {
  if (!window.ethereum) throw new Error("A browser wallet is required for real on-chain settlement");
  return new BrowserProvider(window.ethereum);
}

async function currentConnectedWalletAddress(): Promise<string | null> {
  if (!window.ethereum) return null;
  const provider = await getBrowserProvider();
  const accounts = await provider.send("eth_accounts", []);
  if (!Array.isArray(accounts)) return null;
  return accounts.find((account): account is string => typeof account === "string" && account.length > 0) ?? null;
}

async function resolveWalletAddress(fallback: string | null): Promise<string | null> {
  if (typeof window !== "undefined" && window.ethereum) {
    return currentConnectedWalletAddress().catch(() => null);
  }
  return fallback;
}

async function sendIntent(intent: TransactionIntent, options: SendIntentOptions = {}): Promise<SentTransaction> {
  const provider = await getBrowserProvider();
  const signer = await provider.getSigner();
  const signerAddress = await signer.getAddress();
  const tx: TransactionRequest = {
    to: intent.to,
    data: intent.data,
    value: BigInt(intent.value || "0")
  };
  const response = await signer.sendTransaction(tx);
  const submitted = { hash: response.hash, from: response.from || signerAddress };
  options.onSubmitted?.(submitted);
  const receipt = await response.wait();
  if (!receipt) throw new Error(`Transaction ${response.hash} was not confirmed`);
  return { hash: receipt.hash || submitted.hash, from: receipt.from || submitted.from };
}

async function apiGet<T = Record<string, unknown>>(path: string): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { cache: "no-store" });
  return parseJsonResponse<T>(response);
}

async function apiPost<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/backend${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseJsonResponse<T>(response);
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function eventPayload(event: AgentEvent | undefined): Record<string, unknown> {
  const payload = event?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function isCrewEvent(event: AgentEvent): boolean {
  const payload = eventPayload(event);
  return event.type === "agent.activity" && String(payload.tool ?? "").startsWith("crewai.");
}

function traceBadges(event: AgentEvent): string[] {
  const payload = eventPayload(event);
  if (!isCrewEvent(event)) return [];
  const badges: string[] = [];
  const sampleCount = numberish(payload.sampleExcerptCount);
  const memoryCount = numberish(payload.memoryLogCount);
  const learnedCount = numberish(payload.learnedPreferenceCount);
  const elapsedSeconds = numberish(payload.elapsedSeconds);
  const styleMatch = payload.styleMatch && typeof payload.styleMatch === "object" && !Array.isArray(payload.styleMatch)
    ? (payload.styleMatch as Record<string, unknown>)
    : null;
  const score = numberish(styleMatch?.score);
  if (sampleCount !== undefined) badges.push(`${sampleCount} excerpts`);
  if (memoryCount !== undefined) badges.push(`${memoryCount} memory logs`);
  if (score !== undefined) badges.push(`style ${Math.round(score * 100)}%`);
  if (learnedCount !== undefined) badges.push(`${learnedCount} learned`);
  if (elapsedSeconds !== undefined) badges.push(`${elapsedSeconds}s elapsed`);
  if (payload.hasAgentBrain === true) badges.push("AgentBrain");
  if (payload.needsRevision === true) badges.push("revision requested");
  return badges;
}

function agentOutputForDisplay(event: AgentEvent): { title: string; text: string } | undefined {
  if (!isCrewEvent(event)) return undefined;
  const payload = eventPayload(event);
  const output = payload.output;
  if (output !== undefined) {
    return {
      title: agentOutputTitle(String(payload.tool ?? "")),
      text: stringifyAgentOutput(output)
    };
  }
  if (typeof payload.draftPreview === "string" && payload.draftPreview.trim()) {
    return {
      title: "Draft output",
      text: payload.draftPreview
    };
  }
  if (typeof payload.revisionGuidance === "string" && payload.revisionGuidance.trim()) {
    return {
      title: "Critic output",
      text: payload.revisionGuidance
    };
  }
  return undefined;
}

function agentOutputTitle(tool: string): string {
  if (tool === "crewai.voice_context") return "Voice packet output";
  if (tool === "crewai.style_writer") return "Draft output";
  if (tool === "crewai.voice_critic_memory") return "Critique + memory output";
  return "Agent output";
}

function stringifyAgentOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(sanitizeOutputForDisplay(value), null, 2);
  } catch {
    return String(value);
  }
}

function sanitizeOutputForDisplay(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 6000 ? `${value.slice(0, 6000)}...` : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 24).map((item) => sanitizeOutputForDisplay(item, depth + 1));
    return value.length > 24 ? [...items, `...${value.length - 24} more item(s)`] : items;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 60).map(([key, item]) => [
    key,
    sanitizeOutputForDisplay(item, depth + 1)
  ]);
  if (Object.keys(value as Record<string, unknown>).length > 60) {
    entries.push(["_truncated", "additional fields hidden"]);
  }
  return Object.fromEntries(entries);
}

function recordish(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sanitizeEventForDisplay(event: AgentEvent): Record<string, unknown> {
  const payload = eventPayload(event);
  return {
    id: event.id,
    type: event.type,
    time: formatTime(event.timestamp),
    actor: event.actor,
    styleId: event.styleId,
    consumerAddress: event.consumerAddress,
    payload: sanitizePayloadForDisplay(payload)
  };
}

function sanitizePayloadForDisplay(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (key.toLowerCase().includes("intent") && value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return [key, {
          to: record.to,
          value: record.value,
          description: record.description,
          data: typeof record.data === "string" ? `${record.data.slice(0, 18)}...${record.data.slice(-8)}` : record.data
        }];
      }
      if (typeof value === "string" && value.length > 1200) {
        return [key, `${value.slice(0, 1200)}...`];
      }
      return [key, value];
    })
  );
}

function eventExplanation(event: AgentEvent): string {
  const payload = eventPayload(event);
  if (event.type === "agent.activity") {
    return String(payload.message ?? payload.tool ?? "Agent activity");
  }
  if (event.type === "generation.requested") return "Generation request accepted by the backend.";
  if (event.type === "generation.drafted") return "CrewAI wrote, critiqued, and logged the voice-matched draft.";
  if (event.type === "generation.published") return "Distribution Manager emitted the selected output and spend-credit transaction.";
  if (event.type === "settlement.intent.created") return "Spend-credit transaction intent prepared.";
  if (event.type === "credit.low") return "No generation credits were available for this wallet.";
  if (event.type === "credit.purchase.intent.created") return "Credit purchase transaction intent prepared.";
  if (event.type === "credit.purchased") return "Credit purchase confirmed on-chain.";
  if (event.type === "credit.deducted") return "Generation credit was deducted on-chain.";
  if (event.type === "royalty.settled") return "Creator royalty settled on-chain.";
  if (event.type.endsWith(".failed")) return String(payload.reason ?? payload.error ?? "Backend reported a failure.");
  return event.styleId ?? event.consumerAddress ?? event.actor;
}

function runEvidenceStatus(events: AgentEvent[], teeVerified: boolean | null, hasCompute: boolean): string {
  if (teeVerified === true) return "TEE verified";
  if (teeVerified === false) return "TEE not verified";
  const latestActivity = [...events].reverse().find((event) => event.type === "agent.activity");
  const payload = eventPayload(latestActivity);
  const tool = String(payload.tool ?? "");
  const status = String(payload.status ?? "");
  if (tool === "crewai.voice_context" && status === "started") return "Reading 0G evidence";
  if (tool === "crewai.voice_context" && status === "completed") return "Voice packet ready";
  if (tool === "crewai.style_writer" && (status === "started" || status === "progress")) return "0G writer running";
  if (tool === "crewai.style_writer" && status === "completed") return "Draft complete";
  if (tool === "crewai.voice_critic_memory" && (status === "started" || status === "progress")) return "Critic running";
  if (tool === "crewai.voice_critic_memory" && status === "completed") return "Memory ready";
  if (tool === "generate_with_voice" && status === "started") return "0G Compute running";
  if (tool === "generate_with_voice" && status === "completed") return "Draft ready";
  if (tool === "log_draft" && status === "started") return "Writing draft log";
  if (tool === "log_draft" && status === "completed") return "Draft logged";
  if (tool === "handoff_to_distribution") return "Preparing output";
  if (tool === "tune_for_platform" && status === "started") return "Formatting output";
  if (tool === "tune_for_platform" && status === "completed") return "Output ready";
  if (hasCompute) return "Compute recorded";
  return "Compute pending";
}

function payloadString(event: AgentEvent | undefined, key: string): string {
  const value = eventPayload(event)[key];
  return typeof value === "string" ? value : "";
}

function payloadValue(event: AgentEvent | undefined, key: string): unknown {
  return eventPayload(event)[key];
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function payloadRecord(event: AgentEvent | undefined, key: string): Record<string, string> {
  const value = eventPayload(event)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function payloadRecordObject(event: AgentEvent | undefined, key: string): Record<string, unknown> | null {
  const value = eventPayload(event)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function payloadIntent(event: AgentEvent | undefined, key: string): TransactionIntent | null {
  const value = eventPayload(event)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Partial<TransactionIntent>;
  return intent.to && intent.data && typeof intent.value === "string" ? (intent as TransactionIntent) : null;
}

function latestEvent(events: AgentEvent[], type: string): AgentEvent | undefined {
  return [...events].reverse().find((event) => event.type === type);
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shortHash(value: string) {
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function transactionLockKey(kind: string, ...parts: Array<string | TransactionIntent | undefined>): string {
  const stableParts = parts.map((part) => {
    if (!part) return "";
    if (typeof part === "string") return part.toLowerCase();
    return `${part.to.toLowerCase()}:${part.value}:${part.data}`;
  });
  return [kind, ...stableParts].join(":");
}

function pendingTransactionMessage(txHash?: string): string {
  return txHash
    ? `A wallet transaction is already pending for this action (${shortHash(txHash)}). Wait for it to confirm, or use Speed up/Cancel in MetaMask before trying again.`
    : "A wallet transaction is already pending for this action. Wait for it to confirm, or use Speed up/Cancel in MetaMask before trying again.";
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function runConsumerAddress(run: LiveRun): string | null {
  const event = [...run.events].reverse().find((item) => typeof item.consumerAddress === "string" || typeof eventPayload(item).consumerAddress === "string");
  if (!event) return null;
  const payloadConsumer = payloadString(event, "consumerAddress");
  return event.consumerAddress ?? (payloadConsumer || null);
}

function parseCreditCount(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function formatCredits(value: string | undefined): string {
  return parseCreditCount(value).toString();
}

function clampCreditAmount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

function formatCreditPrice(value: string | undefined): string {
  return formatWeiAmount(parseCreditCount(value));
}

function formatWeiAmount(value: bigint | string | undefined): string {
  const wei = typeof value === "bigint" ? value : parseCreditCount(value);
  const unit = 1_000_000_000_000_000_000n;
  const whole = wei / unit;
  const fraction = wei % unit;
  if (fraction === 0n) return `${whole.toString()} OG`;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toString()}.${fractionText || "0"} OG`;
}

function chainTxUrl(txHash: string): string {
  return `https://chainscan-galileo.0g.ai/tx/${txHash}`;
}

function platformLabel(value: string): string {
  if (value === "x" || value === "twitter") return "Twitter / X";
  if (value === "thread" || value === "tweet_thread" || value === "twitter_thread") return "Tweet thread";
  if (value === "instagram") return "Instagram";
  if (value === "blog" || value === "blogger_article" || value === "article") return "Blog article";
  if (value === "github_readme" || value === "readme" || value === "github") return "GitHub README";
  return value.replace(/_/g, " ");
}

function platformRecommendationLabel(value: GenerationPlatform): string {
  return isTwitterFamilyPlatform(value) ? "Twitter / X or Tweet thread" : platformLabel(value);
}

function isRecommendedPlatformFit(candidate: GenerationPlatform, recommended: GenerationPlatform): boolean {
  if (candidate === recommended) return true;
  return isTwitterFamilyPlatform(candidate) && isTwitterFamilyPlatform(recommended);
}

function isTwitterFamilyPlatform(value: GenerationPlatform): boolean {
  return value === "x" || value === "thread";
}

function recommendedPlatformForStyle(style: StyleModel, profile: Record<string, unknown> | null | undefined): GenerationPlatform {
  const sourcePlatform = sourcePlatformFromProfile(profile);
  if (sourcePlatform) return sourcePlatform;

  const styleText = [
    style.title,
    style.creatorHandle,
    style.blurb,
    style.about,
    ...(style.tags ?? []),
    ...(style.bestFor ?? [])
  ].join(" ").toLowerCase();
  if (/\b(thread|tweet thread|twitter thread)\b/.test(styleText)) return "thread";
  if (/\b(twitter|tweet|tweets|x profile|x post)\b/.test(styleText) || /@\w+/.test(style.title)) return "x";
  const profileText = profile ? JSON.stringify(profile).toLowerCase() : "";
  const text = `${styleText} ${profileText}`;
  if (/\b(github|readme|repository|repo|docs?)\b/.test(text)) return "github_readme";
  if (/\b(blog|article|essay|newsletter|longform|long-form)\b/.test(text)) return "blog";
  if (/\b(instagram|caption|reel)\b/.test(text)) return "instagram";
  if (/\b(linkedin|professional post)\b/.test(text)) return "thread";
  if (/\b(thread|tweet thread|twitter thread)\b/.test(text)) return "thread";
  if (/\b(twitter|tweet|tweets|x profile|x post)\b/.test(text)) return "x";
  return "x";
}

function sourcePlatformFromProfile(profile: Record<string, unknown> | null | undefined): GenerationPlatform | null {
  const rootSource = normalizeSourcePlatform(profile?.sourceKind) ?? normalizeSourcePlatform(profile?.source_kind);
  if (rootSource) return rootSource;
  const sourceProfile = recordValue(profile?.source_profile);
  const primary = normalizeSourcePlatform(sourceProfile.primary_source_type);
  if (primary) return primary;
  const inventory = Array.isArray(sourceProfile.source_inventory) ? sourceProfile.source_inventory : [];
  for (const item of inventory) {
    const platform = normalizeSourcePlatform(recordValue(item).type);
    if (platform) return platform;
  }
  const metadata = recordValue(profile?.metadata);
  return normalizeSourcePlatform(metadata.sourceKind) ?? normalizeSourcePlatform(metadata.source_kind) ?? null;
}

function normalizeSourcePlatform(value: unknown): GenerationPlatform | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "twitter" || normalized === "tweet" || normalized === "tweets" || normalized === "x") return "x";
  if (normalized === "thread" || normalized === "tweet_thread" || normalized === "twitter_thread") return "thread";
  if (normalized === "linkedin" || normalized === "linked_in") return "thread";
  if (normalized === "instagram" || normalized === "ig" || normalized === "caption") return "instagram";
  if (normalized === "blog" || normalized === "blogger" || normalized === "blogger_article" || normalized === "article" || normalized === "blog_article") return "blog";
  if (normalized === "github" || normalized === "github_readme" || normalized === "readme" || normalized === "docs") return "github_readme";
  return null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function styleHintFor(style: StyleModel | undefined): Record<string, unknown> | null {
  if (!style) return null;
  // Only send a hint when the style has real writing samples — not registry metadata placeholders
  const realSamples = style.samples.filter(
    (s) => s.label !== "Profile summary" && s.text.length > 40 && !s.text.includes("listed on-chain") && !s.text.includes("no stored profile")
  );
  if (realSamples.length === 0) return null;
  // Filter traits to only voice-relevant ones (skip Royalty / Creator / Outputs metadata)
  const voiceTraits = style.traits.filter(
    (t) => !/royalty|creator|outputs?|status|token|price/i.test(t.label)
  );
  return {
    title: style.title,
    blurb: style.blurb,
    about: style.about,
    tags: style.tags,
    bestFor: style.bestFor,
    traits: voiceTraits,
    samples: realSamples
  };
}

function creditPanelText(input: {
  address: string | null;
  isOnCorrectNetwork: boolean;
  creditState: CreditState;
  hasCredits: boolean;
  creditInfo: CreditInfo | null;
  creditError: string;
}): string {
  if (!input.address) return "Connect a wallet to check generation credits before writing a prompt.";
  if (!input.isOnCorrectNetwork) return "Switch to 0G Galileo before buying credits or starting generation.";
  if (input.creditState === "loading") return "Reading CreditSystem.credits from the backend before enabling the prompt.";
  if (input.creditState === "buying") return "Confirm the buyCredits transaction in your wallet; the prompt stays locked until the receipt is verified.";
  if (input.creditState === "error") return input.creditError || "Could not read credits from the backend.";
  if (!input.hasCredits) return `Minimum required: 1 credit. Credit price: ${formatCreditPrice(input.creditInfo?.creditPriceWei)}.`;
  return "You have enough credits to start generation. One credit is spent only after you sign the royalty settlement transaction.";
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navbar } from "../../../../components/Navbar";
import { Footer } from "../../../../components/Footer";
import { Button } from "../../../../components/Button";
import { getStyle, StyleModel } from "../../../../lib/styles";
import { readMintedStyles } from "../../../../lib/mintedStyles";
import { ChainStyleDetails, parseJsonResponse, registryStyleToModel } from "../../../../lib/registryStyles";

type PageProps = {
  params: { slug: string };
};

type LiveStageTone = "accent" | "success" | "warning";
type LiveStage = {
  at: number;
  provider: string;
  title: string;
  detail: string;
  tone: LiveStageTone;
  progress: number;
};
type LiveRun = {
  startedAt: number;
  prompt: string;
  styleTitle: string;
  finalText: string;
};
type Msg = { id: string; role: "user" | "assistant"; text: string; liveRun?: LiveRun };
type MsgGroup = { role: "user" | "assistant"; messages: Msg[] };

const LIVE_STAGES: LiveStage[] = [
  {
    at: 0,
    provider: "Style engine",
    title: "Reading the prompt",
    detail: "Identifying the request, audience, and useful output format before writing.",
    tone: "accent",
    progress: 14,
  },
  {
    at: 1.1,
    provider: "Voice match",
    title: "Mapping creator voice",
    detail: "Matching rhythm, confidence, sentence length, and the creator's usual framing.",
    tone: "accent",
    progress: 35,
  },
  {
    at: 2.2,
    provider: "Draft pass",
    title: "Generating the first pass",
    detail: "Writing a clean draft while keeping the requested style visible in every line.",
    tone: "warning",
    progress: 58,
  },
  {
    at: 3.35,
    provider: "Polish",
    title: "Tightening language",
    detail: "Removing weak phrasing, sharpening transitions, and checking the final cadence.",
    tone: "accent",
    progress: 82,
  },
  {
    at: 4.6,
    provider: "Complete",
    title: "Generation ready",
    detail: "The styled response is ready to review, copy, or iterate on.",
    tone: "success",
    progress: 100,
  },
];

const LIVE_RUN_DURATION_SECONDS = 5.1;

function mockGenerate(styleTitle: string, prompt: string) {
  const p = prompt.trim();
  if (!p) return "Give me a prompt and I’ll generate in this voice.";

  const base = p.length > 220 ? `${p.slice(0, 220)}…` : p;

  if (styleTitle.toLowerCase().includes("viral")) {
    return `Hot take: ${base}\n\nHere’s the thread version:\n1) What people think\n2) What’s actually happening\n3) What to do next\n\nWant it shorter or spicier?`;
  }
  if (styleTitle.toLowerCase().includes("formal")) {
    return `Summary:\n${base}\n\nKey points:\n- Assumptions: [mock]\n- Risks: [mock]\n- Recommendation: proceed with a small pilot and measure impact.`;
  }
  if (styleTitle.toLowerCase().includes("minimal")) {
    return `A few clean lines:\n\n${base}\n\nLess explanation.\nMore feeling.\nKeep it true.`;
  }
  if (styleTitle.toLowerCase().includes("contrarian")) {
    return `Everyone agrees on one thing about this.\n\nThat’s the red flag.\n\n${base}\n\nWatch the incentives. Price the uncertainty.`;
  }
  if (styleTitle.toLowerCase().includes("lyrical")) {
    return `The sentence arrives quietly.\n\n${base}\n\nAnd then, like steam, it lifts what was already there.`;
  }
  if (styleTitle.toLowerCase().includes("observational")) {
    return `There’s a small detail in this that matters more than it should.\n\n${base}\n\nThat’s usually how the truth shows up: softly, and then all at once.`;
  }
  return `Okay, hear me out:\n\n${base}\n\nHere’s the punchline: make it clear, make it human, and keep the rhythm tight. Want 3 variations?`;
}

export default function TryStylePage({ params }: PageProps) {
  const staticStyle = useMemo(() => getStyle(params.slug), [params.slug]);
  const [mintedStyle, setMintedStyle] = useState<StyleModel | undefined>(undefined);
  const [registryStyle, setRegistryStyle] = useState<StyleModel | undefined>(undefined);
  const [registryState, setRegistryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const style = staticStyle ?? mintedStyle ?? registryStyle;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const loadRegistryStyle = useCallback(async () => {
    setRegistryState("loading");
    try {
      const response = await fetch(`/api/backend/styles/${encodeURIComponent(params.slug)}`, { cache: "no-store" });
      const data = await parseJsonResponse<ChainStyleDetails>(response);
      setRegistryStyle(registryStyleToModel(data));
      setRegistryState("ready");
    } catch {
      setRegistryStyle(undefined);
      setRegistryState("error");
    }
  }, [params.slug]);

  useEffect(() => {
    const minted = readMintedStyles().find((s) => s.id === params.slug);
    setMintedStyle(minted);
    setRegistryStyle(undefined);

    if (!staticStyle && !minted) {
      void loadRegistryStyle();
    } else {
      setRegistryState("idle");
    }
  }, [loadRegistryStyle, params.slug, staticStyle]);

  useEffect(() => {
    if (!style) return;
    setMessages([
      {
        id: "m1",
        role: "assistant",
        text: `You’re trying “${style.title}”.\n\nTell me what you want to write (e.g., “Announce a new feature” or “Write a landing page hero”).`,
      },
    ]);
  }, [style?.id]);

  const suggestions = [
    "Write a product launch thread for a new feature.",
    "Rewrite this paragraph in a more confident voice.",
    "Create a landing page hero + subhead for a writing tool.",
  ];

  const groups = useMemo(() => groupMessages(messages), [messages]);
  const hasActiveRun = useMemo(
    () => messages.some((message) => message.liveRun && !isLiveRunComplete(message.liveRun, nowTick)),
    [messages, nowTick],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!hasActiveRun) return;
    const intervalId = window.setInterval(() => {
      setNowTick(Date.now());
    }, 400);
    return () => window.clearInterval(intervalId);
  }, [hasActiveRun]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !style) return;

    const now = Date.now().toString(36);
    const startedAt = Date.now();
    const finalText = mockGenerate(style.title, trimmed);
    const userMsg: Msg = { id: `u-${now}`, role: "user", text: trimmed };
    const assistantMsg: Msg = {
      id: `a-${now}`,
      role: "assistant",
      text: finalText,
      liveRun: {
        startedAt,
        prompt: trimmed,
        styleTitle: style.title,
        finalText,
      },
    };

    setMessages((m) => [...m, userMsg, assistantMsg]);
    setExpandedThinking((current) => ({ ...current, [assistantMsg.id]: true }));
    setNowTick(startedAt);
    setInput("");
    if (inputRef.current) {
      inputRef.current.style.height = "36px";
    }
  }

  function handleInputChange(value: string) {
    setInput(value);
    const el = inputRef.current;
    if (!el) return;

    // Auto-grow up to roughly 2 lines, then keep it fixed.
    el.style.height = "36px";
    const next = Math.min(el.scrollHeight, 56);
    el.style.height = `${next}px`;
  }

  if (!style) {
    return (
      <div>
        <Navbar />
        <main className="siteShell">
          <section className="section sectionTightTop">
            <div className="container">
              <div className="kicker">Try</div>
              <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                {registryState === "loading" ? "Finding style..." : "Style not found"}
              </h1>
              <div className="row" style={{ marginTop: 18 }}>
                <Button href="/styles" variant="primary">
                  Back to styles
                </Button>
              </div>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="styleTryPageRoot">
      <Navbar />
      <main className="siteShell styleTryMain">
        <a href={`/styles/${style.id}`} className="styleTryBackBtn">
          Back
        </a>

        <section className="styleTryChatRoot">
          <div className="styleTryChatScroller">
            <div className="styleTryChatInner">
              <div className="styleTryHeaderMeta">
                <div className="styleTryTitle">
                  Writing with <span>{style.creatorName}</span> · @{style.creatorHandle}
                </div>
                <div className="styleTryPricePill">{style.price}</div>
              </div>

              <div role="log" aria-label="Chat messages">
                {groups.map((group, groupIndex) => (
                  <div
                    key={`${group.role}-${groupIndex}`}
                    className={`styleTryMessageGroup ${
                      group.role === "user" ? "styleTryMessageGroupUser" : ""
                    }`}
                  >
                    <div
                      className={
                        group.role === "user"
                          ? "styleTryAvatar styleTryAvatarUser"
                          : "styleTryAvatar styleTryAvatarAi"
                      }
                      aria-hidden="true"
                    >
                      {group.role === "user" ? "U" : "AI"}
                    </div>

                    <div
                      className={
                        group.role === "user"
                          ? "styleTryBubbleStack styleTryBubbleStackUser"
                          : "styleTryBubbleStack"
                      }
                    >
                      {group.messages.map((m) => (
                        <div
                          key={m.id}
                          className={
                            m.role === "user"
                              ? "styleTryBubble styleTryBubbleUser"
                              : "styleTryBubble styleTryBubbleAi"
                          }
                        >
                          {m.liveRun ? (
                            <LiveStyleGeneration
                              run={m.liveRun}
                              nowTick={nowTick}
                              expanded={expandedThinking[m.id] ?? true}
                              onToggle={() =>
                                setExpandedThinking((current) => ({
                                  ...current,
                                  [m.id]: !(current[m.id] ?? true),
                                }))
                              }
                            />
                          ) : (
                            m.text
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
          </div>

          <div className="styleTryComposerWrap">
            <div className="styleTrySuggestions" aria-label="Suggestions">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="styleTrySuggestion"
                    onClick={() => send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>

            <div className="styleTryComposer">
                <textarea
                  ref={inputRef}
                  className="styleTryInput"
                  value={input}
                  onChange={(e) => handleInputChange(e.target.value)}
                  placeholder="Describe what you want to write…"
                  aria-label="Message input"
                />
              <button
                type="button"
                className="styleTrySendBtn"
                onClick={() => send(input)}
                aria-label="Generate"
              >
                Generate
              </button>
              </div>
            </div>
        </section>
      </main>
    </div>
  );
}

function LiveStyleGeneration({
  run,
  nowTick,
  expanded,
  onToggle,
}: {
  run: LiveRun;
  nowTick: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const elapsedSeconds = Math.max(0, (nowTick - run.startedAt) / 1000);
  const complete = isLiveRunComplete(run, nowTick);
  const activeStage = currentStageForElapsed(elapsedSeconds);
  const visibleStages = LIVE_STAGES.filter((stage) => stage.at <= elapsedSeconds || complete);
  const previewText = complete
    ? run.finalText
    : buildPreviewText(run.finalText, activeStage.progress);

  return (
    <div className="styleTryLiveWrap">
      <div className="styleTryThoughtSummaryWrap">
        <button type="button" className="styleTryThoughtSummary" onClick={onToggle}>
          Thought for {formatDurationLabel(Math.round(complete ? LIVE_RUN_DURATION_SECONDS : elapsedSeconds))}
          <span className={expanded ? "styleTryChevron styleTryChevronOpen" : "styleTryChevron"} aria-hidden="true">
            ›
          </span>
        </button>
      </div>

      {expanded ? (
        <div className="styleTryLiveTracePanel">
          <div className="styleTryLiveTraceSummary">
            <div className="styleTryLiveTraceSummaryTop">
              <span className={`styleTryLiveStatusDot styleTryLiveStatusDot-${activeStage.tone}`} />
              <span className={`styleTryLiveProviderBadge styleTryLiveProviderBadge-${activeStage.tone}`}>
                {activeStage.provider}
              </span>
              <span className="styleTryLiveTraceTime">
                {complete ? "Finished" : `${Math.max(1, Math.ceil(LIVE_RUN_DURATION_SECONDS - elapsedSeconds))}s left`}
              </span>
            </div>
            <p className="styleTryLiveTraceTitle">{activeStage.title}</p>
            <p className="styleTryLiveTraceDetail">{activeStage.detail}</p>
          </div>

          <div className="styleTryThoughtLog">
            {visibleStages.map((stage, index) => {
              const isLast = index === visibleStages.length - 1;
              return (
                <div key={stage.title} className="styleTryThoughtStep">
                  <div className="styleTryThoughtBulletCol">
                    <span className={`styleTryThoughtBullet styleTryThoughtBullet-${stage.tone}`} />
                    {!isLast ? <span className="styleTryThoughtLine" /> : null}
                  </div>
                  <div className="styleTryThoughtStepContent">
                    <div className="styleTryThoughtProviderRow">
                      <span className="styleTryThoughtProvider">{stage.provider}</span>
                      <span className="styleTryThoughtTimestamp">{formatDurationLabel(Math.round(stage.at))}</span>
                    </div>
                    <p className="styleTryThoughtStepTitle">{stage.title}</p>
                    <p className="styleTryThoughtStepDetail">{stage.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="styleTryGenerationCard">
        <div className="styleTryGenerationHeader">
          <div>
            <p className="styleTryGenerationKicker">Live generation</p>
            <h3 className="styleTryGenerationTitle">{run.styleTitle}</h3>
          </div>
          <span className={`styleTryGenerationStatus ${complete ? "styleTryGenerationStatusDone" : ""}`}>
            {complete ? "ready" : "writing"}
          </span>
        </div>
        <div className="styleTryProgressTrack" aria-hidden="true">
          <span style={{ width: `${activeStage.progress}%` }} />
        </div>
        <div className="styleTryGenerationPreview">
          {previewText}
          {!complete ? <span className="styleTryCursor" aria-hidden="true" /> : null}
        </div>
        <div className="styleTryGenerationMeta">
          <span>{complete ? "Final response" : "Streaming mock UI"}</span>
          <span>{shortPrompt(run.prompt)}</span>
        </div>
      </div>
    </div>
  );
}

function currentStageForElapsed(elapsedSeconds: number) {
  return [...LIVE_STAGES].reverse().find((stage) => stage.at <= elapsedSeconds) ?? LIVE_STAGES[0];
}

function isLiveRunComplete(run: LiveRun, nowTick: number) {
  return (nowTick - run.startedAt) / 1000 >= LIVE_RUN_DURATION_SECONDS;
}

function buildPreviewText(value: string, progress: number) {
  const visibleLength = Math.max(18, Math.floor(value.length * Math.min(progress, 92) / 100));
  return value.slice(0, visibleLength).trimEnd();
}

function shortPrompt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 54 ? `${normalized.slice(0, 54)}...` : normalized;
}

function formatDurationLabel(totalSeconds: number) {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function groupMessages(messages: Msg[]): MsgGroup[] {
  return messages.reduce<MsgGroup[]>((acc, msg) => {
    const last = acc[acc.length - 1];
    if (last && last.role === msg.role) {
      last.messages.push(msg);
      return acc;
    }
    acc.push({ role: msg.role, messages: [msg] });
    return acc;
  }, []);
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Navbar } from "../../../../components/Navbar";
import { Footer } from "../../../../components/Footer";
import { Button } from "../../../../components/Button";
import { getStyle } from "../../../../lib/styles";
import { readMintedStyles } from "../../../../lib/mintedStyles";

type PageProps = {
  params: { slug: string };
};

type Msg = { id: string; role: "user" | "assistant"; text: string };
type MsgGroup = { role: "user" | "assistant"; messages: Msg[] };

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
  const [mintedStyle, setMintedStyle] = useState<typeof staticStyle | undefined>(undefined);
  const style = staticStyle ?? mintedStyle;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const minted = readMintedStyles().find((s) => s.id === params.slug);
    setMintedStyle(minted);
  }, [params.slug]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !style) return;

    const now = Date.now().toString(36);
    const userMsg: Msg = { id: `u-${now}`, role: "user", text: trimmed };
    const assistantMsg: Msg = {
      id: `a-${now}`,
      role: "assistant",
      text: mockGenerate(style.title, trimmed),
    };

    setMessages((m) => [...m, userMsg, assistantMsg]);
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
                Style not found
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
                          {m.text}
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


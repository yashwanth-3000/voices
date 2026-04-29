 "use client";

import { useMemo, useState } from "react";
import { Navbar } from "../../../../components/Navbar";
import { Footer } from "../../../../components/Footer";
import { Button } from "../../../../components/Button";
import { getStyle } from "../../../../lib/styles";

type PageProps = {
  params: { slug: string };
};

type Msg = { id: string; role: "user" | "assistant"; text: string };

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
  const style = useMemo(() => getStyle(params.slug), [params.slug]);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>(() => {
    const title = style?.title ?? "this style";
    return [
      {
        id: "m1",
        role: "assistant",
        text: `You’re trying “${title}”.\n\nTell me what you want to write (e.g., “Announce a new feature” or “Write a landing page hero”).`,
      },
    ];
  });

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

  const suggestions = [
    "Write a product launch thread for a new feature.",
    "Rewrite this paragraph in a more confident voice.",
    "Create a landing page hero + subhead for a writing tool.",
  ];

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = Date.now().toString(36);
    const userMsg: Msg = { id: `u-${now}`, role: "user", text: trimmed };
    const assistantMsg: Msg = {
      id: `a-${now}`,
      role: "assistant",
      text: mockGenerate(style!.title, trimmed),
    };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
  }

  return (
    <div className="chatPageRoot">
      <Navbar />
      <main className="siteShell chatPageMain">
        <section className="section sectionTightTop chatPageSection">
          <div className="container chatPageContainer">
            <h1 className="chatPageHeading">Generate content in selected style</h1>
            <div className="chatShell chatShellFull" style={{ marginTop: 14 }}>
              <div className="chatHeader">
                <div className="chatTitle">
                  Writing with <span className="chatAccent">{style.creatorName}</span> · @
                  {style.creatorHandle}
                </div>
                <div className="chatPill">{style.price}</div>
              </div>

              <div className="chatBody" role="log" aria-label="Chat messages">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={m.role === "user" ? "chatMsg chatUser" : "chatMsg chatAssistant"}
                  >
                    <div className="chatBubble">{m.text}</div>
                  </div>
                ))}
              </div>

              <div className="chatSuggestions" aria-label="Suggestions">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chatSuggestion"
                    onClick={() => send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <div className="chatComposer">
                <textarea
                  className="chatInput"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Describe what you want to write…"
                  aria-label="Message input"
                />
                <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
                  <Button
                    variant="secondary"
                    href="/styles"
                    ariaLabel="Back to styles"
                  >
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => send(input)}
                    ariaLabel="Generate"
                  >
                    Generate
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}


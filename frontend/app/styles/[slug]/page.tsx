 "use client";

import { useEffect, useMemo, useState } from "react";
import { Navbar } from "../../../components/Navbar";
import { Footer } from "../../../components/Footer";
import { Button } from "../../../components/Button";
import { PreviewBlock } from "../../../components/PreviewBlock";
import { getStyle } from "../../../lib/styles";
import { readMintedStyles } from "../../../lib/mintedStyles";

type PageProps = {
  params: { slug: string };
};

export default function StyleDetailPage({ params }: PageProps) {
  // Note: the route segment folder is `[slug]`, but we treat it as the style `id`.
  const staticStyle = useMemo(() => getStyle(params.slug), [params.slug]);
  const [mintedStyle, setMintedStyle] = useState<ReturnType<typeof getStyle> | undefined>(undefined);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const minted = readMintedStyles().find((s) => s.id === params.slug);
    setMintedStyle(minted);
  }, [params.slug]);

  const style = staticStyle ?? mintedStyle;

  if (!style) {
    if (!mounted) {
      return (
        <div>
          <Navbar />
          <main className="siteShell">
            <section className="section sectionTightTop">
              <div className="container">
                <div className="kicker">Loading</div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                  Finding style…
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
          <section className="section">
            <div className="container">
              <div className="kicker">Styles</div>
              <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                Style not found
              </h1>
              <p className="sectionSub">
                This is a mock frontend prototype. Try going back to the gallery.
              </p>
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
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="kicker">Style</div>
            <div className="styleHeader">
              <div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                  {style.title}
                </h1>
                <p className="sectionSub">
                  By <strong>{style.creatorName}</strong> · @{style.creatorHandle} ·{" "}
                  <span className="muted">{style.price}</span>
                </p>
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <Button href="/styles" variant="secondary">
                  Back to styles
                </Button>
              </div>
            </div>

            <div className="grid twoCol" style={{ marginTop: 18 }}>
              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">About</div>
                  <h2 className="panelTitle" style={{ marginTop: 10 }}>
                    What this voice feels like
                  </h2>
                  <p className="panelSub">{style.about}</p>
                </div>
                <div className="panelBody">
                  <div className="styleTraitGrid" aria-label="Style traits">
                    {style.traits.map((t) => (
                      <div className="styleTrait" key={t.label}>
                        <div className="styleTraitLabel">{t.label}</div>
                        <div className="styleTraitValue">{t.value}</div>
                      </div>
                    ))}
                  </div>

                  <div className="aboutBottomActions" style={{ marginTop: 14 }}>
                    <span className="stylePriceTag">{style.price}</span>
                    <div className="aboutActionButtons">
                      <Button
                        href={`/styles/${style.id}/try`}
                        variant="primary"
                        className="tryStyleCta"
                      >
                        Try style
                      </Button>
                      <Button
                        variant="secondary"
                        className="buyCreditsCta"
                        ariaLabel={`Buy credits for style ${style.title}`}
                      >
                        Buy credits
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">Best for</div>
                  <h2 className="panelTitle" style={{ marginTop: 10 }}>
                    Where it shines
                  </h2>
                  <p className="panelSub">
                    Common use cases creators and teams pick this voice for.
                  </p>
                </div>
                <div className="panelBody">
                  <div className="chips">
                    {style.bestFor.map((b) => (
                      <span className="chip" key={b}>
                        {b}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <PreviewBlock
                      title="Marketplace preview (mock)"
                      toneLabel={style.title}
                      content={style.samples[0]?.text ?? "—"}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 18 }}>
              <div className="cardInner">
                <div className="kicker">Samples</div>
                <h2 className="sectionTitle" style={{ marginTop: 10 }}>
                  Example outputs
                </h2>
                <p className="sectionSub">
                  These are hardcoded previews to make the idea feel real. In a real
                  app, they’d be generated from the style model.
                </p>

                <div className="grid previewColumns" style={{ marginTop: 18 }}>
                  {style.samples.map((s) => (
                    <PreviewBlock
                      key={s.label}
                      title={s.label}
                      toneLabel={style.creatorHandle}
                      content={s.text}
                    />
                  ))}
                </div>

                <div
                  className="row"
                  style={{ marginTop: 18, justifyContent: "space-between" }}
                >
                  <Button href="/styles" variant="secondary">
                    Back to styles
                  </Button>
                  <Button
                    href={`/styles/${style.id}/try`}
                    variant="primary"
                  >
                    Try style
                  </Button>
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


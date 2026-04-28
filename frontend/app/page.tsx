import { Navbar } from "../components/Navbar";
import { Footer } from "../components/Footer";
import { Button } from "../components/Button";
import { StyleCard } from "../components/StyleCard";
import { CreatorCard } from "../components/CreatorCard";
import { PreviewBlock } from "../components/PreviewBlock";

type FeaturedStyle = {
  name: string;
  badge: string;
  description: string;
};

type Creator = {
  name: string;
  handle: string;
  style: string;
  description: string;
  pricePerUse: string;
  tags: string[];
};

const featuredStyles: FeaturedStyle[] = [
  {
    name: "Witty & conversational",
    badge: "SaaS / Blog",
    description:
      "Warm, punchy sentences with clever callbacks. Great for founder updates and product storytelling.",
  },
  {
    name: "Formal & analytical",
    badge: "Research",
    description:
      "Clear definitions, structured arguments, and calm tone. Built for memos, docs, and deep dives.",
  },
  {
    name: "Minimal & poetic",
    badge: "Brand",
    description:
      "Sparse language, vivid imagery, strong cadence. Perfect for landing pages and brand copy.",
  },
  {
    name: "Viral social media voice",
    badge: "Short-form",
    description:
      "High hook density, pattern breaks, and relatable punchlines. Optimized for scroll-stopping posts.",
  },
];

const creators: Creator[] = [
  {
    name: "Romi Chen",
    handle: "romi",
    style: "playful brand voice",
    description:
      "Okay so hear me out: warm brand writing with quiet humor, soft persuasion, and a slight crush on em dashes.",
    pricePerUse: "$0.02 / gen",
    tags: ["playful", "casual", "millennial"],
  },
  {
    name: "Saoirse Doyle",
    handle: "saoirse",
    style: "intense narrative",
    description:
      "She wrote like the room was on fire and she had exactly one paragraph to say what mattered.",
    pricePerUse: "$0.09 / gen",
    tags: ["intense", "narrative", "poetic"],
  },
  {
    name: "Devansh Patel",
    handle: "dev.p",
    style: "contrarian finance",
    description:
      "The market is wrong about three things, two of which I'll defend. The third is yours to figure out.",
    pricePerUse: "$0.06 / gen",
    tags: ["analytical", "contrarian", "concise"],
  },
  {
    name: "Lin Halverson",
    handle: "lin.h",
    style: "observational essay",
    description:
      "I keep a notebook of sentences I wish I'd written. Today’s was kind and precise, with a tender ache.",
    pricePerUse: "$0.06 / gen",
    tags: ["observational", "tender", "essay"],
  },
  {
    name: "Maren Vasquez",
    handle: "maren.v",
    style: "lyrical literary",
    description:
      "The kettle clicked off. Outside, the city kept doing its slow, deliberate thing, and the paragraph listened.",
    pricePerUse: "$0.06 / gen",
    tags: ["lyrical", "quiet", "literary"],
  },
];

const generatedPreviews = [
  {
    title: "Product launch thread",
    toneLabel: "Viral social",
    content:
      "We rebuilt onboarding in 14 days.\n\nHere’s what surprised us:\n1) People don’t hate setup. They hate guessing.\n2) “Next step” beats “More options.”\n3) Shipping wins trust faster than promises.\n\nIf you’re fixing activation: start with the first 30 seconds, not week 2.",
  },
  {
    title: "Executive memo",
    toneLabel: "Formal analytical",
    content:
      "Summary:\nThe proposed pricing change increases ARR by an estimated 7–10% with moderate churn risk.\n\nKey assumptions:\n- Adoption uplift driven by clarified value tiers\n- Churn concentrated in low-usage segment\n\nRecommendation:\nPilot for 30 days with segmented rollout and weekly retention review.",
  },
  {
    title: "Landing page hero copy",
    toneLabel: "Minimal poetic",
    content:
      "Write like you.\nEverywhere.\n\nA style you can share.\nA voice that stays yours.\nA marketplace that pays for craft.",
  },
];

export default function Page() {
  return (
    <div id="top">
      <Navbar />

      <main className="siteShell">
        <section className="hero">
          <div className="container">
            <div className="heroIntro fadeInUp">
              <h1 className="headline editorialHeadline">
                Write in anyone&apos;s <span className="headlineAccent">voice</span>,{" "}
                <span className="headlineMuted">ethically.</span>
              </h1>
              <p className="subhead heroCopy">
                ContentHub lets creators upload writing samples, turn tone into a
                licensable style, and get paid when brands, teams, and solo users
                generate in that voice.
              </p>

              <div className="row ctaRow heroActions" role="group" aria-label="Primary actions">
                <Button href="#creators" variant="primary">
                  Explore writing styles
                </Button>
                <Button href="#upload" variant="secondary">
                  Upload your style <span aria-hidden="true">↑</span>
                </Button>
              </div>

              <div className="heroStats">
                <span>2,841 styles</span>
                <span className="sep">•</span>
                <span>$0.04 avg / generation</span>
                <span className="sep">•</span>
                <span>Creator-first licensing</span>
              </div>
            </div>
          </div>
        </section>

        <section className="creatorStripSection" id="creators">
          <div className="container">
            <div className="creatorStrip" aria-label="Featured creator styles">
              <div className="creatorTrack">
                {[...creators, ...creators].map((c, idx) => (
                  <CreatorCard
                    key={`${c.handle}-${idx}`}
                    name={c.name}
                    handle={c.handle}
                    style={c.style}
                    description={c.description}
                    pricePerUse={c.pricePerUse}
                    tags={c.tags}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="container">
            <div className="kicker">How it works</div>
            <h2 className="sectionTitle">From samples to a sellable style</h2>
            <p className="sectionSub">
              The same simple three-step loop as the concept: creators upload,
              ContentHub analyzes the voice, and explorers license output on demand.
            </p>

            <div className="grid howGrid" style={{ marginTop: 16 }}>
              <div className="step">
                <span className="stepNum" aria-hidden="true">
                  1
                </span>
                <div className="stepTitle">Upload your writing</div>
                <div className="stepDesc">
                  Add a few samples: newsletters, threads, blog posts, or docs.
                  The more variety, the sharper the voice.
                </div>
              </div>
              <div className="step">
                <span className="stepNum" aria-hidden="true">
                  2
                </span>
                <div className="stepTitle">AI analyzes your style</div>
                <div className="stepDesc">
                  We extract tone, cadence, structure, and signature patterns—then
                  package them into a consistent style profile.
                </div>
              </div>
              <div className="step">
                <span className="stepNum" aria-hidden="true">
                  3
                </span>
                <div className="stepTitle">Others use it and pay you</div>
                <div className="stepDesc">
                  Teams generate content in your voice. You earn per usage while
                  your style stays credited and discoverable.
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="featured">
          <div className="container">
            <div className="kicker">Featured examples</div>
            <h2 className="sectionTitle">Popular voices to start with</h2>
            <p className="sectionSub">
              Distinct voices, clean metadata, and soft editorial cards that make
              the marketplace feel instantly browsable.
            </p>

            <div className="grid stylesGrid" style={{ marginTop: 16 }}>
              {featuredStyles.map((s) => (
                <StyleCard
                  key={s.name}
                  name={s.name}
                  badge={s.badge}
                  description={s.description}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="creators">
          <div className="container">
            <div className="kicker">Marketplace</div>
            <h2 className="sectionTitle">Creators you can license</h2>
            <p className="sectionSub">
              Sample creator listings with pricing, style summaries, and tags.
              In a real product this would be searchable and filterable.
            </p>

            <div className="grid creatorGrid" style={{ marginTop: 16 }}>
              {creators.map((c) => (
                <CreatorCard
                  key={c.handle}
                  name={c.name}
                  handle={c.handle}
                  style={c.style}
                  description={c.description}
                  pricePerUse={c.pricePerUse}
                  tags={c.tags}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="explorers">
          <div className="container">
            <div className="grid twoCol">
              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">Creator panel</div>
                  <h3 className="panelTitle" style={{ marginTop: 8 }}>
                    Upload samples, preview your style profile, track earnings.
                  </h3>
                  <p className="panelSub">
                    A simple creator workflow: add examples, review the extracted
                    voice traits, then publish pricing for teams to use your style.
                  </p>
                </div>
                <div className="panelBody" id="upload">
                  <div className="grid" style={{ gap: 12 }}>
                    <PreviewBlock
                      title="Upload queue"
                      toneLabel="3 samples"
                      content={
                        "✓ newsletter_apr.txt\n✓ product_story.md\n✓ thread_draft.txt\n\nNext: publish your style listing →"
                      }
                    />
                    <div className="row">
                      <Button variant="primary" href="#upload" ariaLabel="Upload your style (demo)">
                        Upload Your Style
                      </Button>
                      <span className="muted" style={{ fontSize: 13 }}>
                        Frontend-only prototype
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">Explorer panel</div>
                  <h3 className="panelTitle" style={{ marginTop: 8 }}>
                    Browse creators, preview styles, generate content.
                  </h3>
                  <p className="panelSub">
                    Pick a voice for a task, skim a preview, then generate with
                    consistent tone across all your channels.
                  </p>
                </div>
                <div className="panelBody">
                  <div className="grid" style={{ gap: 12 }}>
                    <PreviewBlock
                      title="Prompt → Output"
                      toneLabel="Witty conversational"
                      content={
                        "Prompt:\nWrite an announcement about a new feature that saves time.\n\nOutput:\nToday we shipped the feature your calendar begged for.\nLess clicking. Fewer tabs. More “done.”\n\nHere’s the punchline: it quietly removes the tiny delays that add up to a whole afternoon."
                      }
                    />
                    <div className="row">
                      <Button href="#creators" variant="secondary">
                        Browse creators <span aria-hidden="true">↗</span>
                      </Button>
                      <Button href="#featured" variant="primary">
                        Explore styles <span aria-hidden="true">→</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="card previewStack">
              <div className="cardInner">
                <div className="kicker">Generated outputs</div>
                <h2 className="sectionTitle" style={{ marginTop: 10 }}>
                  See the style before you commit.
                </h2>
                <p className="sectionSub">
                  Preview examples make it obvious whether a voice is sharp,
                  lyrical, analytical, or social-first before anyone spends.
                </p>
                <div className="grid previewColumns" style={{ marginTop: 18 }}>
                  {generatedPreviews.map((p) => (
                    <PreviewBlock
                      key={p.title}
                      title={p.title}
                      toneLabel={p.toneLabel}
                      content={p.content}
                    />
                  ))}
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


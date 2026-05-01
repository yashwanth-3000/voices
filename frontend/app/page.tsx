import { Navbar } from "../components/Navbar";
import { Footer } from "../components/Footer";
import { Button } from "../components/Button";
import { CreatorCard } from "../components/CreatorCard";

type WorkflowHighlight = {
  name: string;
  handle: string;
  style: string;
  description: string;
  pricePerUse: string;
  tags: string[];
};

const proofStats = [
  {
    value: "AgentBrain",
    label: "encrypted samples, profile KV, and memory pointers",
  },
  {
    value: "3 agents",
    label: "context, writer, and critic working as one swarm",
  },
  {
    value: "0G proof",
    label: "compute calls, logs, manifests, and settlement state",
  },
];

const proofTimeline = [
  {
    step: "01",
    title: "Voice Context",
    meta: "0G evidence",
    copy: "Reads StyleRegistry, AgentBrain manifest, profile KV, sample excerpts, and memory logs before writing starts.",
  },
  {
    step: "02",
    title: "Style Writer",
    meta: "0G Compute",
    copy: "Turns the prompt and runtime voice packet into the selected format without hardcoded creator phrases.",
  },
  {
    step: "03",
    title: "Critic + Memory",
    meta: "0G Log / KV",
    copy: "Checks the draft against stored evidence, asks for revision when weak, and records learned preferences.",
  },
  {
    step: "04",
    title: "Settlement",
    meta: "0G Chain",
    copy: "Prepares the spend-credit transaction so the creator gets paid when the output is used.",
  },
];

const uploadSourceFeatures = [
  {
    title: "Upload Files",
    label: "TXT / Markdown",
    copy: "Drop TXT or Markdown samples. The full text is preserved in source-material form before the backend profiles the voice.",
  },
  {
    title: "Twitter",
    label: "Profile URL",
    copy: "Import original public posts from one account, including profile details and tweet metrics for context.",
  },
  {
    title: "Blog/Article",
    label: "Up to 3 URLs",
    copy: "Fetch readable article markdown, metadata, summaries, and source URLs into the sample editor.",
  },
  {
    title: "GitHub",
    label: "GitHub",
    copy: "Find public repos, select READMEs, and import technical writing with stars, repo metadata, and paths.",
  },
];

const uploadMintFeatures = [
  {
    label: "Wallet connected",
    detail: "Creator address signs the sample attestation.",
  },
  {
    label: "Source added",
    detail: "Files, X posts, articles, or READMEs become source materials.",
  },
  {
    label: "Samples ready",
    detail: "At least 200 characters are required before minting.",
  },
  {
    label: "Style named",
    detail: "Name, description, keywords, and royalty terms are packaged.",
  },
];

const uploadBackendEvents = [
  "style.uploaded",
  "agent.activity",
  "style.mint.intent.created",
  "style.minted",
];

const uploadPipeline = [
  "Connect wallet",
  "Add source material",
  "Sign sample attestation",
  "Backend /styles/upload",
  "0G profile + AgentBrain",
  "Sign mint intent",
  "Confirm token + proof",
];

const workflowHighlights: WorkflowHighlight[] = [
  {
    name: "Voice Context",
    handle: "agent.one",
    style: "evidence reader",
    description:
      "Reads StyleRegistry, AgentBrain, profile KV, excerpts, and memory logs before writing starts.",
    pricePerUse: "0G evidence",
    tags: ["profile", "samples", "memory"],
  },
  {
    name: "Style Writer",
    handle: "agent.two",
    style: "voice transfer",
    description:
      "Uses the runtime voice packet and prompt to produce the selected output format through 0G Compute.",
    pricePerUse: "0G Compute",
    tags: ["tweet", "blog", "readme"],
  },
  {
    name: "Critic + Memory",
    handle: "agent.three",
    style: "quality loop",
    description:
      "Checks the draft against stored style evidence, requests revision when weak, and records learning back to memory.",
    pricePerUse: "0G Log / KV",
    tags: ["critique", "revision", "memory"],
  },
  {
    name: "Proof Trail",
    handle: "auditable",
    style: "request evidence",
    description:
      "Shows the agent timeline, compute metadata, AgentBrain links, receipts, and settlement status in one view.",
    pricePerUse: "TEE verified",
    tags: ["logs", "proof", "settlement"],
  },
  {
    name: "Royalty Settlement",
    handle: "credit.flow",
    style: "paid usage",
    description:
      "Turns a passed draft into a spend-credit intent so the user signs once and the style owner gets paid.",
    pricePerUse: "0.0005 OG / gen",
    tags: ["credits", "royalty", "chain"],
  },
];

const generationSurfaces = [
  {
    title: "Tweet thread",
    label: "Voice-matched",
    lines: [
      "1/4 Voices turns writing style into an ownable AI asset.",
      "2/4 Upload samples. Extract tone, cadence, structure, and phrasing.",
      "3/4 Generate through a voice swarm, not a generic prompt.",
      "4/4 Every use leaves proof and prepares royalty settlement.",
    ],
  },
  {
    title: "Agent log",
    label: "Live backend",
    lines: [
      "Voice Context: runtime packet prepared from stored evidence.",
      "Style Writer: draft generated through 0G Compute.",
      "Critic + Memory: style score checked and queued for memory.",
      "Distribution: spend-credit intent prepared.",
    ],
  },
  {
    title: "Proof summary",
    label: "Settlement-ready",
    lines: [
      "Request settled.",
      "Agent steps recorded.",
      "Compute calls attached.",
      "AgentBrain manifest linked.",
      "Royalty payment ready for the creator.",
    ],
  },
];

const marketplaceOwnerSteps = [
  {
    title: "Source evidence",
    copy: "Samples, imports, profile KV, and memory pointers become the style's evidence base.",
  },
  {
    title: "AgentBrain published",
    copy: "The voice points to encrypted source material, extracted profile, and royalty terms.",
  },
  {
    title: "Royalty terms",
    copy: "Every successful use prepares a spend-credit settlement for the style owner.",
  },
];

const marketplaceConsumerSteps = [
  {
    title: "Choose a style",
    copy: "Pick a minted voice from the marketplace and send a format-specific prompt.",
  },
  {
    title: "CrewAI generation",
    copy: "Context, writer, and critic agents stream logs while the draft is produced.",
  },
  {
    title: "Inspect + settle",
    copy: "Open the proof trail, review the generated output, and sign the royalty payment.",
  },
];

const marketplaceBridge = [
  "AgentBrain",
  "0G Compute",
  "0G Log",
  "Spend credit",
];

export default function Page() {
  return (
    <div id="top">
      <Navbar />

      <main className="siteShell">
        <section className="hero">
          <div className="container">
            <div className="heroIntro fadeInUp">
              <h1 className="headline editorialHeadline heroMainHeading">
                Write in anyone&apos;s <span className="headlineAccent">voice</span>,{" "}
                <span className="headlineMuted">ethically.</span>
              </h1>
              <p className="subhead heroCopy">
                Voices turns creator writing samples into iNFT-backed styles that
                can be browsed, used by a CrewAI voice swarm, proven through 0G
                evidence, and settled with on-chain royalties.
              </p>

              <div className="row ctaRow heroActions" role="group" aria-label="Primary actions">
                <Button href="/styles" variant="primary">
                  Browse live styles
                </Button>
                <Button href="/upload" variant="secondary">
                  Mint your voice <span aria-hidden="true">↑</span>
                </Button>
              </div>

            </div>
          </div>
        </section>

        <section className="creatorStripSection" aria-label="Agent workflow highlights">
          <div className="container">
            <div className="creatorStrip" aria-label="Agent workflow highlights">
              <div className="creatorTrack">
                {[...workflowHighlights, ...workflowHighlights].map((c, idx) => (
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
            <h2 className="sectionTitle">From writing samples to an ownable voice agent</h2>
            <p className="sectionSub">
              Voices combines the creator onboarding lifecycle with a generation
              swarm. One side mints the voice. The other side uses it, proves the
              run, and settles payment.
            </p>

            <div className="grid howGrid" style={{ marginTop: 16 }}>
              <div className="step">
                <span className="stepNum" aria-hidden="true">
                  1
                </span>
                <div className="stepTitle">Upload voice evidence</div>
                <div className="stepDesc">
                  Add creator-owned samples. The backend encrypts and stores the
                  evidence, then builds a structured style profile.
                </div>
              </div>
              <div className="step">
                <span className="stepNum" aria-hidden="true">
                  2
                </span>
                <div className="stepTitle">Publish the AgentBrain</div>
                <div className="stepDesc">
                  The style profile, memory pointers, sealed key reference, and
                  manifest become an ownable iNFT-style voice on 0G.
                </div>
              </div>
              <div className="step">
                <span className="stepNum" aria-hidden="true">
                  3
                </span>
                <div className="stepTitle">Generate, critique, settle</div>
                <div className="stepDesc">
                  CrewAI agents write and critique the draft, then prepare a
                  spend-credit transaction that pays the style owner royalty.
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section uploadFeatureSection" id="upload-flow">
          <div className="container">
            <div className="uploadFeatureHeader">
              <div>
                <div className="kicker">Upload page</div>
                <h2 className="sectionTitle">A real mint studio for creator voices.</h2>
              </div>
              <p className="sectionSub">
                The upload page turns creator-owned evidence into a style iNFT:
                import source material, configure the voice, pass readiness,
                sign an ownership attestation, stream the backend workflow, then
                sign the on-chain mint intent.
              </p>
            </div>

            <div className="uploadFeatureShell">
              <article className="uploadStudioPanel" aria-label="Upload source options">
                <div className="uploadPanelTop">
                  <div>
                    <span>Content Sources</span>
                    <strong>Four ways to build the evidence packet</strong>
                  </div>
                  <Button href="/upload" variant="primary">
                    Open upload
                  </Button>
                </div>

                <div className="uploadSourceTabs" aria-label="Upload source tabs preview">
                  {uploadSourceFeatures.map((source) => (
                    <span key={source.title}>{source.title}</span>
                  ))}
                </div>

                <div className="uploadStudioBody">
                  <div className="uploadSourceGrid">
                    {uploadSourceFeatures.map((source) => (
                      <div className="uploadSourceCard" key={source.title}>
                        <div className="uploadSourceCardTop">
                          <strong>{source.title}</strong>
                          <span>{source.label}</span>
                        </div>
                        <p>{source.copy}</p>
                      </div>
                    ))}
                  </div>

                  <div className="uploadStudioPreviewGrid">
                    <div className="uploadEditorPreview">
                      <div className="uploadPreviewHead">
                        <span>Sample editor</span>
                        <strong>2,480 chars</strong>
                      </div>
                      <p>
                        [Import: GitHub README voices/backend]
                        <br />
                        Full source text is preserved with source kind, label,
                        unit count, character count, and metadata before profiling.
                      </p>
                    </div>

                    <div className="uploadConfigPreview">
                      <div className="uploadPreviewHead">
                        <span>Voice Configuration</span>
                        <strong>Ready</strong>
                      </div>
                      <div className="uploadConfigRows">
                        <span>Style name</span>
                        <strong>Technical Builder Voice</strong>
                        <span>Keywords</span>
                        <strong>agents · 0G · backend</strong>
                        <span>Royalty</span>
                        <strong>5.0%</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </article>

              <article className="uploadMintPanel" aria-label="Mint readiness features">
                <div className="laneBadge">Mint readiness</div>
                <h3>Configure the voice, pass checks, then mint on-chain.</h3>
                <div className="uploadMintChecks">
                  {uploadMintFeatures.map((feature) => (
                    <div className="uploadMintCheck" key={feature.label}>
                      <span aria-hidden="true" />
                      <div>
                        <strong>{feature.label}</strong>
                        <p>{feature.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="uploadLogPreview">
                  <div className="uploadPreviewHead">
                    <span>Live Backend Logs</span>
                    <strong>open</strong>
                  </div>
                  {uploadBackendEvents.map((event) => (
                    <div className="uploadLogRow" key={event}>
                      <span aria-hidden="true" />
                      <code>{event}</code>
                    </div>
                  ))}
                </div>

                <div className="uploadRoyaltyPreview">
                  <span>Mint intent</span>
                  <strong>1.0% - 20.0% royalty</strong>
                  <p>After profiling, the backend returns a wallet-signable transaction and links the proof trail for the request.</p>
                </div>
              </article>
            </div>

            <div className="uploadPipelineRail" aria-label="Upload mint pipeline">
              {uploadPipeline.map((step, index) => (
                <div className="uploadPipelineStep" key={step}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section proofSection" id="featured">
          <div className="container">
            <div className="proofCockpit">
              <div className="proofIntro">
                <div className="kicker">What the proof shows</div>
                <h2 className="sectionTitle">A marketplace with proof built in</h2>
                <p className="sectionSub">
                  Voices is not just a content form. Each generation exposes the
                  agent decisions, stored evidence, compute calls, and settlement
                  state behind the output.
                </p>
                <div className="proofMetricGrid">
                  {proofStats.map((stat) => (
                    <div className="proofMetric" key={stat.value}>
                      <strong>{stat.value}</strong>
                      <span>{stat.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="proofConsole" aria-label="Proof timeline">
                <div className="proofConsoleHeader">
                  <div>
                    <span>Request 01KQH...</span>
                    <strong>CrewAI voice generation</strong>
                  </div>
                  <span className="proofStatus">TEE verified</span>
                </div>
                <div className="proofTimeline">
                  {proofTimeline.map((item) => (
                    <article className="proofStep" key={item.step}>
                      <span className="proofStepNum">{item.step}</span>
                      <div>
                        <div className="proofStepHeader">
                          <strong>{item.title}</strong>
                          <span>{item.meta}</span>
                        </div>
                        <p>{item.copy}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section workflowSection" id="explorers">
          <div className="container">
            <div className="workflowHeader">
              <div>
                <div className="kicker">Two sides of the marketplace</div>
                <h2 className="sectionTitle">Mint the voice. Use the voice. Prove the run.</h2>
              </div>
              <p className="sectionSub">
                The homepage now mirrors the real backend: owner minting,
                consumer generation, live agent logs, proof pages, and spend-credit
                settlement stay connected in one product story.
              </p>
            </div>

            <div className="marketplaceFlowShell">
              <article className="marketplaceColumn marketplaceColumnOwner">
                <div className="flowColumnTop">
                  <span>Style owner</span>
                  <strong>Mint and monetize the voice</strong>
                </div>
                <div className="marketplaceStepList">
                  {marketplaceOwnerSteps.map((step, index) => (
                    <div className="marketplaceStep" key={step.title}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{step.title}</strong>
                        <p>{step.copy}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="marketplaceActionRow">
                  <Button variant="primary" href="/upload" ariaLabel="Upload your style">
                    Upload your style
                  </Button>
                  <span>Mint intent ready after profiling</span>
                </div>
              </article>

              <div className="marketplaceBridge" aria-label="Shared proof and settlement layer">
                <div className="marketplaceBridgeHead">
                  <span>Shared layer</span>
                  <strong>Proof connects both sides</strong>
                </div>
                <div className="marketplaceBridgeNodes">
                  {marketplaceBridge.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
                <div className="marketplaceBridgeProof">
                  <span>Request settled</span>
                  <strong>agent logs + compute + receipt</strong>
                </div>
              </div>

              <article className="marketplaceColumn marketplaceColumnConsumer">
                <div className="flowColumnTop">
                  <span>Explorer</span>
                  <strong>Generate, inspect, settle</strong>
                </div>
                <div className="marketplaceStepList">
                  {marketplaceConsumerSteps.map((step, index) => (
                    <div className="marketplaceStep" key={step.title}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{step.title}</strong>
                        <p>{step.copy}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="marketplacePromptMini">
                  <span>Prompt → CrewAI → Proof</span>
                  <p>Introduce my new 0G project.</p>
                </div>
                <div className="marketplaceActionRow">
                  <Button href="/styles" variant="secondary">
                    Browse styles <span aria-hidden="true">↗</span>
                  </Button>
                  <span>Output: draft + proof + royalty intent</span>
                </div>
              </article>
            </div>

            <div className="surfaceDock">
              <div className="surfaceDockHeader">
                <span>Generation surfaces</span>
                <strong>Content, logs, proof, and payment stay together.</strong>
              </div>
              <div className="surfaceDockGrid">
                {generationSurfaces.map((surface) => (
                  <article className="surfaceCard" key={surface.title}>
                    <div className="surfaceHeader">
                      <span>{surface.title}</span>
                      <strong>{surface.label}</strong>
                    </div>
                    <div className="surfaceBody">
                      {surface.lines.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Navbar } from "../../../components/Navbar";
import { Footer } from "../../../components/Footer";
import { Button } from "../../../components/Button";
import { getStyle, StyleModel } from "../../../lib/styles";
import { readMintedStyles } from "../../../lib/mintedStyles";
import { ChainStyleDetails, parseJsonResponse, registryStyleToModel, shortAddress } from "../../../lib/registryStyles";
import { CONTRACTS, explorerAddressUrl } from "../../../lib/proofTrail";
import { friendlyErrorMessage } from "../../../lib/friendlyErrors";

type PageProps = {
  params: { slug: string };
};

export default function StyleDetailPage({ params }: PageProps) {
  const staticStyle = useMemo(() => getStyle(params.slug), [params.slug]);
  const [mintedStyle, setMintedStyle] = useState<StyleModel | undefined>(undefined);
  const [registryDetails, setRegistryDetails] = useState<ChainStyleDetails | undefined>(undefined);
  const [registryState, setRegistryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [registryError, setRegistryError] = useState("");
  const [mounted, setMounted] = useState(false);

  const loadRegistryStyle = useCallback(async () => {
    setRegistryState("loading");
    setRegistryError("");
    try {
      const response = await fetch(`/api/backend/styles/${encodeURIComponent(params.slug)}`, { cache: "no-store" });
      let data = await parseJsonResponse<ChainStyleDetails>(response);
      setRegistryDetails(data);
      setRegistryState("ready");
      if (data.profile && !hasDetailedStyleGuide(data.profile)) {
        const regenerateResponse = await fetch(`/api/backend/styles/${encodeURIComponent(params.slug)}/regenerate-guide`, {
          method: "POST",
          cache: "no-store"
        });
        data = await parseJsonResponse<ChainStyleDetails>(regenerateResponse);
        setRegistryDetails(data);
      }
    } catch (flowError) {
      setRegistryDetails(undefined);
      setRegistryError(friendlyErrorMessage(flowError));
      setRegistryState("error");
    }
  }, [params.slug]);

  useEffect(() => {
    setMounted(true);
    const minted = readMintedStyles().find((s) => s.id === params.slug);
    setMintedStyle(minted);
    setRegistryDetails(undefined);
    setRegistryError("");

    if (!staticStyle && !minted) {
      void loadRegistryStyle();
    } else {
      setRegistryState("idle");
    }
  }, [loadRegistryStyle, params.slug, staticStyle]);

  if (registryDetails && !staticStyle && !mintedStyle) {
    return <LiveRegistryStyleDetail style={registryDetails} />;
  }

  const style = staticStyle ?? mintedStyle ?? (registryDetails ? registryStyleToModel(registryDetails) : undefined);
  const isLoading = !style && (!mounted || registryState === "loading");

  if (!style) {
    return <StyleMissing loading={isLoading} error={registryError} />;
  }

  return <StaticStyleDetail style={style} />;
}

function LiveRegistryStyleDetail({ style }: { style: ChainStyleDetails }) {
  const profile = recordValue(style.profile);
  const agentBrain = recordValue(style.agentBrain);
  const marketplace = style.marketplace;
  const sourceContext = recordValue(profile.sourceContext);
  const sourceProfile = recordValue(profile.source_profile);
  const detailedGuide = recordValue(profile.detailed_style_guide);
  const styleGuideCompute = recordValue(profile.styleGuideCompute);
  const sourceMaterials = arrayRecords(profile.sourceMaterials).length
    ? arrayRecords(profile.sourceMaterials)
    : arrayRecords(sourceContext.sourceMaterials);
  const outputs = style.recentOutputs ?? [];
  const proofOutput = outputs.find((output) => output.requestId);
  const title = marketplace.title || stringValue(profile.styleName) || `Style token ${style.tokenId}`;
  const sourceKind = stringValue(profile.sourceKind) || stringValue(sourceContext.sourceKind) || "unknown";
  const summary =
    stringValue(profile.voice_essence) ||
    stringValue(profile.voiceEssence) ||
    marketplace.summary ||
    "A creator-owned voice profile stored by the backend.";
  const cleanExcerpts = [
    ...(marketplace.sampleExcerpts ?? []),
    ...stringArray(profile.sampleExcerpts)
  ].map(cleanExcerpt).filter(Boolean);
  const labels = marketplace.tags.length ? marketplace.tags : profileLabels(profile);

  return (
    <div>
      <Navbar />
      <main className="styleDetailPage">
        <section className="styleDetailHero">
          <div className="container">
            <div className="styleDetailTopbar">
              <div>
                <div className="kicker">Live Style</div>
                <h1>{title}</h1>
                <p>
                  Token {style.tokenId} · Creator <strong>{shortAddress(style.chain.creator)}</strong> ·{" "}
                  {formatWei(style.chain.royaltyWei)} per generation
                </p>
              </div>
              <div className="styleDetailActions">
                <Button href="/styles" variant="secondary">Back to styles</Button>
                <Button href="#proof-trail" variant="secondary">Proof Trail</Button>
                <Button href={`/styles/${style.tokenId}/try`} variant="primary">Try style</Button>
              </div>
            </div>

            <div className="styleDetailStatusRow">
              <StatusPill label="Status" value={marketplace.statusLabel} />
              <StatusPill label="Source" value={sourceKindLabel(sourceKind)} />
              <StatusPill label="Inputs" value={stringValue(profile.sourceSummary) || stringValue(sourceContext.sourceSummary) || `${style.chain.sampleCount ?? 0} sample(s)`} />
              <StatusPill label="Outputs" value={`${marketplace.outputCount} recorded`} />
              <StatusPill label="AgentBrain" value={marketplace.hasAgentBrain ? "Manifest linked" : "Missing"} />
            </div>
          </div>
        </section>

        <section className="styleDetailBody">
          <div className="container styleDetailGrid">
            <article className="styleDetailPanel styleDetailMainPanel">
              <PanelHeader eyebrow="Voice profile" title="Generated style report" subtitle={summary} />
              <div className="styleTagList">
                {labels.map((tag) => <span key={tag}>{tag}</span>)}
              </div>

              <div className="styleReportGrid">
                <ReportCard title="Core voice">
                  <Fact label="Style name" value={stringValue(profile.styleName) || title} />
                  <Fact label="Primary tone" value={stringValue(profile.primary) || nestedString(profile, ["tone", "primary"]) || "Not recorded"} />
                  <Fact label="Confidence" value={formatConfidence(profile.confidence ?? nestedValue(profile, ["tone", "confidence"]))} />
                  <Fact label="Keywords" value={stringArray(profile.keywords).join(", ") || "Not recorded"} />
                </ReportCard>

                <ReportCard title="Source mechanics">
                  <Fact label="Primary source" value={sourceKindLabel(sourceKind)} />
                  <Fact label="Analysis focus" value={stringValue(sourceProfile.analysis_focus) || stringValue(sourceContext.extractionWindow) || "Source-aware profile extraction"} />
                  <Fact label="Full input stored" value={sourceContext.fullMaterialPreservedInEncryptedStorage === true ? "Encrypted in AgentBrain" : "Not recorded"} />
                  <Fact label="Profile bytes" value={formatBytes(numberValue(profile.fullSampleBytes))} />
                </ReportCard>
              </div>

              <DetailedStyleGuide guide={detailedGuide} />
              <SourceSpecificReport sourceKind={sourceKind} sourceProfile={sourceProfile} profile={profile} />
              <RuleList title="Do rules" values={stringArray(profile.do_rules).concat(stringArray(profile.doRules))} />
              <RuleList title="Don't rules" values={stringArray(profile.dont_rules).concat(stringArray(profile.dontRules))} />

              {cleanExcerpts.length > 0 ? (
                <div className="styleDetailSection">
                  <h3>Representative excerpts</h3>
                  <div className="styleExcerptList">
                    {cleanExcerpts.map((excerpt, index) => (
                      <blockquote key={`${excerpt}-${index}`}>{excerpt}</blockquote>
                    ))}
                  </div>
                </div>
              ) : null}

              <details className="styleJsonDetails">
                <summary>Full generated profile JSON</summary>
                <pre>{JSON.stringify(profile, null, 2)}</pre>
              </details>
            </article>

            <aside className="styleDetailSide">
              <article className="styleDetailPanel">
                <PanelHeader eyebrow="Source data" title="Creator inputs" subtitle="Public source metadata. Full raw samples stay encrypted in 0G Storage." />
                <div className="sourceInventory">
                  {sourceMaterials.length ? sourceMaterials.map((source, index) => (
                    <SourceCard key={`${stringValue(source.id) || index}`} source={source} />
                  )) : <p className="styleEmptyText">No source inventory was stored for this token.</p>}
                </div>
              </article>

              <article className="styleDetailPanel proofTrailPanel" id="proof-trail">
                <PanelHeader eyebrow="Judge proof" title="Proof Trail" subtitle="The exact AgentBrain, 0G Storage, memory, generation proof, and contract evidence for this voice agent." />
                <div className="evidenceList">
                  <Evidence label="AgentBrain manifest root" value={stringValue(agentBrain.manifestRootHash)} truncate={false} />
                  <Evidence label="Profile KV key" value={style.profileKey || style.chain.profileURI} truncate={false} />
                  <Evidence label="Memory log stream" value={stringValue(agentBrain.memoryLogStream)} truncate={false} />
                  <Evidence
                    label="Latest generation proof"
                    value={proofOutput?.requestId}
                    href={proofOutput?.requestId ? `/api/backend/proof/${encodeURIComponent(proofOutput.requestId)}` : undefined}
                    truncate={false}
                  />
                  <Evidence label="AgentBrain KV" value={style.agentBrainKey} truncate={false} />
                  <Evidence label="Samples URI" value={style.chain.encryptedSamplesURI} />
                  <Evidence label="Manifest storage tx" value={stringValue(agentBrain.manifestStorageTxHash)} />
                  <Evidence label="Samples root" value={stringValue(agentBrain.samplesRootHash)} />
                  <Evidence label="Profile root" value={stringValue(agentBrain.profileRootHash)} />
                  <Evidence label="Key hash" value={stringValue(agentBrain.keyHash)} />
                  <Evidence label="Compute model" value={stringValue(agentBrain.computeModel) || stringValue(profile.computeModel)} />
                  <Evidence label="TEE verified" value={profile.teeVerified === undefined ? "Not recorded" : String(profile.teeVerified)} />
                  {CONTRACTS.map((contract) => (
                    <Evidence
                      key={contract.label}
                      label={contract.label}
                      value={contract.address}
                      href={explorerAddressUrl(contract.address)}
                      truncate={false}
                    />
                  ))}
                </div>
                {style.evidenceLinks?.length ? (
                  <div className="styleEvidenceLinks">
                    {style.evidenceLinks.map((link) => (
                      <a key={link.url} href={evidenceHref(link.url)} target="_blank" rel="noreferrer">{link.label}</a>
                    ))}
                  </div>
                ) : null}
                <div className="styleEvidenceLinks">
                  <a href={`/dashboard/styles/${style.tokenId}/agent-brain`}>Open AgentBrain inspector</a>
                  <a href={`/styles/${style.tokenId}/try#proof-trail`}>Open try-page proof</a>
                </div>
              </article>

              <article className="styleDetailPanel">
                <PanelHeader eyebrow="Compute proof" title="Inference evidence" subtitle="The style guide and generations attach compute metadata that judges can inspect." />
                <div className="evidenceList">
                  <Evidence label="Guide purpose" value={stringValue(styleGuideCompute.purpose)} />
                  <Evidence label="Guide model" value={stringValue(styleGuideCompute.model)} />
                  <Evidence label="Guide provider" value={stringValue(styleGuideCompute.provider)} />
                  <Evidence label="Guide chat id" value={stringValue(styleGuideCompute.chatId)} />
                  <Evidence label="Guide path" value={stringValue(styleGuideCompute.path) || stringValue(styleGuideCompute.computePath)} />
                  <Evidence label="Guide TEE" value={styleGuideCompute.teeVerified === undefined ? "Not recorded" : String(styleGuideCompute.teeVerified)} />
                  <Evidence label="Token usage" value={computeTokenSummary(styleGuideCompute)} />
                </div>
                {proofOutput?.requestId ? (
                  <div className="proofCtaBox">
                    <span>Generation proof page</span>
                    <a href={`/api/backend/proof/${encodeURIComponent(proofOutput.requestId)}`} target="_blank" rel="noreferrer">
                      Open proof trail
                    </a>
                    <small>{proofOutput.requestId}</small>
                  </div>
                ) : (
                  <p className="styleEmptyText">No generated output proof has been recorded yet.</p>
                )}
              </article>
            </aside>
          </div>
        </section>

        <section className="styleDetailBody styleDetailOutputs">
          <div className="container">
            <article className="styleDetailPanel">
              <PanelHeader eyebrow="Generated outputs" title="Recorded generations" subtitle="Only real outputs produced through this backend are shown here." />
              {outputs.length ? (
                <div className="outputGrid">
                  {outputs.map((output, index) => (
                    <OutputCard key={output.requestId || index} output={output} index={index} />
                  ))}
                </div>
              ) : (
                <p className="styleEmptyText">No generated outputs have been recorded for this style yet.</p>
              )}
            </article>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function DetailedStyleGuide({ guide }: { guide: Record<string, unknown> }) {
  const examples = arrayRecords(guide.actual_examples);
  const writingPatterns = recordValue(guide.writing_patterns);
  const recipe = recordValue(guide.generation_recipe);
  const promptBrief = stringValue(guide.prompt_ready_style_brief);
  const voiceSummary = stringValue(guide.voice_summary);
  const voiceRules = stringArray(guide.voice_rules);
  const avoidRules = stringArray(guide.avoid_rules);

  if (!Object.keys(guide).length) {
    return (
      <div className="styleDetailSection">
        <h3>Detailed style guide</h3>
        <p className="styleEmptyText">The backend has not attached a detailed guide for this style yet.</p>
      </div>
    );
  }

  return (
    <div className="styleDetailSection detailedGuide">
      <h3>Detailed style guide</h3>
      <div className="styleGuideBrief">
        <span>Prompt-ready brief</span>
        <p>{promptBrief || voiceSummary || "No prompt-ready brief was recorded."}</p>
      </div>

      <div className="styleGuideGrid">
        <ReportCard title="Writing patterns">
          <ObjectFacts value={writingPatterns} />
        </ReportCard>
        <ReportCard title="Generation recipe">
          <ObjectFacts value={recipe} />
        </ReportCard>
      </div>

      <div className="styleGuideRules">
        <RuleList title="Voice rules from guide" values={voiceRules} />
        <RuleList title="Avoid rules from guide" values={avoidRules} />
      </div>

      {examples.length ? (
        <div className="styleGuideExamples">
          <h4>Actual source examples</h4>
          <div className="styleExampleGrid">
            {examples.map((example, index) => (
              <article className="styleExampleCard" key={`${stringValue(example.label) || "example"}-${index}`}>
                <div className="styleExampleTop">
                  <span>{stringValue(example.label) || `Example ${index + 1}`}</span>
                  <strong>{stringValue(example.source_label) || stringValue(example.date) || "Source"}</strong>
                </div>
                <blockquote>{stringValue(example.text) || "No example text recorded."}</blockquote>
                <ul>
                  {stringArray(example.observed_patterns).slice(0, 5).map((pattern) => (
                    <li key={pattern}>{pattern}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SourceSpecificReport({
  sourceKind,
  sourceProfile,
  profile
}: {
  sourceKind: string;
  sourceProfile: Record<string, unknown>;
  profile: Record<string, unknown>;
}) {
  const twitter = recordValue(sourceProfile.twitter_profile);
  const readme = recordValue(sourceProfile.readme_profile);
  const article = recordValue(sourceProfile.article_profile);
  const file = recordValue(sourceProfile.file_profile);
  const guidelines = recordValue(sourceProfile.generation_guidelines_by_format);
  const cards: Array<{ title: string; data: Record<string, unknown> }> = [];

  if (Object.keys(twitter).length) cards.push({ title: "Twitter/X mechanics", data: twitter });
  if (Object.keys(readme).length) cards.push({ title: "README mechanics", data: readme });
  if (Object.keys(article).length) cards.push({ title: "Article mechanics", data: article });
  if (Object.keys(file).length) cards.push({ title: "File/document mechanics", data: file });
  if (Object.keys(guidelines).length) cards.push({ title: "Generation guidelines by format", data: guidelines });

  if (!cards.length) {
    return null;
  }

  return (
    <div className="styleDetailSection">
      <h3>Source-specific mechanics</h3>
      <div className="sourceMechanicsGrid">
        {cards.map((card) => (
          <ReportCard key={card.title} title={card.title}>
            <ObjectFacts value={card.data} />
          </ReportCard>
        ))}
      </div>
    </div>
  );
}

function StaticStyleDetail({ style }: { style: StyleModel }) {
  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="kicker">Style</div>
            <div className="styleHeader">
              <div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>{style.title}</h1>
                <p className="sectionSub">
                  By <strong>{style.creatorName}</strong> · @{style.creatorHandle} · <span className="muted">{style.price}</span>
                </p>
              </div>
              <Button href="/styles" variant="secondary">Back to styles</Button>
            </div>

            <div className="grid twoCol" style={{ marginTop: 18 }}>
              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">About</div>
                  <h2 className="panelTitle" style={{ marginTop: 10 }}>What this voice feels like</h2>
                  <p className="panelSub">{style.about}</p>
                </div>
                <div className="panelBody">
                  <div className="styleTraitGrid" aria-label="Style traits">
                    {style.traits.map((trait) => (
                      <div className="styleTrait" key={trait.label}>
                        <div className="styleTraitLabel">{trait.label}</div>
                        <div className="styleTraitValue">{trait.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="aboutBottomActions" style={{ marginTop: 14 }}>
                    <span className="stylePriceTag">{style.price}</span>
                    <Button href={`/styles/${style.id}/try`} variant="primary" className="tryStyleCta">Try style</Button>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panelHeader">
                  <div className="kicker">Best for</div>
                  <h2 className="panelTitle" style={{ marginTop: 10 }}>Where it shines</h2>
                </div>
                <div className="panelBody">
                  <div className="chips">{style.bestFor.map((item) => <span className="chip" key={item}>{item}</span>)}</div>
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

function StyleMissing({ loading, error }: { loading: boolean; error: string }) {
  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="kicker">{loading ? "Loading" : "Styles"}</div>
            <h1 className="sectionTitle" style={{ marginTop: 10 }}>
              {loading ? "Finding style..." : "Style not found"}
            </h1>
            {!loading ? (
              <p className="sectionSub">
                We could not find this style in the gallery or the live registry.
                {error ? ` Backend said: ${error}` : ""}
              </p>
            ) : null}
            <div className="row" style={{ marginTop: 18 }}>
              <Button href="/styles" variant="primary">Back to styles</Button>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function PanelHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="stylePanelHeader">
      <div className="kicker">{eyebrow}</div>
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="styleStatusPill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReportCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="reportCard">
      <h3>{title}</h3>
      <div className="reportFacts">{children}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="reportFact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ObjectFacts({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (!entries.length) return <p className="styleEmptyText">Not recorded in this profile.</p>;
  return entries.map(([key, item]) => <Fact key={key} label={humanize(key)} value={formatUnknown(item)} />);
}

function RuleList({ title, values }: { title: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="styleDetailSection">
      <h3>{title}</h3>
      <ul className="ruleList">
        {values.map((value) => <li key={value}>{value}</li>)}
      </ul>
    </div>
  );
}

function SourceCard({ source }: { source: Record<string, unknown> }) {
  const metadata = recordValue(source.metadata);
  return (
    <div className="sourceCard">
      <div className="sourceCardTop">
        <div>
          <strong>{stringValue(source.label) || "Untitled source"}</strong>
          <span>{sourceKindLabel(stringValue(source.kind) || "unknown")}</span>
        </div>
        <em>{formatDate(stringValue(source.importedAt))}</em>
      </div>
      <div className="sourceStats">
        <span>{numberValue(source.unitCount) ?? 1} unit(s)</span>
        <span>{formatNumber(numberValue(source.characterCount))} chars</span>
      </div>
      {Object.keys(metadata).length ? (
        <dl className="sourceMeta">
          {Object.entries(metadata).slice(0, 8).map(([key, value]) => (
            <div key={key}>
              <dt>{humanize(key)}</dt>
              <dd>{formatUnknown(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function Evidence({
  label,
  value,
  href,
  truncate = true
}: {
  label: string;
  value?: string;
  href?: string;
  truncate?: boolean;
}) {
  const display = value ? (truncate ? shortHash(value) : value) : "Not recorded";
  return (
    <div className="evidenceRow">
      <span>{label}</span>
      {href && value ? (
        <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined} title={value}>
          {display}
        </a>
      ) : (
        <strong title={value}>{display}</strong>
      )}
    </div>
  );
}

function OutputCard({
  output,
  index
}: {
  output: NonNullable<ChainStyleDetails["recentOutputs"]>[number];
  index: number;
}) {
  const primary = output.draft || firstVariant(output.variants) || "";
  return (
    <article className="outputCard">
      <div className="outputCardTop">
        <span>Output {index + 1}</span>
        <time>{formatDate(output.timestamp ? new Date(output.timestamp).toISOString() : undefined)}</time>
      </div>
      {output.prompt ? <p className="outputPrompt">{output.prompt}</p> : null}
      <pre>{primary || JSON.stringify(output.variants ?? {}, null, 2)}</pre>
      {output.variants ? (
        <div className="variantList">
          {Object.entries(output.variants).map(([platform, text]) => (
            <div key={platform}>
              <span>{platform}</span>
              <p>{text}</p>
            </div>
          ))}
        </div>
      ) : null}
      {output.requestId ? (
        <a className="outputProofLink" href={`/api/backend/proof/${encodeURIComponent(output.requestId)}`} target="_blank" rel="noreferrer">
          View proof page
        </a>
      ) : null}
    </article>
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(recordValue).filter((item) => Object.keys(item).length > 0) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedValue(value: Record<string, unknown>, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => recordValue(current)[key], value);
}

function nestedString(value: Record<string, unknown>, path: string[]): string | undefined {
  return stringValue(nestedValue(value, path));
}

function computeTokenSummary(compute: Record<string, unknown>): string | undefined {
  const input = numberValue(compute.inputTokens);
  const output = numberValue(compute.outputTokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return `${input ?? "?"} in / ${output ?? "?"} out`;
}

function profileLabels(profile: Record<string, unknown>): string[] {
  const tone = recordValue(profile.tone);
  return [
    ...stringArray(profile.labels),
    stringValue(profile.primary),
    ...stringArray(profile.secondary),
    ...stringArray(tone.labels),
    stringValue(tone.primary),
    ...stringArray(tone.secondary)
  ].filter((value): value is string => Boolean(value));
}

function hasDetailedStyleGuide(profile: Record<string, unknown>): boolean {
  const guide = recordValue(profile.detailed_style_guide);
  return Boolean(stringValue(guide.prompt_ready_style_brief)) && arrayRecords(guide.actual_examples).length > 0;
}

function cleanExcerpt(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.startsWith("<source")) return text;
  const marker = text.toLowerCase().indexOf("full source text:");
  if (marker === -1) return "";
  return text.slice(marker + "full source text:".length).replace(/<\/source>\s*$/i, "").trim();
}

function evidenceHref(url: string): string {
  return url.startsWith("/storage/") ? `/api/backend${url}` : url;
}

function firstVariant(variants: Record<string, string> | undefined): string | undefined {
  return variants ? Object.values(variants).find(Boolean) : undefined;
}

function sourceKindLabel(value: string): string {
  if (value === "twitter") return "Twitter/X";
  if (value === "github_readme") return "GitHub README";
  if (value === "blog_article") return "Blog/article";
  if (value === "file_upload") return "Uploaded file";
  if (value === "mixed") return "Mixed sources";
  return "Unknown";
}

function formatConfidence(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not recorded";
  return `${Math.round(value * 100)}%`;
}

function formatWei(value: string | undefined) {
  try {
    const wei = BigInt(value ?? "0");
    const unit = 1_000_000_000_000_000_000n;
    const whole = wei / unit;
    const fraction = wei % unit;
    if (fraction === 0n) return `${whole.toString()} OG`;
    const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return `${whole.toString()}.${fractionText || "0"} OG`;
  } catch {
    return "0 OG";
  }
}

function formatBytes(value: number | undefined): string {
  if (!value) return "Not recorded";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatNumber(value: number | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

function formatDate(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatUnknown(value: unknown): string {
  if (Array.isArray(value)) {
    const preview = value.slice(0, 8).map((item) => String(item)).join(", ");
    return value.length > 8 ? `${preview} + ${value.length - 8} more` : preview;
  }
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  if (value === undefined || value === null || value === "") return "Not recorded";
  return String(value);
}

function shortHash(value: string): string {
  return value.length > 30 ? `${value.slice(0, 14)}...${value.slice(-10)}` : value;
}

function humanize(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

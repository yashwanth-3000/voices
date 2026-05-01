"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navbar } from "../../../../components/Navbar";
import { Footer } from "../../../../components/Footer";
import { Button } from "../../../../components/Button";
import {
  asRecord,
  ChainStyleDetails,
  formatDate,
  formatJson,
  formatWei,
  getManifestRootHash,
  LoadState,
  parseJsonResponse,
  shortHash,
  stringArray,
  stringField
} from "./inspector-utils";

type PageProps = {
  params: { tokenId: string };
};

export default function VoiceInspectorPage({ params }: PageProps) {
  const tokenId = decodeURIComponent(params.tokenId);
  const [state, setState] = useState<LoadState>("idle");
  const [style, setStyle] = useState<ChainStyleDetails | null>(null);
  const [error, setError] = useState("");

  const loadStyle = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const response = await fetch(`/api/backend/styles/${encodeURIComponent(tokenId)}`, { cache: "no-store" });
      const data = await parseJsonResponse<ChainStyleDetails>(response);
      setStyle(data);
      setState("ready");
    } catch (flowError) {
      setError(flowError instanceof Error ? flowError.message : String(flowError));
      setStyle(null);
      setState("error");
    }
  }, [tokenId]);

  useEffect(() => {
    void loadStyle();
  }, [loadStyle]);

  const profile = useMemo(() => asRecord(style?.profile), [style]);
  const agentBrain = useMemo(() => asRecord(style?.agentBrain), [style]);
  const manifest = useMemo(() => asRecord(style?.agentBrain?.manifest), [style]);
  const profileLabels = useMemo(() => stringArray(profile?.labels), [profile]);
  const sampleExcerpts = style?.marketplace.sampleExcerpts?.length
    ? style.marketplace.sampleExcerpts
    : stringArray(profile?.sampleExcerpts);
  const manifestRootHash = getManifestRootHash(style);

  return (
    <div>
      <Navbar />
      <main className="siteShell dashboardShell">
        <section className="section sectionTightTop">
          <div className="container">
            <Link className="inspectorBackLink" href="/dashboard">
              Back to dashboard
            </Link>

            <div className="inspectorHero">
              <div className="inspectorHeroCopy">
                <div className="kicker">Voice inspector</div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                  {style ? style.marketplace.title : `Token ${tokenId}`}
                </h1>
                <p className="sectionSub">
                  {style
                    ? `Token ${style.tokenId} published by ${shortHash(style.chain.creator, 12, 8)}`
                    : "Loading the on-chain style profile and royalty record."}
                </p>
              </div>
              <div className="inspectorHeroActions">
                {style ? <span className="inspectorStatusPill">{style.marketplace.statusLabel}</span> : null}
                <button type="button" className="dashboardRefreshBtn" onClick={loadStyle} disabled={state === "loading"}>
                  {state === "loading" ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            {state === "loading" && !style ? <div className="dashboardLoading">Loading voice details...</div> : null}
            {state === "error" ? (
              <div className="dashboardError">
                <strong>Unable to load token {tokenId}</strong>
                <p>{error}</p>
              </div>
            ) : null}

            {style ? (
              <>
                <section className="inspectorMetricGrid" aria-label="Voice metrics">
                  <InspectorMetric label="Royalty per generation" value={formatWei(style.chain.royaltyWei)} detail="Recorded on StyleRegistry" />
                  <InspectorMetric label="Total earned" value={formatWei(style.chain.totalEarnings)} detail="Settled royalty value" />
                  <InspectorMetric label="Outputs" value={String(style.marketplace.outputCount)} detail="Recorded generations" />
                  <InspectorMetric label="Samples" value={String(style.chain.sampleCount)} detail={style.chain.language || "Language not recorded"} />
                </section>

                <section className="dashboardPanel inspectorPanel" aria-label="Voice overview">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">Published voice</div>
                      <h2>{style.marketplace.title}</h2>
                    </div>
                    <span>{style.source ? `${style.source} source` : "StyleRegistry record"}</span>
                  </div>
                  <div className="inspectorPanelBody">
                    <div className="inspectorLeadGrid">
                      <div>
                        <p className="inspectorSummary">{style.marketplace.summary}</p>
                        <TagRow tags={style.marketplace.tags.length ? style.marketplace.tags : profileLabels} />
                      </div>
                      <div className="inspectorFlagGrid">
                        <InspectorField label="Listed" value={style.chain.listed ? "Yes" : "No"} />
                        <InspectorField label="Profile" value={style.marketplace.hasProfile ? "Available" : "Missing"} />
                        <InspectorField label="AgentBrain" value={style.marketplace.hasAgentBrain ? "Available" : "Missing"} />
                        <InspectorField label="Updated" value={formatDate(style.marketplace.updatedAt)} />
                      </div>
                    </div>
                  </div>
                </section>

                <section className="inspectorTwoColumn" aria-label="Profile and chain data">
                  <div className="dashboardPanel inspectorPanel">
                    <div className="dashboardPanelHeader">
                      <div>
                        <div className="kicker">Profile</div>
                        <h2>Style signals</h2>
                      </div>
                    </div>
                    <div className="inspectorPanelBody">
                      <div className="inspectorFlagGrid">
                        <InspectorField label="Primary" value={stringField(profile, "primary", "Not recorded")} />
                        <InspectorField label="Secondary" value={stringField(profile, "secondary", "Not recorded")} />
                        <InspectorField label="Confidence" value={stringField(profile, "confidence", "Not recorded")} />
                        <InspectorField label="Profile key" value={shortHash(stringField(profile, "profileKey") || stringField(profile, "profile_key"), 14, 10)} />
                      </div>
                      {sampleExcerpts.length ? (
                        <div className="inspectorQuoteList">
                          {sampleExcerpts.map((sample, index) => (
                            <blockquote key={`${style.tokenId}-sample-${index}`}>{sample}</blockquote>
                          ))}
                        </div>
                      ) : (
                        <p className="inspectorMuted">No sample excerpts were returned for this token.</p>
                      )}
                    </div>
                  </div>

                  <div className="dashboardPanel inspectorPanel">
                    <div className="dashboardPanelHeader">
                      <div>
                        <div className="kicker">Chain data</div>
                        <h2>Registry values</h2>
                      </div>
                    </div>
                    <div className="inspectorPanelBody">
                      <div className="inspectorFieldStack">
                        <InspectorField label="Creator" value={style.chain.creator} mono />
                        <InspectorField label="Encrypted samples URI" value={style.chain.encryptedSamplesURI || "Not recorded"} mono />
                        <InspectorField label="Profile URI" value={style.chain.profileURI || "Not recorded"} mono />
                        <InspectorField label="Genres" value={style.chain.genres || "Not recorded"} />
                      </div>
                    </div>
                  </div>
                </section>

                <section className="dashboardPanel inspectorPanel" aria-label="AgentBrain summary">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">AgentBrain</div>
                      <h2>Generation memory and evidence</h2>
                    </div>
                    {manifestRootHash ? (
                      <Button href={`/dashboard/styles/${encodeURIComponent(style.tokenId)}/agent-brain`} variant="secondary">
                        Open AgentBrain
                      </Button>
                    ) : null}
                  </div>
                  <div className="inspectorPanelBody">
                    {style.marketplace.hasAgentBrain ? (
                      <div className="inspectorFlagGrid inspectorFlagGridWide">
                        <InspectorField label="Manifest root" value={shortHash(manifestRootHash, 14, 10)} mono />
                        <InspectorField label="Manifest hash" value={shortHash(stringField(agentBrain, "manifestHash") || stringField(manifest, "manifest_hash"), 14, 10)} mono />
                        <InspectorField label="Samples root" value={shortHash(stringField(agentBrain, "samplesRootHash"), 14, 10)} mono />
                        <InspectorField label="Profile root" value={shortHash(stringField(agentBrain, "profileRootHash"), 14, 10)} mono />
                        <InspectorField label="Compute model" value={stringField(agentBrain, "computeModel", "Not recorded")} />
                        <InspectorField label="Compute provider" value={shortHash(stringField(agentBrain, "computeProvider"), 14, 10)} mono />
                      </div>
                    ) : (
                      <p className="inspectorMuted">This style does not have an AgentBrain manifest yet.</p>
                    )}
                  </div>
                </section>

                <section className="inspectorTwoColumn" aria-label="Outputs and evidence">
                  <div className="dashboardPanel inspectorPanel">
                    <div className="dashboardPanelHeader">
                      <div>
                        <div className="kicker">Outputs</div>
                        <h2>Recent generations</h2>
                      </div>
                    </div>
                    <div className="inspectorPanelBody">
                      {style.recentOutputs.length ? (
                        <div className="inspectorOutputList">
                          {style.recentOutputs.slice(0, 4).map((output, index) => (
                            <article className="inspectorOutput" key={output.requestId ?? `${style.tokenId}-output-${index}`}>
                              <span>{output.requestId ? shortHash(output.requestId, 12, 8) : `Output ${index + 1}`}</span>
                              <strong>{formatDate(output.timestamp)}</strong>
                              <p>{output.draft || output.prompt || "No preview returned."}</p>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="inspectorMuted">No recent generation outputs were returned for this token.</p>
                      )}
                    </div>
                  </div>

                  <div className="dashboardPanel inspectorPanel">
                    <div className="dashboardPanelHeader">
                      <div>
                        <div className="kicker">Evidence</div>
                        <h2>Linked records</h2>
                      </div>
                    </div>
                    <div className="inspectorPanelBody">
                      {style.evidenceLinks.length ? (
                        <div className="inspectorEvidenceList">
                          {style.evidenceLinks.map((link) => {
                            const isAgentBrainLink = link.label.toLowerCase().includes("agentbrain");
                            const href = isAgentBrainLink
                              ? `/dashboard/styles/${encodeURIComponent(style.tokenId)}/agent-brain`
                              : link.url.startsWith("http") || link.url.startsWith("/api")
                                ? link.url
                                : `/api/backend${link.url}`;
                            return (
                              <a
                                key={`${link.label}-${link.url}`}
                                href={href}
                                target={isAgentBrainLink ? undefined : "_blank"}
                                rel={isAgentBrainLink ? undefined : "noreferrer"}
                              >
                                <span>{link.label}</span>
                                <small>{isAgentBrainLink ? "Open formatted AgentBrain view" : link.url}</small>
                              </a>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="inspectorMuted">No evidence links were returned for this token.</p>
                      )}
                    </div>
                  </div>
                </section>

                <section className="dashboardPanel inspectorPanel" aria-label="Formatted style JSON">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">Raw record</div>
                      <h2>Formatted backend response</h2>
                    </div>
                  </div>
                  <pre className="inspectorJson">{formatJson(style)}</pre>
                </section>
              </>
            ) : null}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function InspectorMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="dashboardStatCard inspectorMetric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function InspectorField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="inspectorField">
      <span>{label}</span>
      <strong className={mono ? "inspectorMono" : undefined}>{value || "Not recorded"}</strong>
    </div>
  );
}

function TagRow({ tags }: { tags: string[] }) {
  if (!tags.length) return <p className="inspectorMuted">No labels were returned for this voice.</p>;
  return (
    <div className="dashboardVoiceTagRow">
      {tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  );
}

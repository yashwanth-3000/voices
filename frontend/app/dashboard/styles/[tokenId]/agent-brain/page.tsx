"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navbar } from "../../../../../components/Navbar";
import { Footer } from "../../../../../components/Footer";
import { friendlyErrorMessage } from "../../../../../lib/friendlyErrors";
import {
  asRecord,
  ChainStyleDetails,
  formatDate,
  formatJson,
  getManifestRootHash,
  LoadState,
  parseJsonResponse,
  shortHash,
  stringField
} from "../inspector-utils";

type PageProps = {
  params: { tokenId: string };
};

type AgentBrainState = {
  style: ChainStyleDetails | null;
  manifest: Record<string, unknown> | null;
  storageWarning: string;
};

export default function AgentBrainInspectorPage({ params }: PageProps) {
  const tokenId = decodeURIComponent(params.tokenId);
  const [state, setState] = useState<LoadState>("idle");
  const [details, setDetails] = useState<AgentBrainState>({
    style: null,
    manifest: null,
    storageWarning: ""
  });
  const [error, setError] = useState("");

  const loadAgentBrain = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const styleResponse = await fetch(`/api/backend/styles/${encodeURIComponent(tokenId)}`, { cache: "no-store" });
      const style = await parseJsonResponse<ChainStyleDetails>(styleResponse);
      const inlineManifest = asRecord(style.agentBrain?.manifest);
      const manifestRootHash = getManifestRootHash(style);

      let manifest = inlineManifest;
      let storageWarning = "";
      if (manifestRootHash) {
        try {
          const manifestResponse = await fetch(
            `/api/backend/storage/blob?rootHash=${encodeURIComponent(manifestRootHash)}`,
            { cache: "no-store" }
          );
          manifest = await parseJsonResponse<Record<string, unknown>>(manifestResponse);
        } catch (manifestError) {
          storageWarning = friendlyErrorMessage(manifestError);
        }
      }

      setDetails({ style, manifest, storageWarning });
      setState("ready");
    } catch (flowError) {
      setDetails({ style: null, manifest: null, storageWarning: "" });
      setError(friendlyErrorMessage(flowError));
      setState("error");
    }
  }, [tokenId]);

  useEffect(() => {
    void loadAgentBrain();
  }, [loadAgentBrain]);

  const { style, manifest, storageWarning } = details;
  const agentBrain = useMemo(() => asRecord(style?.agentBrain), [style]);
  const encryption = useMemo(() => asRecord(manifest?.encryption), [manifest]);
  const samples = useMemo(() => asRecord(manifest?.samples), [manifest]);
  const profile = useMemo(() => asRecord(manifest?.profile), [manifest]);
  const memory = useMemo(() => asRecord(manifest?.memory), [manifest]);
  const compute = useMemo(() => asRecord(manifest?.compute), [manifest]);
  const manifestRootHash = getManifestRootHash(style);

  return (
    <div>
      <Navbar />
      <main className="siteShell dashboardShell">
        <section className="section sectionTightTop">
          <div className="container">
            <Link className="inspectorBackLink" href={`/dashboard/styles/${encodeURIComponent(tokenId)}`}>
              Back to voice inspector
            </Link>

            <div className="inspectorHero">
              <div className="inspectorHeroCopy">
                <div className="kicker">AgentBrain</div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                  {style ? `${style.marketplace.title} memory` : `Token ${tokenId} memory`}
                </h1>
                <p className="sectionSub">
                  {style
                    ? `The manifest, encrypted storage roots, compute evidence, and generation memory for token ${style.tokenId}.`
                    : "Loading the AgentBrain manifest and storage evidence."}
                </p>
              </div>
              <div className="inspectorHeroActions">
                {style ? <span className="inspectorStatusPill">{style.marketplace.hasAgentBrain ? "AgentBrain ready" : "No AgentBrain"}</span> : null}
                <button type="button" className="dashboardRefreshBtn" onClick={loadAgentBrain} disabled={state === "loading"}>
                  {state === "loading" ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            {state === "loading" && !style ? <div className="dashboardLoading">Loading AgentBrain manifest...</div> : null}
            {state === "error" ? (
              <div className="dashboardError">
                <strong>Unable to load AgentBrain for token {tokenId}</strong>
                <p>{error}</p>
              </div>
            ) : null}

            {style ? (
              <>
                <section className="inspectorMetricGrid" aria-label="AgentBrain metrics">
                  <AgentBrainMetric label="Manifest root" value={shortHash(manifestRootHash, 12, 8)} detail={manifest ? "Loaded manifest" : "No manifest loaded"} />
                  <AgentBrainMetric label="Samples" value={stringField(samples, "count", "0")} detail={`${stringField(samples, "size_bytes", "0")} bytes encrypted`} />
                  <AgentBrainMetric label="Memory" value={stringField(memory, "feedback_count", "0")} detail="Feedback records" />
                  <AgentBrainMetric label="TEE" value={stringField(compute, "tee_verified", "No")} detail={stringField(compute, "model") || stringField(agentBrain, "computeModel", "Compute model")} />
                </section>

                {storageWarning ? (
                  <div className="dashboardError">
                    <strong>Storage fetch warning</strong>
                    <p>The page is showing the inline manifest from the style response. Storage read failed: {storageWarning}</p>
                  </div>
                ) : null}

                {!style.marketplace.hasAgentBrain ? (
                  <div className="dashboardEmptyState">
                    <h2>No AgentBrain manifest found</h2>
                    <p>This style is published, but the backend did not return an AgentBrain manifest for it yet.</p>
                  </div>
                ) : null}

                <section className="inspectorTwoColumn" aria-label="AgentBrain evidence">
                  <div className="dashboardPanel inspectorPanel">
                    <div className="dashboardPanelHeader">
                      <div>
                        <div className="kicker">Encryption</div>
                        <h2>Access envelope</h2>
                      </div>
                    </div>
                    <div className="inspectorPanelBody">
                      <div className="inspectorFieldStack">
                        <AgentBrainField label="Algorithm" value={stringField(encryption, "algo", "Not recorded")} />
                        <AgentBrainField label="Key hash" value={shortHash(stringField(encryption, "key_hash") || stringField(agentBrain, "keyHash"), 16, 12)} mono />
                        <AgentBrainField label="Wrap mode" value={stringField(encryption, "wrap_mode") || stringField(agentBrain, "wrapMode", "Not recorded")} />
                      </div>
                    </div>
                  </div>

                  <div className="dashboardPanel inspectorPanel">
                    <div className="dashboardPanelHeader">
                      <div>
                        <div className="kicker">Compute</div>
                        <h2>Generation provider</h2>
                      </div>
                    </div>
                    <div className="inspectorPanelBody">
                      <div className="inspectorFieldStack">
                        <AgentBrainField label="Provider" value={shortHash(stringField(compute, "provider") || stringField(agentBrain, "computeProvider"), 16, 12)} mono />
                        <AgentBrainField label="Model" value={stringField(compute, "model") || stringField(agentBrain, "computeModel", "Not recorded")} />
                        <AgentBrainField label="Last chat" value={shortHash(stringField(compute, "last_chat_id"), 16, 10)} mono />
                        <AgentBrainField label="TEE verified" value={stringField(compute, "tee_verified", "No")} />
                      </div>
                    </div>
                  </div>
                </section>

                <section className="dashboardPanel inspectorPanel" aria-label="Storage roots">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">0G storage</div>
                      <h2>Encrypted roots</h2>
                    </div>
                    <span>{manifestRootHash ? `Manifest ${shortHash(manifestRootHash)}` : "No manifest root"}</span>
                  </div>
                  <div className="inspectorPanelBody">
                    <div className="inspectorFlagGrid inspectorFlagGridWide">
                      <AgentBrainField label="Manifest root" value={manifestRootHash || "Not recorded"} mono />
                      <AgentBrainField label="Manifest hash" value={stringField(manifest, "manifest_hash") || stringField(agentBrain, "manifestHash", "Not recorded")} mono />
                      <AgentBrainField label="Manifest storage tx" value={stringField(manifest, "manifest_storage_tx_hash") || stringField(agentBrain, "manifestStorageTxHash", "Not recorded")} mono />
                      <AgentBrainField label="Samples root" value={stringField(samples, "encrypted_root_hash") || stringField(agentBrain, "samplesRootHash", "Not recorded")} mono />
                      <AgentBrainField label="Samples storage tx" value={stringField(samples, "storage_tx_hash", "Not recorded")} mono />
                      <AgentBrainField label="Profile root" value={stringField(profile, "encrypted_root_hash") || stringField(agentBrain, "profileRootHash", "Not recorded")} mono />
                      <AgentBrainField label="Profile storage tx" value={stringField(profile, "storage_tx_hash", "Not recorded")} mono />
                      <AgentBrainField label="Memory stream" value={stringField(memory, "log_stream") || stringField(agentBrain, "memoryLogStream", "Not recorded")} mono />
                    </div>
                  </div>
                </section>

                <section className="dashboardPanel inspectorPanel" aria-label="Manifest identity">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">Identity</div>
                      <h2>Style lineage</h2>
                    </div>
                    <span>{formatDate(stringField(manifest, "updated_at"))}</span>
                  </div>
                  <div className="inspectorPanelBody">
                    <div className="inspectorFlagGrid inspectorFlagGridWide">
                      <AgentBrainField label="Agent type" value={stringField(manifest, "agent_type", "Not recorded")} />
                      <AgentBrainField label="Pending style" value={stringField(manifest, "pendingStyleId") || stringField(manifest, "style_id", "Not recorded")} mono />
                      <AgentBrainField label="Confirmed token" value={stringField(manifest, "confirmedStyleId") || style.tokenId} />
                      <AgentBrainField label="Creator" value={stringField(manifest, "creator") || style.chain.creator} mono />
                      <AgentBrainField label="Mint tx" value={stringField(manifest, "mintTxHash", "Not recorded")} mono />
                      <AgentBrainField label="Profile KV key" value={stringField(profile, "kv_key", "Not recorded")} mono />
                    </div>
                  </div>
                </section>

                <section className="dashboardPanel inspectorPanel" aria-label="Formatted manifest JSON">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">Manifest JSON</div>
                      <h2>Readable backend payload</h2>
                    </div>
                    <span>{manifest ? "Formatted from storage/blob" : "No manifest payload"}</span>
                  </div>
                  <pre className="inspectorJson">{formatJson(manifest ?? style.agentBrain ?? {})}</pre>
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

function AgentBrainMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="dashboardStatCard inspectorMetric">
      <span>{label}</span>
      <strong>{value || "Not recorded"}</strong>
      <small>{detail}</small>
    </div>
  );
}

function AgentBrainField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="inspectorField">
      <span>{label}</span>
      <strong className={mono ? "inspectorMono" : undefined}>{value || "Not recorded"}</strong>
    </div>
  );
}

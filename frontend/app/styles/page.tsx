"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { StyleListingCard } from "../../components/StyleListingCard";
import {
  ChainStyleDetails,
  parseJsonResponse,
  registryStyleToModel,
  shortAddress,
  StylesResponse
} from "../../lib/registryStyles";

type GalleryStyle = {
  id: string;
  href: string;
  title: string;
  creator: string;
  price: string;
  tags: string[];
  blurb: string;
  fillText: string;
  status: string;
  tokenId: string;
  outputCount: number;
  sampleCount: number;
  hasAgentBrain: boolean;
  hasProfile: boolean;
  updatedAt?: number;
  updatedLabel: string;
};

type LoadState = "idle" | "loading" | "ready" | "error";

export default function StylesPage() {
  const [state, setState] = useState<LoadState>("idle");
  const [registryStyles, setRegistryStyles] = useState<ChainStyleDetails[]>([]);
  const [registrySource, setRegistrySource] = useState("");
  const [scannedCount, setScannedCount] = useState(0);
  const [error, setError] = useState("");

  const loadRegistryStyles = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const response = await fetch("/api/backend/styles?max=50", { cache: "no-store" });
      const data = await parseJsonResponse<StylesResponse>(response);
      setRegistryStyles(data.styles);
      setRegistrySource(data.source);
      setScannedCount(data.scannedTokenIds.length);
      setState("ready");
    } catch (flowError) {
      setRegistryStyles([]);
      setRegistrySource("");
      setScannedCount(0);
      setError(flowError instanceof Error ? flowError.message : String(flowError));
      setState("error");
    }
  }, []);

  useEffect(() => {
    void loadRegistryStyles();
  }, [loadRegistryStyles]);

  const allStyles = useMemo<GalleryStyle[]>(() => {
    return [...registryStyles]
      .sort((left, right) => (right.marketplace.updatedAt ?? 0) - (left.marketplace.updatedAt ?? 0))
      .map((style) => mapRegistryStyle(style, registrySource));
  }, [registrySource, registryStyles]);

  const listedCount = useMemo(() => registryStyles.filter((style) => style.chain.listed).length, [registryStyles]);
  const profiledCount = useMemo(() => registryStyles.filter((style) => style.marketplace.hasProfile).length, [registryStyles]);
  const agentBrainCount = useMemo(() => registryStyles.filter((style) => style.marketplace.hasAgentBrain).length, [registryStyles]);
  const outputCount = useMemo(
    () => registryStyles.reduce((total, style) => total + style.marketplace.outputCount, 0),
    [registryStyles]
  );
  const lastUpdated = useMemo(() => {
    const timestamp = registryStyles.reduce<number | undefined>((latest, style) => {
      const updatedAt = style.marketplace.updatedAt;
      if (!updatedAt) return latest;
      return latest === undefined || updatedAt > latest ? updatedAt : latest;
    }, undefined);
    return formatUpdated(timestamp);
  }, [registryStyles]);

  const showInitialLoading = state === "loading" && registryStyles.length === 0;
  const refreshLabel = state === "loading" ? "Refreshing registry" : "Refresh registry";

  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="stylesMarketplacePage section sectionTightTop">
          <div className="container">
            <div className="stylesMarketplaceHero">
              <div className="stylesMarketplaceHeroCopy">
                <div className="kicker">Live style registry</div>
                <h1 className="sectionTitle">Browse voice agents with proof attached.</h1>
                <p className="sectionSub">
                  Every listing is pulled from the deployed registry and enriched with stored profile,
                  AgentBrain, output, and royalty evidence when the backend has it.
                </p>
                <div className="stylesHeroActions">
                  <button
                    type="button"
                    className="stylesRefreshButton"
                    onClick={loadRegistryStyles}
                    disabled={state === "loading"}
                    aria-busy={state === "loading"}
                  >
                    <span className="stylesRefreshIcon" aria-hidden="true" />
                    {refreshLabel}
                  </button>
                  <Link className="stylesSecondaryLink" href="/upload">
                    Upload a voice
                  </Link>
                </div>
              </div>

              <div className="stylesRegistryPanel" aria-label="Registry status">
                <div className="stylesRegistryPanelTop">
                  <span>{state === "error" ? "Connection issue" : state === "loading" ? "Syncing" : "Registry ready"}</span>
                  <strong>{registrySource || "0G registry"}</strong>
                </div>
                <div className="stylesRegistryStats">
                  <Metric label="voices" value={String(registryStyles.length)} />
                  <Metric label="listed" value={String(listedCount)} />
                  <Metric label="proofed" value={`${agentBrainCount}/${Math.max(registryStyles.length, 1)}`} />
                  <Metric label="outputs" value={String(outputCount)} />
                </div>
                <div className="stylesRegistryPanelFooter">
                  <span>{scannedCount ? `${scannedCount} tokens scanned` : "Waiting for scan"}</span>
                  <span>{lastUpdated}</span>
                </div>
              </div>
            </div>

            <div className="stylesRegistryMeta">
              <span>{profiledCount} profiles</span>
              <span>{agentBrainCount} AgentBrains</span>
              <span>{outputCount} generations</span>
              <span>{lastUpdated}</span>
            </div>

            {showInitialLoading ? (
              <div className="stylesSkeletonGrid" aria-label="Loading styles">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div className="stylesSkeletonCard" key={index}>
                    <span />
                    <strong />
                    <p />
                    <div />
                  </div>
                ))}
              </div>
            ) : null}
            {state === "error" ? (
              <div className="stylesStatusPanel stylesStatusPanelError">
                <div>
                  <strong>Live registry unavailable</strong>
                  <p>{error}</p>
                </div>
                <button type="button" className="stylesRefreshButton" onClick={loadRegistryStyles}>
                  Try again
                </button>
              </div>
            ) : null}
            {state === "ready" && registryStyles.length === 0 ? (
              <div className="stylesEmptyState">
                <div className="stylesEmptyGlyph" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div>
                  <h2>No live styles found yet</h2>
                  <p>
                    The current registry scan did not return any listed, evidence-backed voices. Mint one from
                    the upload flow or refresh after a new style is confirmed on-chain.
                  </p>
                  <div className="stylesHeroActions">
                    <Link className="stylesRefreshButton stylesRefreshButtonLink" href="/upload">
                      Upload a voice
                    </Link>
                    <button type="button" className="stylesSecondaryButton" onClick={loadRegistryStyles}>
                      Refresh scan
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="styleGallery stylesMarketplaceGrid">
              {allStyles.map((s) => (
                <StyleListingCard
                  key={s.id}
                  href={s.href}
                  title={s.title}
                  creator={s.creator}
                  price={s.price}
                  tags={s.tags}
                  blurb={s.blurb}
                  fillText={s.fillText}
                  status={s.status}
                  tokenId={s.tokenId}
                  outputCount={s.outputCount}
                  sampleCount={s.sampleCount}
                  hasAgentBrain={s.hasAgentBrain}
                  hasProfile={s.hasProfile}
                  updatedLabel={s.updatedLabel}
                />
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function mapRegistryStyle(style: ChainStyleDetails, source: string): GalleryStyle {
  const mapped = registryStyleToModel(style);
  const status = style.chain.listed ? style.marketplace.statusLabel : "Unlisted";
  const outputText = style.marketplace.outputCount === 1 ? "1 output" : `${style.marketplace.outputCount} outputs`;
  const sampleCount = style.chain.sampleCount ?? style.marketplace.sampleExcerpts?.length ?? 0;
  return {
    id: `registry-${style.tokenId}`,
    href: `/styles/${encodeURIComponent(style.tokenId)}`,
    title: mapped.title,
    creator: `${shortAddress(style.chain.creator)} · token ${style.tokenId}`,
    price: mapped.price,
    tags: mapped.tags,
    blurb: mapped.blurb,
    fillText: `${outputText}${source ? ` · ${source}` : ""}`,
    status,
    tokenId: style.tokenId,
    outputCount: style.marketplace.outputCount,
    sampleCount,
    hasAgentBrain: Boolean(style.marketplace.hasAgentBrain),
    hasProfile: Boolean(style.marketplace.hasProfile),
    updatedAt: style.marketplace.updatedAt,
    updatedLabel: formatUpdated(style.marketplace.updatedAt)
  };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatUpdated(timestamp?: number) {
  if (!timestamp) return "No recent updates";
  const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(millis);
}

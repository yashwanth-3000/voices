"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="dashboardHero">
              <div className="dashboardHeroCopy">
                <div className="kicker">Styles</div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                  Explore writing styles
                </h1>
                <p className="sectionSub">
                  {registryStyles.length > 0
                    ? `${registryStyles.length} styles from the live registry${scannedCount ? ` after scanning ${scannedCount} tokens` : ""}.`
                    : "Loading creator-uploaded voices from the backend. No local demo styles are shown here."}
                </p>
              </div>
              <div className="dashboardHeroActions">
                <button type="button" className="dashboardRefreshBtn" onClick={loadRegistryStyles} disabled={state === "loading"}>
                  {state === "loading" ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>

            {state === "loading" && registryStyles.length === 0 ? (
              <div className="dashboardLoading">Loading all registry styles...</div>
            ) : null}
            {state === "error" ? (
              <div className="dashboardError">
                <strong>Live registry unavailable</strong>
                <p>{error}</p>
              </div>
            ) : null}
            {registryStyles.length > 0 ? (
              <div className="stylesRegistryMeta">
                <span>{registrySource || "0G style registry"}</span>
                <span>{scannedCount} scanned</span>
                <span>{registryStyles.filter((style) => style.chain.listed).length} listed</span>
              </div>
            ) : null}
            {state === "ready" && registryStyles.length === 0 ? (
              <div className="dashboardEmptyState">
                <h2>No live styles found</h2>
                <p>The backend did not return any on-chain or evidence-backed styles for the scanned token range.</p>
              </div>
            ) : null}

            <div className="styleGallery" style={{ marginTop: 18 }}>
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
  return {
    id: `registry-${style.tokenId}`,
    href: `/styles/${encodeURIComponent(style.tokenId)}`,
    title: mapped.title,
    creator: `${shortAddress(style.chain.creator)} · token ${style.tokenId}`,
    price: mapped.price,
    tags: mapped.tags,
    blurb: mapped.blurb,
    fillText: `${status} · ${outputText}${source ? ` · ${source}` : ""}`
  };
}

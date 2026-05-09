"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";
import { useWallet } from "../../context/WalletContext";
import { friendlyErrorMessage } from "../../lib/friendlyErrors";

type ChainStyleDetails = {
  tokenId: string;
  source: string;
  chain: {
    creator: string;
    royaltyWei: string;
    totalEarnings: string;
    sampleCount: number;
    listed: boolean;
    language: string;
    genres: string;
  };
  marketplace: {
    title: string;
    statusLabel: string;
    summary: string;
    tags: string[];
    outputCount: number;
    hasAgentBrain: boolean;
    hasProfile: boolean;
    outputPreview?: string;
    updatedAt?: number;
  };
  recentOutputs: Array<{
    requestId?: string;
    prompt?: string;
    draft?: string;
    variants?: Record<string, string>;
    timestamp?: number;
  }>;
  agentBrain: Record<string, unknown> | null;
  evidenceLinks: Array<{ label: string; url: string }>;
};

type StylesResponse = {
  source: string;
  scannedTokenIds: string[];
  profiledCount?: number;
  generatedCount?: number;
  styles: ChainStyleDetails[];
};

type LoadState = "idle" | "loading" | "ready" | "error";

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function shortAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function parseWei(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function formatWei(wei: bigint) {
  const unit = 1_000_000_000_000_000_000n;
  const whole = wei / unit;
  const fraction = wei % unit;
  if (fraction === 0n) return `${whole.toString()} OG`;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toString()}.${fractionText || "0"} OG`;
}

function formatDate(timestamp?: number) {
  if (!timestamp) return "No updates yet";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function voiceStatus(style: ChainStyleDetails) {
  if (style.marketplace.hasProfile && style.marketplace.hasAgentBrain) return "Ready";
  if (style.marketplace.hasProfile) return "Profiled";
  return "On-chain";
}

export default function DashboardPage() {
  const { address, balance, credits, isInitializing } = useWallet();
  const [state, setState] = useState<LoadState>("idle");
  const [source, setSource] = useState("");
  const [scannedCount, setScannedCount] = useState(0);
  const [styles, setStyles] = useState<ChainStyleDetails[]>([]);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    if (!address) return;
    setState("loading");
    setError("");
    try {
      const response = await fetch("/api/backend/styles?max=50", { cache: "no-store" });
      const data = (await parseJsonResponse(response)) as StylesResponse;
      const creatorStyles = data.styles.filter((style) => sameAddress(style.chain.creator, address));
      setStyles(creatorStyles);
      setSource(data.source);
      setScannedCount(data.scannedTokenIds.length);
      setState("ready");
    } catch (flowError) {
      setError(friendlyErrorMessage(flowError));
      setStyles([]);
      setSource("");
      setScannedCount(0);
      setState("error");
    }
  }, [address]);

  useEffect(() => {
    if (!isInitializing && address) {
      void loadDashboard();
    }
  }, [address, isInitializing, loadDashboard]);

  const stats = useMemo(() => {
    const totalEarningsWei = styles.reduce((total, style) => total + parseWei(style.chain.totalEarnings), 0n);
    const totalRoyaltyWei = styles.reduce((total, style) => total + parseWei(style.chain.royaltyWei), 0n);
    const listedCount = styles.filter((style) => style.chain.listed).length;
    const profiledCount = styles.filter((style) => style.marketplace.hasProfile).length;
    const agentBrainCount = styles.filter((style) => style.marketplace.hasAgentBrain).length;
    const generatedCount = styles.reduce((total, style) => total + style.marketplace.outputCount, 0);
    const latestUpdate = styles.reduce<number | undefined>((latest, style) => {
      const updated = style.marketplace.updatedAt;
      if (!updated) return latest;
      return latest && latest > updated ? latest : updated;
    }, undefined);
    return {
      totalEarningsWei,
      averageRoyaltyWei: styles.length > 0 ? totalRoyaltyWei / BigInt(styles.length) : 0n,
      listedCount,
      profiledCount,
      agentBrainCount,
      generatedCount,
      latestUpdate
    };
  }, [styles]);

  const sortedStyles = useMemo(
    () => [...styles].sort((left, right) => (right.marketplace.updatedAt ?? 0) - (left.marketplace.updatedAt ?? 0)),
    [styles]
  );

  return (
    <div>
      <Navbar />
      <main className="siteShell dashboardShell">
        <section className="section sectionTightTop">
          <div className="container">
            <div className="dashboardHero">
              <div className="dashboardHeroCopy">
                <div className="kicker">Dashboard</div>
                <h1 className="sectionTitle" style={{ marginTop: 10 }}>
                  Creator earnings
                </h1>
                <p className="sectionSub">
                  {address
                    ? `${shortAddress(address)} on 0G Galileo`
                    : "Connect a wallet to see published voices and royalty activity."}
                </p>
              </div>
              <div className="dashboardHeroActions">
                {address ? (
                  <button type="button" className="dashboardRefreshBtn" onClick={loadDashboard} disabled={state === "loading"}>
                    {state === "loading" ? "Refreshing..." : "Refresh"}
                  </button>
                ) : (
                  <Button href="/wallet?returnTo=/dashboard" variant="primary">
                    Connect wallet
                  </Button>
                )}
              </div>
            </div>

            {!address && !isInitializing ? (
              <div className="dashboardEmptyState">
                <h2>Wallet required</h2>
                <p>Published voices and royalties are tied to the creator wallet.</p>
                <Button href="/wallet?returnTo=/dashboard" variant="primary">
                  Connect wallet
                </Button>
              </div>
            ) : null}

            {address ? (
              <>
                <section className="dashboardOverview" aria-label="Creator overview">
                  <div className="dashboardEarningsCard">
                    <span>Total earned</span>
                    <strong>{formatWei(stats.totalEarningsWei)}</strong>
                    <p>Settled from royalty activity recorded by the style registry.</p>
                    <div className="dashboardEarningsBreakdown">
                      <div>
                        <span>Average royalty</span>
                        <strong>{formatWei(stats.averageRoyaltyWei)}</strong>
                      </div>
                      <div>
                        <span>Wallet credits</span>
                        <strong>{credits === null ? "-" : String(credits)}</strong>
                      </div>
                      <div>
                        <span>0G balance</span>
                        <strong>{balance ? `${balance} OG` : "Loading"}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="dashboardStatsGrid" aria-label="Creator dashboard stats">
                    <DashboardStat label="Voices" value={String(styles.length)} detail={`${stats.listedCount} listed`} />
                    <DashboardStat label="Ready" value={String(stats.profiledCount)} detail={`${stats.agentBrainCount} with AgentBrain`} />
                    <DashboardStat label="Outputs" value={String(stats.generatedCount)} detail="Recorded generations" />
                    <DashboardStat label="Latest update" value={formatDate(stats.latestUpdate)} detail={source ? `Scanned ${scannedCount} tokens` : "Registry scan"} />
                  </div>
                </section>

                <section className="dashboardPanel" aria-label="Published voices">
                  <div className="dashboardPanelHeader">
                    <div>
                      <div className="kicker">Published voices</div>
                      <h2>Royalty inventory</h2>
                    </div>
                    <span>{source ? `${source} / scanned ${scannedCount}` : "Registry scan"}</span>
                  </div>

                  {state === "error" ? <div className="dashboardError">{error}</div> : null}
                  {state === "loading" && styles.length === 0 ? <div className="dashboardLoading">Loading published voices...</div> : null}
                  {state !== "loading" && styles.length === 0 && !error ? (
                    <div className="dashboardEmptyState dashboardEmptyStateInline">
                      <h2>No published voices found</h2>
                      <p>This wallet has no styles in the scanned token range yet.</p>
                      <Button href="/upload" variant="primary">
                        Upload a voice
                      </Button>
                    </div>
                  ) : null}

                  {styles.length > 0 ? (
                    <div className="dashboardVoiceTableWrap">
                      <table className="dashboardVoiceTable">
                        <thead>
                          <tr>
                            <th>Voice</th>
                            <th>Status</th>
                            <th>Royalty</th>
                            <th>Earned</th>
                            <th>Outputs</th>
                            <th>Updated</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedStyles.map((style) => (
                            <tr key={style.tokenId}>
                              <td className="dashboardVoiceCell">
                                <div className="dashboardVoiceToken">Token {style.tokenId}</div>
                                <strong>{style.marketplace.title}</strong>
                                <p>{style.marketplace.summary}</p>
                                <div className="dashboardVoiceTagRow">
                                  {style.marketplace.tags.slice(0, 3).map((tag) => (
                                    <span key={`${style.tokenId}-${tag}`}>{tag}</span>
                                  ))}
                                </div>
                              </td>
                              <td>
                                <span className="dashboardStatusPill" data-state={voiceStatus(style).toLowerCase()}>
                                  {voiceStatus(style)}
                                </span>
                                <small>{style.chain.listed ? "Listed" : "Unlisted"}</small>
                              </td>
                              <td>{formatWei(parseWei(style.chain.royaltyWei))}</td>
                              <td>{formatWei(parseWei(style.chain.totalEarnings))}</td>
                              <td>{style.marketplace.outputCount}</td>
                              <td>{formatDate(style.marketplace.updatedAt)}</td>
                              <td>
                                <div className="dashboardVoiceActions">
                                  <Link href={`/dashboard/styles/${encodeURIComponent(style.tokenId)}`}>
                                    Inspect
                                  </Link>
                                  {style.agentBrain?.manifestRootHash ? (
                                    <Link href={`/dashboard/styles/${encodeURIComponent(style.tokenId)}/agent-brain`}>
                                      AgentBrain
                                    </Link>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
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

function DashboardStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="dashboardStatCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  let data: { message?: string; error?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as { message?: string; error?: string };
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) {
    throw new Error(friendlyErrorMessage(data.message ?? data.error ?? `Request failed with ${response.status}`));
  }
  return data;
}

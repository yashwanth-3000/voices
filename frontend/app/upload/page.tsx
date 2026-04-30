"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";
import type { StyleModel } from "../../lib/styles";
import { upsertMintedStyle } from "../../lib/mintedStyles";
import { useWallet } from "../../context/WalletContext";

const MIN_CHARS = 200;
const ROYALTY_MIN = 0.0001;
const ROYALTY_MAX = 0.002;
const ROYALTY_STEP = 0.0001;
const MAX_BLOG_IMPORTS = 3;
const MAX_GITHUB_READMES = 3;

function shortAddress(addr: string) {
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

function makeFakeTxHash() {
  const hex = Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `0x${hex}`;
}

function makeFakeStyleId() {
  const a = Math.random().toString(16).slice(2, 8);
  const b = Date.now().toString(16).slice(-6);
  return `uploaded-${a}-${b}`;
}

function formatImportDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

function compactNumber(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "0";
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!\[[^\]]*\]\s*\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("![")) {
      const image = token.match(/^!\[([^\]]*)\]\s*\(([^)]+)\)$/);
      if (image) {
        nodes.push(
          <img key={key} src={image[2]} alt={image[1]} loading="lazy" />,
        );
      } else {
        nodes.push(token);
      }
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableDivider(line?: string) {
  if (!line) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function MarkdownView({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`code-${i}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], `h-${i}`);
      if (level === 1) blocks.push(<h3 key={`h-${i}`}>{content}</h3>);
      else if (level === 2) blocks.push(<h4 key={`h-${i}`}>{content}</h4>);
      else blocks.push(<h5 key={`h-${i}`}>{content}</h5>);
      i += 1;
      continue;
    }

    if (trimmed.includes("|") && isMarkdownTableDivider(lines[i + 1])) {
      const headers = splitMarkdownTableRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim()) {
        rows.push(splitMarkdownTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <div className="vcMarkdownTableWrap" key={`table-${i}`}>
          <table>
            <thead>
              <tr>
                {headers.map((header, idx) => (
                  <th key={`th-${i}-${idx}`}>{renderInlineMarkdown(header, `th-${i}-${idx}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={`tr-${i}-${rowIdx}`}>
                  {headers.map((_, cellIdx) => (
                    <td key={`td-${i}-${rowIdx}-${cellIdx}`}>
                      {renderInlineMarkdown(row[cellIdx] || "", `td-${i}-${rowIdx}-${cellIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^>\s+/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s+/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s+/, ""));
        i += 1;
      }
      blocks.push(<blockquote key={`q-${i}`}>{quoteLines.join(" ")}</blockquote>);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        const match = ordered ? current.match(/^\d+\.\s+(.+)$/) : current.match(/^[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      const children = items.map((item, idx) => (
        <li key={`${ordered ? "ol" : "ul"}-${i}-${idx}`}>{renderInlineMarkdown(item, `${ordered ? "ol" : "ul"}-${i}-${idx}`)}</li>
      ));
      blocks.push(ordered ? <ol key={`ol-${i}`}>{children}</ol> : <ul key={`ul-${i}`}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next || next.startsWith("```") || /^(#{1,3})\s+/.test(next) || /^>\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next)) break;
      paragraph.push(next);
      i += 1;
    }
    blocks.push(<p key={`p-${i}`}>{renderInlineMarkdown(paragraph.join(" "), `p-${i}`)}</p>);
  }

  return <div className="vcMarkdown">{blocks}</div>;
}

async function extractMockText(file: File): Promise<string> {
  const name = file.name || "file";
  const lower = name.toLowerCase();
  const isPdf = lower.endsWith(".pdf") || file.type.includes("pdf");
  const isTxt = lower.endsWith(".txt");
  const isMd = lower.endsWith(".md") || lower.endsWith(".markdown");
  if (isPdf) return `\n[Mock PDF extract: ${name}]\nThis is mocked extracted content from a PDF upload.\n\n`;
  if (isTxt || isMd) {
    const txt = await file.text();
    return `\n[${isMd ? "Mock Markdown" : "Text"}: ${name}]\n${txt}\n\n`;
  }
  return `\n[Unsupported file type (mocked): ${name}]\n`;
}

type MintPhase = "idle" | "processing" | "ready" | "confirming" | "success";
type MintStep = { key: string; label: string };
type ImportStatus = "idle" | "loading" | "ready" | "error";

type TwitterImportTweet = {
  id: string;
  text: string;
  createdAt?: string;
  metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
};

type TwitterImportProfile = {
  username: string;
  displayName: string;
  avatarUrl?: string;
  verified?: boolean;
  metrics?: {
    followers_count?: number;
    tweet_count?: number;
    following_count?: number;
  };
};

type BlogImportResult = {
  url: string;
  source: "firecrawl" | "direct";
  title: string;
  text: string;
  summary?: string;
  siteName?: string;
  chars?: number;
  importedAt?: string;
};

type GitHubRepo = {
  id?: number;
  name: string;
  fullName: string;
  description: string;
  fork: boolean;
  stars: number;
  updatedAt: string;
  defaultBranch: string;
  url: string;
};

type GitHubReadmeImport = {
  repo: GitHubRepo;
  name: string;
  path: string;
  url: string;
  text: string;
  chars: number;
  importedAt: string;
};

export default function UploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { address: walletAddress, isInitializing } = useWallet();

  const [activeTab, setActiveTab] = useState<"upload" | "twitter" | "blog" | "github">("upload");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [styleName, setStyleName] = useState("");
  const [description, setDescription] = useState("");
  const [royalty, setRoyalty] = useState<number>(0.0005);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [twitterHandle, setTwitterHandle] = useState("");
  const [twitterStatus, setTwitterStatus] = useState<ImportStatus>("idle");
  const [twitterError, setTwitterError] = useState("");
  const [twitterTweets, setTwitterTweets] = useState<TwitterImportTweet[]>([]);
  const [twitterProfile, setTwitterProfile] = useState<TwitterImportProfile | null>(null);
  const [githubUsername, setGithubUsername] = useState("");
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [githubRepoFullName, setGithubRepoFullName] = useState("");
  const [githubStatus, setGithubStatus] = useState<ImportStatus>("idle");
  const [githubError, setGithubError] = useState("");
  const [githubReadmes, setGithubReadmes] = useState<GitHubReadmeImport[]>([]);
  const [showGithubImporter, setShowGithubImporter] = useState(true);
  const [blogDrafts, setBlogDrafts] = useState([""]);
  const [blogStatus, setBlogStatus] = useState<ImportStatus>("idle");
  const [blogError, setBlogError] = useState("");
  const [blogPreview, setBlogPreview] = useState<BlogImportResult | null>(null);
  const [blogImports, setBlogImports] = useState<BlogImportResult[]>([]);
  const [blogLoadingIndex, setBlogLoadingIndex] = useState<number | null>(null);
  const [mintPhase, setMintPhase] = useState<MintPhase>("idle");
  const [mintStepIndex, setMintStepIndex] = useState(0);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [mintedStyleId, setMintedStyleId] = useState<string | null>(null);

  const mintSteps: MintStep[] = useMemo(() => [
    { key: "verify", label: "Verifying input" },
    { key: "process", label: "Processing samples" },
    { key: "profile", label: "Generating style profile" },
    { key: "prepare", label: "Preparing mint transaction" },
  ], []);

  useEffect(() => {
    if (!isInitializing && !walletAddress) router.replace("/wallet?returnTo=/upload");
  }, [isInitializing, walletAddress, router]);

  const charCount = content.length;

  const selectedGitHubRepo = useMemo(
    () => githubRepos.find((r) => r.fullName === githubRepoFullName) ?? null,
    [githubRepoFullName, githubRepos],
  );
  const sourceCount = uploadedFiles.length;

  const canMint =
    Boolean(walletAddress) && content.trim().length >= MIN_CHARS && styleName.trim().length > 0;

  const readiness = useMemo(() => [
    {
      label: "Wallet connected",
      detail: walletAddress ? shortAddress(walletAddress) : "Connect wallet",
      ready: Boolean(walletAddress),
    },
    {
      label: "Source added",
      detail: sourceCount > 0 ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}` : "Paste or import writing",
      ready: charCount > 0 || sourceCount > 0,
    },
    {
      label: "Samples ready",
      detail: charCount >= MIN_CHARS ? `${charCount} characters` : `${Math.max(0, MIN_CHARS - charCount)} chars needed`,
      ready: charCount >= MIN_CHARS,
    },
    {
      label: "Style named",
      detail: styleName.trim() || "Add a name",
      ready: styleName.trim().length > 0,
    },
  ], [charCount, sourceCount, styleName, walletAddress]);
  const readinessCompleteCount = readiness.filter((item) => item.ready).length;
  const readinessPercent = Math.round((readinessCompleteCount / readiness.length) * 100);

  function addKeyword(raw: string) {
    const trimmed = raw.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > 22 || keywords.length >= 3) return;
    if (keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) return;
    setKeywords((prev) => [...prev, trimmed]);
    setKeywordDraft("");
  }

  function removeKeyword(value: string) {
    setKeywords((prev) => prev.filter((k) => k !== value));
  }

  function updateBlogDraft(index: number, value: string) {
    setBlogDrafts((prev) => prev.map((draft, idx) => idx === index ? value : draft));
  }

  function addBlogDraft() {
    setBlogError("");
    setBlogDrafts((prev) => {
      if (prev.length >= MAX_BLOG_IMPORTS || prev.length > blogImports.length) return prev;
      return [...prev, ""];
    });
  }

  function addGithubDraft() {
    setGithubError("");
    setGithubStatus("idle");
    setGithubUsername("");
    setGithubRepos([]);
    setGithubRepoFullName("");
    setShowGithubImporter(true);
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const accepted = Array.from(files).filter((f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".txt") || n.endsWith(".md") || n.endsWith(".pdf");
    });
    if (!accepted.length) return;
    setUploadedFiles((prev) => [...prev, ...accepted.map((f) => f.name)]);
    let combined = content;
    for (const f of accepted) {
      combined = combined + (await extractMockText(f));
    }
    setContent(combined);
  }

  function triggerFilePicker() { fileInputRef.current?.click(); }
  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragging(true); }
  function handleDragLeave(e: React.DragEvent) { e.preventDefault(); setIsDragging(false); }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setIsDragging(false);
    handleFilesSelected(e.dataTransfer.files);
  }

  function appendImportedText(label: string, text: string) {
    if (!text.trim()) return;
    setContent((prev) => {
      const divider = prev.trim().length > 0 ? "\n\n" : "";
      return `${prev}${divider}[Import: ${label}]\n${text}`;
    });
    setUploadedFiles((prev) => [...prev, label]);
  }

  function normalizeExternalHandle(value: string) {
    let raw = value.trim();
    if (!raw) return "";
    if (raw.startsWith("@")) raw = raw.slice(1);
    if (raw.includes("://") || raw.startsWith("x.com/") || raw.startsWith("twitter.com/")) {
      try {
        const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
        raw = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
      } catch {
        raw = raw.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "");
      }
    }
    return raw.split("?")[0].split("/")[0].replace(/^@/, "").trim();
  }

  function normalizeGitHubUser(value: string) {
    let raw = value.trim();
    if (!raw) return "";
    if (raw.includes("://") || raw.startsWith("github.com/")) {
      try {
        const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
        raw = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
      } catch {
        raw = raw.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
      }
    }
    return raw.split("?")[0].split("/")[0].replace(/^@/, "").trim();
  }

  function normalizeArticleUrl(value: string) {
    const raw = value.trim();
    if (!raw) return "";
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  }

  async function importBlogUrl(index: number) {
    const url = normalizeArticleUrl(blogDrafts[index] ?? "");
    if (!url) { setBlogStatus("error"); setBlogError("Enter a blog or article URL."); return; }
    if (blogImports.length >= MAX_BLOG_IMPORTS) {
      setBlogStatus("error");
      setBlogError(`You can import up to ${MAX_BLOG_IMPORTS} blogs.`);
      return;
    }
    if (blogImports.some((blog) => normalizeArticleUrl(blog.url) === url)) {
      setBlogStatus("error");
      setBlogError("This blog is already imported.");
      return;
    }
    setBlogStatus("loading"); setBlogError(""); setBlogPreview(null); setBlogLoadingIndex(index);
    try {
      const res = await fetch(`/api/import/blog?url=${encodeURIComponent(url)}`);
      const data = (await res.json().catch(() => null)) as (BlogImportResult & { message?: string }) | null;
      if (!res.ok) throw new Error(data?.message || `Blog import failed (${res.status})`);
      const text = typeof data?.text === "string" ? data.text : "";
      if (!text.trim()) throw new Error("No readable article text returned.");
      const title = data?.title?.trim() || hostnameFromUrl(url);
      const importedBlog = {
        url: data?.url || url,
        title,
        text,
        source: data?.source || "direct",
        summary: data?.summary || "",
        siteName: data?.siteName || "",
        chars: data?.chars || text.length,
        importedAt: new Date().toISOString(),
      } satisfies BlogImportResult;
      setBlogPreview(importedBlog);
      setBlogImports((prev) => [...prev, importedBlog]);
      setBlogDrafts((prev) => prev.map((draft, idx) => idx === index ? importedBlog.url : draft));
      appendImportedText(`Blog ${title}`, text);
      setBlogStatus("ready");
    } catch (err) {
      setBlogStatus("error");
      setBlogError(err instanceof Error ? err.message : "Could not import this URL.");
    } finally {
      setBlogLoadingIndex(null);
    }
  }

  function buildTweetsImportText(tweets: TwitterImportTweet[], handle: string) {
    const h = handle.replace(/^@/, "").trim();
    const lines = [`Posts from @${h}`, "Imported as writing samples.", ""];
    tweets.forEach((tweet, idx) => {
      const t = tweet.text;
      if (!t.trim()) return;
      lines.push(`Post ${idx + 1}${tweet.createdAt ? ` (${tweet.createdAt})` : ""}:`);
      lines.push('"""'); lines.push(t); lines.push('"""'); lines.push("");
    });
    return lines.join("\n");
  }

  function isOriginalTweet(tweet: TwitterImportTweet) {
    return tweet.text.trim().length > 0 && !/^RT\s+@/i.test(tweet.text.trim());
  }

  async function importTwitterPosts() {
    const handle = normalizeExternalHandle(twitterHandle);
    if (!handle) { setTwitterStatus("error"); setTwitterError("Enter a handle or profile URL."); return; }
    setTwitterStatus("loading"); setTwitterError(""); setTwitterTweets([]);
    try {
      const res = await fetch(`/api/import/twitter?username=${encodeURIComponent(handle)}`);
      const data = (await res.json().catch(() => null)) as {
        username?: string;
        displayName?: string;
        avatarUrl?: string;
        verified?: boolean;
        metrics?: TwitterImportProfile["metrics"];
        tweets?: TwitterImportTweet[];
        message?: string;
      } | null;
      if (!res.ok) throw new Error(data?.message || `X import failed (${res.status})`);
      const tweets = Array.isArray(data?.tweets) ? data.tweets.filter(isOriginalTweet) : [];
      if (tweets.length === 0) throw new Error("No recent public posts returned.");
      const resolved = data?.username || handle;
      setTwitterTweets(tweets); setTwitterHandle(resolved);
      setTwitterProfile({
        username: resolved,
        displayName: data?.displayName || resolved,
        avatarUrl: data?.avatarUrl || "",
        verified: Boolean(data?.verified),
        metrics: data?.metrics || {},
      });
      appendImportedText(`X @${resolved} (${tweets.length} posts)`, buildTweetsImportText(tweets, resolved));
      if (!styleName.trim()) setStyleName(`@${resolved}`);
      setTwitterStatus("ready");
    } catch (err) {
      setTwitterStatus("error");
      setTwitterError(err instanceof Error ? err.message : "Could not import X posts.");
    }
  }

  async function loadGithubRepos() {
    const username = normalizeGitHubUser(githubUsername);
    if (!username) { setGithubStatus("error"); setGithubError("Enter a GitHub username or URL."); return; }
    setGithubStatus("loading"); setGithubError(""); setGithubRepos([]); setGithubRepoFullName("");
    try {
      const res = await fetch(`/api/import/github/repos?username=${encodeURIComponent(username)}`);
      const data = (await res.json().catch(() => null)) as { username?: string; repos?: GitHubRepo[]; message?: string } | null;
      if (!res.ok) throw new Error(data?.message || `GitHub lookup failed (${res.status})`);
      const repos = Array.isArray(data?.repos) ? data.repos : [];
      setGithubRepos(repos); setGithubUsername(data?.username || username);
      setGithubRepoFullName(repos[0]?.fullName ?? "");
      setGithubStatus("ready");
      if (repos.length === 0) setGithubError("No public repos found.");
    } catch (err) {
      setGithubStatus("error");
      setGithubError(err instanceof Error ? err.message : "Could not load GitHub repos.");
    }
  }

  async function importGithubReadme() {
    if (!selectedGitHubRepo) { setGithubStatus("error"); setGithubError("Select a repo first."); return; }
    if (githubReadmes.length >= MAX_GITHUB_READMES) {
      setGithubStatus("error");
      setGithubError(`You can import up to ${MAX_GITHUB_READMES} GitHub READMEs.`);
      return;
    }
    if (githubReadmes.some((readme) => readme.repo.fullName === selectedGitHubRepo.fullName)) {
      setGithubStatus("error");
      setGithubError("This README is already imported.");
      return;
    }
    const [owner, repo] = selectedGitHubRepo.fullName.split("/");
    setGithubStatus("loading"); setGithubError("");
    try {
      const res = await fetch(`/api/import/github/readme?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
      const data = (await res.json().catch(() => null)) as { name?: string; path?: string; url?: string; text?: string; message?: string } | null;
      if (!res.ok) throw new Error(data?.message || `README import failed (${res.status})`);
      const readme = typeof data?.text === "string" ? data.text : "";
      if (!readme.trim()) throw new Error("No readable README found.");
      appendImportedText(`GitHub README ${selectedGitHubRepo.fullName}`, readme);
      setGithubReadmes((prev) => [
        ...prev,
        {
          repo: selectedGitHubRepo,
          name: data?.name || "README",
          path: data?.path || "README",
          url: data?.url || selectedGitHubRepo.url,
          text: readme,
          chars: readme.length,
          importedAt: new Date().toISOString(),
        },
      ]);
      if (!styleName.trim()) setStyleName(selectedGitHubRepo.name);
      setShowGithubImporter(false);
      setGithubStatus("ready");
    } catch (err) {
      setGithubStatus("error");
      setGithubError(err instanceof Error ? err.message : "Could not import the README.");
    }
  }

  async function startMintPipeline() {
    if (!canMint || mintPhase !== "idle") return;
    setMintPhase("processing"); setMintStepIndex(0); setTxHash(null); setMintedStyleId(null);
    for (let i = 0; i < mintSteps.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 520 + i * 160));
      setMintStepIndex(i + 1);
    }
    setMintPhase("ready");
  }

  async function confirmMint() {
    if (mintPhase !== "ready") return;
    setMintPhase("confirming");
    await new Promise((r) => setTimeout(r, 900));
    const newTx = makeFakeTxHash();
    const newStyleId = makeFakeStyleId();
    const trimmed = content.trim();

    const newStyle: StyleModel = {
      id: newStyleId,
      title: styleName.trim() || "Untitled style",
      creatorName: "Creator",
      creatorHandle: (walletAddress ?? "creator").replace(/^0x/i, "").slice(0, 10),
      price: `$${royalty.toFixed(4)} / use`,
      tags: ["uploaded"],
      blurb: trimmed ? `Based on your samples: "${trimmed.slice(0, 90)}${trimmed.length > 90 ? "…" : ""}"` : "Based on your samples.",
      about: description.trim() || "A reusable writing voice built from your uploaded samples. This is a UI prototype.",
      bestFor: ["Posts", "Memos", "Landing page copy", "Thread replies"],
      traits: [
        { label: "Tone", value: content.includes("?") ? "Curious, conversational" : "Clear, polished" },
        { label: "Cadence", value: content.length > 2000 ? "Structured, confident pacing" : "Tight, punchy flow" },
        { label: "Signature", value: "Creator-first phrasing with consistent rhythm" },
      ],
      samples: [
        { label: "Style sample", text: trimmed.slice(0, 220) || "—" },
        { label: "Alt angle", text: trimmed.slice(220, 440) || trimmed.slice(0, 220) || "—" },
      ],
    };

    upsertMintedStyle(newStyle);
    setTxHash(newTx); setMintedStyleId(newStyleId); setMintPhase("success");
  }

  function resetAll() {
    setMintPhase("idle"); setMintStepIndex(0); setTxHash(null); setMintedStyleId(null);
    setUploadedFiles([]); setContent(""); setStyleName(""); setDescription(""); setRoyalty(0.0005);
    setKeywords([]); setKeywordDraft(""); setIsDragging(false);
    setTwitterHandle(""); setTwitterStatus("idle"); setTwitterError(""); setTwitterTweets([]); setTwitterProfile(null);
    setGithubUsername(""); setGithubRepos([]); setGithubRepoFullName("");
    setGithubStatus("idle"); setGithubError(""); setGithubReadmes([]); setShowGithubImporter(true);
    setBlogDrafts([""]); setBlogStatus("idle"); setBlogError(""); setBlogPreview(null); setBlogImports([]); setBlogLoadingIndex(null);
  }

  if (isInitializing || !walletAddress) {
    return (
      <div>
        <Navbar />
        <main className="vcMain vcMainLoading">
          <div className="container vcLoadingBox">
            <div className="vcSpinner" aria-label="Loading" />
            <p>Checking wallet…</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const tabs = [
    { id: "upload" as const,  label: "Upload Files" },
    { id: "twitter" as const, label: "Twitter" },
    { id: "blog" as const,    label: "Blog/Article" },
    { id: "github" as const,  label: "GitHub" },
  ];

  return (
    <div>
      <Navbar />
      <main className="vcMain">
        <div className="vcShell container">

          {/* ── Header ── */}
          <header className="vcHeader">
            <h1 className="vcHeaderTitle">Create Your Voice</h1>
            <p className="vcHeaderSub">Upload your writing samples and craft a unique voice for the marketplace.</p>
          </header>

          {/* ── Two-column grid ── */}
          <div className="vcGrid">

            {/* ── Left column ── */}
            <div className="vcPrimary">

              {/* Card 1 — Content Sources (tabbed) */}
              <section className="vcCard" aria-label="Content sources">
                <div className="vcCardHead">
                  <h2>Content Sources</h2>
                </div>

                {/* Tab bar */}
                <div className="vcTabBar" role="tablist" aria-label="Content source type">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      role="tab"
                      type="button"
                      aria-selected={activeTab === t.id}
                      className={`vcTab${activeTab === t.id ? " vcTabActive" : ""}`}
                      onClick={() => setActiveTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Tab panels */}
                <div className="vcTabContent">

                  {/* Upload Files */}
                  <div role="tabpanel" hidden={activeTab !== "upload"}>
                    <div
                      className={`vcDropZone${isDragging ? " vcDropZoneActive" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-label="Drop files or click to upload"
                      onClick={triggerFilePicker}
                      onKeyDown={(e) => e.key === "Enter" && triggerFilePicker()}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                    >
                      <svg className="vcDropIcon" viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <div>
                        <p className="vcDropTitle">Drop files or click to upload</p>
                        <p className="vcDropSub">TXT, MD, PDF supported</p>
                      </div>
                    </div>
                    <input ref={fileInputRef} type="file" multiple accept=".txt,.md,.pdf" style={{ display: "none" }} onChange={(e) => handleFilesSelected(e.target.files)} />
                    {uploadedFiles.length > 0 && (
                      <div className="vcChips" style={{ marginTop: 12 }} aria-label="Uploaded files">
                        {uploadedFiles.slice(-8).map((name, idx) => (
                          <span className="vcChip" key={`${name}-${idx}`}>{name}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Twitter */}
                  <div role="tabpanel" hidden={activeTab !== "twitter"}>
                    <div className="vcImportPanel">
                      <label className="vcImportLabel" htmlFor="vc-twitter-input">Twitter Profile or Thread URL</label>
                      <div className="vcImportRow">
                        <div className="vcImportInputWrap">
                          <svg className="vcImportInputIcon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.261 5.635zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                          </svg>
                          <input id="vc-twitter-input" className="vcInput vcInputIcon" value={twitterHandle} onChange={(e) => setTwitterHandle(e.target.value)} placeholder="https://twitter.com/username" aria-label="Twitter username" onKeyDown={(e) => e.key === "Enter" && importTwitterPosts()} />
                        </div>
                        <Button variant="primary" onClick={importTwitterPosts} disabled={twitterStatus === "loading"} ariaLabel="Import Twitter posts">
                          {twitterStatus === "loading" ? "Importing…" : twitterProfile ? "Replace" : "Import"}
                        </Button>
                      </div>
                      {twitterError && <div className="vcAlertError" role="alert">{twitterError}</div>}
                      {twitterTweets.length > 0 && !twitterError && (
                        <div className="vcAlertSuccess">1 Twitter account added — {twitterTweets.length} posts — {charCount.toLocaleString()} chars in sample</div>
                      )}
                      {twitterTweets.length > 0 && !twitterError && (
                        <div className="vcImportResultPanel" aria-label="Imported Twitter posts">
                          <div className="vcImportResultHead">
                            <div>
                              <strong>{twitterProfile?.displayName || "Imported account"}{twitterProfile?.verified ? " ✓" : ""}</strong>
                              <p>@{twitterProfile?.username || twitterHandle} · one account max</p>
                            </div>
                            <span>{twitterTweets.length} posts</span>
                          </div>
                          {twitterProfile && (
                            <div className="vcProfileStrip">
                              {twitterProfile.avatarUrl && <img src={twitterProfile.avatarUrl} alt="" />}
                              <div>
                                <strong>{twitterProfile.displayName}</strong>
                                <span>@{twitterProfile.username}</span>
                              </div>
                              <div className="vcProfileStats">
                                <span>{compactNumber(twitterProfile.metrics?.followers_count)} followers</span>
                                <span>{compactNumber(twitterProfile.metrics?.tweet_count)} posts</span>
                              </div>
                            </div>
                          )}
                          <div className="vcTweetList vcTweetListScrollable">
                            {twitterTweets.map((tweet, idx) => (
                              <article className="vcTweetItem" key={tweet.id || `${tweet.text}-${idx}`}>
                                <div className="vcTweetMeta">
                                  <span>Post {idx + 1}</span>
                                  {tweet.createdAt && <time dateTime={tweet.createdAt}>{formatImportDate(tweet.createdAt)}</time>}
                                </div>
                                <p>{tweet.text}</p>
                                {tweet.metrics && (
                                  <div className="vcMetricRow" aria-label="Post metrics">
                                    <span>{compactNumber(tweet.metrics.like_count)} likes</span>
                                    <span>{compactNumber(tweet.metrics.reply_count)} replies</span>
                                    <span>{compactNumber(tweet.metrics.retweet_count)} reposts</span>
                                  </div>
                                )}
                              </article>
                            ))}
                          </div>
                        </div>
                      )}
                      {!twitterTweets.length && !twitterError && charCount > 0 && (
                        <div className="vcSampleCounter">{charCount.toLocaleString()} chars in sample</div>
                      )}
                    </div>
                  </div>

                  {/* Blog/Article */}
                  <div role="tabpanel" hidden={activeTab !== "blog"}>
                    <div className="vcImportPanel">
                      <div className="vcImportHeaderLine">
                        <label className="vcImportLabel" htmlFor="vc-blog-input-0">Blog or Article URL</label>
                        <span>{blogImports.length}/{MAX_BLOG_IMPORTS} blogs</span>
                      </div>
                      {blogStatus === "loading" && (
                        <div className="vcImportLoading">
                          <div className="vcSourceProgressTrack">
                            <div className="vcSourceProgressFill vcSourceProgressFillIndeterminate" />
                          </div>
                          <span>Fetching markdown and metadata…</span>
                        </div>
                      )}
                      {blogError && <div className="vcAlertError" role="alert">{blogError}</div>}
                      {blogPreview && !blogError && (
                        <div className="vcAlertSuccess">{blogPreview.title} added — {charCount.toLocaleString()} chars in sample</div>
                      )}
                      <div className="vcImportStack" aria-label="Blog article slots">
                        {blogDrafts.map((draft, idx) => {
                          const blog = blogImports[idx];
                          if (blog) {
                            return (
                              <div className="vcBlogSlot" key={blog.url}>
                                <article className="vcImportResultPanel">
                                  <div className="vcImportResultHead">
                                    <div>
                                      <strong>{idx + 1}. {blog.title}</strong>
                                      <p>{blog.siteName || hostnameFromUrl(blog.url)} · {formatImportDate(blog.importedAt)}</p>
                                    </div>
                                    <span>{blog.source === "firecrawl" ? "Firecrawl" : "Direct"}</span>
                                  </div>
                                  <div className="vcMetricRow">
                                    <span>{(blog.chars || blog.text.length).toLocaleString()} chars</span>
                                    {blog.summary && <span>summary included</span>}
                                    <span className="vcImportUrl">{blog.url}</span>
                                  </div>
                                  {blog.summary && (
                                    <div className="vcImportSummary">
                                      <strong>Summary</strong>
                                      <p>{renderInlineMarkdown(blog.summary, `blog-summary-${idx}`)}</p>
                                    </div>
                                  )}
                                  <details className="vcMarkdownDetails">
                                    <summary>
                                      <span>Show markdown</span>
                                      <small>{(blog.chars || blog.text.length).toLocaleString()} chars</small>
                                    </summary>
                                    <MarkdownView text={blog.text} />
                                  </details>
                                </article>
                                {idx === blogImports.length - 1 && blogDrafts.length === blogImports.length && blogImports.length < MAX_BLOG_IMPORTS && (
                                  <button type="button" className="vcAddSourceBtn" onClick={addBlogDraft}>
                                    <span className="vcAddSourceIcon" aria-hidden="true">
                                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 5v14" />
                                        <path d="M5 12h14" />
                                      </svg>
                                    </span>
                                    <span className="vcAddSourceText">
                                      <strong>Add another blog URL</strong>
                                      <small>Open Blog {blogImports.length + 1} of {MAX_BLOG_IMPORTS}</small>
                                    </span>
                                  </button>
                                )}
                              </div>
                            );
                          }

                          const normalizedDraft = normalizeArticleUrl(draft);
                          const alreadyImported = Boolean(normalizedDraft) && blogImports.some((item) => normalizeArticleUrl(item.url) === normalizedDraft);
                          const isLoading = blogLoadingIndex === idx && blogStatus === "loading";
                          return (
                            <div className="vcBlogDraft" key={`blog-draft-${idx}`}>
                              <div className="vcBlogDraftLabel">
                                <span>Blog {idx + 1}</span>
                                {alreadyImported && <strong>Added</strong>}
                              </div>
                              <div className="vcImportRow">
                                <div className="vcImportInputWrap">
                                  <svg className="vcImportInputIcon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                  </svg>
                                  <input
                                    id={`vc-blog-input-${idx}`}
                                    className="vcInput vcInputIcon"
                                    value={draft}
                                    onChange={(e) => updateBlogDraft(idx, e.target.value)}
                                    placeholder="https://example.com/article"
                                    aria-label={`Blog ${idx + 1} URL`}
                                    onKeyDown={(e) => e.key === "Enter" && importBlogUrl(idx)}
                                  />
                                </div>
                                <Button
                                  variant="primary"
                                  onClick={() => importBlogUrl(idx)}
                                  disabled={isLoading || blogImports.length >= MAX_BLOG_IMPORTS || alreadyImported}
                                  ariaLabel={`Import blog ${idx + 1}`}
                                >
                                  {isLoading ? "Importing…" : alreadyImported ? "Added" : blogImports.length >= MAX_BLOG_IMPORTS ? "Max added" : "Import"}
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {!blogImports.length && !blogError && charCount > 0 && (
                        <div className="vcSampleCounter">{charCount.toLocaleString()} chars in sample</div>
                      )}
                    </div>
                  </div>

                  {/* GitHub */}
                  <div role="tabpanel" hidden={activeTab !== "github"}>
                    <div className="vcImportPanel">
                      <div className="vcImportHeaderLine">
                        <label className="vcImportLabel" htmlFor="vc-github-input">GitHub Repository or README URL</label>
                        <span>{githubReadmes.length}/{MAX_GITHUB_READMES} READMEs</span>
                      </div>
                      {githubError && <div className="vcAlertError" role="alert">{githubError}</div>}
                      {githubReadmes.length > 0 && !githubError && (
                        <div className="vcAlertSuccess">{githubReadmes.length} README{githubReadmes.length === 1 ? "" : "s"} imported — {charCount.toLocaleString()} chars in sample</div>
                      )}
                      {githubReadmes.length > 0 && !githubError && (
                        <div className="vcImportStack" aria-label="Imported GitHub READMEs">
                          {githubReadmes.map((readme, idx) => (
                            <div className="vcBlogSlot" key={readme.repo.fullName}>
                              <article className="vcImportResultPanel">
                                <div className="vcImportResultHead">
                                  <div>
                                    <strong>{idx + 1}. {readme.repo.fullName}</strong>
                                    <p>{readme.repo.description || "README content added to the sample editor."}</p>
                                  </div>
                                  <span>{readme.name}</span>
                                </div>
                                <div className="vcMetricRow">
                                  <span>{readme.chars.toLocaleString()} chars</span>
                                  <span>{compactNumber(readme.repo.stars)} stars</span>
                                  <span>Repo updated {formatImportDate(readme.repo.updatedAt)}</span>
                                  <span>Imported {formatImportDate(readme.importedAt)}</span>
                                  <span className="vcImportUrl">{readme.url}</span>
                                </div>
                                <div className="vcImportSummary">
                                  <strong>README path</strong>
                                  <p>{readme.path}</p>
                                </div>
                                <details className="vcMarkdownDetails">
                                  <summary>
                                    <span>Show markdown</span>
                                    <small>{readme.chars.toLocaleString()} chars</small>
                                  </summary>
                                  <MarkdownView text={readme.text} />
                                </details>
                              </article>
                              {idx === githubReadmes.length - 1 && !showGithubImporter && githubReadmes.length < MAX_GITHUB_READMES && (
                                <button type="button" className="vcAddSourceBtn" onClick={addGithubDraft}>
                                  <span className="vcAddSourceIcon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 5v14" />
                                      <path d="M5 12h14" />
                                    </svg>
                                  </span>
                                  <span className="vcAddSourceText">
                                    <strong>Add another GitHub README</strong>
                                    <small>Open README {githubReadmes.length + 1} of {MAX_GITHUB_READMES}</small>
                                  </span>
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {showGithubImporter && (
                        <div className="vcGithubDraft">
                          <div className="vcBlogDraftLabel">
                            <span>README {githubReadmes.length + 1}</span>
                          </div>
                          <div className="vcImportRow">
                            <div className="vcImportInputWrap">
                              <svg className="vcImportInputIcon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.21.09 1.85 1.25 1.85 1.25 1.07 1.83 2.82 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02.01 2.05.14 3.01.4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.23v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
                              </svg>
                              <input id="vc-github-input" className="vcInput vcInputIcon" value={githubUsername} onChange={(e) => setGithubUsername(e.target.value)} placeholder="https://github.com/username/repo" aria-label="GitHub username" onKeyDown={(e) => e.key === "Enter" && loadGithubRepos()} />
                            </div>
                            <Button variant="secondary" onClick={loadGithubRepos} disabled={githubStatus === "loading"} ariaLabel="Find repos">
                              {githubStatus === "loading" && githubRepos.length === 0 ? "Finding…" : "Find repos"}
                            </Button>
                          </div>
                          {githubRepos.length > 0 && (
                            <div className="vcImportRow" style={{ marginTop: 10 }}>
                              <select className="vcSelect" value={githubRepoFullName} onChange={(e) => setGithubRepoFullName(e.target.value)} aria-label="Select repository">
                                {githubRepos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
                              </select>
                              <Button variant="primary" onClick={importGithubReadme} disabled={githubStatus === "loading" || !selectedGitHubRepo || githubReadmes.length >= MAX_GITHUB_READMES} ariaLabel="Import README">
                                {githubStatus === "loading" && githubRepos.length > 0 ? "Importing…" : githubReadmes.length >= MAX_GITHUB_READMES ? "Max added" : "Import"}
                              </Button>
                            </div>
                          )}
                          {githubRepos.length > 0 && githubReadmes.length < MAX_GITHUB_READMES && !githubError && (
                            <div className="vcImportResultPanel" aria-label="GitHub repositories">
                              <div className="vcImportResultHead">
                                <div>
                                  <strong>Repos found</strong>
                                  <p>Select one above, then import its README.</p>
                                </div>
                                <span>{githubRepos.length} repos</span>
                              </div>
                              <div className="vcRepoList vcRepoListScrollable">
                                {githubRepos.map((repo) => (
                                  <button
                                    type="button"
                                    key={repo.fullName}
                                    className={`vcRepoItem${repo.fullName === githubRepoFullName ? " vcRepoItemActive" : ""}`}
                                    onClick={() => setGithubRepoFullName(repo.fullName)}
                                  >
                                    <div className="vcRepoItemTop">
                                      <strong>{repo.fullName}</strong>
                                      <span>{compactNumber(repo.stars)} stars</span>
                                    </div>
                                    <p>{repo.description || "No description provided."}</p>
                                    <em>Updated {formatImportDate(repo.updatedAt)}</em>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {!githubReadmes.length && !githubError && charCount > 0 && (
                        <div className="vcSampleCounter">{charCount.toLocaleString()} chars in sample</div>
                      )}
                    </div>
                  </div>

                </div>
              </section>

              {/* Card 2 — Voice Configuration */}
              <section className="vcCard" aria-label="Voice configuration">
                <div className="vcCardHead">
                  <h2>Voice Configuration</h2>
                </div>
                <div className="vcCardBody vcConfigStack">
                  <div className="vcField">
                    <label htmlFor="vc-style-name" className="vcLabel">Style Name <span className="vcLabelReq">*</span></label>
                    <input id="vc-style-name" className="vcInput vcInputLg" value={styleName} onChange={(e) => setStyleName(e.target.value.slice(0, 60))} placeholder="e.g., Poetic Storyteller, Technical Writer, Casual Blogger" />
                  </div>
                  <div className="vcField">
                    <label htmlFor="vc-desc" className="vcLabel">Description <span className="vcLabelOpt">(Optional)</span></label>
                    <textarea id="vc-desc" className="vcMiniTextarea" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 280))} placeholder="Describe the unique characteristics of this voice…" rows={3} />
                  </div>
                  <div className="vcField">
                    <label htmlFor="vc-royalty" className="vcLabel">
                      Royalty Percentage: <strong className="vcRoyaltyVal">{(royalty * 10000).toFixed(1)}%</strong>
                    </label>
                    <input id="vc-royalty" type="range" className="vcRange" min={ROYALTY_MIN} max={ROYALTY_MAX} step={ROYALTY_STEP} value={royalty} onChange={(e) => setRoyalty(Number(e.target.value))} aria-label="Royalty slider" />
                    <p className="vcFieldHint">Set the royalty you&apos;ll earn when others use your voice</p>
                  </div>
                  <div className="vcField">
                    <label className="vcLabel">Keywords</label>
                    <div className="vcInputRow">
                      <input className="vcInput" value={keywordDraft} onChange={(e) => setKeywordDraft(e.target.value)} placeholder="Add a keyword…" disabled={keywords.length >= 3} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(keywordDraft); } }} />
                      <button type="button" className="vcAddBtn" onClick={() => addKeyword(keywordDraft)} disabled={keywords.length >= 3}>Add</button>
                    </div>
                    {keywords.length > 0 && (
                      <div className="vcChips" style={{ marginTop: 10 }}>
                        {keywords.map((k) => (
                          <button key={k} type="button" className="vcChip vcKwChip" onClick={() => removeKeyword(k)} aria-label={`Remove ${k}`}>{k} ×</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>

            </div>

            {/* ── Sidebar ── */}
            <aside className="vcSidebar">

              {/* Readiness checklist */}
              <section className="vcCard vcStickyCard" aria-label="Readiness checklist">
                <div className="vcSidebarHead"><h3>Readiness Checklist</h3></div>

                <div className="vcProgressSummary">
                  <div className="vcProgressSummaryRow">
                    <span>Progress</span>
                    <strong>{readinessCompleteCount}/{readiness.length}</strong>
                  </div>
                  <div className="vcProgressTrack">
                    <div className="vcProgressFill" style={{ width: `${readinessPercent}%` }} />
                  </div>
                </div>

                <div className="vcChecklist">
                  {readiness.map((item) => (
                    <div key={item.label} className="vcCheckItem">
                      <span className={`vcCheckDot${item.ready ? " vcCheckDotOn" : ""}`} aria-hidden="true">
                        {item.ready && (
                          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <div>
                        <div className="vcCheckLabel">{item.label}</div>
                        <div className="vcCheckDetail">{item.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {!canMint && (
                  <div className="vcNotice" role="status">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    Complete all checklist items to mint your voice
                  </div>
                )}

                <div className="vcMintArea">
                  <button
                    type="button"
                    className={`vcMintBtn${canMint && mintPhase === "idle" ? "" : " vcMintBtnDisabled"}`}
                    onClick={startMintPipeline}
                    disabled={!canMint || mintPhase !== "idle"}
                    aria-label="Mint Voice NFT"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 2L2 7l10 5 10-5-10-5Z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                    </svg>
                    {mintPhase === "idle" ? "Mint Voice NFT" : mintPhase === "processing" ? "Processing…" : mintPhase === "success" ? "Style minted" : "Minting…"}
                  </button>

                  {mintPhase !== "idle" && (
                    <div className="vcMintFlow">
                      {mintSteps.map((s, idx) => {
                        const done = idx < mintStepIndex;
                        const active = idx === mintStepIndex && mintPhase === "processing";
                        return (
                          <div key={s.key} className={`vcMintStep${done ? " vcMintStepDone" : ""}${active ? " vcMintStepActive" : ""}`}>
                            <span className="vcMintBullet" aria-hidden="true">{done ? "✓" : active ? "◎" : "○"}</span>
                            <span>{s.label}</span>
                          </div>
                        );
                      })}
                      {mintPhase === "ready" && (
                        <button type="button" className="vcMintBtn" onClick={confirmMint}>Confirm &amp; sign</button>
                      )}
                      {mintPhase === "confirming" && <p className="vcMintStatus">Submitting transaction…</p>}
                      {mintPhase === "success" && txHash && mintedStyleId && (
                        <div className="vcMintSuccess" aria-live="polite">
                          <div className="vcMintSuccessTitle">Style minted</div>
                          <div className="vcMintHash">{txHash.slice(0, 20)}…</div>
                          <div className="vcMintSuccessActions">
                            <Button variant="secondary" href="/styles" ariaLabel="Browse styles">Browse styles</Button>
                            <Button variant="primary" onClick={resetAll} ariaLabel="Create another">Create another</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <p className="vcMintNote">Minting creates a reusable style profile for this voice.</p>
                </div>
              </section>

              {/* Tips */}
              <section className="vcCard vcTipsCard" aria-label="Pro tips">
                <h3 className="vcTipsTitle">💡 Pro Tips</h3>
                <ul className="vcTipsList">
                  <li>Upload diverse writing samples for better voice quality</li>
                  <li>Use descriptive keywords to help others discover your voice</li>
                  <li>Import public writing when you want a faster first draft</li>
                  <li>Set competitive royalties (3–10% recommended)</li>
                </ul>
              </section>

            </aside>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

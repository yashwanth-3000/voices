import { friendlyErrorMessage } from "../../../../lib/friendlyErrors";

export type AgentBrainDetails = {
  manifestRootHash?: string;
  manifestHash?: string;
  manifestStorageTxHash?: string;
  keyHash?: string;
  wrapMode?: string;
  samplesRootHash?: string;
  profileRootHash?: string;
  memoryLogStream?: string;
  computeModel?: string;
  computeProvider?: string;
  manifest?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ChainStyleDetails = {
  tokenId: string;
  source?: string;
  chain: {
    creator: string;
    royaltyWei: string;
    totalEarnings: string;
    sampleCount: number;
    listed: boolean;
    encryptedSamplesURI?: string;
    profileURI?: string;
    language?: string;
    genres?: string;
    [key: string]: unknown;
  };
  marketplace: {
    title: string;
    status?: string;
    statusLabel: string;
    listed?: boolean;
    summary: string;
    tags: string[];
    sampleExcerpts?: string[];
    outputCount: number;
    hasAgentBrain: boolean;
    hasProfile: boolean;
    outputPreview?: string;
    updatedAt?: number;
  };
  profile?: Record<string, unknown>;
  recentOutputs: Array<{
    requestId?: string;
    prompt?: string;
    draft?: string;
    variants?: Record<string, string>;
    timestamp?: number;
  }>;
  agentBrain: AgentBrainDetails | null;
  evidenceLinks: Array<{ label: string; url: string }>;
};

export type LoadState = "idle" | "loading" | "ready" | "error";

export function parseWei(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

export function formatWei(value: bigint | string | undefined) {
  const wei = typeof value === "bigint" ? value : parseWei(value);
  const unit = 1_000_000_000_000_000_000n;
  const whole = wei / unit;
  const fraction = wei % unit;
  if (fraction === 0n) return `${whole.toString()} OG`;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toString()}.${fractionText || "0"} OG`;
}

export function formatDate(timestamp?: number | string) {
  if (timestamp === undefined || timestamp === null || timestamp === "") return "No updates yet";
  const raw = Number(timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return "No updates yet";
  const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(millis);
}

export function shortHash(value: string | undefined | null, front = 10, back = 8) {
  if (!value) return "Not recorded";
  if (value.length <= front + back + 3) return value;
  return `${value.slice(0, front)}...${value.slice(-back)}`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function stringField(record: Record<string, unknown> | null | undefined, key: string, fallback = "") {
  const value = record?.[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function getManifestRootHash(style: ChainStyleDetails | null) {
  const agentBrain = style?.agentBrain;
  if (!agentBrain) return "";
  const manifest = asRecord(agentBrain.manifest);
  return (
    agentBrain.manifestRootHash ||
    stringField(manifest, "manifest_root_hash") ||
    ""
  );
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) {
    const record = asRecord(data);
    throw new Error(
      friendlyErrorMessage(
        stringField(record, "message") ||
          stringField(record, "error") ||
          `Request failed with ${response.status}`
      )
    );
  }
  return data as T;
}

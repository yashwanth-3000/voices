import type { StyleModel } from "./styles";

export type ChainStyleDetails = {
  tokenId: string;
  source?: string;
  chain: {
    creator: string;
    royaltyWei: string;
    totalEarnings?: string;
    sampleCount?: number;
    listed: boolean;
    language?: string;
    genres?: string;
  };
  marketplace: {
    title: string;
    statusLabel: string;
    summary: string;
    tags: string[];
    outputCount: number;
    updatedAt?: number;
    sampleExcerpts?: string[];
    outputPreview?: string;
    hasAgentBrain?: boolean;
    hasProfile?: boolean;
  };
};

export type StylesResponse = {
  source: string;
  scannedTokenIds: string[];
  styles: ChainStyleDetails[];
};

export function registryStyleToModel(style: ChainStyleDetails): StyleModel {
  const tags = style.marketplace.tags.length ? style.marketplace.tags : ["registry", "voice"];
  const sampleExcerpts = style.marketplace.sampleExcerpts?.filter(Boolean) ?? [];
  const preview = style.marketplace.outputPreview || sampleExcerpts[0] || style.marketplace.summary;
  const sampleBlocks = sampleExcerpts.length
    ? sampleExcerpts.slice(0, 3).map((text, index) => ({ label: `Profile excerpt ${index + 1}`, text }))
    : [{ label: "Profile summary", text: preview || "This registry style is ready for generation." }];

  return {
    id: style.tokenId,
    title: style.marketplace.title || `Style ${style.tokenId}`,
    creatorName: shortAddress(style.chain.creator),
    creatorHandle: `token-${style.tokenId}`,
    price: `${formatWei(style.chain.royaltyWei)} / gen`,
    tags,
    blurb: preview,
    about: style.marketplace.summary || "A creator-published writing style from the live 0G registry.",
    bestFor: buildBestFor(tags),
    traits: [
      { label: "Status", value: style.marketplace.statusLabel || (style.chain.listed ? "Listed" : "Unlisted") },
      { label: "Royalty", value: `${formatWei(style.chain.royaltyWei)} per generation` },
      { label: "Outputs", value: `${style.marketplace.outputCount} recorded generations` },
      { label: "Creator", value: shortAddress(style.chain.creator) }
    ],
    samples: sampleBlocks
  };
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: any = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) {
    throw new Error(data.message ?? data.error ?? `Request failed with ${response.status}`);
  }
  return data as T;
}

export function shortAddress(address: string) {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function buildBestFor(tags: string[]) {
  const normalized = tags.map((tag) => tag.toLowerCase());
  const choices = new Set<string>();
  if (normalized.some((tag) => tag.includes("technical") || tag.includes("analytical"))) {
    choices.add("Technical posts");
    choices.add("Product explainers");
  }
  if (normalized.some((tag) => tag.includes("direct") || tag.includes("concise"))) {
    choices.add("Landing page copy");
    choices.add("Launch notes");
  }
  if (normalized.some((tag) => tag.includes("reflective") || tag.includes("literary") || tag.includes("lyrical"))) {
    choices.add("Essays");
    choices.add("Brand storytelling");
  }
  choices.add("Creator posts");
  choices.add("Voice generation");
  return Array.from(choices).slice(0, 4);
}

function parseWei(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function formatWei(value: string | undefined) {
  const wei = parseWei(value);
  const unit = 1_000_000_000_000_000_000n;
  const whole = wei / unit;
  const fraction = wei % unit;
  if (fraction === 0n) return `${whole.toString()} OG`;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toString()}.${fractionText || "0"} OG`;
}

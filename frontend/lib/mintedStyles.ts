import type { StyleModel } from "./styles";

const MINTED_STYLES_KEY = "voices.mintedStyles.v1";

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isStyleModel(maybe: any): maybe is StyleModel {
  return (
    maybe &&
    typeof maybe === "object" &&
    typeof maybe.id === "string" &&
    typeof maybe.title === "string" &&
    typeof maybe.creatorName === "string" &&
    typeof maybe.creatorHandle === "string" &&
    typeof maybe.price === "string" &&
    Array.isArray(maybe.tags) &&
    typeof maybe.blurb === "string" &&
    typeof maybe.about === "string" &&
    Array.isArray(maybe.bestFor) &&
    Array.isArray(maybe.traits) &&
    Array.isArray(maybe.samples)
  );
}

export function readMintedStyles(): StyleModel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MINTED_STYLES_KEY);
    if (!raw) return [];
    const parsed = safeParseJSON(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as any[]).filter(isStyleModel) as StyleModel[];
  } catch {
    return [];
  }
}

export function upsertMintedStyle(style: StyleModel) {
  if (typeof window === "undefined") return;
  const all = readMintedStyles();
  const idx = all.findIndex((s) => s.id === style.id);
  if (idx >= 0) all[idx] = style;
  else all.unshift(style);
  localStorage.setItem(MINTED_STYLES_KEY, JSON.stringify(all));
}

export function clearMintedStyles() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(MINTED_STYLES_KEY);
}


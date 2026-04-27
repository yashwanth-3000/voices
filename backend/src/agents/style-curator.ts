import { ethers } from "ethers";
import { AgentEvent } from "../events/types.js";
import { MintStyleInput } from "../infra/types.js";
import { BaseAgent } from "./base-agent.js";
import { styleExtractionPrompt, styleRefinementPrompt } from "./prompts.js";

const MIN_SAMPLE_BYTES = 1024;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const DEFAULT_STYLE_SAMPLE_CHAR_BUDGET = 12_000;
const DENYLIST = ["paul graham", "j.k. rowling", "jk rowling", "stephen king"];

export class StyleCuratorAgent extends BaseAgent {
  readonly name = "Style Curator";
  readonly subscribedEvents = ["style.uploaded", "feedback.received"] as const;

  protected async handleEvent(event: AgentEvent): Promise<void> {
    if (event.type === "style.uploaded") {
      await this.bootstrapStyle(event);
      return;
    }
    await this.refineStyle(event);
  }

  private async bootstrapStyle(event: AgentEvent): Promise<void> {
    const samples = stringArray(event.payload.samples);
    const actor = event.actor;
    const requestId = stringValue(event.payload.requestId, event.id);
    const attestationMessage = stringValue(event.payload.attestationMessage, "");
    const attestationSignature = stringValue(event.payload.attestationSignature, "");

    this.validateAttestation(actor, attestationMessage, attestationSignature);
    this.validateSamples(samples);

    const encryptionKey = attestationSignature || process.env.OG_STORAGE_ENCRYPTION_KEY;
    const rawSamples = Buffer.from(samples.join("\n\n--- sample break ---\n\n"), "utf8");
    const upload = await this.context.storage.uploadEncrypted(rawSamples, encryptionKey);

    const promptSamples = budgetSamplesForExtraction(samples);
    const compute = await this.extractProfile(promptSamples, {
      wallet: actor,
      language: stringValue(event.payload.language, "en"),
      genres: stringArray(event.payload.genres),
      sourceSampleCount: samples.length,
      promptSampleCount: promptSamples.length,
      sampleBudget: "low-cost-demo"
    });
    const profile = parseTaggedJson(compute.content, "style_profile");

    const styleId = `pending:${event.id}`;
    const profileKey = `style:${styleId}:profile`;
    await this.context.storage.kvSet(profileKey, {
      ...profile,
      sampleExcerpts: normalizeSampleExcerpts(profile, samples),
      samplesRootHash: upload.rootHash,
      teeVerified: compute.verified,
      updatedAt: Date.now()
    });

    const mintInput: MintStyleInput = {
      tokenMetadataURI: stringValue(event.payload.tokenMetadataURI, ""),
      encryptedSamplesURI: `0g://storage/${upload.rootHash}`,
      profileURI: `0g://kv/${profileKey}`,
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(profile))),
      sealedKey: ethers.hexlify(ethers.toUtf8Bytes("server-side-demo-sealed-key")),
      royaltyWei: stringValue(event.payload.royaltyWei, "1000000000000000"),
      sampleCount: samples.length,
      language: stringValue(event.payload.language, "en"),
      genres: stringArray(event.payload.genres).join(","),
      attestationURI: `eip191://${ethers.keccak256(ethers.toUtf8Bytes(attestationMessage))}`
    };
    const transactionIntent = this.context.chain.mintStyleIntent(mintInput);

    await this.context.bus.publish({
      id: `${event.id}:style.mint.intent.created`,
      type: "style.mint.intent.created",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      payload: {
        requestId,
        status: "awaiting_wallet_signature",
        profileKey,
        samplesRootHash: upload.rootHash,
        storageTxHash: upload.txHash,
        teeVerified: compute.verified,
        transactionIntent
      }
    });
  }

  private async refineStyle(event: AgentEvent): Promise<void> {
    const styleId = event.styleId ?? stringValue(event.payload.styleId, "");
    const requestId = stringValue(event.payload.requestId, event.id);
    const feedback = feedbackText(event.payload);
    if (!styleId || !this.isMeaningfulFeedback(feedback, event.payload)) {
      return;
    }

    const profileKey = await this.resolveProfileKey(styleId);
    const existing = await this.context.storage.kvGet<Record<string, unknown>>(profileKey);
    if (!existing) {
      return;
    }

    const consumerAddress = event.consumerAddress ?? stringValue(event.payload.consumerAddress, "");
    const recentHistory = consumerAddress
      ? await this.context.storage.logScan(`consumer:${consumerAddress}:history`, "", undefined)
      : [];
    const compute = await this.context.compute.chat(
      styleRefinementPrompt({ existingProfile: existing, feedback, recentHistory: recentHistory.slice(-8) }),
      { maxRetries: 1, maxTokens: 500 }
    );
    const delta = parseTaggedJson(compute.content, "style_profile_delta");
    if (delta.meaningful_change === false) {
      return;
    }

    const refined = {
      ...existing,
      ...recordValue(delta.updated_profile_patch),
      recentFeedback: feedback,
      lastRefinementReason: stringValue(delta.reason, "feedback.received"),
      lastRefinementQualitySignal: stringValue(delta.quality_signal, "mixed"),
      lastRefinementTeeVerified: compute.verified,
      refinementCount: Number(existing.refinementCount ?? 0) + 1,
      updatedAt: Date.now()
    };
    await this.context.storage.kvSet(profileKey, refined);
    await this.context.bus.publish({
      id: `${event.id}:style.refined`,
      type: "style.refined",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      payload: { requestId, profileKey, reason: "feedback.received" }
    });
  }

  private async extractProfile(samples: string[], metadata: Record<string, unknown>) {
    try {
      return await this.context.compute.chat(styleExtractionPrompt(samples, metadata), { maxRetries: 1, maxTokens: 900 });
    } catch (error) {
      const smallerWindow = samples.slice(0, Math.max(1, Math.min(samples.length, 3)));
      if (smallerWindow.length === samples.length) {
        throw error;
      }
      return this.context.compute.chat(styleExtractionPrompt(smallerWindow, { ...metadata, retry: "short_sample_window" }), {
        maxRetries: 1,
        maxTokens: 700
      });
    }
  }

  private async resolveProfileKey(styleId: string): Promise<string> {
    const defaultKey = `style:${styleId}:profile`;
    if (await this.context.storage.kvGet<Record<string, unknown>>(defaultKey)) {
      return defaultKey;
    }
    try {
      const style = await this.context.chain.styleOf(styleId);
      return style.profileURI.startsWith("0g://kv/") ? style.profileURI.replace("0g://kv/", "") : style.profileURI;
    } catch {
      return defaultKey;
    }
  }

  private validateAttestation(actor: string, message: string, signature: string): void {
    if (!message || !signature) {
      throw new Error("Missing wallet-signed attestation");
    }
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== actor.toLowerCase()) {
      throw new Error("Attestation signature does not match creator wallet");
    }
  }

  private validateSamples(samples: string[]): void {
    const text = samples.join("\n");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < MIN_SAMPLE_BYTES) {
      throw new Error("Writing sample must be at least 1KB of text");
    }
    if (bytes > MAX_SAMPLE_BYTES) {
      throw new Error("Writing sample must be under 1MB of text");
    }
    const lower = text.toLowerCase();
    if (DENYLIST.some((author) => lower.includes(author))) {
      throw new Error("Sample matches a known-author denylist entry");
    }
  }

  private isMeaningfulFeedback(feedback: string, payload: Record<string, unknown>): boolean {
    if (feedback.trim().length >= 20) {
      return true;
    }
    return Boolean(payload.editedDraft || payload.rejected || payload.rating === "negative");
  }
}

function parseTaggedJson(content: string, tag: string): Record<string, unknown> {
  const cleaned = stripCodeFence(content);
  const tagged = matchTaggedContent(cleaned, tag);
  const candidate = extractFirstJsonObject(stripCodeFence(tagged ?? cleaned));

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tagged response was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const snippet = cleaned.replace(/\s+/g, " ").slice(0, 240);
    const reason = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Could not parse ${tag} JSON from 0G Compute response: ${reason}. Response starts: ${snippet}`);
  }
}

function matchTaggedContent(content: string, tag: string): string | undefined {
  const pattern = new RegExp(`<\\s*${tag}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, "i");
  return content.match(pattern)?.[1]?.trim();
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json|xml|text)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function extractFirstJsonObject(content: string): string {
  const start = content.indexOf("{");
  if (start === -1) {
    return content.trim();
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1).trim();
      }
    }
  }

  return content.slice(start).trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function feedbackText(payload: Record<string, unknown>): string {
  return [
    stringValue(payload.feedback, ""),
    stringValue(payload.editSummary, ""),
    stringValue(payload.rejectionReason, ""),
    stringValue(payload.editedDraft, "")
  ]
    .filter(Boolean)
    .join("\n\n");
}

function normalizeSampleExcerpts(profile: Record<string, unknown>, samples: string[]): string[] {
  const fromProfile = stringArray(profile.sample_excerpts).concat(stringArray(profile.sampleExcerpts));
  if (fromProfile.length > 0) {
    return fromProfile.slice(0, 5);
  }
  return samples
    .map((sample) => sample.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((sample) => sample.slice(0, 240));
}

function budgetSamplesForExtraction(samples: string[]): string[] {
  const budget = Number(process.env.OG_AGENT_STYLE_SAMPLE_CHAR_BUDGET ?? DEFAULT_STYLE_SAMPLE_CHAR_BUDGET);
  const safeBudget = Number.isFinite(budget) && budget > 1_000 ? budget : DEFAULT_STYLE_SAMPLE_CHAR_BUDGET;
  const normalized = samples.map((sample) => sample.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunkBudget = Math.max(800, Math.floor(safeBudget / Math.min(normalized.length || 1, 8)));
  const chunks: string[] = [];

  for (const sample of normalized) {
    if (chunks.join("").length >= safeBudget || chunks.length >= 8) {
      break;
    }
    chunks.push(sample.slice(0, chunkBudget));
  }

  return chunks.length > 0 ? chunks : samples.slice(0, 1);
}

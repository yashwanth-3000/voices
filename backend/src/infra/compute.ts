import { createRequire } from "node:module";
import { ethers } from "ethers";
import OpenAI from "openai";
import { normalizePrivateKey, optionalEnv, requiredEnv } from "../config.js";
import { AgentCompute, ChatMessage, ChatResult } from "./types.js";

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } = require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

type Metadata = { endpoint: string; model: string; expiresAt: number };

export class MockComputeClient implements AgentCompute {
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const prompt = messages.map((message) => message.content).join("\n\n");
    if (prompt.includes("<style_profile_delta>")) {
      return mockResult(`<style_profile_delta>${JSON.stringify(buildStyleDelta(prompt))}</style_profile_delta>`);
    }
    if (prompt.includes("<style_profile>") && prompt.includes("literary analyst")) {
      return mockResult(`<style_profile>${JSON.stringify(buildStyleProfile(prompt))}</style_profile>`);
    }
    if (prompt.includes("Target platforms:") || prompt.includes("platform-specific variants")) {
      return mockResult(JSON.stringify(buildPlatformVariants(prompt)));
    }
    return mockResult(`<draft>${buildDraft(prompt)}</draft>`);
  }

  async verifyResponse(): Promise<boolean | null> {
    return null;
  }

  async ensureFunds(): Promise<void> {}
}

function mockResult(content: string): ChatResult {
  return { content, verified: null, model: "mock-derived-from-input" };
}

export class ZeroGComputeClient implements AgentCompute {
  private metadata?: Metadata;

  async chat(messages: ChatMessage[], options?: { model?: string; maxRetries?: number; maxTokens?: number }): Promise<ChatResult> {
    if (process.env.OG_COMPUTE_API_KEY && process.env.OG_COMPUTE_SERVICE_URL && process.env.OG_COMPUTE_MODEL) {
      return this.directChat(messages, options);
    }
    return this.brokerChat(messages, options);
  }

  async verifyResponse(): Promise<boolean | null> {
    return null;
  }

  async ensureFunds(): Promise<void> {
    const broker = await this.createBroker();
    try {
      const providerAddress = requiredEnv("OG_COMPUTE_PROVIDER_ADDRESS");
      await broker.inference.startAutoFunding(providerAddress);
    } finally {
      broker.inference.stopAutoFunding();
    }
  }

  private async directChat(messages: ChatMessage[], options?: { model?: string; maxTokens?: number }): Promise<ChatResult> {
    const client = new OpenAI({
      apiKey: requiredEnv("OG_COMPUTE_API_KEY"),
      baseURL: normalizeDirectBaseUrl(requiredEnv("OG_COMPUTE_SERVICE_URL"))
    });
    const model = options?.model ?? requiredEnv("OG_COMPUTE_MODEL");
    const completion = await client.chat.completions.create({ model, messages, max_tokens: options?.maxTokens });
    return {
      content: completion.choices[0]?.message?.content ?? "",
      chatId: completion.id,
      verified: null,
      model
    };
  }

  private async brokerChat(messages: ChatMessage[], options?: { maxRetries?: number; maxTokens?: number }): Promise<ChatResult> {
    const broker = await this.createBroker();
    const providerAddress = requiredEnv("OG_COMPUTE_PROVIDER_ADDRESS");
    try {
      const { endpoint, model } = await this.getMetadata(broker, providerAddress);
      const body = { model, messages, max_tokens: options?.maxTokens };
      const headers = await broker.inference.getRequestHeaders(providerAddress, JSON.stringify(body));
      const response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(`0G Compute request failed: ${response.status} ${await response.text()}`);
      }
      const data = await response.json();
      const chatId = response.headers.get("ZG-Res-Key") || response.headers.get("zg-res-key") || data.id || data.chatID;
      const verified = await broker.inference.processResponse(providerAddress, chatId, JSON.stringify(data.usage || {}));
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        chatId,
        verified,
        model
      };
    } finally {
      broker.inference.stopAutoFunding();
    }
  }

  private async getMetadata(
    broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
    providerAddress: string
  ): Promise<{ endpoint: string; model: string }> {
    if (this.metadata && this.metadata.expiresAt > Date.now()) {
      return this.metadata;
    }
    const metadata = await broker.inference.getServiceMetadata(providerAddress);
    this.metadata = { ...metadata, expiresAt: Date.now() + 5 * 60_000 };
    return metadata;
  }

  private async createBroker(): Promise<Awaited<ReturnType<typeof createZGComputeNetworkBroker>>> {
    const provider = new ethers.JsonRpcProvider(optionalEnv("OG_RPC_URL", "https://evmrpc-testnet.0g.ai"));
    const wallet = new ethers.Wallet(normalizePrivateKey(requiredEnv("PRIVATE_KEY")), provider);
    return createZGComputeNetworkBroker(wallet as unknown as Parameters<typeof createZGComputeNetworkBroker>[0]);
  }
}

function buildStyleProfile(prompt: string): Record<string, unknown> {
  const samples = extractTaggedBlocks(prompt, "sample");
  const sampleText = samples.join("\n\n") || prompt;
  const words = distinctiveWords(sampleText, 12);
  const sentences = splitSentences(sampleText);
  const avgSentenceLength = average(sentences.map((sentence) => wordsIn(sentence).length));
  const excerpts = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 50)
    .slice(0, 5)
    .map((sentence) => sentence.slice(0, 240));

  return {
    tone: {
      labels: inferToneLabels(sampleText),
      primary: inferToneLabels(sampleText)[0] ?? "direct",
      secondary: inferToneLabels(sampleText).slice(1, 4),
      confidence: 0.7
    },
    vocabulary: {
      distinctive_words: words.slice(0, 8),
      favorite_phrases: repeatedPhrases(sampleText).slice(0, 5),
      avoided_patterns: inferAvoidedPatterns(sampleText),
      domain_terms: words.filter((word) => ["agent", "style", "creator", "event", "profile", "settlement"].includes(word))
    },
    sentence_rhythm: {
      average_sentence_length: avgSentenceLength > 24 ? "long" : avgSentenceLength > 13 ? "medium" : "short",
      variance: sentenceVariance(sentences),
      punctuation_habits: punctuationHabits(sampleText),
      cadence_notes: "Derived from the uploaded sample in mock mode."
    },
    structural_patterns: {
      openings: excerpts.slice(0, 2),
      closings: excerpts.slice(-2),
      paragraphing: `${Math.max(1, sampleText.split(/\n\s*\n/).filter(Boolean).length)} paragraph blocks`,
      transition_style: sampleText.includes("because") || sampleText.includes("That is") ? "explanatory" : "direct"
    },
    recurring_themes: words.slice(0, 6),
    sample_excerpts: excerpts.length > 0 ? excerpts : [sampleText.slice(0, 240)],
    voice_fingerprint: {
      fingerprint_text: `A ${inferToneLabels(sampleText).join(", ")} voice with recurring focus on ${words
        .slice(0, 4)
        .join(", ")}.`,
      embedding_hint: words.slice(0, 10)
    },
    voice_essence: `A ${inferToneLabels(sampleText)[0] ?? "direct"} voice that frames ${words[0] ?? "the topic"} through concrete explanation.`,
    safety_notes: ["Mock profile generated from the submitted sample, not a fixed response."],
    confidence: 0.7
  };
}

function buildStyleDelta(prompt: string): Record<string, unknown> {
  const feedback = afterLabel(prompt, "Latest feedback:") || prompt;
  const feedbackWords = distinctiveWords(feedback, 8);
  const meaningful = feedback.trim().length >= 20 || feedbackWords.length > 2;

  return {
    meaningful_change: meaningful,
    reason: meaningful
      ? `Feedback emphasizes ${feedbackWords.slice(0, 4).join(", ") || "a clearer voice direction"}.`
      : "Feedback was too short to justify a profile update.",
    updated_profile_patch: meaningful
      ? {
          feedback_guidance: feedback.trim().slice(0, 500),
          vocabulary_adjustments: feedbackWords,
          safety_notes: ["This patch was derived from the latest feedback in mock mode."]
        }
      : {},
    quality_signal: /less|not|reject|wrong|generic|bad/i.test(feedback) ? "mixed" : "positive",
    confidence: meaningful ? 0.68 : 0.35
  };
}

function buildDraft(prompt: string): string {
  const topic = afterLabel(prompt, "Write content matching the voice above on the following topic:").replace(
    /Return only <draft>[\s\S]*$/i,
    ""
  );
  const styleProfileText = between(prompt, "Style profile to follow:", "Few-shot examples of this voice");
  const styleWords = distinctiveWords(styleProfileText, 5);
  const cleanTopic = compact(topic || "Write a concise update").replace(/\.$/, "");

  return [
    `${cleanTopic}.`,
    `The useful part is not another polished prompt. It is the system around it: a style profile, an event trail, and a settlement path that can be checked later.`,
    `Keep the claim simple. The voice is ${styleWords.slice(0, 3).join(", ") || "clear and specific"}; the workflow should show exactly what happened.`
  ].join("\n\n");
}

function buildPlatformVariants(prompt: string): Record<string, string> {
  const platforms = parseJsonArray(afterLabel(prompt, "Target platforms:")) ?? ["x", "linkedin", "instagram"];
  const draft = compact(between(prompt, "Draft to adapt:", "Required JSON keys:") || prompt);

  return Object.fromEntries(
    platforms.map((platform) => {
      if (platform === "x") {
        return [platform, truncate(`${firstSentence(draft)} The value is the event trail: style, draft, publish, feedback.`, 276)];
      }
      if (platform === "linkedin") {
        return [
          platform,
          [
            firstSentence(draft),
            "What matters is the workflow behind it: the style is profiled, the draft is generated from that profile, platform variants are published, and feedback updates the profile through events.",
            "That makes the demo inspectable instead of just impressive."
          ].join("\n\n")
        ];
      }
      if (platform === "instagram") {
        return [
          platform,
          `${firstSentence(draft)}\n\nA style profile, an event trail, and feedback that actually changes the next run.\n\n#0G #iNFT #Agents #CreatorTools`
        ];
      }
      return [platform, firstSentence(draft)];
    })
  );
}

export function createComputeClient(): AgentCompute {
  return process.env.AGENT_COMPUTE_MODE === "0g" || process.env.AGENT_COMPUTE_MODE === "live"
    ? new ZeroGComputeClient()
    : new MockComputeClient();
}

function normalizeDirectBaseUrl(serviceUrl: string): string {
  const trimmed = serviceUrl.replace(/\/$/, "");
  return trimmed.endsWith("/v1/proxy") ? trimmed : `${trimmed}/v1/proxy`;
}

function extractTaggedBlocks(input: string, tag: string): string[] {
  return [...input.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1].trim());
}

function afterLabel(input: string, label: string): string {
  const index = input.indexOf(label);
  if (index === -1) {
    return "";
  }
  return input.slice(index + label.length).trim();
}

function between(input: string, start: string, end: string): string {
  const startIndex = input.indexOf(start);
  if (startIndex === -1) {
    return "";
  }
  const afterStart = input.slice(startIndex + start.length);
  const endIndex = afterStart.indexOf(end);
  return (endIndex === -1 ? afterStart : afterStart.slice(0, endIndex)).trim();
}

function compact(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function wordsIn(input: string): string[] {
  return input.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
}

function distinctiveWords(input: string, limit: number): string[] {
  const stop = new Set([
    "the",
    "and",
    "that",
    "with",
    "this",
    "from",
    "into",
    "should",
    "would",
    "could",
    "about",
    "while",
    "there",
    "their",
    "because",
    "only",
    "your",
    "above",
    "following",
    "return",
    "style",
    "profile"
  ]);
  const counts = new Map<string, number>();
  for (const word of wordsIn(input)) {
    if (!stop.has(word)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function repeatedPhrases(input: string): string[] {
  const phrases = input.match(/\b(?:[A-Z]?[a-z][a-z'-]*\s+){2,4}[A-Z]?[a-z][a-z'-]*\b/g) ?? [];
  const counts = new Map<string, number>();
  for (const phrase of phrases.map((phrase) => phrase.toLowerCase())) {
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([phrase]) => phrase);
}

function inferToneLabels(input: string): string[] {
  const lower = input.toLowerCase();
  const labels = new Set<string>();
  if (/because|means|difference|specific|concrete/.test(lower)) labels.add("educational");
  if (/should|must|avoid|do not|don't|not/.test(lower)) labels.add("direct");
  if (/system|agent|profile|workflow|event|settlement/.test(lower)) labels.add("technical");
  if (/trust|creator|private|honest/.test(lower)) labels.add("creator-first");
  if (labels.size === 0) labels.add("clear");
  return [...labels];
}

function inferAvoidedPatterns(input: string): string[] {
  const lower = input.toLowerCase();
  const avoided: string[] = [];
  if (/avoid|no /.test(lower)) avoided.push("generic launch language");
  if (/not .*pretend|does not pretend/.test(lower)) avoided.push("unsupported claims");
  return avoided;
}

function splitSentences(input: string): string[] {
  return input.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sentenceVariance(sentences: string[]): "low" | "medium" | "high" {
  const lengths = sentences.map((sentence) => wordsIn(sentence).length);
  const avg = average(lengths);
  const variance = average(lengths.map((length) => Math.abs(length - avg)));
  return variance > 10 ? "high" : variance > 4 ? "medium" : "low";
}

function punctuationHabits(input: string): string[] {
  const habits: string[] = [];
  if (input.includes(":")) habits.push("uses colons for explanation");
  if (input.includes(";")) habits.push("uses semicolons sparingly");
  if (input.includes("?")) habits.push("uses questions");
  if (habits.length === 0) habits.push("mostly period-led declarative sentences");
  return habits;
}

function parseJsonArray(input: string): string[] | null {
  const match = input.match(/\[[\s\S]*?\]/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function firstSentence(input: string): string {
  return splitSentences(input)[0] ?? compact(input).slice(0, 180);
}

function truncate(input: string, maxLength: number): string {
  const compacted = compact(input);
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

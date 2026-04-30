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
  return {
    content,
    verified: null,
    teeVerified: null,
    model: "mock-derived-from-input",
    computePath: "mock",
    durationMs: 0
  };
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
    const started = Date.now();
    const client = new OpenAI({
      apiKey: requiredEnv("OG_COMPUTE_API_KEY"),
      baseURL: normalizeDirectBaseUrl(requiredEnv("OG_COMPUTE_SERVICE_URL"))
    });
    const model = options?.model ?? requiredEnv("OG_COMPUTE_MODEL");
    const completion = await client.chat.completions.create({ model, messages, max_tokens: options?.maxTokens });
    const usage = tokenUsage(completion.usage);
    return {
      content: completion.choices[0]?.message?.content ?? "",
      chatId: completion.id,
      verified: null,
      teeVerified: null,
      model,
      serviceUrl: normalizeDirectBaseUrl(requiredEnv("OG_COMPUTE_SERVICE_URL")),
      computePath: "direct",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Date.now() - started
    };
  }

  private async brokerChat(messages: ChatMessage[], options?: { maxRetries?: number; maxTokens?: number }): Promise<ChatResult> {
    const started = Date.now();
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
      const usage = tokenUsage(data.usage);
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        chatId,
        verified,
        teeVerified: verified,
        providerAddress,
        serviceUrl: endpoint,
        model,
        computePath: "broker",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - started
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
  const metadata = parsePromptMetadata(prompt);
  const sourceContext = recordValue(metadata.sourceContext);
  const sourceKind = stringValue(metadata.sourceKind) || stringValue(sourceContext.sourceKind) || "unknown";
  const sourceMaterials = Array.isArray(metadata.sourceMaterials) ? metadata.sourceMaterials : [];
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
    source_profile: {
      primary_source_type: sourceKind,
      source_inventory: sourceMaterials,
      analysis_focus: mockAnalysisFocus(sourceKind),
      twitter_profile: sourceKind === "twitter" || sourceKind === "mixed"
        ? {
            tweet_shapes: ["Mock mode: derived from imported post boundaries and sentence cadence."],
            hook_patterns: excerpts.slice(0, 2),
            line_breaking: sampleText.includes("\n\n") ? "uses separated post blocks" : "compact single-block posts",
            emoji_usage: /[\u{1F300}-\u{1FAFF}]/u.test(sampleText) ? "emoji present in source text" : "no emoji pattern detected",
            hashtag_usage: /#[\p{L}\p{N}_]+/u.test(sampleText) ? "hashtags present in source text" : "no hashtag pattern detected",
            cta_patterns: /follow|subscribe|join|read|try|check/i.test(sampleText) ? ["direct CTA appears in source"] : ["no strong CTA detected"]
          }
        : undefined,
      readme_profile: sourceKind === "github_readme" || sourceKind === "mixed"
        ? {
            heading_hierarchy: "Mock mode: inferred from markdown headings and section order.",
            setup_flow: /install|usage|quickstart|setup/i.test(sampleText) ? "includes setup or usage language" : "setup flow not strongly visible",
            code_block_usage: sampleText.includes("```") ? "uses fenced code blocks" : "no fenced code blocks detected",
            feature_framing: "features are framed through recurring project nouns and direct explanations"
          }
        : undefined,
      article_profile: sourceKind === "blog_article" || sourceKind === "mixed"
        ? {
            headline_and_opening: excerpts[0] ?? "Mock mode opening unavailable",
            thesis_shape: sampleText.includes("because") ? "explains causality explicitly" : "states observations directly",
            sectioning: sampleText.includes("#") ? "uses markdown headings" : "paragraph-led structure",
            conclusion_or_cta: excerpts.at(-1) ?? "Mock mode closing unavailable"
          }
        : undefined,
      file_profile: sourceKind === "file_upload" || sourceKind === "unknown"
        ? {
            document_structure: "Mock mode: inferred from uploaded text blocks.",
            formatting_habits: sampleText.includes("- ") ? "uses lists" : "mostly prose paragraphs",
            reuse_guidance: "preserve cadence and rhetorical shape without copying source sentences"
          }
        : undefined,
      generation_guidelines_by_format: {
        tweet: ["Open with the strongest concrete point.", "Keep one clear idea per post."],
        thread: ["Use one move per post and keep transitions explicit."],
        readme: ["Mirror heading hierarchy and setup flow before examples."],
        article: ["Start with a clear thesis, then develop with concrete examples."]
      }
    },
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
  const cleanTopic = normalizeMockTopic(topic || "this topic");

  return [
    `${cleanTopic} is bigger than the headline. The useful question is what changed, who had to react, and which assumptions stopped being safe.`,
    "The concrete part matters most: ownership changed, incentives shifted, and people who depended on the platform had to re-check what they could trust.",
    "No fake precision, no invented motives, no pretending the consequences are settled. Say the visible mechanism plainly, then stop before speculation starts sounding like evidence."
  ].join("\n\n");
}

function buildPlatformVariants(prompt: string): Record<string, string> {
  const platforms = parseJsonArray(afterLabel(prompt, "Target platforms:")) ?? ["x", "linkedin", "instagram"];
  const draft = compact(between(prompt, "Draft to adapt:", "Required JSON keys:") || prompt);

  return Object.fromEntries(
    platforms.map((platform) => {
      if (platform === "x") {
        return [platform, truncate(firstSentence(draft), 260)];
      }
      if (platform === "linkedin") {
        return [
          platform,
          [
            firstSentence(draft),
            "The important part is to keep the claim careful: name the mechanism, avoid fake precision, and separate what is visible from what is still interpretation.",
            "That makes the post useful instead of just confident."
          ].join("\n\n")
        ];
      }
      if (platform === "instagram") {
        return [
          platform,
          `${firstSentence(draft)}\n\nNo fake certainty. Just the visible change, the tradeoff, and why it matters.`
        ];
      }
      return [platform, firstSentence(draft)];
    })
  );
}

function normalizeMockTopic(topic: string): string {
  const stripped = compact(topic)
    .replace(/^(write|draft|create|make)\s+(me\s+)?(a\s+|an\s+)?(post|tweet|thread|caption|linkedin post|article)?\s*(about|on|for)?\s*/i, "")
    .replace(/^about\s+/i, "")
    .replace(/[.?!]+$/, "")
    .trim();
  const normalized = rephraseMockHowSubject(stripped || "this topic")
    .replace(/\belon\s+(?:much|mush|musk)\b/gi, "Elon Musk")
    .replace(/\bthe\s+x\b/gi, "X")
    .replace(/\bx\b/gi, "X")
    .replace(/\belon\s+musk\b/gi, "Elon Musk")
    .replace(/\bthe\s+twitter\b/gi, "Twitter")
    .replace(/\btwitter\b/gi, "Twitter");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function rephraseMockHowSubject(input: string): string {
  const match = input.match(/^how\s+(.+?)\s+(bought|acquired)\s+(.+)$/i);
  if (!match) {
    return input;
  }
  return `${match[1]} ${match[2].toLowerCase() === "acquired" ? "acquiring" : "buying"} ${match[3]}`;
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

function tokenUsage(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  return {
    inputTokens: numberValue(record.prompt_tokens) ?? numberValue(record.input_tokens),
    outputTokens: numberValue(record.completion_tokens) ?? numberValue(record.output_tokens)
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractTaggedBlocks(input: string, tag: string): string[] {
  return [...input.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1].trim());
}

function parsePromptMetadata(prompt: string): Record<string, unknown> {
  const line = prompt.match(/Metadata:\s*(\{[^\n]+})/);
  if (!line?.[1]) {
    return {};
  }
  try {
    const parsed = JSON.parse(line[1]) as unknown;
    return recordValue(parsed);
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function mockAnalysisFocus(sourceKind: string): string {
  if (sourceKind === "twitter") return "tweet structure, hooks, emoji/hashtag/CTA habits, and short-form rhythm";
  if (sourceKind === "github_readme") return "README hierarchy, setup flow, examples, code blocks, and maintainer docs tone";
  if (sourceKind === "blog_article") return "long-form thesis, sectioning, evidence style, transitions, and conclusion habits";
  if (sourceKind === "mixed") return "cross-source voice fingerprint plus per-source generation rules";
  return "general writing structure, cadence, vocabulary, and reusable generation rules";
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

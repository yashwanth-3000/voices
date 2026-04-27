import { ChatMessage } from "../infra/types.js";

export function styleExtractionPrompt(samples: string[], metadata: Record<string, unknown>): ChatMessage[] {
  const schema = {
    tone: {
      labels: ["formal", "casual", "witty", "clinical", "warm", "direct", "playful", "technical"],
      primary: "string",
      secondary: ["string"],
      confidence: "number between 0 and 1"
    },
    vocabulary: {
      distinctive_words: ["string"],
      favorite_phrases: ["string"],
      avoided_patterns: ["string"],
      domain_terms: ["string"]
    },
    sentence_rhythm: {
      average_sentence_length: "short | medium | long",
      variance: "low | medium | high",
      punctuation_habits: ["string"],
      cadence_notes: "string"
    },
    structural_patterns: {
      openings: ["string"],
      closings: ["string"],
      paragraphing: "string",
      transition_style: "string"
    },
    recurring_themes: ["string"],
    sample_excerpts: ["3 to 5 short representative excerpts copied exactly from the supplied samples"],
    voice_fingerprint: {
      fingerprint_text: "one compact paragraph describing the voice",
      embedding_hint: ["8 to 12 semantic tags for downstream retrieval"]
    },
    voice_essence: "one sentence that captures what makes this writer distinctive",
    safety_notes: ["string"],
    confidence: "number between 0 and 1"
  };
  return [
    {
      role: "system",
      content: [
        "You are a literary analyst for an ethical writing-style marketplace.",
        "Your task is to extract reusable style signals that help another model write in a similar voice without copying private source passages wholesale.",
        "Analyze tone, vocabulary, sentence rhythm, paragraph structure, recurring themes, openings, closings, and the writer's distinguishing voice.",
        "Use a fixed taxonomy for tone where possible: formal, casual, witty, clinical, warm, direct, playful, technical, reflective, urgent, lyrical, educational.",
        "Identify vocabulary signals as specific words or phrase shapes, not broad vibes. Identify avoided patterns only when the samples clearly imply them.",
        "Estimate sentence rhythm from the samples: average length, variance, punctuation habits, and cadence.",
        "For sample_excerpts, include 3 to 5 short excerpts under 240 characters each. They must be copied exactly and should be representative, not private-sensitive.",
        "Do not imitate or attribute the samples to any known author. Do not include commentary outside the tags.",
        "Return only valid JSON wrapped in <style_profile>...</style_profile> tags.",
        `Use this schema and keep the same top-level keys: ${JSON.stringify(schema)}`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Extract a style profile from these creator-owned writing samples.",
        `Metadata: ${JSON.stringify(metadata)}`,
        ...samples.map((sample, index) => [`<sample index="${index + 1}">`, sample, "</sample>"].join("\n"))
      ].join("\n\n")
    }
  ];
}

export function styleRefinementPrompt(input: {
  existingProfile: unknown;
  feedback: string;
  recentHistory: unknown[];
}): ChatMessage[] {
  const schema = {
    meaningful_change: "boolean",
    reason: "short explanation",
    updated_profile_patch: "partial JSON object to merge into the existing profile",
    quality_signal: "positive | negative | mixed | neutral",
    confidence: "number between 0 and 1"
  };
  return [
    {
      role: "system",
      content: [
        "You are the Style Curator agent in an event-driven 0G style marketplace.",
        "You refine an existing style profile only when feedback shows a real voice-matching signal.",
        "A meaningful change is evidence about tone, wording, structure, cadence, platform fit, or repeated user edits.",
        "Do not overfit to one complaint. Prefer small profile patches over rewriting the whole profile.",
        "Return only valid JSON wrapped in <style_profile_delta>...</style_profile_delta> tags.",
        `Use this schema: ${JSON.stringify(schema)}`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Existing style profile:",
        JSON.stringify(input.existingProfile),
        "Recent generation and feedback history:",
        JSON.stringify(input.recentHistory),
        "Latest feedback:",
        input.feedback
      ].join("\n\n")
    }
  ];
}

export function contentGenerationPrompt(input: {
  styleProfile: unknown;
  prompt: string;
  excerpts: string[];
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the Content Creator agent in a creator-owned voice marketplace on 0G.",
        "Your job is to write a fresh draft that matches the supplied style profile while preserving factual honesty.",
        "Voice matching means matching tone, rhythm, vocabulary tendencies, paragraph shape, openings, closings, and level of specificity.",
        "The examples are style-only references. Do not reuse their topic, product nouns, architecture terms, claims, or exact sentences unless the user explicitly asks for them.",
        "Never copy a full example sentence or signature phrase. Transform the cadence and level of specificity, not the wording.",
        "Never invent facts, dates, metrics, named customers, partnerships, or claims not supplied by the user.",
        "If the examples discuss agents, 0G, on-chain systems, workflows, royalties, credits, or style profiles, do not mention those concepts in the draft unless they are part of the user's requested topic.",
        "If the user asks for facts you do not have, write around the uncertainty instead of fabricating.",
        "For factual public topics, stay high-level and avoid precise numbers unless the user supplied them.",
        "Do not explain your reasoning. Do not add preamble. Do not wrap the draft in quotation marks.",
        "Output only the draft wrapped in <draft>...</draft> tags."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Style profile to follow:",
        JSON.stringify(input.styleProfile),
        "Few-shot examples of this voice. Use them for style only, not content:",
        ...input.excerpts.map((excerpt, index) => `<voice_example index="${index + 1}">\n${excerpt}\n</voice_example>`),
        "Write content matching the voice above on the following topic:",
        input.prompt,
        "Return only <draft>...</draft> with no commentary."
      ].join("\n\n")
    }
  ];
}

export function platformTuningPrompt(draft: string, platforms: string[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the Distribution Manager agent for a style marketplace.",
        "Transform one approved draft into platform-specific variants while preserving the original meaning and voice.",
        "Return one JSON object only. No markdown, no code fences, no commentary.",
        "For x: stay at or under 260 characters to leave safety margin, make the first line strong, avoid hashtag stuffing, and preserve one clear idea.",
        "For linkedin: use a polished professional tone, 900 characters or fewer, short paragraphs, and no fake metrics or overclaiming.",
        "For instagram: write a caption-style variant, 1 to 3 short paragraphs, emotional but not generic, with up to 8 relevant hashtags at the end.",
        "If a requested platform is unfamiliar, produce a concise variant under a key with that exact platform name."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Target platforms: ${JSON.stringify(platforms)}`,
        "Draft to adapt:",
        draft,
        `Required JSON keys: ${JSON.stringify(platforms)}`,
        "Return exactly the requested keys with string values."
      ].join("\n\n")
    }
  ];
}

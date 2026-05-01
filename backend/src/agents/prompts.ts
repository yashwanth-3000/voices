import { ChatMessage } from "../infra/types.js";

export function styleExtractionPrompt(samples: string[], metadata: Record<string, unknown>): ChatMessage[] {
  const schema = {
    tone: {
      labels: [
        "formal",
        "casual",
        "witty",
        "clinical",
        "warm",
        "direct",
        "playful",
        "technical",
        "reflective",
        "urgent",
        "lyrical",
        "educational",
        "skeptical",
        "builder-first"
      ],
      primary: "one strongest tone label",
      secondary: ["2 to 4 supporting labels"],
      confidence: "number between 0 and 1"
    },
    vocabulary: {
      distinctive_words: ["8 to 16 words that recur or feel unusually characteristic"],
      favorite_phrases: ["3 to 8 phrase shapes, not full long sentences"],
      avoided_patterns: ["cliches, hype phrases, or constructions the writer appears to avoid"],
      domain_terms: ["specific nouns and technical terms the writer naturally uses"],
      register_notes: "plain explanation of whether wording is simple, academic, salesy, technical, etc."
    },
    sentence_rhythm: {
      average_sentence_length: "short | medium | long",
      variance: "low | medium | high",
      punctuation_habits: ["string"],
      cadence_notes: "how the prose moves from sentence to sentence",
      compression_level: "sparse | balanced | dense"
    },
    structural_patterns: {
      openings: ["string"],
      closings: ["string"],
      paragraphing: "string",
      transition_style: "string",
      argument_shape: "how the writer tends to build a point"
    },
    recurring_themes: ["string"],
    rhetorical_moves: ["named moves such as contrast, caveat, concrete example, escalation, warning, reframing"],
    do_rules: ["6 to 10 compact style rules a downstream generation model should follow"],
    dont_rules: ["4 to 8 compact style mistakes a downstream generation model should avoid"],
    sample_excerpts: ["3 to 5 short representative excerpts copied exactly from the supplied samples, each under 240 chars"],
    voice_fingerprint: {
      fingerprint_text: "one compact paragraph describing the voice",
      embedding_hint: ["8 to 12 semantic tags for downstream retrieval"]
    },
    voice_essence: "one sentence that captures what makes this writer distinctive",
    safety_notes: ["privacy, attribution, known-author, or over-copying concerns"],
    source_profile: {
      primary_source_type: "twitter | github_readme | blog_article | file_upload | mixed",
      source_inventory: [
        {
          type: "source type",
          label: "creator-facing source label",
          unit_count: "number of posts/articles/readmes/files represented",
          character_count: "number of submitted characters for this source"
        }
      ],
      analysis_focus: "which source-specific style lens was used and why",
      generation_guidelines_by_format: {
        tweet: ["2 to 4 compact rules for writing a new tweet in this voice"],
        thread: ["2 to 4 compact rules for writing a thread"],
        readme: ["2 to 4 compact rules for writing README/docs"],
        article: ["2 to 4 compact rules for writing a blog/article"]
      }
    },
    confidence: "number between 0 and 1"
  };
  return [
    {
      role: "system",
      content: [
        "You are a literary analyst for an ethical writing-style marketplace on 0G.",
        "Your job is to turn creator-owned writing samples into a structured style profile that downstream agents can use without exposing or copying the private source text.",
        "",
        "Analyze the writing at five levels:",
        "1. Tone: choose labels from the fixed taxonomy when possible and explain the dominant emotional stance.",
        "2. Vocabulary: identify concrete word choices, recurring nouns, favorite phrase shapes, level of technicality, and language the writer seems to avoid.",
        "3. Rhythm: estimate sentence length, variance, punctuation habits, compression level, and how short and long sentences are sequenced.",
        "4. Structure: describe openings, closings, paragraph length, transitions, and how arguments are built.",
        "5. Voice fingerprint: summarize what makes this writer recognizable in a way a generation model can follow without copying exact prose.",
        "6. Source mechanics: adapt the profile to the submitted source type.",
        "",
        "Source-specific requirements:",
        "- If the material is only Twitter/X posts, focus the profile on tweet behavior: hooks, post length, line breaks, emoji usage, hashtags, CTAs, thread shapes, quote/reply habits, punctuation, casing, and how a new tweet should be written.",
        "- If the material is only GitHub READMEs, focus the profile on README/docs behavior: heading hierarchy, setup flow, code blocks, command examples, badges, tables, feature framing, contribution/license sections, and maintainer tone.",
        "- If the material is only blogs/articles, focus the profile on long-form behavior: headline/opening style, thesis shape, sectioning, paragraph cadence, evidence style, examples, transitions, conclusion, and CTA.",
        "- If the material is uploaded files, infer the document genre from the content and describe its formatting and transfer rules.",
        "- If multiple source types are present, create one cross-source voice fingerprint plus a source_profile section for each source type that appears.",
        "",
        "Be specific. Prefer observable signals such as 'uses contrast before making the point' over vague labels such as 'professional'.",
        "Separate style from subject matter. Do not treat product names, wallet mechanics, or 0G-specific nouns as mandatory unless they are genuinely part of the writer's voice.",
        "Keep this base profile compact and parse-safe. The next 0G Compute call creates the long detailed style guide, so do not put the full report here.",
        "Prefer concise JSON arrays for do_rules, dont_rules, rhetorical_moves, and generation_guidelines_by_format. These fields should be directly usable by a future generation prompt.",
        "For sample_excerpts, include 3 to 5 short excerpts under 180 characters each. Copy them exactly, but choose excerpts that are representative and not private-sensitive.",
        "Output must be under 1800 tokens.",
        "Do not imitate or attribute the samples to any known author. Do not include commentary outside the tags.",
        "Return one complete JSON object wrapped in <style_profile>...</style_profile> tags. The first character inside the opening tag must be { and the last character before the closing tag must be }.",
        "No markdown. No code fences. No trailing text.",
        `Use this schema and keep the same top-level keys: ${JSON.stringify(schema)}`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Extract a style profile from these creator-owned writing samples.",
        `Metadata: ${JSON.stringify(metadata)}`,
        "Treat each sample as private source material. Extract style signals, not reusable paragraphs.",
        ...samples.map((sample, index) => [`<sample index="${index + 1}">`, sample, "</sample>"].join("\n"))
      ].join("\n\n")
    }
  ];
}

export function detailedStyleGuidePrompt(input: {
  profile: Record<string, unknown>;
  samples: string[];
  metadata: Record<string, unknown>;
}): ChatMessage[] {
  const schema = {
    guide_version: 1,
    generated_by: "0g-compute",
    source_type: "twitter | github_readme | blog_article | file_upload | mixed",
    source_summary: "what material was analyzed",
    source_preservation: {
      full_input_stored_encrypted: true,
      public_report_contains_selected_examples_only: true,
      analyzed_unit_count: "number",
      analyzed_character_count: "number"
    },
    prompt_ready_style_brief: "dense paragraph that a generation model can follow directly",
    voice_summary: "plain-language summary of what makes the voice recognizable",
    actual_examples: [
      {
        label: "short label",
        source_label: "where this example came from",
        text: "exact short example from the supplied material",
        observed_patterns: ["specific style mechanics visible in this example"]
      }
    ],
    writing_patterns: {
      length_and_density: "measurable post, paragraph, or section length patterns",
      hooks_or_openings: ["specific observed opening patterns"],
      structure: "how the writer organizes the material",
      line_breaks_or_sectioning: "spacing, section, heading, or paragraph habits",
      vocabulary_signals: ["recurring words, domain nouns, and phrase shapes"],
      punctuation_and_casing: "questions, exclamations, colon use, caps, quote style",
      emoji_hashtag_link_cta_usage: "for Twitter/X; say none if absent",
      argument_shape: "how points are built, caveated, escalated, or closed"
    },
    voice_rules: ["10 to 16 concrete generation rules"],
    avoid_rules: ["8 to 12 concrete mistakes to avoid"],
    generation_recipe: {
      tweet: ["source-specific steps for writing one tweet"],
      thread: ["source-specific steps for writing a thread"],
      readme: ["source-specific steps for writing README/docs"],
      article: ["source-specific steps for writing a long-form piece"],
      generic: ["safe adaptation steps for other formats"]
    },
    confidence: "number between 0 and 1"
  };

  return [
    {
      role: "system",
      content: [
        "You are the 0G Compute Style Guide Generator for Voices.",
        "Your task is to create a detailed, public, prompt-ready style guide from creator-owned private samples and an existing style profile.",
        "",
        "This is not a summary. It must be operational: another generation model should be able to follow it to write in the same structural voice without seeing the full encrypted source material.",
        "",
        "Hard requirements:",
        "- Derive every claim from the supplied samples and existing profile. Do not invent mechanics.",
        "- Preserve all important source-specific behavior: tweet hooks, emoji/hashtag/link/CTA habits, line breaks, post length, thread shape; README headings, setup flow, code blocks, tables; article thesis, sectioning, evidence style, paragraph cadence.",
        "- Include 4 to 8 actual examples copied exactly from the supplied material. For Twitter/X, use whole short posts when possible. For README/article/file material, use representative headings, paragraphs, or concise sections.",
        "- For each example, explain observed_patterns: why this example teaches the style.",
        "- Create concrete voice_rules and avoid_rules. Avoid generic instructions like 'be professional' unless the samples actually show that behavior and you explain how.",
        "- Do not expose secrets, credentials, private keys, or sensitive personal identifiers if present. If an example contains sensitive data, choose another example.",
        "- Do not attribute the style to a known author. Do not say the creator is a public figure.",
        "- Do not include markdown, commentary, or code fences.",
        "",
        "Return only valid JSON wrapped in <style_guide>...</style_guide> tags.",
        `Use this schema and keep the same top-level keys: ${JSON.stringify(schema)}`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Existing style profile:",
        JSON.stringify(input.profile),
        "Metadata:",
        JSON.stringify(input.metadata),
        "Creator-owned samples to analyze:",
        ...input.samples.map((sample, index) => `<sample index="${index + 1}">\n${sample}\n</sample>`)
      ].join("\n\n")
    }
  ];
}

export function jsonRepairPrompt(input: {
  tag: string;
  content: string;
  parseError: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You repair malformed JSON emitted by an LLM.",
        "Keep the original meaning and fields. Do not invent new analysis. Do not summarize.",
        "Fix only syntax problems: missing outer braces, missing commas, trailing commas, unescaped newlines inside strings, accidental tag text, and unfinished trailing fields.",
        "If the input is an object fragment such as \"tone\": {...}, wrap it with { and }.",
        "If the response was cut off, close the current object/array safely and omit only the unfinished trailing field.",
        `Return exactly one complete JSON object wrapped in <${input.tag}>...</${input.tag}> tags. The first character inside the opening tag must be { and the last character before the closing tag must be }. No markdown. No code fences.`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Tag: ${input.tag}`,
        `Parse error: ${input.parseError}`,
        "Malformed response:",
        input.content
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
    updated_profile_patch: "partial JSON object to merge into the existing profile; only include fields that should change",
    quality_signal: "positive | negative | mixed | neutral",
    confidence_after_feedback: "number between 0 and 1",
    next_generation_guidance: ["specific instructions the Content Creator should follow next time"],
    ignored_feedback: ["items that were too vague, unsafe, or unrelated to style"],
    confidence: "number between 0 and 1"
  };
  return [
    {
      role: "system",
      content: [
        "You are the Style Curator agent in an event-driven 0G style marketplace.",
        "You refine an existing style profile only when feedback contains real evidence about voice matching.",
        "",
        "A meaningful change is evidence about tone, wording, structure, cadence, platform fit, repeated user edits, or a concrete mismatch between the draft and the creator's known voice.",
        "Not meaningful: vague praise, vague dislike, topic disagreement, new factual requirements, or requests that would make the model copy private source passages.",
        "",
        "Patch conservatively. Do not rewrite the whole profile unless the feedback clearly contradicts multiple existing fields.",
        "Prefer adding next_generation_guidance and small do/dont rule changes over changing tone labels after a single weak signal.",
        "Preserve creator safety: never add instructions to mimic a known public figure, reveal private samples, or copy a signature sentence.",
        "Return only valid JSON wrapped in <style_profile_delta>...</style_profile_delta> tags. No markdown. No code fences.",
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
  platforms: string[];
  qualityRetry?: {
    reason: string;
  };
}): ChatMessage[] {
  const platforms = input.platforms.length > 0 ? input.platforms : ["x"];
  const targetFormat = platforms[0] ?? "x";
  const styleContract = buildGenerationStyleContract(input.styleProfile, targetFormat);
  const profileSummary = buildSanitizedProfileSummary(input.styleProfile);
  const transferStrategy = buildVoiceTransferStrategy(input.prompt, targetFormat, input.excerpts, styleContract, profileSummary);
  return [
    {
      role: "system",
      content: [
        "You are the Content Creator agent for Voices, a 0G-powered style marketplace.",
        "Your job is not to summarize the user's topic. Your job is to perform style transfer: write the user's topic as if the selected creator wrote it.",
        "",
        "The style profile and examples are the evidence. Use them directly for tone, cadence, sentence shape, vocabulary register, openings, closings, line breaks, punctuation, emoji/hashtag habits, and structural rhythm.",
        "Transfer the voice and mechanics. Do not transfer private subject matter unless the user also supplied that fact in the task.",
        "",
        "Work like an expert writing agent:",
        "1. Silently extract the concrete facts and intent from the user's task.",
        "2. Silently infer the strongest voice mechanics from the profile and examples.",
        "3. Draft in that voice, then silently compare the draft against the examples for rhythm, structure, wording, and platform fit.",
        "4. Revise internally until it sounds like the selected style instead of generic marketing copy.",
        "",
        "Quality bar:",
        "- The output must be publishable as-is.",
        "- Include the important facts from the user's topic; do not collapse a rich request into a vague announcement.",
        "- Preserve factual boundaries. Do not add metrics, partnerships, product claims, links, commands, or APIs unless supplied.",
        "- Let the supplied style evidence determine the register; do not substitute a generic task template.",
        "- Prefer the creator's observed structure and vocabulary over category-default phrasing.",
        "- Do not explain the style, mention these instructions, or output analysis.",
        "",
        "FORMAT RULES:",
        "- x/twitter: one finished tweet, 260 characters or fewer.",
        "- thread: a finished tweet thread with 3 to 5 tweet blocks separated by blank lines. Do not include 1/N numbering. Aim for 160 to 220 characters per tweet when the user's material has enough detail.",
        "- instagram: a caption-style draft, concrete and visually grounded when the topic supports it.",
        "- blog: markdown with a useful title and sections.",
        "- github_readme: markdown with practical sections. Do not invent commands or APIs.",
        "",
        "Output only the draft inside <draft>...</draft> tags. Nothing else."
      ].join("\n")
    },
    {
      role: "user",
      content: buildGenerationUserMessage(input, styleContract, profileSummary, transferStrategy, targetFormat)
    }
  ];
}

function buildGenerationUserMessage(
  input: { styleProfile: unknown; prompt: string; excerpts: string[]; qualityRetry?: { reason: string } },
  styleContract: Record<string, unknown>,
  profileSummary: Record<string, unknown>,
  transferStrategy: Record<string, unknown>,
  targetFormat: string
): string {
  const parts: string[] = [];

  parts.push(`<target_format>${targetFormat}</target_format>`);
  parts.push(["<style_contract_json>", JSON.stringify(styleContract, null, 2), "</style_contract_json>"].join("\n"));
  parts.push(["<profile_summary_json>", JSON.stringify(profileSummary, null, 2), "</profile_summary_json>"].join("\n"));
  parts.push(["<voice_transfer_strategy_json>", JSON.stringify(transferStrategy, null, 2), "</voice_transfer_strategy_json>"].join("\n"));

  parts.push("<creator_style_examples>");
  if (input.excerpts.length > 0) {
    input.excerpts.forEach((excerpt, index) => {
      parts.push(`<example index="${index + 1}">\n${excerpt.slice(0, 1200)}\n</example>`);
    });
  } else {
    parts.push("No raw examples were available; rely on the style profile contract.");
  }
  parts.push("</creator_style_examples>");

  if (input.qualityRetry) {
    parts.push(`<previous_attempt_note>${input.qualityRetry.reason}</previous_attempt_note>`);
  }

  parts.push([
    "<user_task>",
    input.prompt,
    "</user_task>",
    "<final_instruction>",
    "Write the final draft now in the selected creator voice. Use the examples as the voice anchor, the transfer strategy as the shape, and the user task as the factual source. Return only <draft>...</draft>.",
    "</final_instruction>"
  ].join("\n"));

  return parts.join("\n\n");
}

export function platformTuningPrompt(draft: string, platforms: string[]): ChatMessage[] {
  const requested = platforms.length > 0 ? platforms : ["x"];
  return [
    {
      role: "system",
      content: [
        "You are the Distribution Manager agent for a style marketplace.",
        "Transform one approved draft into the single requested platform output while preserving the original meaning, voice fingerprint, and factual boundaries.",
        "Do not add new facts, stats, claims, names, hashtags, or links that are not supported by the draft.",
        "Do not add 0G/iNFT/agent/workflow/platform-demo language unless it is already in the draft.",
        "Do not add public-person claims, dollar amounts, or causal explanations that are not already in the draft.",
        "Keep the creator's voice intact: preserve rhythm, specificity, and rhetorical shape while adapting length and platform conventions.",
        "Return one JSON object only. No markdown, no code fences, no commentary.",
        "",
        "Platform rules:",
        "For x: return exactly one tweet, stay at or under 260 characters to leave safety margin, make the first clause strong, preserve one clear idea, and use hashtags/emoji only if they are already supported by the voice.",
        "For thread: return a tweet thread as one string with 3 to 5 tweets separated by blank lines. Do not include 1/N numbering; each tweet should carry one idea and aim for 160 to 220 characters when the draft has enough substance.",
        "For instagram: write a caption-style variant, 1 to 3 short paragraphs, concrete rather than generic, and include hashtags only if the draft or voice supports hashtag use.",
        "For blog: write a markdown article with a title, section headings, coherent flow, and no unsupported facts.",
        "For github_readme: write markdown README content with practical sections. Do not invent install commands, API references, repo names, badges, or environment variables.",
        "For unknown platforms: keep the same voice, make it concise, and use the exact requested key.",
        "",
        "Output validation rules:",
        "The response must parse as JSON.",
        "The object must contain exactly the requested platform keys.",
        "Every value must be a string.",
        "Every value must be final publishable content, not advice or writing instructions.",
        "Do not include extra keys such as notes, rationale, or warnings.",
        "If a constraint conflicts with the draft, preserve factual accuracy first and platform polish second."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Target platforms: ${JSON.stringify(requested)}`,
        "Draft to adapt:",
        draft,
        `Required JSON keys: ${JSON.stringify(requested)}`,
        "Return exactly the requested keys with string values."
      ].join("\n\n")
    }
  ];
}

function buildGenerationStyleContract(profile: unknown, targetFormat: string): Record<string, unknown> {
  const root = recordValue(profile);
  const guide = recordValue(root.detailed_style_guide);
  const sourceProfile = recordValue(root.source_profile);
  const voiceFingerprint = recordValue(root.voice_fingerprint);
  const guideRecipe = recordValue(guide.generation_recipe);
  const sourceGuidelines = recordValue(sourceProfile.generation_guidelines_by_format);
  const writingPatterns = recordValue(guide.writing_patterns);

  return {
    target_format: targetFormat,
    primary_source_type: stringValue(sourceProfile.primary_source_type, stringValue(guide.source_type, stringValue(root.sourceKind, "unknown"))),
    voice_essence: stringValue(root.voice_essence, stringValue(voiceFingerprint.fingerprint_text, "")),
    prompt_ready_style_brief: stringValue(guide.prompt_ready_style_brief, stringValue(voiceFingerprint.fingerprint_text, "")),
    writing_patterns: {
      length_and_density: stringValue(writingPatterns.length_and_density, stringValue(recordValue(root.sentence_rhythm).average_sentence_length, "")),
      hooks_or_openings: stringArray(writingPatterns.hooks_or_openings).concat(stringArray(recordValue(root.structural_patterns).openings).filter((s) => s.length < 80)).slice(0, 8),
      structure: stringValue(writingPatterns.structure, stringValue(recordValue(root.structural_patterns).argument_shape, "")),
      line_breaks_or_sectioning: stringValue(writingPatterns.line_breaks_or_sectioning, stringValue(recordValue(root.structural_patterns).paragraphing, "")),
      vocabulary_signals: stringArray(writingPatterns.vocabulary_signals).concat(stringArray(recordValue(root.vocabulary).distinctive_words)).slice(0, 16),
      punctuation_and_casing: stringValue(writingPatterns.punctuation_and_casing, ""),
      emoji_hashtag_link_cta_usage: stringValue(writingPatterns.emoji_hashtag_link_cta_usage, ""),
      argument_shape: stringValue(writingPatterns.argument_shape, stringValue(recordValue(root.structural_patterns).argument_shape, ""))
    },
    voice_rules: stringArray(guide.voice_rules).concat(stringArray(root.do_rules)).concat(stringArray(root.doRules)).slice(0, 18),
    avoid_rules: stringArray(guide.avoid_rules).concat(stringArray(root.dont_rules)).concat(stringArray(root.dontRules)).slice(0, 16),
    target_format_recipe: recipeForTarget(targetFormat, guideRecipe, sourceGuidelines),
    example_derived_mechanics: exampleMechanics(guide.actual_examples),
    source_analysis_focus: stringValue(sourceProfile.analysis_focus, stringValue(guide.source_summary, "")),
    confidence: root.confidence ?? guide.confidence
  };
}

function buildVoiceTransferStrategy(
  prompt: string,
  targetFormat: string,
  excerpts: string[],
  styleContract: Record<string, unknown>,
  profileSummary: Record<string, unknown>
): Record<string, unknown> {
  const writingPatterns = recordValue(styleContract.writing_patterns);
  const profileStructure = recordValue(profileSummary.structural_patterns);
  const profileVocabulary = recordValue(profileSummary.vocabulary);
  const exampleMechanicSummary = recordValue(styleContract.example_derived_mechanics);
  const exampleMechanicsRecord = recordValue(exampleMechanicSummary.mechanics);
  const sourceType = stringValue(styleContract.primary_source_type, stringValue(recordValue(profileSummary.source_profile).primary_source_type, "unknown"));

  return {
    target_format: targetFormat,
    source_type: sourceType,
    user_task_terms: contentWords(prompt).slice(0, 16),
    evidence_derived_shape: {
      opening_candidates: stringArray(writingPatterns.hooks_or_openings)
        .concat(stringArray(profileStructure.openings))
        .concat(excerptOpenings(excerpts))
        .slice(0, 10),
      closing_candidates: stringArray(profileStructure.closings).concat(excerptClosings(excerpts)).slice(0, 8),
      paragraphing: stringValue(profileStructure.paragraphing, stringValue(writingPatterns.line_breaks_or_sectioning, "")),
      structure: stringValue(writingPatterns.structure, stringValue(profileStructure.argument_shape, "")),
      argument_shape: stringValue(writingPatterns.argument_shape, stringValue(profileStructure.argument_shape, "")),
      line_breaks_or_sectioning: stringValue(writingPatterns.line_breaks_or_sectioning, ""),
      example_line_shape: summarizeLineShape(excerpts)
    },
    evidence_derived_register: {
      voice_essence: stringValue(profileSummary.voice_essence, stringValue(styleContract.voice_essence, "")),
      vocabulary_signals: stringArray(writingPatterns.vocabulary_signals)
        .concat(stringArray(profileVocabulary.distinctive_words))
        .slice(0, 18),
      favorite_phrases: stringArray(profileVocabulary.favorite_phrases).slice(0, 8),
      register_notes: stringValue(profileVocabulary.register_notes, ""),
      punctuation_and_casing: writingPatterns.punctuation_and_casing,
      emoji_hashtag_link_cta_usage: writingPatterns.emoji_hashtag_link_cta_usage
    },
    evidence_derived_mechanics: {
      target_format_recipe: stringArray(styleContract.target_format_recipe),
      observed_example_patterns: stringArray(exampleMechanicSummary.observed_patterns),
      metrics: exampleMechanicsRecord
    },
    avoid_rules_from_profile: stringArray(styleContract.avoid_rules).concat(stringArray(profileSummary.dont_rules)).slice(0, 16),
    adaptation_rules: [
      "Choose the closest observed structure from evidence_derived_shape.",
      "Map the user's facts into that observed structure without copying source-only facts.",
      "Use evidence_derived_register for word choice, density, punctuation, and platform habits.",
      "If evidence is weak or conflicting, prefer the explicit style profile over generic format conventions."
    ]
  };
}

function excerptOpenings(excerpts: string[]): string[] {
  return excerpts.map((excerpt) => firstMeaningfulLine(excerpt)).filter(Boolean).slice(0, 6);
}

function excerptClosings(excerpts: string[]): string[] {
  return excerpts.map((excerpt) => lastMeaningfulLine(excerpt)).filter(Boolean).slice(0, 6);
}

function firstMeaningfulLine(value: string): string {
  return value.split(/\n+/).map((line) => line.trim()).find(Boolean)?.slice(0, 180) ?? "";
}

function lastMeaningfulLine(value: string): string {
  const lines = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 180);
}

function summarizeLineShape(excerpts: string[]): Record<string, unknown> {
  const joined = excerpts.join("\n");
  const lines = joined.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  const hashtagCount = countMatches(joined, /#[\p{L}\p{N}_]+/gu);
  const emojiCount = countMatches(joined, /[\u{1F300}-\u{1FAFF}]/gu);
  return {
    excerpt_count: excerpts.length,
    non_empty_line_count: lines.length,
    bullet_line_count: bulletLines,
    has_bullets: bulletLines > 0,
    has_line_breaks: lines.length > excerpts.length,
    hashtag_count: hashtagCount,
    emoji_count: emojiCount,
    average_line_characters: lines.length > 0
      ? Math.round(lines.reduce((total, line) => total + line.length, 0) / lines.length)
      : 0
  };
}

function contentWords(value: string): string[] {
  const stop = new Set(["about", "with", "from", "into", "that", "this", "your", "have", "will", "what", "when", "where", "which", "write"]);
  return value
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{2,}/g)
    ?.filter((word) => !stop.has(word)) ?? [];
}

function buildSanitizedProfileSummary(profile: unknown): Record<string, unknown> {
  const root = recordValue(profile);
  const sourceProfile = recordValue(root.source_profile);
  const voiceFingerprint = recordValue(root.voice_fingerprint);
  const vocabulary = recordValue(root.vocabulary);
  const rhythm = recordValue(root.sentence_rhythm);
  const structure = recordValue(root.structural_patterns);
  return {
    tone: root.tone,
    voice_essence: stringValue(root.voice_essence, stringValue(voiceFingerprint.fingerprint_text, "")),
    vocabulary: {
      distinctive_words: stringArray(vocabulary.distinctive_words).slice(0, 12),
      favorite_phrases: stringArray(vocabulary.favorite_phrases).slice(0, 8),
      register_notes: stringValue(vocabulary.register_notes, ""),
      avoided_patterns: stringArray(vocabulary.avoided_patterns).slice(0, 8)
    },
    sentence_rhythm: {
      average_sentence_length: rhythm.average_sentence_length,
      variance: rhythm.variance,
      cadence_notes: rhythm.cadence_notes,
      compression_level: rhythm.compression_level,
      punctuation_habits: stringArray(rhythm.punctuation_habits).slice(0, 8)
    },
    structural_patterns: {
      openings: stringArray(structure.openings).filter((s) => s.length < 80).slice(0, 4),
      closings: stringArray(structure.closings).filter((s) => s.length < 80).slice(0, 4),
      paragraphing: structure.paragraphing,
      transition_style: structure.transition_style,
      argument_shape: structure.argument_shape
    },
    rhetorical_moves: stringArray(root.rhetorical_moves).slice(0, 12),
    do_rules: stringArray(root.do_rules).concat(stringArray(root.doRules)).slice(0, 14),
    dont_rules: stringArray(root.dont_rules).concat(stringArray(root.dontRules)).slice(0, 12),
    source_profile: {
      primary_source_type: sourceProfile.primary_source_type,
      analysis_focus: sourceProfile.analysis_focus,
      generation_guidelines_by_format: sourceProfile.generation_guidelines_by_format
    }
  };
}

function excerptMechanics(excerpts: string[]): Record<string, unknown> {
  const joined = excerpts.join("\n\n");
  const normalized = joined.replace(/\s+/g, " ").trim();
  const sentences = normalized.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  const lineCount = joined.split(/\n+/).filter((line) => line.trim()).length;
  const bulletCount = joined.split(/\n+/).filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  const avgSentenceChars = sentences.length > 0
    ? Math.round(sentences.reduce((total, sentence) => total + sentence.length, 0) / sentences.length)
    : 0;
  return {
    analyzed_excerpt_count: excerpts.length,
    average_sentence_characters: avgSentenceChars,
    has_line_breaks: lineCount > excerpts.length,
    line_break_density: lineCount,
    bullet_style_visible: bulletCount > 0,
    punctuation_profile: {
      question_marks: countMatches(joined, /\?/g),
      exclamation_marks: countMatches(joined, /!/g),
      colons: countMatches(joined, /:/g),
      semicolons: countMatches(joined, /;/g),
      em_dashes: countMatches(joined, /—/g)
    }
  };
}

function exampleMechanics(value: unknown): Record<string, unknown> {
  const examples = exampleRecords(value);
  return {
    example_count: examples.length,
    observed_patterns: examples
      .flatMap((example) => stringArray(example.observed_patterns))
      .slice(0, 16),
    mechanics: excerptMechanics(examples.map((example) => stringValue(example.text, "")))
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function recipeForTarget(targetFormat: string, guideRecipe: Record<string, unknown>, sourceGuidelines: Record<string, unknown>): string[] {
  const recipeKey = targetFormat === "x" ? "tweet" : targetFormat === "thread" ? "thread" : targetFormat === "github_readme" ? "readme" : targetFormat;
  const sourceKey = targetFormat === "x" ? "tweet" : targetFormat === "thread" ? "thread" : targetFormat === "github_readme" ? "readme" : targetFormat;
  return stringArray(guideRecipe[recipeKey])
    .concat(stringArray(sourceGuidelines[sourceKey]))
    .slice(0, 10);
}

function exampleRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item === "string") {
      records.push({ text: item.slice(0, 500), observed_patterns: [] });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = stringValue(record.text, stringValue(record.example, ""));
    if (!text) {
      continue;
    }
    records.push({
        label: stringValue(record.label, undefined),
        source_label: stringValue(record.source_label, undefined),
        text: text.slice(0, 500),
        observed_patterns: stringArray(record.observed_patterns).slice(0, 6)
    });
  }
  return records;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

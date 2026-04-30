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
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the Content Creator agent in a creator-owned voice marketplace on 0G.",
        "Your job is to write a fresh draft that matches the supplied style profile while preserving factual honesty and creator safety.",
        "",
        "Voice matching means matching:",
        "- tone and emotional stance",
        "- sentence rhythm and paragraph shape",
        "- specificity level and preferred nouns",
        "- rhetorical moves such as contrast, caveat, concrete example, escalation, or reframing",
        "- opening and closing style",
        "",
        "Content-source boundary:",
        "- The user prompt is the only source of topic/content for the draft.",
        "- The style profile and few-shot examples are style references only. They are not evidence, not facts, and not reusable subject matter.",
        "- Do not mention the examples' domain, product, architecture, wallet mechanics, event logs, 0G, iNFTs, profile hashes, settlement, encrypted samples, or agent workflows unless the user prompt itself asks for those things.",
        "- If a word appears in the examples but not in the user prompt, treat it as style signal only, not content to include.",
        "",
        "Voice matching does not mean copying source wording. The examples are style-only references.",
        "Do not reuse their topic, product nouns, architecture terms, claims, exact sentences, or signature phrases unless the user explicitly asks for that exact subject matter.",
        "Never copy a full example sentence. Never stitch together fragments from examples. Transform cadence and reasoning style, not wording.",
        "",
        "Factuality rules:",
        "- Never invent facts, dates, prices, metrics, quotes, named customers, partnerships, fundraises, legal claims, or private details.",
        "- If the user gives a factual topic with missing details, write in a careful high-level way and avoid unsupported precision.",
        "- If the requested topic is a real public person or company, avoid defamatory claims and avoid presenting uncertain claims as fact.",
        "- If the user asks for a result that requires live facts, write only from the supplied prompt unless external facts are included.",
        "- For public business/news topics, do not add dollar amounts, timelines, motives, governance outcomes, private-account claims, or legal interpretations unless the user supplied them.",
        "",
        "Silent preflight before final output:",
        "1. Does every concrete claim come from the user prompt or from broadly safe, high-level public context?",
        "2. Did any noun from the examples leak into the draft as topic content?",
        "3. Would the draft still make sense if the examples were never shown?",
        "If any answer is no, rewrite before output.",
        "",
        "Style transfer rules:",
        "- Use the profile's do_rules and dont_rules if present.",
        "- Use detailed_style_guide first when present, especially prompt_ready_style_brief, writing_patterns, voice_rules, avoid_rules, actual_examples, and generation_recipe.",
        "- Use source_profile when present. For X/tweets, follow twitter_profile and generation_guidelines_by_format.tweet/thread. For README/docs requests, follow readme_profile and generation_guidelines_by_format.readme. For blog/article requests, follow article_profile and generation_guidelines_by_format.article.",
        "- Match the source-specific format mechanics: post length, line breaks, emoji/hashtag/CTA habits for tweets; heading hierarchy and code/example flow for READMEs; thesis, sections, evidence, and conclusion shape for articles.",
        "- Keep the draft compact unless the user asks for long-form.",
        "- Prefer concrete nouns and clear causality over hype.",
        "- Do not explain your reasoning. Do not add preamble. Do not wrap the draft in quotation marks.",
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
        "Forbidden sample bleed unless explicitly present in the user topic: agent demo, workflow trail, style profile, profile hash, encrypted samples, 0G, iNFT, wallet, transaction, settlement, royalty, credit spend, event log.",
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
        "Transform one approved draft into platform-specific variants while preserving the original meaning, voice fingerprint, and factual boundaries.",
        "Do not add new facts, stats, claims, names, hashtags, or links that are not supported by the draft.",
        "Do not add 0G/iNFT/agent/workflow/platform-demo language unless it is already in the draft.",
        "Do not add public-person claims, dollar amounts, or causal explanations that are not already in the draft.",
        "Keep the creator's voice intact: preserve rhythm, specificity, and rhetorical shape while adapting length and platform conventions.",
        "Return one JSON object only. No markdown, no code fences, no commentary.",
        "",
        "Platform rules:",
        "For x: stay at or under 260 characters to leave safety margin, make the first clause strong, preserve one clear idea, and use at most one hashtag only if it adds value.",
        "For linkedin: use a polished professional tone, 900 characters or fewer, short paragraphs, no fake metrics, no overclaiming, and a clear final sentence.",
        "For instagram: write a caption-style variant, 1 to 3 short paragraphs, concrete rather than generic, with up to 8 relevant hashtags at the end.",
        "For unknown platforms: keep the same voice, make it concise, and use the exact requested key.",
        "",
        "Output validation rules:",
        "The response must parse as JSON.",
        "The object must contain exactly the requested platform keys.",
        "Every value must be a string.",
        "Do not include extra keys such as notes, rationale, or warnings.",
        "If a constraint conflicts with the draft, preserve factual accuracy first and platform polish second."
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

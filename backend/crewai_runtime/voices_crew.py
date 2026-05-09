#!/usr/bin/env python3
"""CrewAI generation crew for Voices.

The TypeScript backend owns 0G reads/writes and starts this runner with a
runtime evidence packet. This runner owns the chatbot generation swarm:
Voice Context Agent -> Style Writer Agent -> Voice Critic + Memory Agent.
It emits JSONL so the Node backend can forward live SSE activity.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import builtins
from typing import Any, Dict, Iterable, List, Optional, Tuple

os.environ.setdefault("CI", "1")
os.environ.setdefault("NO_COLOR", "1")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_DISABLE_TRACING", "true")
builtins.input = lambda prompt="": "n"


AgentPayload = Dict[str, Any]


AGENTS = {
    "voice_context": {
        "label": "Voice Context Agent",
        "tool": "crewai.voice_context",
    },
    "style_writer": {
        "label": "Style Writer Agent",
        "tool": "crewai.style_writer",
    },
    "voice_critic_memory": {
        "label": "Voice Critic + Memory Agent",
        "tool": "crewai.voice_critic_memory",
    },
}
EMIT_LOCK = threading.Lock()


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    try:
        result = run(payload)
        emit({"type": "result", **result})
        return 0
    except Exception as exc:  # pragma: no cover - surfaced to Node runner
        emit_activity(
            "voice_critic_memory",
            "failed",
            f"CrewAI generation failed: {exc}",
            {"trace": traceback.format_exc(limit=6)},
        )
        emit({"type": "error", "message": str(exc)})
        return 1


def run(payload: AgentPayload) -> AgentPayload:
    mode = os.environ.get("CREWAI_RUNTIME_MODE", "auto").strip().lower()
    strict = mode in {"crewai", "strict"} or os.environ.get("CREWAI_STRICT", "").lower() in {"1", "true", "yes"}
    if mode == "mock":
        return run_bridge_harness(payload, runtime="mock")
    if mode in {"bridge", "compat"}:
        return run_bridge_harness(payload, runtime="bridge")

    try:
        import_crewai()
    except Exception:
        if strict:
            raise
        return run_bridge_harness(payload, runtime="bridge_no_crewai")

    return run_crewai(payload)


def import_crewai():
    from crewai import Agent, BaseLLM, Crew, Process, Task  # noqa: F401

    return Agent, BaseLLM, Crew, Process, Task


def run_crewai(payload: AgentPayload) -> AgentPayload:
    Agent, BaseLLM, Crew, Process, Task = import_crewai()
    llm = build_bridge_llm(BaseLLM)
    evidence_packet = build_voice_packet(payload)

    emit_activity(
        "voice_context",
        "started",
        "Reading StyleRegistry, AgentBrain manifest, profile KV, sample excerpts, and memory logs from 0G evidence.",
        source_summary(payload),
    )

    context_agent = Agent(
        role="Voice Context Agent",
        goal="Build a runtime voice packet from only the stored evidence supplied by the backend.",
        backstory=(
            "You turn 0G StyleRegistry metadata, AgentBrain manifest references, KV profile fields, "
            "sample excerpts, and memory logs into an execution-ready style packet. "
            "You use creator-specific phrasing only when it appears in stored evidence."
        ),
        llm=llm,
        verbose=False,
        allow_delegation=False,
    )
    writer_agent = Agent(
        role="Style Writer Agent",
        goal="Generate the user's requested content in the selected creator style using 0G Compute.",
        backstory=(
            "You are a specialist style-transfer writer. You preserve user facts, follow the runtime "
            "voice packet, and prioritize publishable content over generic summaries."
        ),
        llm=llm,
        verbose=False,
        allow_delegation=False,
    )
    critic_agent = Agent(
        role="Voice Critic + Memory Agent",
        goal="Evaluate style match, request one focused revision when needed, and return memory updates.",
        backstory=(
            "You compare drafts against the profile, excerpts, and memory logs. You write critique and "
            "learned preferences for 0G Log/KV without fixed creator phrases from code."
        ),
        llm=llm,
        verbose=False,
        allow_delegation=False,
    )

    context_task = Task(
        description=(
            "Build the runtime voice packet from this backend-supplied 0G evidence. "
            "Use only fields that are present. Keep examples as evidence, not text to copy. "
            "Return JSON only.\n\n"
            f"Evidence read from 0G/storage/chain:\n{json.dumps(evidence_packet, ensure_ascii=True)}"
        ),
        expected_output=(
            "A JSON object with voice_packet, evidence_sources, voice_rules, avoid_rules, "
            "format_guidance, excerpt_mechanics, and memory_signals."
        ),
        agent=context_agent,
    )
    writer_task = Task(
        description=writer_task_description(payload),
        expected_output="Final content wrapped in <draft>...</draft> tags.",
        agent=writer_agent,
        context=[context_task],
    )
    critic_task = Task(
        description=critic_task_description(payload),
        expected_output=(
            "A JSON object with draft, style_match, needs_revision, revision_guidance, critique, "
            "feedback, and learned_preferences."
        ),
        agent=critic_agent,
        context=[context_task, writer_task],
    )

    crew = Crew(
        agents=[context_agent, writer_agent, critic_agent],
        tasks=[context_task, writer_task, critic_task],
        process=Process.sequential,
        verbose=False,
        cache=False,
    )

    result = crew.kickoff(inputs={})
    outputs = task_outputs(result)
    context_output = outputs[0] if len(outputs) > 0 else ""
    writer_output = outputs[1] if len(outputs) > 1 else raw_text(result)
    critic_output = outputs[2] if len(outputs) > 2 else raw_text(result)
    emitted_voice_packet = parse_json_object(context_output) or evidence_packet
    emit_activity(
        "voice_context",
        "completed",
        "Runtime voice packet prepared from stored evidence.",
        {**source_summary(payload), "output": {"voicePacket": emitted_voice_packet}},
    )
    draft = extract_draft(writer_output) or extract_draft(critic_output) or clean_text(writer_output)
    emit_activity(
        "style_writer",
        "completed",
        "Draft generated from the runtime voice packet.",
        {"draftPreview": draft[:220], "output": {"draft": draft}},
    )

    emit_activity("voice_critic_memory", "started", "Comparing draft against profile, excerpts, and memory evidence.", {})
    critique = apply_revision_gate(parse_json_object(critic_output) or heuristic_critique(payload, draft, evidence_packet), draft)
    final_draft = clean_text(str(critique.get("draft") or draft))
    revision_count = 0

    if truthy(critique.get("needs_revision")) and max_revisions() > 0:
        revision_count = 1
        guidance = str(critique.get("revision_guidance") or critique.get("critique") or "")
        emit_activity(
            "voice_critic_memory",
            "completed",
            "Style match looked weak; requesting one targeted revision from Style Writer Agent.",
            {
                "styleMatch": critique.get("style_match"),
                "needsRevision": True,
                "revisionGuidance": guidance[:320],
                "minStyleScore": min_style_score(),
            },
        )
        emit_activity("style_writer", "started", "Revising the draft using critic guidance and the same runtime voice packet.", {})
        revised = bridge_chat(
            writer_revision_messages(payload, evidence_packet, final_draft, guidance),
            {**compute_options(payload), "purpose": "style_writer_revision"},
        )
        final_draft = extract_draft(revised["content"]) or clean_text(revised["content"]) or final_draft
        emit_activity(
            "style_writer",
            "completed",
            "Revision generated after critic feedback.",
            {"draftPreview": final_draft[:220], "output": {"draft": final_draft}},
        )
        emit_activity("voice_critic_memory", "started", "Re-checking the revised draft against stored voice evidence.", {})
        revised_critic = bridge_chat(
            critic_messages(payload, evidence_packet, final_draft),
            {**compute_options(payload), "purpose": "voice_critic_memory"},
        )
        critique = apply_revision_gate(
            parse_json_object(revised_critic["content"]) or heuristic_critique(payload, final_draft, evidence_packet),
            final_draft,
            allow_revision=False,
        )
        critique = close_revision_loop(critique, revision_count)
        final_draft = clean_text(str(critique.get("draft") or final_draft))

    memory_patch = build_memory_patch(payload, final_draft, critique)
    memory_patch["runtime"] = "crewai"
    emit_activity(
        "voice_critic_memory",
        "completed",
        "Critique and learned preferences are ready for 0G Log/KV.",
        {
            "styleMatch": critique.get("style_match"),
            "needsRevision": bool(critique.get("needs_revision")),
            "learnedPreferenceCount": len(memory_patch.get("learned_preferences", [])),
            "revisionCount": revision_count,
            "output": {
                "draft": final_draft,
                "critique": critique,
                "memoryPatch": memory_patch,
            },
        },
    )
    return {
        "draft": final_draft,
        "critique": critique,
        "memoryPatch": memory_patch,
        "runtime": "crewai",
        "revisionCount": revision_count,
        "voicePacket": evidence_packet,
    }


def run_bridge_harness(payload: AgentPayload, runtime: str) -> AgentPayload:
    evidence_packet = build_voice_packet(payload)
    emit_activity(
        "voice_context",
        "started",
        "Reading StyleRegistry, AgentBrain manifest, profile KV, sample excerpts, and memory logs from 0G evidence.",
        source_summary(payload),
    )
    emit_activity(
        "voice_context",
        "completed",
        "Runtime voice packet prepared from stored evidence.",
        {**source_summary(payload), "output": {"voicePacket": evidence_packet}},
    )

    if runtime == "mock":
        draft = mock_draft(payload, evidence_packet)
    else:
        emit_activity("style_writer", "started", "Generating the first voice-matched draft through 0G Compute.", {"platforms": platforms(payload)})
        writer = bridge_chat(writer_messages(payload, evidence_packet), {**compute_options(payload), "purpose": "style_writer_draft"})
        draft = extract_draft(writer["content"]) or clean_text(writer["content"])
        emit_activity(
            "style_writer",
            "completed",
            "Draft generated from the runtime voice packet.",
            {"draftPreview": draft[:220], "output": {"draft": draft}},
        )

    emit_activity("voice_critic_memory", "started", "Comparing draft against profile, excerpts, and memory evidence.", {})
    if runtime == "mock":
        critique = heuristic_critique(payload, draft, evidence_packet)
    else:
        critic = bridge_chat(critic_messages(payload, evidence_packet, draft), {**compute_options(payload), "purpose": "voice_critic_memory"})
        critique = parse_json_object(critic["content"]) or heuristic_critique(payload, draft, evidence_packet)
    critique = apply_revision_gate(critique, draft)

    revision_count = 0
    final_draft = clean_text(str(critique.get("draft") or draft))
    if runtime != "mock" and truthy(critique.get("needs_revision")) and max_revisions() > 0:
        revision_count = 1
        guidance = str(critique.get("revision_guidance") or critique.get("critique") or "")
        emit_activity(
            "voice_critic_memory",
            "completed",
            "Style match looked weak; requesting one targeted revision from Style Writer Agent.",
            {
                "styleMatch": critique.get("style_match"),
                "needsRevision": True,
                "revisionGuidance": guidance[:320],
                "minStyleScore": min_style_score(),
            },
        )
        emit_activity("style_writer", "started", "Revising the draft using critic guidance and the same runtime voice packet.", {})
        revised = bridge_chat(
            writer_revision_messages(payload, evidence_packet, final_draft, guidance),
            {**compute_options(payload), "purpose": "style_writer_revision"},
        )
        final_draft = extract_draft(revised["content"]) or clean_text(revised["content"]) or final_draft
        emit_activity(
            "style_writer",
            "completed",
            "Revision generated after critic feedback.",
            {"draftPreview": final_draft[:220], "output": {"draft": final_draft}},
        )
        emit_activity("voice_critic_memory", "started", "Re-checking the revised draft against stored voice evidence.", {})
        critic = bridge_chat(critic_messages(payload, evidence_packet, final_draft), {**compute_options(payload), "purpose": "voice_critic_memory"})
        critique = apply_revision_gate(
            parse_json_object(critic["content"]) or heuristic_critique(payload, final_draft, evidence_packet),
            final_draft,
            allow_revision=False,
        )
        critique = close_revision_loop(critique, revision_count)
        final_draft = clean_text(str(critique.get("draft") or final_draft))

    memory_patch = build_memory_patch(payload, final_draft, critique)
    memory_patch["runtime"] = runtime
    emit_activity(
        "voice_critic_memory",
        "completed",
        "Critique and learned preferences are ready for 0G Log/KV.",
        {
            "styleMatch": critique.get("style_match"),
            "needsRevision": bool(critique.get("needs_revision")),
            "learnedPreferenceCount": len(memory_patch.get("learned_preferences", [])),
            "revisionCount": revision_count,
            "output": {
                "draft": final_draft,
                "critique": critique,
                "memoryPatch": memory_patch,
            },
        },
    )
    return {
        "draft": final_draft,
        "critique": critique,
        "memoryPatch": memory_patch,
        "runtime": runtime,
        "revisionCount": revision_count,
        "voicePacket": evidence_packet,
    }


def build_bridge_llm(BaseLLM):
    class VoicesBridgeLLM(BaseLLM):
        def __init__(self):
            super().__init__(
                model=os.environ.get("VOICES_CREWAI_MODEL") or "0g-compute",
                temperature=float(os.environ.get("VOICES_CREWAI_TEMPERATURE") or "0.7"),
            )

        def call(self, messages, tools=None, callbacks=None, available_functions=None, **kwargs):
            normalized = normalize_messages(messages)
            response = bridge_chat(normalized, {**compute_options({}), "purpose": infer_compute_purpose(normalized)})
            return response["content"]

        def supports_function_calling(self) -> bool:
            return False

        def get_context_window_size(self) -> int:
            return int(os.environ.get("VOICES_CREWAI_CONTEXT_WINDOW") or "32768")

    return VoicesBridgeLLM()


def bridge_chat(messages: List[AgentPayload], options: AgentPayload) -> AgentPayload:
    url = os.environ.get("VOICES_CREWAI_COMPUTE_BRIDGE_URL")
    token = os.environ.get("VOICES_CREWAI_COMPUTE_BRIDGE_TOKEN")
    if not url or not token:
        return {"content": mock_draft({}, {})}

    body = json.dumps({"messages": normalize_messages(messages), "options": options}, ensure_ascii=True).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    heartbeat = start_compute_heartbeat(options)
    try:
        with urllib.request.urlopen(request, timeout=float(os.environ.get("VOICES_CREWAI_BRIDGE_TIMEOUT_SECONDS") or "180")) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"0G Compute bridge failed: {exc.code} {detail}") from exc
    finally:
        stop_compute_heartbeat(heartbeat)


def infer_compute_purpose(messages: List[AgentPayload]) -> str:
    text = "\n".join(str(message.get("content") or "") for message in messages)
    if "Voice Critic + Memory Agent" in text or "<draft_to_review>" in text:
        return "voice_critic_memory"
    if "Style Writer Agent" in text or "<user_task>" in text:
        return "style_writer_draft"
    if "Voice Context Agent" in text or "runtime voice packet" in text.lower():
        return "voice_context"
    return "crewai_llm_call"


def start_compute_heartbeat(options: AgentPayload) -> Optional[Tuple[threading.Event, threading.Thread]]:
    if os.environ.get("VOICES_CREWAI_PROGRESS_LOGS", "true").strip().lower() in {"0", "false", "off", "no"}:
        return None
    purpose = str(options.get("purpose") or "crewai_llm_call")
    agent = progress_agent_for_purpose(purpose)
    if not agent:
        return None
    try:
        interval = max(5.0, float(os.environ.get("VOICES_CREWAI_PROGRESS_INTERVAL_SECONDS") or "10"))
    except ValueError:
        interval = 10.0
    first_tick = min(6.0, interval)
    started_at = time.time()
    stop = threading.Event()

    def loop() -> None:
        tick = 1
        if stop.wait(first_tick):
            return
        while not stop.is_set():
            elapsed = int(time.time() - started_at)
            emit_activity(
                agent,
                "progress",
                progress_message_for_purpose(purpose, elapsed),
                {
                    "purpose": purpose,
                    "elapsedSeconds": elapsed,
                    "progressTick": tick,
                    "streaming": True,
                },
            )
            tick += 1
            if stop.wait(interval):
                return

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return stop, thread


def stop_compute_heartbeat(heartbeat: Optional[Tuple[threading.Event, threading.Thread]]) -> None:
    if not heartbeat:
        return
    stop, thread = heartbeat
    stop.set()
    thread.join(timeout=0.25)


def progress_agent_for_purpose(purpose: str) -> Optional[str]:
    if purpose in {"style_writer_draft", "style_writer_revision", "crewai_llm_call"}:
        return "style_writer"
    if purpose == "voice_critic_memory":
        return "voice_critic_memory"
    if purpose == "voice_context":
        return "voice_context"
    return None


def progress_message_for_purpose(purpose: str, elapsed: int) -> str:
    if purpose == "voice_critic_memory":
        return f"Critic is still comparing the draft against stored voice evidence ({elapsed}s elapsed)."
    if purpose == "style_writer_revision":
        return f"Style Writer is still revising with critic guidance through 0G Compute ({elapsed}s elapsed)."
    if purpose == "voice_context":
        return f"Voice Context is still shaping the runtime voice packet from stored evidence ({elapsed}s elapsed)."
    return f"Style Writer is still waiting on 0G Compute for the voice-matched draft ({elapsed}s elapsed)."


def writer_task_description(payload: AgentPayload) -> str:
    return (
        "Use the runtime voice packet from the previous task and write the user's requested content. "
        "Focus only on style transfer and content quality. Preserve factual boundaries from the user task. "
        "Do not add creator-specific phrases that are not in evidence. Return only <draft>...</draft>.\n\n"
        f"Target platforms: {json.dumps(platforms(payload), ensure_ascii=True)}\n"
        f"Format requirements:\n{platform_format_requirements(platforms(payload))}\n"
        f"User prompt:\n{str(payload.get('prompt') or '')}"
    )


def critic_task_description(payload: AgentPayload) -> str:
    return (
        "Compare the generated draft against the runtime voice packet, profile, excerpts, and memory evidence. "
        f"If style match is weak or style_match.score is below {min_style_score():.2f}, set needs_revision true and provide concise revision_guidance. "
        "Also return learned_preferences suitable for 0G Log/KV. Return JSON only.\n\n"
        f"Original user prompt:\n{str(payload.get('prompt') or '')}"
    )


def writer_messages(payload: AgentPayload, voice_packet: AgentPayload) -> List[AgentPayload]:
    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "You are the Style Writer Agent inside the Voices CrewAI swarm.",
                    "Generate through 0G Compute by writing final content, not advice.",
                    "Use the runtime voice packet as the style source. Do not use fixed creator phrases from code.",
                    "Preserve user-supplied facts. Do not invent metrics, links, partnerships, APIs, or claims.",
                    platform_format_requirements(platforms(payload)),
                    "Output only <draft>...</draft>.",
                ]
            ),
        },
        {
            "role": "user",
            "content": "\n\n".join(
                [
                    f"<target_platforms>{json.dumps(platforms(payload), ensure_ascii=True)}</target_platforms>",
                    "<format_requirements>",
                    platform_format_requirements(platforms(payload)),
                    "</format_requirements>",
                    "<runtime_voice_packet_json>",
                    json.dumps(voice_packet, ensure_ascii=True, indent=2),
                    "</runtime_voice_packet_json>",
                    "<user_task>",
                    str(payload.get("prompt") or ""),
                    "</user_task>",
                ]
            ),
        },
    ]


def writer_revision_messages(payload: AgentPayload, voice_packet: AgentPayload, draft: str, guidance: str) -> List[AgentPayload]:
    return writer_messages(
        {
            **payload,
            "prompt": "\n\n".join(
                [
                    str(payload.get("prompt") or ""),
                    "Revise the previous draft using this critic guidance while preserving the user's facts.",
                    guidance,
                    "Previous draft:",
                    draft,
                ]
            ),
        },
        voice_packet,
    )


def critic_messages(payload: AgentPayload, voice_packet: AgentPayload, draft: str) -> List[AgentPayload]:
    return [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "You are the Voice Critic + Memory Agent inside the Voices CrewAI swarm.",
                    "Compare the draft with the runtime voice packet and stored evidence.",
                    f"If style_match.score is below {min_style_score():.2f}, needs_revision must be true.",
                    "Return JSON only. Do not add policy text or hidden reasoning.",
                    "Schema: {\"draft\":\"final draft or same draft\",\"style_match\":{\"score\":0-1,\"why\":\"...\"},\"needs_revision\":false,\"revision_guidance\":\"...\",\"critique\":\"...\",\"feedback\":\"...\",\"learned_preferences\":[\"...\"]}",
                ]
            ),
        },
        {
            "role": "user",
            "content": "\n\n".join(
                [
                    "<runtime_voice_packet_json>",
                    json.dumps(voice_packet, ensure_ascii=True, indent=2),
                    "</runtime_voice_packet_json>",
                    "<user_task>",
                    str(payload.get("prompt") or ""),
                    "</user_task>",
                    "<draft_to_review>",
                    draft,
                    "</draft_to_review>",
                ]
            ),
        },
    ]


def build_voice_packet(payload: AgentPayload) -> AgentPayload:
    profile = obj(payload.get("styleProfile"))
    guide = obj(profile.get("detailed_style_guide"))
    source_profile = obj(profile.get("source_profile"))
    vocabulary = obj(profile.get("vocabulary"))
    rhythm = obj(profile.get("sentence_rhythm"))
    structure = obj(profile.get("structural_patterns"))
    excerpts = clean_list(payload.get("excerpts"))[:8]
    memory_entries = list_values(payload.get("memoryEntries"))[-12:]
    agent_brain = obj(payload.get("agentBrain"))
    style_registry = obj(payload.get("styleRegistry"))

    example_records = list_values(guide.get("actual_examples"))
    observed_patterns = []
    example_texts = []
    for item in example_records:
        if isinstance(item, str):
            example_texts.append(item[:900])
            continue
        record = obj(item)
        text = str(record.get("text") or record.get("example") or "").strip()
        if text:
            example_texts.append(text[:900])
        observed_patterns.extend(clean_list(record.get("observed_patterns")))

    combined_examples = unique([*excerpts, *example_texts])[:8]
    mechanics = excerpt_mechanics(combined_examples)

    return {
        "style_id": payload.get("styleId"),
        "creator": style_registry.get("creator") or payload.get("creatorAddress"),
        "target_platforms": platforms(payload),
        "evidence_sources": {
            "style_registry": compact_obj(style_registry),
            "profile_kv_key": payload.get("profileKey"),
            "agent_brain_manifest": compact_obj(agent_brain),
            "sample_excerpt_count": len(excerpts),
            "memory_log_count": len(memory_entries),
        },
        "voice": {
            "tone": profile.get("tone"),
            "voice_essence": profile.get("voice_essence") or obj(profile.get("voice_fingerprint")).get("fingerprint_text"),
            "prompt_ready_style_brief": guide.get("prompt_ready_style_brief"),
            "vocabulary_signals": unique(
                clean_list(vocabulary.get("distinctive_words"))
                + clean_list(vocabulary.get("favorite_phrases"))
                + clean_list(obj(guide.get("writing_patterns")).get("vocabulary_signals"))
            )[:20],
            "rhythm": compact_obj(rhythm),
            "structure": compact_obj(structure),
        },
        "voice_rules": unique(clean_list(guide.get("voice_rules")) + clean_list(profile.get("do_rules")) + clean_list(profile.get("doRules")))[:18],
        "avoid_rules": unique(clean_list(guide.get("avoid_rules")) + clean_list(profile.get("dont_rules")) + clean_list(profile.get("dontRules")))[:18],
        "format_guidance": {
            "source_type": source_profile.get("primary_source_type") or guide.get("source_type") or profile.get("sourceKind"),
            "recipes": compact_obj(guide.get("generation_recipe")),
            "source_guidelines": compact_obj(source_profile.get("generation_guidelines_by_format")),
        },
        "examples": [{"text": text, "observed_patterns": observed_patterns[:10]} for text in combined_examples],
        "excerpt_mechanics": mechanics,
        "memory_signals": summarize_memory(memory_entries),
        "user_task_terms": content_terms(str(payload.get("prompt") or ""))[:20],
    }


def build_memory_patch(payload: AgentPayload, draft: str, critique: AgentPayload) -> AgentPayload:
    preferences = clean_list(critique.get("learned_preferences"))
    feedback = str(critique.get("feedback") or critique.get("critique") or "").strip()
    return {
        "styleId": payload.get("styleId"),
        "prompt": payload.get("prompt"),
        "draft": draft,
        "critique": critique,
        "feedback": feedback,
        "learned_preferences": preferences,
        "platforms": platforms(payload),
        "runtime": "crewai",
        "timestamp": int(time.time() * 1000),
    }


def source_summary(payload: AgentPayload) -> AgentPayload:
    memory_entries = list_values(payload.get("memoryEntries"))
    agent_brain = obj(payload.get("agentBrain"))
    return {
        "styleId": payload.get("styleId"),
        "profileKey": payload.get("profileKey"),
        "hasAgentBrain": bool(agent_brain),
        "sampleExcerptCount": len(clean_list(payload.get("excerpts"))),
        "memoryLogCount": len(memory_entries),
    }


def summarize_memory(entries: List[Any]) -> AgentPayload:
    learned = []
    feedback = []
    for entry in entries:
        value = obj(obj(entry).get("value") if isinstance(entry, dict) else entry)
        learned.extend(clean_list(value.get("learned_preferences")))
        if value.get("feedback"):
            feedback.append(str(value.get("feedback"))[:280])
        critique = obj(value.get("critique"))
        if critique.get("feedback"):
            feedback.append(str(critique.get("feedback"))[:280])
    return {
        "learned_preferences": unique(learned)[-12:],
        "recent_feedback": feedback[-8:],
    }


def heuristic_critique(payload: AgentPayload, draft: str, voice_packet: AgentPayload) -> AgentPayload:
    terms = set(content_terms(json.dumps(voice_packet, ensure_ascii=True)))
    draft_terms = set(content_terms(draft))
    overlap = len(terms.intersection(draft_terms))
    score = min(0.92, 0.45 + overlap / 30)
    needs_revision = bool(draft.strip()) and score < min_style_score() and max_revisions() > 0
    return {
        "draft": draft,
        "style_match": {
            "score": round(score, 2),
            "why": "Estimated from overlap between the draft and the runtime voice evidence.",
        },
        "needs_revision": needs_revision,
        "revision_guidance": "Use more of the observed structure, vocabulary register, and rhythm from the runtime voice packet.",
        "critique": "Draft checked against runtime evidence.",
        "feedback": "Store the observed fit signal and any revision guidance.",
        "learned_preferences": [
            "For future generations, compare the draft against stored examples before publishing.",
            "Prefer evidence-derived structure over generic platform defaults.",
        ],
    }


def apply_revision_gate(critique: AgentPayload, draft: str, allow_revision: bool = True) -> AgentPayload:
    checked = dict(critique)
    checked.setdefault("draft", draft)
    score = style_match_score(checked)
    checked["min_style_score"] = min_style_score()
    if allow_revision and max_revisions() > 0 and score is not None and score < min_style_score():
        existing = str(checked.get("revision_guidance") or "").strip()
        score_guidance = (
            f"Style match score is {round(score * 100)}%, below the {round(min_style_score() * 100)}% bar. "
            "Revise by matching the evidence-derived structure, rhythm, vocabulary register, and format mechanics more closely."
        )
        checked["needs_revision"] = True
        checked["revision_guidance"] = f"{existing} {score_guidance}".strip()
    return checked


def close_revision_loop(critique: AgentPayload, revision_count: int) -> AgentPayload:
    checked = dict(critique)
    checked["revision_count"] = revision_count
    score = style_match_score(checked)
    if revision_count >= max_revisions() and (truthy(checked.get("needs_revision")) or (score is not None and score < min_style_score())):
        checked["revision_limit_reached"] = True
        checked["needs_revision"] = False
        note = "Revision limit reached after the critic-requested pass."
        critique_text = str(checked.get("critique") or "").strip()
        checked["critique"] = f"{critique_text} {note}".strip()
    return checked


def style_match_score(critique: AgentPayload) -> Optional[float]:
    style_match = obj(critique.get("style_match"))
    value = style_match.get("score")
    if isinstance(value, (int, float)):
        score = float(value)
    elif isinstance(value, str):
        try:
            score = float(value.strip().rstrip("%"))
            if score > 1:
                score = score / 100
        except ValueError:
            return None
    else:
        return None
    if not 0 <= score <= 1:
        return None
    return score


def mock_draft(payload: AgentPayload, voice_packet: AgentPayload) -> str:
    prompt = str(payload.get("prompt") or "Write the requested content.").strip()
    essence = obj(voice_packet.get("voice")).get("voice_essence") if voice_packet else None
    prefix = f"{essence}: " if essence else ""
    return f"{prefix}{prompt}".strip()


def compute_options(payload: AgentPayload) -> AgentPayload:
    options = obj(payload.get("computeOptions"))
    return {
        "model": options.get("model") or os.environ.get("VOICES_CREWAI_MODEL") or None,
        "maxRetries": int(options.get("maxRetries") or os.environ.get("VOICES_CREWAI_MAX_RETRIES") or 1),
        "maxTokens": int(options.get("maxTokens") or os.environ.get("VOICES_CREWAI_MAX_TOKENS") or 1600),
        "temperature": float(options.get("temperature") if options.get("temperature") is not None else os.environ.get("VOICES_CREWAI_TEMPERATURE") or 0.7),
        "topP": float(options.get("topP") if options.get("topP") is not None else os.environ.get("VOICES_CREWAI_TOP_P") or 0.95),
    }


def max_revisions() -> int:
    try:
        return max(0, int(os.environ.get("CREWAI_MAX_REVISIONS") or "1"))
    except ValueError:
        return 1


def min_style_score() -> float:
    try:
        value = float(os.environ.get("CREWAI_MIN_STYLE_SCORE") or "0.72")
    except ValueError:
        value = 0.72
    return min(0.95, max(0.0, value))


def platforms(payload: AgentPayload) -> List[str]:
    values = clean_list(payload.get("platforms"))
    return values if values else ["x"]


def platform_format_requirements(values: List[str]) -> str:
    target = values[0] if values else "x"
    if target == "x":
        return "Write exactly one finished tweet. Keep it under 260 characters. Preserve one clear idea and the selected voice."
    if target == "thread":
        return "Write a tweet thread with 3 to 5 tweet blocks. Separate tweets with blank lines. Do not include 1/N numbering. Aim for 160 to 220 characters per tweet when the user's material has enough detail. Put one idea in each tweet."
    if target == "instagram":
        return "Write a concise caption in 1 to 3 short paragraphs. Use hashtags only if the voice evidence supports them."
    if target == "blog":
        return "Write markdown with a useful title and sections. Keep it tight and avoid unsupported claims."
    if target == "github_readme":
        return "Write markdown README-style content with practical sections. Do not invent commands, APIs, repo names, badges, or env vars."
    return "Keep the output concise and final-publishable."


def task_outputs(result: Any) -> List[str]:
    outputs = getattr(result, "tasks_output", None) or getattr(result, "tasks", None) or []
    values = []
    for output in outputs:
        raw = getattr(output, "raw", None)
        values.append(str(raw if raw is not None else output))
    return values


def raw_text(result: Any) -> str:
    raw = getattr(result, "raw", None)
    return str(raw if raw is not None else result)


def normalize_messages(messages: Any) -> List[AgentPayload]:
    if isinstance(messages, str):
        return [{"role": "user", "content": messages}]
    normalized = []
    for message in messages or []:
        if isinstance(message, dict):
            role = message.get("role") or "user"
            content = message.get("content") or ""
        else:
            role = getattr(message, "role", None) or getattr(message, "type", None) or "user"
            content = getattr(message, "content", "")
        if isinstance(content, list):
            content = "\n".join(str(part) for part in content)
        normalized.append({"role": str(role), "content": str(content)})
    return normalized


def extract_draft(content: str) -> str:
    match = re.search(r"<\s*draft\b[^>]*>([\s\S]*?)<\s*/\s*draft\s*>", content or "", re.IGNORECASE)
    return clean_text(match.group(1)) if match else ""


def parse_json_object(content: str) -> Optional[AgentPayload]:
    if not content:
        return None
    match = re.search(r"\{[\s\S]*\}", strip_fence(content))
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def strip_fence(value: str) -> str:
    return re.sub(r"^```(?:json|xml|text)?\s*|\s*```$", "", value.strip(), flags=re.IGNORECASE)


def clean_text(value: str) -> str:
    return strip_fence(value or "").strip().strip("\"'").replace("\r", "").strip()


def excerpt_mechanics(excerpts: List[str]) -> AgentPayload:
    joined = "\n".join(excerpts)
    lines = [line.strip() for line in joined.splitlines() if line.strip()]
    sentences = re.findall(r"[^.!?]+[.!?]+|[^.!?]+$", joined)
    bullet_count = sum(1 for line in lines if re.match(r"^\s*(?:[-*]|\d+[.)])\s+", line))
    return {
        "excerpt_count": len(excerpts),
        "line_count": len(lines),
        "has_line_breaks": len(lines) > len(excerpts),
        "bullet_line_count": bullet_count,
        "average_sentence_characters": round(sum(len(sentence.strip()) for sentence in sentences) / len(sentences)) if sentences else 0,
        "punctuation": {
            "question_marks": joined.count("?"),
            "exclamation_marks": joined.count("!"),
            "colons": joined.count(":"),
            "semicolons": joined.count(";"),
        },
    }


def content_terms(value: str) -> List[str]:
    stop = {"about", "with", "from", "into", "that", "this", "your", "have", "will", "what", "when", "where", "which", "write", "the", "and", "for"}
    return [word for word in re.findall(r"[a-z0-9][a-z0-9-]{2,}", value.lower()) if word not in stop]


def compact_obj(value: Any) -> AgentPayload:
    source = obj(value)
    result = {}
    for key, item in source.items():
        if item is None:
            continue
        if isinstance(item, (str, int, float, bool)):
            result[key] = item
        elif isinstance(item, list):
            result[key] = item[:12]
        elif isinstance(item, dict):
            result[key] = compact_obj(item)
    return result


def obj(value: Any) -> AgentPayload:
    return value if isinstance(value, dict) else {}


def list_values(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def clean_list(value: Any) -> List[str]:
    return [str(item).strip() for item in list_values(value) if str(item).strip()]


def unique(values: Iterable[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        normalized = value.strip()
        key = normalized.lower()
        if normalized and key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value > 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "weak", "revise"}
    return False


def emit_activity(agent: str, status: str, message: str, payload: AgentPayload) -> None:
    meta = AGENTS[agent]
    emit(
        {
            "type": "agent_activity",
            "agent": agent,
            "agentLabel": meta["label"],
            "tool": meta["tool"],
            "status": status,
            "message": message,
            "payload": payload,
        }
    )


def emit(record: AgentPayload) -> None:
    with EMIT_LOCK:
        sys.stdout.write(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    exit_code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(exit_code)

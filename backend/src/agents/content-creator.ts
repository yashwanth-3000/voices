import { AgentEvent } from "../events/types.js";
import { BaseAgent } from "./base-agent.js";
import { contentGenerationPrompt } from "./prompts.js";

export class ContentCreatorAgent extends BaseAgent {
  readonly name = "Content Creator";
  readonly subscribedEvents = ["generation.requested", "style.refined"] as const;

  private readonly profileCache = new Map<string, Record<string, unknown>>();
  private readonly excerptCache = new Map<string, string[]>();

  protected async handleEvent(event: AgentEvent): Promise<void> {
    if (event.type === "style.refined") {
      if (event.styleId) {
        this.profileCache.delete(event.styleId);
        this.excerptCache.delete(event.styleId);
      }
      return;
    }
    await this.generateDraft(event);
  }

  private async generateDraft(event: AgentEvent): Promise<void> {
    const requestId = stringValue(event.payload.requestId, event.id);
    const styleId = event.styleId ?? stringValue(event.payload.styleId, "");
    const consumerAddress = event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
    const prompt = stringValue(event.payload.prompt, "");

    const credits = await this.context.chain.credits(consumerAddress);
    if (credits === 0n) {
      await this.context.bus.publish({
        id: `${event.id}:credit.low`,
        type: "credit.low",
        timestamp: Date.now(),
        actor: "system",
        styleId,
        consumerAddress,
        payload: { requestId, reason: "no_credits" }
      });
      return;
    }

    const style = await this.context.chain.styleOf(styleId);
    if (!style.listed) {
      await this.fail(event, "Style is no longer listed");
      return;
    }

    const profile = await this.getProfile(styleId, style.profileURI);
    const excerpts = await this.getExcerpts(styleId, profile);
    const compute = await this.context.compute.chat(contentGenerationPrompt({ styleProfile: profile, prompt, excerpts }), {
      maxRetries: 1,
      maxTokens: 500
    });
    const draft = extractTagged(compute.content, "draft");

    await this.context.storage.logAppend(`consumer:${consumerAddress}:history`, `gen:${event.id}`, {
      styleId,
      draft,
      prompt,
      teeVerified: compute.verified,
      timestamp: Date.now()
    });

    await this.context.bus.publish({
      id: `${event.id}:generation.drafted`,
      type: "generation.drafted",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      consumerAddress,
      payload: {
        requestId,
        draft,
        prompt,
        platforms: arrayValue(event.payload.platforms, ["x", "linkedin", "instagram"]),
        teeVerified: compute.verified
      }
    });
  }

  private async getProfile(styleId: string, profileURI: string): Promise<Record<string, unknown>> {
    const cached = this.profileCache.get(styleId);
    if (cached) {
      return cached;
    }
    const key = profileURI.startsWith("0g://kv/") ? profileURI.replace("0g://kv/", "") : `style:${styleId}:profile`;
    const profile = await this.context.storage.kvGet<Record<string, unknown>>(key);
    if (!profile) {
      throw new Error(`Missing style profile for ${styleId}`);
    }
    this.profileCache.set(styleId, profile);
    return profile;
  }

  private async getExcerpts(styleId: string, profile: Record<string, unknown>): Promise<string[]> {
    const cached = this.excerptCache.get(styleId);
    if (cached) {
      return cached;
    }
    const excerpts = arrayValue(profile.sampleExcerpts, []).slice(0, 5);
    this.excerptCache.set(styleId, excerpts);
    return excerpts;
  }

  private async fail(event: AgentEvent, reason: string): Promise<void> {
    await this.context.bus.publish({
      id: `${event.id}:generation.failed`,
      type: "generation.failed",
      timestamp: Date.now(),
      actor: "system",
      styleId: event.styleId,
      consumerAddress: event.consumerAddress,
      payload: { requestId: event.payload.requestId, reason }
    });
  }
}

function extractTagged(content: string, tag: string): string {
  const cleaned = stripCodeFence(content);
  const match = cleaned.match(new RegExp(`<\\s*${tag}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, "i"));
  return stripCodeFence(match?.[1] ?? cleaned).trim();
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json|xml|text)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function arrayValue(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

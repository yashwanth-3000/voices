import { AgentEvent } from "../events/types.js";
import { BaseAgent } from "./base-agent.js";
import { platformTuningPrompt } from "./prompts.js";

export class DistributionManagerAgent extends BaseAgent {
  readonly name = "Distribution Manager";
  readonly subscribedEvents = ["generation.drafted", "credit.low"] as const;

  protected async handleEvent(event: AgentEvent): Promise<void> {
    if (event.type === "credit.low") {
      await this.handleCreditLow(event);
      return;
    }
    await this.publishVariants(event);
  }

  private async publishVariants(event: AgentEvent): Promise<void> {
    const requestId = stringValue(event.payload.requestId, event.id);
    const styleId = event.styleId ?? stringValue(event.payload.styleId, "");
    const consumerAddress = event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
    const draft = stringValue(event.payload.draft, "");
    const platforms = arrayValue(event.payload.platforms, ["x", "linkedin", "instagram"]);

    const compute = await this.context.compute.chat(platformTuningPrompt(draft, platforms), {
      maxRetries: 1,
      maxTokens: 650
    });
    const variants = parseVariants(compute.content, draft, platforms);
    await this.context.storage.logAppend(`consumer:${consumerAddress}:history`, `published:${event.id}`, {
      styleId,
      variants,
      teeVerified: compute.verified,
      timestamp: Date.now()
    });

    const spendIntent = this.context.chain.spendCreditIntent(styleId);

    await this.context.bus.publish({
      id: `${event.id}:generation.published`,
      type: "generation.published",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      consumerAddress,
      payload: {
        requestId,
        variants,
        teeVerified: compute.verified,
        settlementStatus: "awaiting_wallet_signature",
        spendIntent
      }
    });

    await this.context.bus.publish({
      id: `${event.id}:settlement.intent.created`,
      type: "settlement.intent.created",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      consumerAddress,
      payload: { requestId, spendIntent }
    });

    const settlement = await this.context.keeperhub.executeTransaction(spendIntent);

    if (settlement.status === "confirmed") {
      await this.context.bus.publish({
        id: `${event.id}:credit.deducted`,
        type: "credit.deducted",
        timestamp: Date.now(),
        actor: "system",
        styleId,
        consumerAddress,
        payload: { requestId, txHash: settlement.txHash }
      });
      await this.context.bus.publish({
        id: `${event.id}:royalty.settled`,
        type: "royalty.settled",
        timestamp: Date.now(),
        actor: "system",
        styleId,
        consumerAddress,
        payload: { requestId, txHash: settlement.txHash }
      });
    }
  }

  private async handleCreditLow(event: AgentEvent): Promise<void> {
    const consumerAddress = event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
    const settings = await this.context.storage.kvGet<{ autoTopUp?: boolean; topUpCredits?: string }>(
      `consumer:${consumerAddress}:settings`
    );
    if (!settings?.autoTopUp) {
      return;
    }

    const intent = await this.context.chain.buyCreditsIntent(BigInt(settings.topUpCredits ?? "5"));
    const result = await this.context.keeperhub.executeTransaction(intent);
    await this.context.bus.publish({
      id: `${event.id}:credit.replenished`,
      type: "credit.replenished",
      timestamp: Date.now(),
      actor: "system",
      styleId: event.styleId,
      consumerAddress,
      payload: {
        requestId: event.payload.requestId,
        status: result.status,
        workflowId: result.workflowId,
        reason: result.reason
      }
    });
  }
}

function parseVariants(content: string, draft: string, platforms: string[]): Record<string, string> {
  try {
    const parsed = JSON.parse(extractFirstJsonObject(stripCodeFence(content))) as Record<string, string>;
    return Object.fromEntries(
      platforms.map((platform) => [platform, enforcePlatformLimit(parsed[platform] ?? tuneFallback(draft, platform), platform)])
    );
  } catch {
    return Object.fromEntries(platforms.map((platform) => [platform, tuneFallback(draft, platform)]));
  }
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

function tuneFallback(draft: string, platform: string): string {
  const cleaned = draft.replace(/\s+/g, " ").trim();
  if (platform === "x") {
    return truncate(cleaned, 280);
  }
  if (platform === "instagram") {
    return `${cleaned}\n\n#0G #iNFT #AI`;
  }
  return cleaned;
}

function enforcePlatformLimit(value: string, platform: string): string {
  const cleaned = value.trim();
  if (platform === "x") {
    return truncate(cleaned, 280);
  }
  if (platform === "linkedin") {
    return truncate(cleaned, 900);
  }
  return cleaned;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const sliced = value.slice(0, Math.max(0, maxLength - 1)).trimEnd();
  const lastSpace = sliced.lastIndexOf(" ");
  const compact = lastSpace > 120 ? sliced.slice(0, lastSpace) : sliced;
  return `${compact.replace(/[.,;:!?-]+$/, "")}…`;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function arrayValue(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

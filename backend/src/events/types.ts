import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type EventType =
  | "style.uploaded"
  | "style.mint.intent.created"
  | "style.minted"
  | "style.refined"
  | "style.failed"
  | "agent.activity"
  | "generation.requested"
  | "generation.drafted"
  | "settlement.intent.created"
  | "generation.published"
  | "generation.failed"
  | "feedback.received"
  | "credit.auto_refill.intent.created"
  | "credit.auto_refill.configured"
  | "credit.purchase.intent.created"
  | "credit.purchased"
  | "credit.deducted"
  | "credit.low"
  | "credit.replenished"
  | "credit.replenish_failed"
  | "royalty.settled";

export type AgentEvent = {
  id: string;
  type: EventType;
  timestamp: number;
  actor: string;
  styleId?: string;
  consumerAddress?: string;
  payload: Record<string, unknown>;
};

export type AgentStatus = "idle" | "busy" | "error" | "stopped";

export type NewAgentEvent = Omit<AgentEvent, "id" | "timestamp"> & {
  id?: string;
  timestamp?: number;
};

export function createAgentEvent(input: NewAgentEvent): AgentEvent {
  return {
    id: input.id ?? createUlid(),
    type: input.type,
    timestamp: input.timestamp ?? Date.now(),
    actor: input.actor,
    styleId: input.styleId,
    consumerAddress: input.consumerAddress,
    payload: input.payload
  };
}

export function requestIdFromEvent(event: AgentEvent): string | undefined {
  const requestId = event.payload.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

export function createUlid(now = Date.now()): string {
  let timestamp = now;
  let encodedTime = "";
  for (let i = 0; i < 10; i += 1) {
    encodedTime = ENCODING[timestamp % 32] + encodedTime;
    timestamp = Math.floor(timestamp / 32);
  }

  const entropy = randomBytes(10);
  let encodedEntropy = "";
  for (const byte of entropy) {
    encodedEntropy += ENCODING[byte >> 3];
    encodedEntropy += ENCODING[byte & 31];
  }

  return `${encodedTime}${encodedEntropy.slice(0, 16)}`;
}

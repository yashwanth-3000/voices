import { EventBus } from "../events/event-bus.js";
import { AgentEvent, AgentStatus, EventType } from "../events/types.js";
import { AgentChain, AgentCompute, AgentStorage, KeeperHubClient } from "../infra/types.js";

export type AgentContext = {
  bus: EventBus;
  storage: AgentStorage;
  compute: AgentCompute;
  chain: AgentChain;
  keeperhub: KeeperHubClient;
};

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly subscribedEvents: readonly EventType[];

  private state: AgentStatus = "stopped";
  private unsubscribe?: () => void;
  private lastError?: string;

  constructor(protected readonly context: AgentContext) {}

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      return;
    }

    this.state = "idle";
    this.unsubscribe = this.context.bus.subscribe(this.subscribedEvents, (event) => this.onEvent(event));

    for (const event of this.context.bus.allEvents()) {
      if (this.subscribedEvents.includes(event.type)) {
        await this.onEvent(event);
      }
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.state = "stopped";
  }

  async onEvent(event: AgentEvent): Promise<void> {
    if (!this.subscribedEvents.includes(event.type)) {
      return;
    }

    this.state = "busy";
    this.lastError = undefined;

    try {
      await this.handleEvent(event);
      this.state = "idle";
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.onError(event, this.lastError);
    }
  }

  status(): { name: string; status: AgentStatus; subscribedEvents: readonly EventType[]; lastError?: string } {
    return {
      name: this.name,
      status: this.state,
      subscribedEvents: this.subscribedEvents,
      lastError: this.lastError
    };
  }

  protected abstract handleEvent(event: AgentEvent): Promise<void>;

  protected async onError(event: AgentEvent, reason: string): Promise<void> {
    await this.context.bus.publish({
      id: `${event.id}:agent-error:${this.name}`,
      type: event.type === "generation.requested" ? "generation.failed" : "style.failed",
      timestamp: Date.now(),
      actor: "system",
      styleId: event.styleId,
      consumerAddress: event.consumerAddress,
      payload: {
        requestId: event.payload.requestId,
        sourceEventId: event.id,
        agent: this.name,
        reason
      }
    });
  }
}

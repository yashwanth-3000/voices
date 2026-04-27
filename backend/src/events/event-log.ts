import { EventEmitter } from "node:events";
import { AgentStorage } from "../infra/types.js";
import { AgentEvent, createAgentEvent, requestIdFromEvent, type NewAgentEvent } from "./types.js";

export type EventHandler = (event: AgentEvent) => void | Promise<void>;

export type EventLogOptions = {
  storage: AgentStorage;
  streamId?: string;
};

export class EventLog {
  private readonly emitter = new EventEmitter();
  private readonly events = new Map<string, AgentEvent>();
  private readonly eventOrder: string[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly storage: AgentStorage;
  private readonly streamId: string;

  constructor(options: EventLogOptions) {
    this.storage = options.storage;
    this.streamId = options.streamId ?? "voices:agent-events";
    this.emitter.setMaxListeners(100);
  }

  subscribeAll(handler: EventHandler): () => void {
    const listener = (event: AgentEvent) => handler(event);
    this.emitter.on("*", listener);
    return () => {
      this.emitter.off("*", listener);
    };
  }

  async publish(input: AgentEvent | NewAgentEvent): Promise<AgentEvent> {
    const event = "timestamp" in input && "id" in input
      ? (input as AgentEvent)
      : createAgentEvent(input as NewAgentEvent);

    if (this.events.has(event.id)) {
      return this.events.get(event.id)!;
    }

    this.events.set(event.id, event);
    this.eventOrder.push(event.id);

    this.dispatch(event);
    const task = this.storage
      .logAppend(this.streamId, event.id, event)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);

    return event;
  }

  async replay(after?: string): Promise<AgentEvent[]> {
    const entries = await this.storage.logScan<AgentEvent>(this.streamId, "", after);
    const replayed: AgentEvent[] = [];

    for (const entry of entries) {
      if (this.events.has(entry.value.id)) {
        continue;
      }
      this.events.set(entry.value.id, entry.value);
      this.eventOrder.push(entry.value.id);
      replayed.push(entry.value);
    }

    return replayed;
  }

  allEvents(): AgentEvent[] {
    return this.eventOrder.map((id) => this.events.get(id)!).filter(Boolean);
  }

  eventsForRequest(requestId: string): AgentEvent[] {
    return this.allEvents().filter((event) => requestIdFromEvent(event) === requestId || event.id === requestId);
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private dispatch(event: AgentEvent): void {
    for (const listener of this.emitter.listeners("*")) {
      const task = Promise.resolve()
        .then(() => (listener as (event: AgentEvent) => void | Promise<void>)(event))
        .catch(() => undefined)
        .finally(() => {
          this.inFlight.delete(task);
        });
      this.inFlight.add(task);
    }
  }
}

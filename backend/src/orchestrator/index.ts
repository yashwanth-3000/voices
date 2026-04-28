import { VoicesLangGraphSwarm } from "../agents/langgraph/swarm.js";
import { EventLog } from "../events/event-log.js";
import { AgentEvent, NewAgentEvent } from "../events/types.js";
import { createChainClient } from "../infra/chain.js";
import { createComputeClient } from "../infra/compute.js";
import { createKeeperHubClient } from "../infra/keeperhub.js";
import { createStorageClient } from "../infra/storage.js";
import { AgentChain, AgentCompute, AgentStorage, KeeperHubClient } from "../infra/types.js";

export type OrchestratorDeps = {
  storage?: AgentStorage;
  compute?: AgentCompute;
  chain?: AgentChain;
  keeperhub?: KeeperHubClient;
  eventLog?: EventLog;
  swarm?: VoicesLangGraphSwarm;
};

export class Orchestrator {
  readonly events: EventLog;
  readonly swarm: VoicesLangGraphSwarm;
  readonly storage: AgentStorage;
  readonly chain: AgentChain;
  private started = false;

  constructor(deps: OrchestratorDeps = {}) {
    const storage = deps.storage ?? createStorageClient();
    const compute = deps.compute ?? createComputeClient();
    const chain = deps.chain ?? createChainClient();
    const keeperhub = deps.keeperhub ?? createKeeperHubClient();
    this.storage = storage;
    this.chain = chain;
    this.events = deps.eventLog ?? new EventLog({ storage });
    this.swarm =
      deps.swarm ??
      new VoicesLangGraphSwarm({
        storage,
        compute,
        chain,
        keeperhub,
        publish: (event) => this.events.publish(event)
      });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.events.replay();
    this.swarm.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.swarm.stop();
    this.started = false;
  }

  async publish(event: AgentEvent | NewAgentEvent): Promise<AgentEvent> {
    const published = await this.events.publish(event);
    this.swarm.handleEvent(published);
    return published;
  }

  async drain(): Promise<void> {
    await this.events.drain();
    await this.swarm.drain();
    await this.events.drain();
  }

  eventsForRequest(requestId: string): AgentEvent[] {
    return this.events.eventsForRequest(requestId);
  }

  status(): {
    started: boolean;
    agents: ReturnType<VoicesLangGraphSwarm["status"]>["agents"];
  } {
    const swarmStatus = this.swarm.status();
    return { started: this.started && swarmStatus.started, agents: swarmStatus.agents };
  }
}

export function createOrchestrator(deps: OrchestratorDeps = {}): Orchestrator {
  return new Orchestrator(deps);
}

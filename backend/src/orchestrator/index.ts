import { ContentCreatorAgent, DistributionManagerAgent, StyleCuratorAgent } from "../agents/index.js";
import { AgentContext, BaseAgent } from "../agents/base-agent.js";
import { EventBus } from "../events/event-bus.js";
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
  bus?: EventBus;
};

export class Orchestrator {
  readonly bus: EventBus;
  readonly agents: BaseAgent[];
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
    this.bus = deps.bus ?? new EventBus({ storage });

    const context: AgentContext = {
      bus: this.bus,
      storage,
      compute,
      chain,
      keeperhub
    };

    this.agents = [
      new StyleCuratorAgent(context),
      new ContentCreatorAgent(context),
      new DistributionManagerAgent(context)
    ];
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.bus.replay();
    for (const agent of this.agents) {
      await agent.start();
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    for (const agent of this.agents) {
      await agent.stop();
    }
    this.started = false;
  }

  async publish(event: AgentEvent | NewAgentEvent): Promise<AgentEvent> {
    return this.bus.publish(event);
  }

  async drain(): Promise<void> {
    await this.bus.drain();
  }

  eventsForRequest(requestId: string): AgentEvent[] {
    return this.bus.eventsForRequest(requestId);
  }

  status(): {
    started: boolean;
    agents: ReturnType<BaseAgent["status"]>[];
  } {
    return {
      started: this.started,
      agents: this.agents.map((agent) => agent.status())
    };
  }
}

export function createOrchestrator(deps: OrchestratorDeps = {}): Orchestrator {
  return new Orchestrator(deps);
}

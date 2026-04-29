import { AIMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { SwarmState } from "@langchain/langgraph-swarm";
import { AgentEvent, EventType } from "../../events/types.js";
import { TransactionIntent } from "../../infra/types.js";

export type VoicesAgentName = "style_curator" | "content_creator" | "distribution_mgr";

export type VoicesWorkflowKind = "style_upload" | "generation" | "feedback_refinement" | "credit_low";

export type VoicesPlatformVariants = Record<string, string>;

export const VoicesSwarmState = Annotation.Root({
  ...SwarmState.spec,
  workflowKind: Annotation<VoicesWorkflowKind | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  incomingEvent: Annotation<AgentEvent | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  requestId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  currentStyleId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  pendingStyleId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  consumerAddress: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  creatorAddress: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  prompt: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  targetPlatforms: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => ["x", "linkedin", "instagram"]
  }),
  draftText: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  platformVariants: Annotation<VoicesPlatformVariants | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  royaltyAmount: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  attestationVerified: Annotation<boolean | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  samplesRootHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  storageTxHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  runtimeContentKey: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  keyHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  wrappedKey: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  ownerPublicKey: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  keyWrapMode: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  profileKey: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  profileRootHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  profileStorageTxHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  agentBrainRootHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  agentBrainTxHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  agentBrainManifestHash: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  styleProfile: Annotation<Record<string, unknown> | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  selectedSamples: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  creditBalance: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  teeVerified: Annotation<boolean | null | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  lastCompute: Annotation<Record<string, unknown> | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  keeperHubWorkflowId: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  settlementStatus: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  mintIntent: Annotation<TransactionIntent | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  spendIntent: Annotation<TransactionIntent | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  lastEventType: Annotation<EventType | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  lastError: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  })
});

export type VoicesSwarmStateValue = typeof VoicesSwarmState.State;
export type VoicesSwarmUpdate = typeof VoicesSwarmState.Update;

export function appendAgentMessage(
  agentName: VoicesAgentName,
  content: string
): Pick<VoicesSwarmUpdate, "messages" | "activeAgent"> {
  return {
    activeAgent: agentName,
    messages: [new AIMessage({ content, name: agentName })]
  };
}

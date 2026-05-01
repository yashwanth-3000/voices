import { Buffer } from "node:buffer";
import { ethers } from "ethers";
import { AIMessage, BaseMessage, HumanMessage, isToolMessage } from "@langchain/core/messages";
import { BaseChatModel, BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createSwarm } from "@langchain/langgraph-swarm";
import { z } from "zod";
import { AgentEvent, AgentStatus, EventType, createUlid, requestIdFromEvent } from "../../events/types.js";
import { runCrewAiGeneration, CrewAiActivity, CrewAiGenerationResult } from "../crewai/runner.js";
import {
  buildAgentBrain,
  generateContentKey,
  protectContentKeyForRuntime,
  recoverRuntimeContentKey,
  uploadAgentBrain,
  wrapKeyForOwner
} from "../../inft/agent-brain.js";
import {
  detailedStyleGuidePrompt,
  jsonRepairPrompt,
  platformTuningPrompt,
  styleExtractionPrompt,
  styleRefinementPrompt
} from "../prompts.js";
import { MintStyleInput, AgentChain, AgentCompute, AgentStorage, ChatResult as AgentChatResult, KeeperHubClient } from "../../infra/types.js";
import {
  VoicesAgentName,
  VoicesSwarmState,
  VoicesSwarmStateValue,
  VoicesSwarmUpdate,
  VoicesWorkflowKind,
  appendAgentMessage
} from "./state.js";
import { ZeroGCheckpointSaver } from "./zero-g-checkpointer.js";

type LangGraphSwarmDeps = {
  storage: AgentStorage;
  compute: AgentCompute;
  chain: AgentChain;
  keeperhub: KeeperHubClient;
  publish: (event: AgentEvent) => Promise<AgentEvent>;
};

type AgentMeta = {
  displayName: string;
  graphName: VoicesAgentName;
  subscribedEvents: readonly EventType[];
  status: AgentStatus;
  lastError?: string;
};

type AgentActivityStatus = "started" | "progress" | "completed" | "failed" | "handoff";

type StyleExtractionMetadata = Record<string, unknown> & {
  sourceContext: Record<string, unknown>;
  sourceMaterials: Array<Record<string, unknown>>;
  sourceKind: string;
  sourceSummary?: string;
  styleName?: string;
  description?: string;
  keywords: string[];
};

const MIN_SAMPLE_BYTES = 1024;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const DEFAULT_STYLE_SAMPLE_CHAR_BUDGET = 60_000;

export class VoicesLangGraphSwarm {
  private readonly checkpointer: ZeroGCheckpointSaver;
  private readonly app: ReturnType<ReturnType<typeof createSwarm>["compile"]>;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly agents: AgentMeta[] = [
    {
      displayName: "Style Curator",
      graphName: "style_curator",
      subscribedEvents: ["style.uploaded", "feedback.received"],
      status: "stopped"
    },
    {
      displayName: "Content Creator",
      graphName: "content_creator",
      subscribedEvents: ["generation.requested", "style.refined"],
      status: "stopped"
    },
    {
      displayName: "Distribution Manager",
      graphName: "distribution_mgr",
      subscribedEvents: ["credit.low"],
      status: "stopped"
    }
  ];

  private started = false;

  constructor(private readonly deps: LangGraphSwarmDeps) {
    this.checkpointer = new ZeroGCheckpointSaver(deps.storage);
    const styleCurator = createReactAgent({
      llm: createPlannerModel("style_curator", deps.compute),
      tools: [
        this.verifyAttestationTool(),
        this.encryptAndStoreSamplesTool(),
        this.extractStyleProfileTool(),
        this.buildAndUploadAgentBrainTool(),
        this.mintInftTool(),
        this.refineProfileFromFeedbackTool(),
        this.handoffToContentCreatorTool()
      ],
      prompt: STYLE_CURATOR_PROMPT,
      name: "style_curator",
      stateSchema: VoicesSwarmState
    });
    const contentCreator = createReactAgent({
      llm: createPlannerModel("content_creator", deps.compute),
      tools: [
        this.checkCreditBalanceTool(),
        this.readStyleProfileTool(),
        this.pullRelevantSamplesTool(),
        this.generateWithVoiceTool(),
        this.logDraftTool(),
        this.handoffToDistributionTool()
      ],
      prompt: CONTENT_CREATOR_PROMPT,
      name: "content_creator",
      stateSchema: VoicesSwarmState
    });
    const distributionMgr = createReactAgent({
      llm: createPlannerModel("distribution_mgr", deps.compute),
      tools: [
        this.tuneForPlatformTool(),
        this.topupCreditsViaKeeperTool(),
        this.handoffToCuratorTool()
      ],
      prompt: DISTRIBUTION_MANAGER_PROMPT,
      name: "distribution_mgr",
      stateSchema: VoicesSwarmState
    });
    this.app = createSwarm<typeof VoicesSwarmState>({
      agents: [styleCurator, contentCreator, distributionMgr] as never,
      defaultActiveAgent: "style_curator",
      stateSchema: VoicesSwarmState
    }).compile({ checkpointer: this.checkpointer, name: "voices_langgraph_swarm" });
  }

  private verifyAttestationTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        await this.publishToolActivity(state, "style_curator", "verify_attestation", "started", "Verifying the wallet-signed EIP-191 attestation.");
        try {
          validateAttestation(event.actor, stringValue(event.payload.attestationMessage, ""), stringValue(event.payload.attestationSignature, ""));
          await this.publishToolActivity(state, "style_curator", "verify_attestation", "completed", "Attestation signature matches the creator wallet.");
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", "Creator attestation verified."),
              requestId,
              creatorAddress: event.actor,
              attestationVerified: true,
              lastError: undefined
            }
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.publishToolActivity(state, "style_curator", "verify_attestation", "failed", reason);
          await this.publishStyleFailure(event, requestId, reason);
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Attestation rejected: ${reason}`),
              requestId,
              attestationVerified: false,
              lastEventType: "style.failed",
              lastError: reason
            }
          });
        }
      },
      {
        name: "verify_attestation",
        description: "Deterministically verify the creator wallet's EIP-191 attestation signature before any style work.",
        schema: z.object({})
      }
    );
  }

  private encryptAndStoreSamplesTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        await this.publishToolActivity(state, "style_curator", "encrypt_and_store_samples", "started", "Checking sample size and encrypting the creator samples.");
        try {
          if (state.attestationVerified === false) {
            throw new Error("Cannot store samples after failed attestation");
          }
          const samples = stringArray(event.payload.samples);
          validateSamples(samples);
          const contentKey = generateContentKey();
          const keyWrap = wrapKeyForOwner(contentKey, event.actor, {
            attestationMessage: stringValue(event.payload.attestationMessage, undefined),
            attestationSignature: stringValue(event.payload.attestationSignature, undefined),
            ownerPublicKey: stringValue(event.payload.ownerPublicKey, undefined)
          });
          const rawSamples = Buffer.from(samples.join("\n\n--- sample break ---\n\n"), "utf8");
          const upload = await this.deps.storage.uploadEncrypted(rawSamples, ethers.hexlify(contentKey));
          await this.publishToolActivity(state, "style_curator", "encrypt_and_store_samples", "completed", "Encrypted samples were written through 0G Storage.", {
            rootHash: upload.rootHash,
            txHash: upload.txHash,
            keyHash: keyWrap.keyHash,
            keyWrapMode: keyWrap.wrapMode
          });
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Encrypted samples stored at ${upload.rootHash}.`),
              requestId,
              samplesRootHash: upload.rootHash,
              storageTxHash: upload.txHash,
              runtimeContentKey: protectContentKeyForRuntime(contentKey),
              keyHash: keyWrap.keyHash,
              wrappedKey: keyWrap.wrappedKey,
              ownerPublicKey: keyWrap.ownerPublicKey,
              keyWrapMode: keyWrap.wrapMode,
              selectedSamples: budgetSamplesForExtraction(samples),
              lastError: undefined
            }
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.publishToolActivity(state, "style_curator", "encrypt_and_store_samples", "failed", reason);
          await this.publishStyleFailure(event, requestId, reason);
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Sample storage failed: ${reason}`),
              requestId,
              lastEventType: "style.failed",
              lastError: reason
            }
          });
        }
      },
      {
        name: "encrypt_and_store_samples",
        description: "Validate sample size, encrypt the raw samples, and upload the encrypted bytes to 0G Storage.",
        schema: z.object({})
      }
    );
  }

  private extractStyleProfileTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        await this.publishToolActivity(state, "style_curator", "extract_style_profile", "started", "Calling 0G Compute to extract the structured voice profile.");
        try {
          if (!state.samplesRootHash) {
            throw new Error("Samples must be encrypted and stored before profile extraction");
          }
          const allSamples = stringArray(event.payload.samples);
          const samples = state.selectedSamples.length > 0 ? state.selectedSamples : budgetSamplesForExtraction(allSamples);
          const extractionMetadata = buildStyleExtractionMetadata(event.payload, event.actor, allSamples, samples);
          const { compute, profile: baseProfile } = await this.extractProfile(samples, extractionMetadata);
          const guideResult = hasDetailedStyleGuide(baseProfile)
            ? undefined
            : await this.generateDetailedStyleGuide(samples, baseProfile, extractionMetadata).catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                return {
                  guide: buildFallbackDetailedStyleGuide(baseProfile, samples, extractionMetadata, reason),
                  compute: undefined
                };
              });
          const profile = guideResult
            ? {
                ...baseProfile,
                detailed_style_guide: guideResult.guide,
                styleGuideCompute: guideResult.compute ? computeEvidence(guideResult.compute, "detailed_style_guide") : undefined
              }
            : baseProfile;
          const styleId = state.currentStyleId ?? state.pendingStyleId ?? `pending:${event.id}`;
          const profileKey = `style:${styleId}:profile`;
          const enrichedProfile = {
            ...profile,
            sampleExcerpts: normalizeSampleExcerpts(profile, allSamples),
            sourceContext: extractionMetadata.sourceContext,
            sourceMaterials: extractionMetadata.sourceMaterials,
            sourceKind: extractionMetadata.sourceKind,
            sourceSummary: extractionMetadata.sourceSummary,
            styleName: extractionMetadata.styleName,
            description: extractionMetadata.description,
            keywords: extractionMetadata.keywords,
            fullSampleCount: allSamples.length,
            fullSampleBytes: Buffer.byteLength(allSamples.join("\n"), "utf8"),
            extractionSampleCount: samples.length,
            extractionSampleBytes: Buffer.byteLength(samples.join("\n"), "utf8"),
            samplesRootHash: state.samplesRootHash,
            teeVerified: compute.teeVerified ?? compute.verified,
            computeProvider: compute.providerAddress,
            computeModel: compute.model,
            computeChatId: compute.chatId,
            styleGuideCompute: guideResult?.compute
              ? computeEvidence(guideResult.compute, "detailed_style_guide")
              : baseProfile.styleGuideCompute,
            langGraphThread: `voices:${requestId}`,
            updatedAt: Date.now()
          };
          await this.deps.storage.kvSet(profileKey, enrichedProfile);
          await this.publishToolActivity(state, "style_curator", "extract_style_profile", "completed", "Profile JSON was extracted and stored in 0G KV.", {
            profileKey,
            sourceKind: extractionMetadata.sourceKind,
            sourceCount: extractionMetadata.sourceMaterials.length,
            fullSampleBytes: Buffer.byteLength(allSamples.join("\n"), "utf8"),
            teeVerified: compute.teeVerified ?? compute.verified,
            compute: computeEvidence(compute, "style_profile_extraction"),
            styleGuideCompute: guideResult?.compute ? computeEvidence(guideResult.compute, "detailed_style_guide") : undefined,
            hasDetailedStyleGuide: hasDetailedStyleGuide(enrichedProfile)
          });
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Structured style profile extracted for ${styleId}.`),
              requestId,
              pendingStyleId: styleId,
              currentStyleId: styleId,
              creatorAddress: event.actor,
              styleProfile: enrichedProfile,
              profileKey,
              teeVerified: compute.teeVerified ?? compute.verified,
              lastCompute: computeEvidence(compute, "style_profile_extraction"),
              lastError: undefined
            }
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.publishToolActivity(state, "style_curator", "extract_style_profile", "failed", reason);
          await this.publishStyleFailure(event, requestId, reason);
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Style extraction failed: ${reason}`),
              requestId,
              lastEventType: "style.failed",
              lastError: reason
            }
          });
        }
      },
      {
        name: "extract_style_profile",
        description: "Call 0G Compute with the detailed style extraction prompt and persist the structured profile to 0G Storage KV.",
        schema: z.object({})
      }
    );
  }

  private buildAndUploadAgentBrainTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        await this.publishToolActivity(state, "style_curator", "build_and_upload_agent_brain", "started", "Encrypting profile material and publishing the AgentBrain manifest.");
        try {
          if (!state.runtimeContentKey || !state.samplesRootHash || !state.profileKey || !state.styleProfile) {
            throw new Error("Content key, encrypted samples, and profile are required before AgentBrain upload");
          }
          if (!state.wrappedKey || !state.keyHash) {
            throw new Error("Wrapped key material is required before AgentBrain upload");
          }

          const contentKey = recoverRuntimeContentKey(state.runtimeContentKey);
          const styleId = state.currentStyleId ?? state.pendingStyleId ?? `pending:${event.id}`;
          const profileBytes = Buffer.from(JSON.stringify(state.styleProfile), "utf8");
          const profileUpload = await this.deps.storage.uploadEncrypted(profileBytes, ethers.hexlify(contentKey));
          const samples = stringArray(event.payload.samples);
          const { manifest } = buildAgentBrain({
            styleId,
            creator: state.creatorAddress ?? event.actor,
            contentKey,
            samplesUpload: { rootHash: state.samplesRootHash, txHash: state.storageTxHash },
            profileUpload,
            profileKey: state.profileKey,
            profile: state.styleProfile,
            sampleCount: samples.length,
            sampleSizeBytes: Buffer.byteLength(samples.join("\n"), "utf8"),
            memoryLogStream: `style:${styleId}:memory`,
            feedbackCount: 0,
            compute: {
              content: "",
              verified: state.teeVerified ?? null,
              teeVerified: state.teeVerified ?? null,
              model: stringValue(state.styleProfile.computeModel, undefined),
              providerAddress: stringValue(state.styleProfile.computeProvider, undefined),
              chatId: stringValue(state.styleProfile.computeChatId, undefined)
            },
            wrapMode: state.keyWrapMode === "ecies-secp256k1-attestation" ? "ecies-secp256k1-attestation" : "address-derived-demo"
          });
          const brainUpload = await uploadAgentBrain(this.deps.storage, manifest);
          const agentBrainKey = `style:${styleId}:agentBrain`;
          await this.deps.storage.kvSet(agentBrainKey, {
            ...manifest,
            manifest_root_hash: brainUpload.rootHash,
            manifest_storage_tx_hash: brainUpload.txHash,
            manifest_hash: brainUpload.manifestHash
          });

          await this.publishToolActivity(state, "style_curator", "build_and_upload_agent_brain", "completed", "AgentBrain manifest uploaded to 0G Storage.", {
            agentBrainRootHash: brainUpload.rootHash,
            agentBrainTxHash: brainUpload.txHash,
            agentBrainManifestHash: brainUpload.manifestHash,
            profileRootHash: profileUpload.rootHash,
            keyHash: state.keyHash
          });

          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `AgentBrain manifest uploaded at ${brainUpload.rootHash}.`),
              requestId,
              pendingStyleId: styleId,
              currentStyleId: styleId,
              profileRootHash: profileUpload.rootHash,
              profileStorageTxHash: profileUpload.txHash,
              agentBrainRootHash: brainUpload.rootHash,
              agentBrainTxHash: brainUpload.txHash,
              agentBrainManifestHash: brainUpload.manifestHash,
              lastError: undefined
            }
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.publishToolActivity(state, "style_curator", "build_and_upload_agent_brain", "failed", reason);
          await this.publishStyleFailure(event, requestId, reason);
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `AgentBrain upload failed: ${reason}`),
              requestId,
              lastEventType: "style.failed",
              lastError: reason
            }
          });
        }
      },
      {
        name: "build_and_upload_agent_brain",
        description: "Encrypt the profile with the per-style content key, upload the AgentBrain manifest, and persist its 0G root hash.",
        schema: z.object({})
      }
    );
  }

  private mintInftTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        await this.publishToolActivity(state, "style_curator", "mint_inft", "started", "Preparing the StyleRegistry mint transaction intent for the creator wallet.");
        try {
          if (!state.profileKey || !state.samplesRootHash || !state.styleProfile || !state.agentBrainRootHash) {
            throw new Error("Profile, encrypted samples, and AgentBrain manifest are required before minting");
          }
          if (!state.wrappedKey || !state.keyHash) {
            throw new Error("Wrapped key material is required before minting");
          }
          const styleId = state.currentStyleId ?? state.pendingStyleId ?? `pending:${event.id}`;
          const mintInput: MintStyleInput = {
            tokenMetadataURI: stringValue(event.payload.tokenMetadataURI, ""),
            encryptedSamplesURI: `0g://agent-brain/${state.agentBrainRootHash}`,
            profileURI: `0g://kv/${state.profileKey}`,
            metadataHash: state.agentBrainManifestHash ?? ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(state.styleProfile))),
            sealedKey: state.wrappedKey,
            royaltyWei: stringValue(event.payload.royaltyWei, "1000000000000000"),
            sampleCount: stringArray(event.payload.samples).length,
            language: stringValue(event.payload.language, "en"),
            genres: stringArray(event.payload.genres).join(","),
            attestationURI: `eip191://${ethers.keccak256(ethers.toUtf8Bytes(stringValue(event.payload.attestationMessage, "")))}`
          };
          const transactionIntent = this.deps.chain.mintStyleIntent(mintInput);
          await this.deps.publish({
            id: `${event.id}:style.mint.intent.created`,
            type: "style.mint.intent.created",
            timestamp: Date.now(),
            actor: "system",
            styleId,
            payload: {
              requestId,
              status: "awaiting_wallet_signature",
              profileKey: state.profileKey,
              samplesRootHash: state.samplesRootHash,
              storageTxHash: state.storageTxHash,
              agentBrainRootHash: state.agentBrainRootHash,
              agentBrainTxHash: state.agentBrainTxHash,
              agentBrainManifestHash: state.agentBrainManifestHash,
              keyHash: state.keyHash,
              keyWrapMode: state.keyWrapMode,
              teeVerified: state.teeVerified,
              transactionIntent,
              langGraphThread: `voices:${requestId}`
            }
          });
          await this.publishToolActivity(state, "style_curator", "mint_inft", "completed", "Mint transaction intent is ready for MetaMask.", {
            styleId,
            to: transactionIntent.to
          });
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Mint intent prepared for ${styleId}.`),
              requestId,
              pendingStyleId: styleId,
              currentStyleId: styleId,
              creatorAddress: event.actor,
              mintIntent: transactionIntent,
              lastEventType: "style.mint.intent.created",
              lastError: undefined
            }
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.publishToolActivity(state, "style_curator", "mint_inft", "failed", reason);
          await this.publishStyleFailure(event, requestId, reason);
          return new Command({
            update: {
              ...appendAgentMessage("style_curator", `Mint intent failed: ${reason}`),
              requestId,
              lastEventType: "style.failed",
              lastError: reason
            }
          });
        }
      },
      {
        name: "mint_inft",
        description: "Prepare the real StyleRegistry mint transaction intent for the creator wallet to sign on 0G Chain.",
        schema: z.object({})
      }
    );
  }

  private refineProfileFromFeedbackTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        await this.publishToolActivity(state, "style_curator", "refine_profile_from_feedback", "started", "Checking feedback for meaningful voice changes.");
        return new Command({ update: await this.refineStyle(state, event) });
      },
      {
        name: "refine_profile_from_feedback",
        description: "Read recent feedback and generation history, then update the stored style profile only if the feedback is meaningful.",
        schema: z.object({})
      }
    );
  }

  private handoffToContentCreatorTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        if (!state.consumerAddress || !state.prompt) {
          await this.publishToolActivity(state, "style_curator", "handoff_to_content_creator", "completed", "No consumer context is present, so the creator path stops after mint intent creation.");
          return "No consumer context is present; the creator upload path stops after mint intent creation.";
        }
        await this.publishToolActivity(state, "style_curator", "handoff_to_content_creator", "handoff", "Handing the workflow to the Content Creator agent.");
        return new Command({
          goto: "content_creator",
          graph: Command.PARENT,
          update: {
            ...appendAgentMessage("style_curator", "Handing off to Content Creator."),
            activeAgent: "content_creator",
            workflowKind: "generation"
          }
        });
      },
      {
        name: "handoff_to_content_creator",
        description: "Command handoff from Style Curator to Content Creator when a workflow includes consumer generation context.",
        schema: z.object({})
      }
    );
  }

  private checkCreditBalanceTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        await this.publishToolActivity(state, "content_creator", "check_credit_balance", "started", "Reading the consumer credit balance from CreditSystem.", {
          consumerAddress
        });
        const credits = await this.deps.chain.credits(consumerAddress);
        if (credits === 0n) {
          await this.deps.publish({
            id: `${event.id}:credit.low`,
            type: "credit.low",
            timestamp: Date.now(),
            actor: "system",
            styleId,
            consumerAddress,
            payload: { requestId, reason: "no_credits", langGraphThread: `voices:${requestId}` }
          });
          await this.publishToolActivity(state, "content_creator", "check_credit_balance", "completed", "No credits found; emitted credit.low and handed off to Distribution Manager.", {
            consumerAddress,
            credits: "0"
          });
          return new Command({
            goto: "distribution_mgr",
            graph: Command.PARENT,
            update: {
              ...appendAgentMessage("content_creator", `No credits available for ${consumerAddress}; handing off for top-up policy.`),
              activeAgent: "distribution_mgr",
              workflowKind: "credit_low",
              currentStyleId: styleId,
              consumerAddress,
              creditBalance: "0",
              lastEventType: "credit.low"
            }
          });
        }
        await this.publishToolActivity(state, "content_creator", "check_credit_balance", "completed", "Consumer has credits available for generation.", {
          consumerAddress,
          credits: credits.toString()
        });
        return new Command({
          update: {
            ...appendAgentMessage("content_creator", `${consumerAddress} has ${credits.toString()} generation credit(s).`),
            currentStyleId: styleId,
            consumerAddress,
            creditBalance: credits.toString(),
            lastError: undefined
          }
        });
      },
      {
        name: "check_credit_balance",
        description: "Read CreditSystem.credits for the consumer and emit credit.low when no credits are available.",
        schema: z.object({})
      }
    );
  }

  private readStyleProfileTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        await this.publishToolActivity(state, "content_creator", "read_style_profile", "started", "Reading StyleRegistry and the 0G KV profile for the selected iNFT.", {
          styleId
        });
        const style = await this.deps.chain.styleOf(styleId);
        if (!style.listed) {
          await this.publishGenerationFailure(event, requestId, "Style is no longer listed");
          await this.publishToolActivity(state, "content_creator", "read_style_profile", "failed", "Style is no longer listed.", { styleId });
          return new Command({
            update: {
              ...appendAgentMessage("content_creator", `Style ${styleId} is no longer listed.`),
              lastEventType: "generation.failed",
              lastError: "Style is no longer listed"
            }
          });
        }
        let profile: Record<string, unknown>;
        let profileSource: string;
        try {
          profile = await this.getProfile(styleId, style.profileURI);
          profileSource = "0g_kv";
        } catch {
          const hint = recordValue(event.payload.styleHint);
          if (Object.keys(hint).length > 0) {
            profile = buildProfileFromHint(hint);
            profileSource = "style_hint";
          } else {
            throw new Error(`Missing style profile for ${styleId}`);
          }
        }
        await this.publishToolActivity(state, "content_creator", "read_style_profile", "completed", `Style profile loaded (${profileSource}).`, {
          styleId,
          creatorAddress: style.creator,
          profileSource
        });
        return new Command({
          update: {
            ...appendAgentMessage("content_creator", `Loaded style profile for ${styleId}.`),
            currentStyleId: styleId,
            creatorAddress: style.creator,
            royaltyAmount: style.royaltyWei.toString(),
            styleProfile: profile,
            profileKey: style.profileURI.startsWith("0g://kv/") ? style.profileURI.replace("0g://kv/", "") : style.profileURI,
            lastError: undefined
          }
        });
      },
      {
        name: "read_style_profile",
        description: "Read StyleRegistry.styleOf and the 0G Storage KV profile for the chosen iNFT style.",
        schema: z.object({})
      }
    );
  }

  private pullRelevantSamplesTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const profile = state.styleProfile ?? {};
        const selectedSamples = styleExcerptsFromProfile(profile).slice(0, 8);
        await this.publishToolActivity(state, "content_creator", "pull_relevant_samples", "completed", `Selected ${selectedSamples.length} style-only excerpt(s) for low-cost conditioning.`, {
          sampleCount: selectedSamples.length
        });
        return new Command({
          update: {
            ...appendAgentMessage("content_creator", `Selected ${selectedSamples.length} voice example(s) for few-shot conditioning.`),
            selectedSamples,
            lastError: undefined
          }
        });
      },
      {
        name: "pull_relevant_samples",
        description: "Select the most useful stored sample excerpts for the generation prompt while keeping token cost low.",
        schema: z.object({})
      }
    );
  }

  private generateWithVoiceTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const prompt = state.prompt ?? stringValue(event.payload.prompt, "");
        const platforms = generationPlatforms(state, event);
        await this.publishToolActivity(state, "content_creator", "generate_with_voice", "started", "Starting the CrewAI voice-generation swarm for the selected output format.", {
          styleId,
          prompt: prompt.slice(0, 160),
          platforms
        });
        try {
          const styleReferences = state.selectedSamples.length > 0
            ? state.selectedSamples
            : styleExcerptsFromProfile(state.styleProfile ?? {}).slice(0, 5);
          const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
          const [styleRegistry, agentBrain, memoryEntries] = await Promise.all([
            this.getStyleRegistryEvidence(styleId, state),
            this.getAgentBrainEvidence(styleId, state.styleProfile ?? {}),
            this.getCrewMemoryEvidence(styleId, consumerAddress, state.styleProfile ?? {})
          ]);
          const crew = await runCrewAiGeneration(
            {
              requestId,
              styleId,
              consumerAddress,
              creatorAddress: state.creatorAddress,
              prompt,
              platforms,
              profileKey: state.profileKey,
              styleRegistry,
              styleProfile: state.styleProfile ?? {},
              excerpts: styleReferences,
              agentBrain,
              memoryEntries,
              computeOptions: generationComputeOptions(platforms, "draft")
            },
            {
              compute: this.deps.compute,
              onActivity: (activity) => this.publishCrewActivity(state, activity)
            }
          );
          const draft = finalizeGeneratedDraft(crew.draft);
          const compute = crewAiComputeEvidence(crew, "crewai_voice_generation");
          await this.persistCrewMemory(state, {
            styleId,
            consumerAddress,
            prompt,
            draft,
            crew
          });
          await this.publishToolActivity(state, "content_creator", "generate_with_voice", "completed", "CrewAI swarm generated, critiqued, and queued memory sync for the voice-matched draft.", {
            styleId,
            teeVerified: compute.teeVerified,
            qualityGuard: "voice_critic_memory_agent",
            compute
          });
          return new Command({
            update: {
              ...appendAgentMessage("content_creator", `Draft generated for style ${styleId}.`),
              requestId,
              currentStyleId: styleId,
              prompt,
              targetPlatforms: platforms,
              draftText: draft,
              teeVerified: compute.teeVerified,
              lastCompute: compute,
              lastError: undefined
            }
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await this.publishToolActivity(state, "content_creator", "generate_with_voice", "failed", reason);
          await this.publishGenerationFailure(event, requestId, reason);
          return new Command({
            update: {
              ...appendAgentMessage("content_creator", `Generation failed: ${reason}`),
              lastEventType: "generation.failed",
              lastError: reason
            }
          });
        }
      },
      {
        name: "generate_with_voice",
        description: "Run the CrewAI voice context, style writer, and critic/memory agents over 0G Compute evidence.",
        schema: z.object({})
      }
    );
  }

  private logDraftTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        const draft = state.draftText ?? "";
        const platforms = generationPlatforms(state, event);
        await this.publishToolActivity(state, "content_creator", "log_draft", "started", "Writing the draft to the consumer 0G history log.", {
          styleId,
          consumerAddress
        });
        const historyStream = `consumer:${consumerAddress}:history`;
        const historyKey = `gen:${event.id}`;
        this.queueHistoryLogAppend(historyStream, historyKey, {
          styleId,
          draft,
          prompt: state.prompt ?? stringValue(event.payload.prompt, ""),
          teeVerified: state.teeVerified,
          compute: state.lastCompute,
          langGraphThread: `voices:${requestId}`,
          timestamp: Date.now()
        }, "draft history append");
        await this.deps.publish({
          id: `${event.id}:generation.drafted`,
          type: "generation.drafted",
          timestamp: Date.now(),
          actor: "system",
          styleId,
          consumerAddress,
          payload: {
            requestId,
            draft,
            prompt: state.prompt ?? stringValue(event.payload.prompt, ""),
            platforms,
            teeVerified: state.teeVerified,
            compute: state.lastCompute,
            historyLogStream: historyStream,
            historyLogKey: historyKey,
            historyLogStatus: "syncing_to_0g",
            langGraphThread: `voices:${requestId}`
          }
        });
        await this.publishToolActivity(state, "content_creator", "log_draft", "completed", "Draft event emitted; 0G history log append is syncing in the background.", {
          styleId,
          consumerAddress,
          historyLogStream: historyStream,
          historyLogKey: historyKey,
          historyLogStatus: "syncing_to_0g"
        });
        return new Command({
          update: {
            ...appendAgentMessage("content_creator", "Draft emitted; 0G history log append is syncing in the background."),
            currentStyleId: styleId,
            consumerAddress,
            lastEventType: "generation.drafted"
          }
        });
      },
      {
        name: "log_draft",
        description: "Append the draft to the consumer history log and emit generation.drafted.",
        schema: z.object({})
      }
    );
  }

  private handoffToDistributionTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        const platforms = generationPlatforms(state, event);
        await this.publishToolActivity(state, "content_creator", "handoff_to_distribution", "handoff", "Handing the draft to Distribution Manager for platform variants and settlement intent.", {
          styleId,
          consumerAddress,
          platforms
        });
        const update = await this.publishSelectedOutputAndSettlement({
          ...state,
          activeAgent: "distribution_mgr",
          workflowKind: "generation",
          currentStyleId: styleId,
          consumerAddress,
          targetPlatforms: platforms,
          draftText: state.draftText,
          royaltyAmount: state.royaltyAmount,
          lastEventType: "generation.drafted"
        });
        return new Command({ update });
      },
      {
        name: "handoff_to_distribution",
        description: "Command handoff from Content Creator to Distribution Manager after the draft is logged.",
        schema: z.object({})
      }
    );
  }

  private tuneForPlatformTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        return new Command({ update: await this.publishSelectedOutputAndSettlement(state) });
      },
      {
        name: "tune_for_platform",
        description: "Produce only the requested platform output, write it to the consumer log, and prepare the spend-credit intent.",
        schema: z.object({}),
        returnDirect: true
      }
    );
  }

  private async publishSelectedOutputAndSettlement(state: VoicesSwarmStateValue): Promise<VoicesSwarmUpdate> {
    const event = requireIncomingEvent(state);
    const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
    const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
    const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
    const draft = state.draftText ?? stringValue(event.payload.draft, "");
    const platforms = generationPlatforms(state, event);
    await this.publishToolActivity(state, "distribution_mgr", "tune_for_platform", "started", "Creating the selected output format and wallet-signable royalty intent.", {
      styleId,
      platforms
    });
    const tuningCompute = shouldTuneDistributionWithCompute()
      ? await this.deps.compute.chat(platformTuningPrompt(draft, platforms), generationComputeOptions(platforms, "platform"))
      : undefined;
    const prompt = state.prompt ?? stringValue(event.payload.prompt, "");
    const variants = tuningCompute
      ? parseVariants(tuningCompute.content, draft, platforms, prompt)
      : variantsFromDraft(draft, platforms, prompt);
    const spendIntent = this.deps.chain.spendCreditIntent(styleId);
    const historyStream = `consumer:${consumerAddress}:history`;
    const historyKey = `published:${event.id}`;
    const compute = tuningCompute
      ? computeEvidence(tuningCompute, "platform_tuning")
      : state.lastCompute
        ? { ...state.lastCompute, purpose: "voice_generation_validated" }
        : undefined;
    const teeVerified = tuningCompute
      ? tuningCompute.teeVerified ?? tuningCompute.verified
      : state.teeVerified ?? null;
    this.queueHistoryLogAppend(historyStream, historyKey, {
      styleId,
      variants,
      teeVerified,
      compute,
      langGraphThread: `voices:${requestId}`,
      timestamp: Date.now()
    }, "published variants history append");
    await this.deps.publish({
      id: `${event.id}:generation.published`,
      type: "generation.published",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      consumerAddress,
      payload: {
        requestId,
        variants,
        teeVerified,
        compute,
        settlementStatus: "awaiting_wallet_signature",
        spendIntent,
        historyLogStream: historyStream,
        historyLogKey: historyKey,
        historyLogStatus: "syncing_to_0g",
        langGraphThread: `voices:${requestId}`
      }
    });
    await this.deps.publish({
      id: `${event.id}:settlement.intent.created`,
      type: "settlement.intent.created",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      consumerAddress,
      payload: {
        requestId,
        spendIntent,
        status: "awaiting_wallet_signature",
        sourceEventType: "generation.published",
        langGraphThread: `voices:${requestId}`
      }
    });
    await this.publishToolActivity(state, "distribution_mgr", "tune_for_platform", "completed", "Selected output format emitted and spend-credit intent prepared; 0G history log is syncing in the background.", {
      styleId,
      platforms,
      historyLogStream: historyStream,
      historyLogKey: historyKey,
      historyLogStatus: "syncing_to_0g",
      teeVerified,
      compute
    });
    return {
      ...appendAgentMessage("distribution_mgr", "Selected output format created. Spend-credit transaction intent prepared."),
      activeAgent: "distribution_mgr",
      workflowKind: "generation",
      currentStyleId: styleId,
      consumerAddress,
      targetPlatforms: platforms,
      platformVariants: variants,
      spendIntent,
      teeVerified,
      lastEventType: "settlement.intent.created",
      lastError: undefined
    };
  }

  private checkDistributionCreditBalanceTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        await this.publishToolActivity(state, "distribution_mgr", "check_credit_balance", "started", "Rechecking credits before settlement.");
        const credits = await this.deps.chain.credits(consumerAddress);
        await this.publishToolActivity(state, "distribution_mgr", "check_credit_balance", "completed", "Settlement credit balance read.", {
          consumerAddress,
          credits: credits.toString()
        });
        return new Command({
          update: {
            ...appendAgentMessage("distribution_mgr", `Settlement check sees ${credits.toString()} credit(s).`),
            consumerAddress,
            creditBalance: credits.toString(),
            lastError: undefined
          }
        });
      },
      {
        name: "check_credit_balance",
        description: "Read the consumer credit balance during Distribution Manager settlement and auto-top-up reasoning.",
        schema: z.object({})
      }
    );
  }

  private deductCreditViaKeeperTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        const spendIntent = state.spendIntent ?? this.deps.chain.spendCreditIntent(styleId);
        await this.publishToolActivity(state, "distribution_mgr", "deduct_credit_via_keeper", "started", "Creating the spend-credit transaction intent and asking KeeperHub when configured.", {
          styleId,
          consumerAddress
        });
        await this.deps.publish({
          id: `${event.id}:settlement.intent.created`,
          type: "settlement.intent.created",
          timestamp: Date.now(),
          actor: "system",
          styleId,
          consumerAddress,
          payload: { requestId, spendIntent, langGraphThread: `voices:${requestId}` }
        });
        const settlement = await this.deps.keeperhub.executeTransaction(spendIntent);
        if (settlement.status === "confirmed") {
          await this.deps.publish({
            id: `${event.id}:credit.deducted`,
            type: "credit.deducted",
            timestamp: Date.now(),
            actor: "system",
            styleId,
            consumerAddress,
            payload: { requestId, txHash: settlement.txHash, langGraphThread: `voices:${requestId}` }
          });
        }
        await this.publishToolActivity(state, "distribution_mgr", "deduct_credit_via_keeper", "completed", `Settlement status is ${settlement.status}.`, {
          styleId,
          consumerAddress,
          workflowId: settlement.workflowId,
          txHash: settlement.txHash,
          reason: settlement.reason
        });
        return new Command({
          update: {
            ...appendAgentMessage("distribution_mgr", `Credit spend submitted with status ${settlement.status}.`),
            spendIntent,
            settlementStatus: settlement.status,
            keeperHubWorkflowId: settlement.workflowId,
            lastEventType: settlement.status === "confirmed" ? "credit.deducted" : "settlement.intent.created",
            lastError: settlement.status === "failed" ? settlement.reason : undefined
          }
        });
      },
      {
        name: "deduct_credit_via_keeper",
        description: "Create the current CreditSystem.spendCredit transaction intent and submit it through KeeperHub when configured.",
        schema: z.object({})
      }
    );
  }

  private depositRoyaltyViaKeeperTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        await this.publishToolActivity(state, "distribution_mgr", "deposit_royalty_via_keeper", "started", "Checking whether the atomic spendCredit path confirmed royalty settlement.", {
          styleId,
          consumerAddress
        });
        if (state.settlementStatus === "confirmed") {
          await this.deps.publish({
            id: `${event.id}:royalty.settled`,
            type: "royalty.settled",
            timestamp: Date.now(),
            actor: "system",
            styleId,
            consumerAddress,
            payload: { requestId, workflowId: state.keeperHubWorkflowId, langGraphThread: `voices:${requestId}` }
          });
        }
        await this.publishToolActivity(
          state,
          "distribution_mgr",
          "deposit_royalty_via_keeper",
          "completed",
          state.settlementStatus === "confirmed"
            ? "Royalty settlement confirmed through spendCredit."
            : "Royalty settlement is pending wallet or KeeperHub confirmation.",
          { styleId, consumerAddress, settlementStatus: state.settlementStatus }
        );
        return new Command({
          update: {
            ...appendAgentMessage(
              "distribution_mgr",
              state.settlementStatus === "confirmed"
                ? "Royalty settlement confirmed through the atomic spendCredit path."
                : "Royalty settlement is pending wallet/KeeperHub confirmation."
            ),
            lastEventType: state.settlementStatus === "confirmed" ? "royalty.settled" : "settlement.intent.created"
          }
        });
      },
      {
        name: "deposit_royalty_via_keeper",
        description: "Record royalty settlement once the atomic spendCredit path confirms creator payment.",
        schema: z.object({})
      }
    );
  }

  private topupCreditsViaKeeperTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        const event = requireIncomingEvent(state);
        await this.publishToolActivity(state, "distribution_mgr", "topup_credits_via_keeper", "started", "Checking auto-top-up settings for this consumer.");
        return new Command({ update: await this.handleCreditLow(state, event) });
      },
      {
        name: "topup_credits_via_keeper",
        description: "If consumer settings enable auto-top-up, prepare or submit a buyCredits transaction through KeeperHub.",
        schema: z.object({})
      }
    );
  }

  private handoffToCuratorTool() {
    return tool(
      async () => {
        const state = getCurrentTaskInput() as VoicesSwarmStateValue;
        await this.publishToolActivity(state, "distribution_mgr", "handoff_to_curator", "handoff", "Routing feedback context back to Style Curator.");
        return new Command({
          goto: "style_curator",
          graph: Command.PARENT,
          update: {
            ...appendAgentMessage("distribution_mgr", "Handing feedback context back to Style Curator."),
            activeAgent: "style_curator",
            workflowKind: "feedback_refinement"
          }
        });
      },
      {
        name: "handoff_to_curator",
        description: "Command handoff back to Style Curator when feedback severity warrants profile refinement.",
        schema: z.object({})
      }
    );
  }

  start(): void {
    this.started = true;
    for (const agent of this.agents) {
      agent.status = "idle";
      agent.lastError = undefined;
    }
  }

  stop(): void {
    this.started = false;
    for (const agent of this.agents) {
      agent.status = "stopped";
    }
  }

  canHandle(event: AgentEvent): boolean {
    return event.type === "style.uploaded" || event.type === "generation.requested" || event.type === "feedback.received" || event.type === "credit.low";
  }

  handleEvent(event: AgentEvent): void {
    if (!this.started || !this.canHandle(event)) {
      return;
    }

    const activeAgent = activeAgentForEvent(event);
    const task = this.invokeForEvent(event, activeAgent)
      .catch(async (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.markError(activeAgent, reason);
        await this.publishAgentFailure(event, activeAgent, reason);
      })
      .finally(() => {
        this.markIdle(activeAgent);
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  status(): { started: boolean; agents: Array<{ name: string; status: AgentStatus; subscribedEvents: readonly EventType[]; lastError?: string }> } {
    return {
      started: this.started,
      agents: this.agents.map((agent) => ({
        name: agent.displayName,
        status: agent.status,
        subscribedEvents: agent.subscribedEvents,
        lastError: agent.lastError
      }))
    };
  }

  private async publishToolActivity(
    state: VoicesSwarmStateValue,
    agent: VoicesAgentName,
    toolName: string,
    status: AgentActivityStatus,
    message: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const event = requireIncomingEvent(state);
    const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
    await this.deps.publish({
      id: `${event.id}:agent.activity:${createUlid()}`,
      type: "agent.activity",
      timestamp: Date.now(),
      actor: agent,
      styleId: state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, undefined),
      consumerAddress: state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, undefined),
      payload: {
        requestId,
        sourceEventId: event.id,
        agent,
        agentLabel: agentLabel(agent),
        tool: toolName,
        status,
        message,
        langGraphThread: `voices:${requestId}`,
        ...details
      }
    });
  }

  private async publishCrewActivity(state: VoicesSwarmStateValue, activity: CrewAiActivity): Promise<void> {
    const event = requireIncomingEvent(state);
    const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
    await this.deps.publish({
      id: `${event.id}:agent.activity:${createUlid()}`,
      type: "agent.activity",
      timestamp: Date.now(),
      actor: "content_creator",
      styleId: state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, undefined),
      consumerAddress: state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, undefined),
      payload: {
        requestId,
        sourceEventId: event.id,
        agent: activity.agent,
        agentLabel: activity.agentLabel,
        langGraphAgent: "content_creator",
        tool: activity.tool,
        status: activity.status,
        message: activity.message,
        crewRuntime: "crewai",
        langGraphThread: `voices:${requestId}`,
        ...recordValue(activity.payload)
      }
    });
  }

  private async getStyleRegistryEvidence(styleId: string, state: VoicesSwarmStateValue): Promise<Record<string, unknown>> {
    try {
      const style = await this.deps.chain.styleOf(styleId);
      return {
        styleId,
        creator: style.creator,
        royaltyWei: style.royaltyWei.toString(),
        totalEarnings: style.totalEarnings.toString(),
        sampleCount: style.sampleCount,
        listed: style.listed,
        encryptedSamplesURI: style.encryptedSamplesURI,
        profileURI: style.profileURI,
        language: style.language,
        genres: style.genres,
        attestationURI: style.attestationURI,
        metadataHash: style.metadataHash
      };
    } catch {
      return {
        styleId,
        creator: state.creatorAddress,
        royaltyWei: state.royaltyAmount,
        profileURI: state.profileKey ? `0g://kv/${state.profileKey}` : undefined
      };
    }
  }

  private async getAgentBrainEvidence(styleId: string, profile: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const pendingStyleId = stringValue(profile.pendingStyleId, undefined);
    const keys = [
      `style:${styleId}:agentBrain`,
      pendingStyleId ? `style:${pendingStyleId}:agentBrain` : undefined
    ].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const manifest = await this.deps.storage.kvGet<Record<string, unknown>>(key).catch(() => null);
      if (manifest) {
        return { ...manifest, kv_key: key };
      }
    }
    return undefined;
  }

  private async getCrewMemoryEvidence(
    styleId: string,
    consumerAddress: string,
    profile: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>>> {
    const pendingStyleId = stringValue(profile.pendingStyleId, undefined);
    const streams = [
      `style:${styleId}:memory`,
      pendingStyleId ? `style:${pendingStyleId}:memory` : undefined,
      consumerAddress ? `consumer:${consumerAddress}:history` : undefined
    ].filter((stream): stream is string => Boolean(stream));
    const entries: Array<Record<string, unknown>> = [];
    for (const stream of streams) {
      const scan = await this.deps.storage.logScan<Record<string, unknown>>(stream, "", undefined).catch(() => []);
      entries.push(
        ...scan.slice(-8).map((entry) => ({
          stream,
          key: entry.key,
          value: entry.value
        }))
      );
    }
    return entries.slice(-18);
  }

  private async persistCrewMemory(
    state: VoicesSwarmStateValue,
    input: {
      styleId: string;
      consumerAddress: string;
      prompt: string;
      draft: string;
      crew: CrewAiGenerationResult;
    }
  ): Promise<void> {
    const event = requireIncomingEvent(state);
    const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
    const memory = {
      requestId,
      sourceEventId: event.id,
      styleId: input.styleId,
      consumerAddress: input.consumerAddress,
      prompt: input.prompt,
      draft: input.draft,
      critique: input.crew.critique,
      feedback: stringValue(recordValue(input.crew.memoryPatch).feedback, undefined),
      learned_preferences: stringArray(recordValue(input.crew.memoryPatch).learned_preferences),
      revisionCount: input.crew.revisionCount ?? 0,
      runtime: input.crew.runtime,
      compute: crewAiComputeEvidence(input.crew, "crewai_voice_generation"),
      langGraphThread: `voices:${requestId}`,
      timestamp: Date.now()
    };
    const stream = `style:${input.styleId}:memory`;
    const key = `crew:${event.id}`;
    this.queueHistoryLogAppend(stream, key, memory, "CrewAI voice memory append");
    void this.deps.storage.kvSet(`style:${input.styleId}:crewMemory`, {
      latest: memory,
      updatedAt: Date.now()
    }).catch((error) => {
      console.warn("CrewAI voice memory KV sync failed", error);
    });
  }

  private async invokeForEvent(event: AgentEvent, activeAgent: VoicesAgentName): Promise<void> {
    this.markBusy(activeAgent);
    const requestId = requestIdFromEvent(event) ?? event.id;
    const state = initialStateFromEvent(event, activeAgent);
    await this.deps.publish({
      id: `${event.id}:agent.activity:${createUlid()}`,
      type: "agent.activity",
      timestamp: Date.now(),
      actor: activeAgent,
      styleId: event.styleId ?? stringValue(event.payload.styleId, undefined),
      consumerAddress: event.consumerAddress ?? stringValue(event.payload.consumerAddress, undefined),
      payload: {
        requestId,
        sourceEventId: event.id,
        agent: activeAgent,
        agentLabel: agentLabel(activeAgent),
        tool: "langgraph.invoke",
        status: "started",
        message: `${agentLabel(activeAgent)} accepted ${event.type}.`,
        langGraphThread: `voices:${requestId}`
      }
    });
    const stream = await this.app.stream(state, {
      configurable: {
        thread_id: `voices:${requestId}`,
        checkpoint_ns: "runtime"
      },
      streamMode: "values"
    });
    for await (const _chunk of stream) {
      // Iterating the stream drives LangGraph execution and persists each checkpoint.
    }
    await this.deps.publish({
      id: `${event.id}:agent.activity:${createUlid()}`,
      type: "agent.activity",
      timestamp: Date.now(),
      actor: activeAgent,
      styleId: event.styleId ?? stringValue(event.payload.styleId, undefined),
      consumerAddress: event.consumerAddress ?? stringValue(event.payload.consumerAddress, undefined),
      payload: {
        requestId,
        sourceEventId: event.id,
        agent: activeAgent,
        agentLabel: agentLabel(activeAgent),
        tool: "langgraph.invoke",
        status: "completed",
        message: `${agentLabel(activeAgent)} finished the LangGraph run.`,
        langGraphThread: `voices:${requestId}`
      }
    });
  }

  private async refineStyle(state: VoicesSwarmStateValue, event: AgentEvent): Promise<VoicesSwarmUpdate> {
    const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
    const styleId = event.styleId ?? stringValue(event.payload.styleId, "");
    const feedback = feedbackText(event.payload);
    if (!styleId || !isMeaningfulFeedback(feedback, event.payload)) {
      await this.publishToolActivity(state, "style_curator", "refine_profile_from_feedback", "completed", "Feedback was not specific enough to change the profile.");
      return appendAgentMessage("style_curator", "Feedback was not specific enough to refine the style profile.");
    }

    const profileKey = await this.resolveProfileKey(styleId);
    const existing = await this.deps.storage.kvGet<Record<string, unknown>>(profileKey);
    if (!existing) {
      await this.publishToolActivity(state, "style_curator", "refine_profile_from_feedback", "failed", `No profile found for style ${styleId}.`, {
        styleId
      });
      return {
        ...appendAgentMessage("style_curator", `No profile found for style ${styleId}; refinement skipped.`),
        lastError: `Missing style profile for ${styleId}`
      };
    }

    const consumerAddress = event.consumerAddress ?? stringValue(event.payload.consumerAddress, "");
    const recentHistory = consumerAddress
      ? await this.deps.storage.logScan(`consumer:${consumerAddress}:history`, "", undefined)
      : [];
    const compute = await this.deps.compute.chat(
      styleRefinementPrompt({ existingProfile: existing, feedback, recentHistory: recentHistory.slice(-8) }),
      { maxRetries: 1, maxTokens: 500 }
    );
    const delta = parseTaggedJson(compute.content, "style_profile_delta");
    if (delta.meaningful_change === false) {
      await this.publishToolActivity(state, "style_curator", "refine_profile_from_feedback", "completed", "0G Compute judged the feedback too weak for a profile update.", {
        styleId,
        teeVerified: compute.teeVerified ?? compute.verified,
        compute: computeEvidence(compute, "style_profile_refinement")
      });
      return appendAgentMessage("style_curator", "Feedback did not justify a profile update.");
    }

    const refined = {
      ...existing,
      ...recordValue(delta.updated_profile_patch),
      recentFeedback: feedback,
      lastRefinementReason: stringValue(delta.reason, "feedback.received"),
      lastRefinementQualitySignal: stringValue(delta.quality_signal, "mixed"),
      lastRefinementTeeVerified: compute.teeVerified ?? compute.verified,
      lastRefinementCompute: computeEvidence(compute, "style_profile_refinement"),
      refinementCount: Number(existing.refinementCount ?? 0) + 1,
      langGraphThread: `voices:${requestId}`,
      updatedAt: Date.now()
    };
    await this.deps.storage.kvSet(profileKey, refined);
    await this.deps.publish({
      id: `${event.id}:style.refined`,
      type: "style.refined",
      timestamp: Date.now(),
      actor: "system",
      styleId,
      payload: { requestId, profileKey, reason: "feedback.received", langGraphThread: `voices:${requestId}` }
    });
    await this.publishToolActivity(state, "style_curator", "refine_profile_from_feedback", "completed", "Profile patch stored and style.refined emitted.", {
      styleId,
      profileKey,
      teeVerified: compute.teeVerified ?? compute.verified,
      compute: computeEvidence(compute, "style_profile_refinement")
    });

    return {
      ...appendAgentMessage("style_curator", `Profile ${styleId} refined from feedback.`),
      currentStyleId: styleId,
      lastEventType: "style.refined",
      lastError: undefined
    };
  }

  private async handleCreditLow(state: VoicesSwarmStateValue, event: AgentEvent): Promise<VoicesSwarmUpdate> {
    const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
    const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
    const settings = await this.deps.storage.kvGet<{ autoTopUp?: boolean; topUpCredits?: string }>(
      `consumer:${consumerAddress}:settings`
    );
    if (!settings?.autoTopUp) {
      await this.publishToolActivity(state, "distribution_mgr", "topup_credits_via_keeper", "completed", "Auto-top-up is disabled, so no transaction was prepared.", {
        consumerAddress
      });
      return appendAgentMessage("distribution_mgr", `Auto-top-up is disabled for ${consumerAddress}; no transaction was prepared.`);
    }

    const intent = await this.deps.chain.buyCreditsIntent(BigInt(settings.topUpCredits ?? "5"));
    const result = await this.deps.keeperhub.executeTransaction(intent);
    await this.deps.publish({
      id: `${event.id}:credit.replenished`,
      type: "credit.replenished",
      timestamp: Date.now(),
      actor: "system",
      styleId: state.currentStyleId ?? event.styleId,
      consumerAddress,
      payload: {
        requestId,
        status: result.status,
        workflowId: result.workflowId,
        reason: result.reason,
        langGraphThread: `voices:${requestId}`
      }
    });
    await this.publishToolActivity(state, "distribution_mgr", "topup_credits_via_keeper", "completed", "Auto-top-up workflow was prepared through KeeperHub.", {
      consumerAddress,
      status: result.status,
      workflowId: result.workflowId
    });
    return {
      ...appendAgentMessage("distribution_mgr", `Auto-top-up workflow prepared for ${consumerAddress}.`),
      lastEventType: "credit.replenished"
    };
  }

  private async extractProfile(
    samples: string[],
    metadata: Record<string, unknown>
  ): Promise<{ compute: AgentChatResult; profile: Record<string, unknown> }> {
    const attempts = [
      { samples, metadata, maxTokens: 2200 },
      {
        samples: compactSamplesForParseRetry(samples),
        metadata: { ...metadata, retry: "json_parse_safe_compact_profile" },
        maxTokens: 1800
      }
    ];
    let lastError: unknown;

    for (const attempt of attempts) {
      try {
        const compute = await this.deps.compute.chat(styleExtractionPrompt(attempt.samples, attempt.metadata), {
          maxRetries: 1,
          maxTokens: attempt.maxTokens,
          model: highQualityGenerationModel(),
          temperature: generationTemperature(),
          topP: generationTopP()
        });
        return {
          compute,
          profile: await this.parseTaggedJsonWithRepair(compute.content, "style_profile")
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async generateDetailedStyleGuide(
    samples: string[],
    profile: Record<string, unknown>,
    metadata: Record<string, unknown>
  ): Promise<{ guide: Record<string, unknown>; compute: AgentChatResult }> {
    const compute = await this.deps.compute.chat(
      detailedStyleGuidePrompt({ samples, profile, metadata }),
      {
        maxRetries: 1,
        maxTokens: 4200,
        model: highQualityGenerationModel(),
        temperature: generationTemperature(),
        topP: generationTopP()
      }
    );
    return {
      guide: await this.parseTaggedJsonWithRepair(compute.content, "style_guide"),
      compute
    };
  }

  private async parseTaggedJsonWithRepair(content: string, tag: string): Promise<Record<string, unknown>> {
    try {
      return parseTaggedJson(content, tag);
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error);
      const repair = await this.deps.compute.chat(
        jsonRepairPrompt({ tag, content: content.slice(0, 60_000), parseError }),
        {
          maxRetries: 1,
          maxTokens: tag === "style_guide" ? 4200 : 2800,
          model: highQualityGenerationModel()
        }
      );
      return parseTaggedJson(repair.content, tag);
    }
  }

  private async resolveProfileKey(styleId: string): Promise<string> {
    const defaultKey = `style:${styleId}:profile`;
    if (await this.deps.storage.kvGet<Record<string, unknown>>(defaultKey)) {
      return defaultKey;
    }
    try {
      const style = await this.deps.chain.styleOf(styleId);
      return style.profileURI.startsWith("0g://kv/") ? style.profileURI.replace("0g://kv/", "") : style.profileURI;
    } catch {
      return defaultKey;
    }
  }

  private async getProfile(styleId: string, profileURI: string): Promise<Record<string, unknown>> {
    const candidateKeys = [
      profileURI.startsWith("0g://kv/") ? profileURI.replace("0g://kv/", "") : profileURI,
      `style:${styleId}:profile`
    ].filter(Boolean);
    for (const key of candidateKeys) {
      const profile = await this.deps.storage.kvGet<Record<string, unknown>>(key);
      if (profile) {
        return profile;
      }
    }
    throw new Error(`Missing style profile for ${styleId}`);
  }

  private queueHistoryLogAppend<T>(streamId: string, key: string, value: T, label: string): void {
    void this.deps.storage.logAppend(streamId, key, value).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`0G Storage ${label} failed for ${streamId}:${key}: ${reason}`);
    });
  }

  private async publishStyleFailure(event: AgentEvent, requestId: string, reason: string): Promise<void> {
    await this.deps.publish({
      id: `${event.id}:style.failed`,
      type: "style.failed",
      timestamp: Date.now(),
      actor: "system",
      styleId: event.styleId,
      consumerAddress: event.consumerAddress,
      payload: { requestId, sourceEventId: event.id, agent: "Style Curator", reason }
    });
  }

  private async publishGenerationFailure(event: AgentEvent, requestId: string, reason: string): Promise<void> {
    await this.deps.publish({
      id: `${event.id}:generation.failed`,
      type: "generation.failed",
      timestamp: Date.now(),
      actor: "system",
      styleId: event.styleId,
      consumerAddress: event.consumerAddress,
      payload: { requestId, sourceEventId: event.id, agent: "Content Creator", reason }
    });
  }

  private async publishAgentFailure(event: AgentEvent, activeAgent: VoicesAgentName, reason: string): Promise<void> {
    if (activeAgent === "content_creator") {
      await this.publishGenerationFailure(event, requestIdFromEvent(event) ?? event.id, reason);
      return;
    }
    await this.publishStyleFailure(event, requestIdFromEvent(event) ?? event.id, reason);
  }

  private markBusy(agentName: VoicesAgentName): void {
    const agent = this.agents.find((item) => item.graphName === agentName);
    if (agent) {
      agent.status = "busy";
      agent.lastError = undefined;
    }
  }

  private markIdle(agentName: VoicesAgentName): void {
    const agent = this.agents.find((item) => item.graphName === agentName);
    if (agent && agent.status !== "error") {
      agent.status = this.started ? "idle" : "stopped";
    }
  }

  private markError(agentName: VoicesAgentName, reason: string): void {
    const agent = this.agents.find((item) => item.graphName === agentName);
    if (agent) {
      agent.status = "error";
      agent.lastError = reason;
    }
  }
}

class VoicesPlannerModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly toolNames: string[];

  constructor(private readonly agentName: VoicesAgentName, toolNames: string[] = []) {
    super({});
    this.toolNames = toolNames;
  }

  _llmType(): string {
    return "voices-langgraph-planner";
  }

  _combineLLMOutput(): never[] {
    return [];
  }

  bindTools(tools: Array<{ name?: string }>): VoicesPlannerModel {
    return new VoicesPlannerModel(
      this.agentName,
      tools.map((candidate) => candidate.name).filter((name): name is string => typeof name === "string")
    );
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const nextTool = this.nextTool(messages);
    const message = nextTool
      ? new AIMessage({
          content: `${this.agentName} is calling ${nextTool}.`,
          tool_calls: [
            {
              id: `${this.agentName}_${Date.now()}`,
              name: nextTool,
              args: {},
              type: "tool_call"
            }
          ]
        })
      : new AIMessage({ content: `${this.agentName} completed its current step.` });

    return {
      generations: [
        {
          text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          message
        }
      ]
    };
  }

  private nextTool(messages: BaseMessage[]): string | undefined {
    const transcript = messagesToPlannerText(messages);
    if (workflowShouldStop(transcript)) {
      return undefined;
    }
    const workflowOrder = preferredToolOrder(this.agentName, transcript).filter((toolName) =>
      this.toolNames.includes(toolName)
    );
    for (const candidate of workflowOrder) {
      if (!toolHasRun(candidate, messages, transcript)) {
        return candidate;
      }
    }
    return undefined;
  }
}

class ZeroGToolPlannerModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly toolNames: string[];

  constructor(
    private readonly agentName: VoicesAgentName,
    private readonly compute: AgentCompute,
    toolNames: string[] = []
  ) {
    super({});
    this.toolNames = toolNames;
  }

  _llmType(): string {
    return "0g-compute-tool-planner";
  }

  _combineLLMOutput(): never[] {
    return [];
  }

  bindTools(tools: Array<{ name?: string }>): ZeroGToolPlannerModel {
    return new ZeroGToolPlannerModel(
      this.agentName,
      this.compute,
      tools.map((candidate) => candidate.name).filter((name): name is string => typeof name === "string")
    );
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const transcript = messagesToPlannerText(messages);
    if (workflowShouldStop(transcript)) {
      return toChatResult(new AIMessage({ content: `${this.agentName} stopped after a terminal workflow result.` }));
    }
    const pendingTools = preferredToolOrder(this.agentName, transcript)
      .filter((toolName) => this.toolNames.includes(toolName))
      .filter((toolName) => !toolHasRun(toolName, messages, transcript));
    const nextRequiredTool = pendingTools[0];
    if (!nextRequiredTool) {
      return toChatResult(new AIMessage({ content: `${this.agentName} completed its current step.` }));
    }

    const result = await this.compute.chat(
      [
        {
          role: "system",
          content: [
            "You are selecting the next LangGraph ReAct tool call.",
            "Return only JSON. Use this schema: {\"tool\":\"tool_name_or_final\",\"args\":{},\"final\":\"optional final response\"}.",
            "The workflow order is strict. Choose the required tool exactly. Choose final only when no required tool remains.",
            `Agent: ${this.agentName}`,
            `Required next tool: ${nextRequiredTool}`,
            `Remaining workflow tools after this one: ${JSON.stringify(pendingTools.slice(1))}`
          ].join("\n")
        },
        {
          role: "user",
          content: transcript
        }
      ],
      { maxRetries: 1, maxTokens: 220 }
    );

    const decision = parsePlannerDecision(result.content);
    const toolName = decision.tool === nextRequiredTool ? decision.tool : nextRequiredTool;
    return toChatResult(
      new AIMessage({
        content: `${this.agentName} chose ${toolName}.`,
        tool_calls: [
          {
            id: `${this.agentName}_${Date.now()}`,
            name: toolName,
            args: decision.tool === nextRequiredTool ? decision.args ?? {} : {},
            type: "tool_call"
          }
        ]
      })
    );
  }
}

function createPlannerModel(agentName: VoicesAgentName, compute: AgentCompute): BaseChatModel {
  const plannerMode = process.env.AGENT_LANGGRAPH_PLANNER_MODE;
  const liveCompute = process.env.AGENT_COMPUTE_MODE === "0g" || process.env.AGENT_COMPUTE_MODE === "live";
  const useZeroGPlanner = plannerMode === "0g" || plannerMode === "live" || (plannerMode !== "deterministic" && liveCompute);
  return useZeroGPlanner ? new ZeroGToolPlannerModel(agentName, compute) : new VoicesPlannerModel(agentName);
}

function preferredToolOrder(agentName: VoicesAgentName, transcript: string): string[] {
  if (agentName === "style_curator") {
    if (transcript.includes("feedback.received")) {
      return ["refine_profile_from_feedback"];
    }
    return ["verify_attestation", "encrypt_and_store_samples", "extract_style_profile", "build_and_upload_agent_brain", "mint_inft"];
  }

  if (agentName === "content_creator") {
    return [
      "check_credit_balance",
      "read_style_profile",
      "pull_relevant_samples",
      "generate_with_voice",
      "log_draft",
      "handoff_to_distribution"
    ];
  }

  if (transcript.includes("credit.low")) {
    return ["topup_credits_via_keeper"];
  }

  return ["tune_for_platform"];
}

function toolHasRun(toolName: string, messages: BaseMessage[], transcript: string): boolean {
  if (messages.some((message) => isToolMessage(message) && message.name === toolName)) {
    return true;
  }

  const markers: Record<string, string[]> = {
    verify_attestation: ["Creator attestation verified", "Attestation rejected"],
    encrypt_and_store_samples: ["Encrypted samples stored", "Sample storage failed"],
    extract_style_profile: ["Structured style profile extracted", "Style extraction failed"],
    build_and_upload_agent_brain: ["AgentBrain manifest uploaded", "AgentBrain upload failed"],
    mint_inft: ["Mint intent prepared", "Mint intent failed"],
    refine_profile_from_feedback: ["refined from feedback", "refinement skipped", "Feedback was not specific"],
    check_credit_balance: ["generation credit", "No credits available"],
    read_style_profile: ["Loaded style profile", "is no longer listed"],
    pull_relevant_samples: ["voice example"],
    generate_with_voice: ["Draft generated", "Generation failed"],
    log_draft: ["generation.drafted emitted", "Draft emitted", "Draft event emitted", "0G history log append is syncing"],
    handoff_to_distribution: ["Handing off style"],
    tune_for_platform: ["Platform variants created", "Selected output format created", "Selected output format emitted", "Spend-credit transaction intent prepared"],
    deduct_credit_via_keeper: ["Credit spend submitted"],
    deposit_royalty_via_keeper: ["Royalty settlement"],
    topup_credits_via_keeper: ["Auto-top-up"],
    handoff_to_content_creator: ["Handing off to Content Creator"],
    handoff_to_curator: ["Handing feedback context back"]
  };

  return (markers[toolName] ?? []).some((marker) => transcript.includes(marker));
}

function workflowShouldStop(transcript: string): boolean {
  return [
    "Attestation rejected",
    "Sample storage failed",
    "Style extraction failed",
    "AgentBrain upload failed",
    "Mint intent failed",
    "Generation failed",
    "Style is no longer listed",
    "Selected output format created",
    "Selected output format emitted",
    "Spend-credit transaction intent prepared",
    "generation.published",
    "settlement.intent.created"
  ].some((marker) => transcript.includes(marker));
}

function toChatResult(message: AIMessage): ChatResult {
  return {
    generations: [
      {
        text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        message
      }
    ]
  };
}

function computeEvidence(compute: AgentChatResult, purpose: string): Record<string, unknown> {
  return {
    purpose,
    provider: compute.providerAddress,
    serviceUrl: compute.serviceUrl,
    model: compute.model,
    chatId: compute.chatId,
    teeVerified: compute.teeVerified ?? compute.verified ?? null,
    inputTokens: compute.inputTokens,
    outputTokens: compute.outputTokens,
    durationMs: compute.durationMs,
    path: compute.computePath
  };
}

function crewAiComputeEvidence(crew: CrewAiGenerationResult, purpose: string): Record<string, unknown> {
  const calls = crew.computeCalls ?? [];
  const lastCall = calls.at(-1);
  return {
    purpose,
    provider: lastCall?.provider,
    serviceUrl: lastCall?.serviceUrl,
    model: lastCall?.model,
    chatId: lastCall?.chatId,
    teeVerified: calls.length > 0 ? calls.every((call) => call.teeVerified !== false) : null,
    inputTokens: sumOptional(calls.map((call) => call.inputTokens)),
    outputTokens: sumOptional(calls.map((call) => call.outputTokens)),
    durationMs: sumOptional(calls.map((call) => call.durationMs)),
    path: "crewai",
    runtime: crew.runtime,
    revisionCount: crew.revisionCount ?? 0,
    calls
  };
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function messagesToPlannerText(messages: BaseMessage[]): string {
  return messages
    .slice(-40)
    .map((message) => {
      const name = "name" in message && typeof message.name === "string" ? `${message.name}: ` : "";
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return `${message.getType()} ${name}${content}`;
    })
    .join("\n\n");
}

function parsePlannerDecision(content: string): { tool?: string; args?: Record<string, unknown>; final?: string } {
  try {
    const parsed = JSON.parse(extractFirstJsonObject(stripCodeFence(content))) as Record<string, unknown>;
    return {
      tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
      args: recordValue(parsed.args),
      final: typeof parsed.final === "string" ? parsed.final : undefined
    };
  } catch {
    return { final: content };
  }
}

const STYLE_CURATOR_PROMPT = [
  "You are the Style Curator agent for Voices on 0G.",
  "Verify creator attestation before any style work. When samples are insufficient or attestation is invalid, stop with a clear error.",
  "Use tools for deterministic crypto checks, encrypted 0G Storage writes, 0G Compute style extraction, profile refinement, and mint intent preparation.",
  "Do not call the Content Creator directly. State transitions and handoffs happen through LangGraph state and Command objects."
].join("\n");

const CONTENT_CREATOR_PROMPT = [
  "You are the Content Creator agent for Voices on 0G.",
  "Read the style profile, choose relevant sample excerpts, generate a fresh draft with 0G Compute, and never invent facts not supplied by the user.",
  "After a draft is ready, hand off to the Distribution Manager through LangGraph Command routing."
].join("\n");

const DISTRIBUTION_MANAGER_PROMPT = [
  "You are the Distribution Manager agent for Voices on 0G.",
  "Validate the single selected output format and prepare one wallet-signable spend-credit settlement intent.",
  "After generation.published or settlement.intent.created, stop. Do not recheck credits, do not submit KeeperHub settlement, and do not call extra tools.",
  "Only use top-up tooling when the incoming event is credit.low."
].join("\n");

function agentLabel(agent: VoicesAgentName): string {
  if (agent === "style_curator") {
    return "Style Curator";
  }
  if (agent === "content_creator") {
    return "Content Creator";
  }
  return "Distribution Manager";
}

function activeAgentForEvent(event: AgentEvent): VoicesAgentName {
  if (event.type === "generation.requested") {
    return "content_creator";
  }
  if (event.type === "credit.low") {
    return "distribution_mgr";
  }
  return "style_curator";
}

function workflowKindForEvent(event: AgentEvent): VoicesWorkflowKind {
  if (event.type === "generation.requested") {
    return "generation";
  }
  if (event.type === "feedback.received") {
    return "feedback_refinement";
  }
  if (event.type === "credit.low") {
    return "credit_low";
  }
  return "style_upload";
}

function initialStateFromEvent(event: AgentEvent, activeAgent: VoicesAgentName): Partial<VoicesSwarmStateValue> {
  const requestId = requestIdFromEvent(event) ?? event.id;
  return {
    messages: [new HumanMessage({ content: `${event.type}: ${event.id}` })],
    activeAgent,
    workflowKind: workflowKindForEvent(event),
    incomingEvent: event,
    requestId,
    currentStyleId: event.styleId ?? stringValue(event.payload.styleId, undefined),
    pendingStyleId: undefined,
    consumerAddress: event.consumerAddress ?? stringValue(event.payload.consumerAddress, undefined),
    creatorAddress: event.type === "style.uploaded" ? event.actor : undefined,
    prompt: stringValue(event.payload.prompt, undefined),
    targetPlatforms: normalizeGenerationPlatforms(arrayValue(event.payload.platforms, ["x"])),
    draftText: stringValue(event.payload.draft, undefined),
    lastEventType: event.type,
    lastError: undefined
  };
}

function requireIncomingEvent(state: VoicesSwarmStateValue): AgentEvent {
  if (!state.incomingEvent) {
    throw new Error("LangGraph state is missing incomingEvent");
  }
  return state.incomingEvent;
}

function validateAttestation(actor: string, message: string, signature: string): void {
  if (!message || !signature) {
    throw new Error("Missing wallet-signed attestation");
  }
  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== actor.toLowerCase()) {
    throw new Error("Attestation signature does not match creator wallet");
  }
}

function validateSamples(samples: string[]): void {
  const text = samples.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < MIN_SAMPLE_BYTES) {
    throw new Error("Writing sample must be at least 1KB of text");
  }
  if (bytes > MAX_SAMPLE_BYTES) {
    throw new Error("Writing sample must be under 1MB of text");
  }
}

function parseTaggedJson(content: string, tag: string): Record<string, unknown> {
  const cleaned = stripCodeFence(content);
  const tagged = matchTaggedContent(cleaned, tag);
  const source = stripCodeFence(tagged ?? stripLooseTag(cleaned, tag));
  const candidate = normalizeJsonObjectSource(source);

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Tagged response was not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const snippet = cleaned.replace(/\s+/g, " ").slice(0, 240);
    const reason = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Could not parse ${tag} JSON from 0G Compute response: ${reason}. Response starts: ${snippet}`);
  }
}

function normalizeJsonObjectSource(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    return extractFirstJsonObject(trimmed);
  }
  const lastBrace = trimmed.lastIndexOf("}");
  const body = lastBrace >= 0 ? trimmed.slice(0, lastBrace + 1) : trimmed;
  if (body.trim().endsWith("}")) {
    return `{${body.trim()}`;
  }
  return `{${body.trim().replace(/,\s*$/, "")}}`;
}

function stripLooseTag(content: string, tag: string): string {
  return content
    .replace(new RegExp(`<${tag}[^>]*>`, "gi"), "")
    .replace(new RegExp(`<\\/${tag}>`, "gi"), "")
    .trim();
}

const ALLOWED_GENERATION_PLATFORMS = new Set(["x", "thread", "instagram", "blog", "github_readme"]);
const THREAD_TWEET_MAX_CHARS = 220;
const THREAD_MAX_TWEETS = 5;

function generationPlatforms(state: VoicesSwarmStateValue, event: AgentEvent): string[] {
  return normalizeGenerationPlatforms(state.targetPlatforms.length > 0 ? state.targetPlatforms : arrayValue(event.payload.platforms, ["x"]));
}

function normalizeGenerationPlatforms(values: string[]): string[] {
  for (const value of values) {
    const normalized = normalizeGenerationPlatform(value);
    if (normalized && ALLOWED_GENERATION_PLATFORMS.has(normalized)) {
      return [normalized];
    }
  }
  return ["x"];
}

function normalizeGenerationPlatform(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "twitter" || normalized === "tweet" || normalized === "tweets") return "x";
  if (normalized === "x") return "x";
  if (normalized === "thread" || normalized === "tweet_thread" || normalized === "twitter_thread") return "thread";
  if (normalized === "linked_in" || normalized === "linkedin") return "thread";
  if (normalized === "ig" || normalized === "instagram" || normalized === "caption") return "instagram";
  if (normalized === "blogger" || normalized === "blogger_article" || normalized === "blog_article" || normalized === "article" || normalized === "blog") return "blog";
  if (normalized === "github" || normalized === "github_readme" || normalized === "readme" || normalized === "github_readme_file") return "github_readme";
  return normalized;
}

function maxTokensForPlatforms(platforms: string[], stage: "draft" | "platform"): number {
  const hasLongForm = platforms.some((platform) => platform === "blog" || platform === "github_readme");
  if (hasLongForm) {
    return stage === "draft" ? 2600 : 3200;
  }
  if (platforms.some((platform) => platform === "thread")) {
    return stage === "draft" ? 1100 : 1200;
  }
  if (platforms.some((platform) => platform === "instagram")) {
    return stage === "draft" ? 1200 : 1400;
  }
  return stage === "draft" ? 550 : 650;
}

function generationComputeOptions(platforms: string[], stage: "draft" | "platform") {
  return {
    maxRetries: 1,
    maxTokens: maxTokensForPlatforms(platforms, stage),
    model: highQualityGenerationModel(),
    temperature: generationTemperature(),
    topP: generationTopP()
  };
}

function highQualityGenerationModel(): string | undefined {
  return process.env.OG_COMPUTE_GENERATION_MODEL?.trim() || process.env.OG_COMPUTE_HIGH_QUALITY_MODEL?.trim() || undefined;
}

function generationTemperature(): number | undefined {
  return optionalNumberEnv("OG_COMPUTE_GENERATION_TEMPERATURE") ?? 0.7;
}

function generationTopP(): number | undefined {
  return optionalNumberEnv("OG_COMPUTE_GENERATION_TOP_P") ?? 0.95;
}

function optionalNumberEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function shouldTuneDistributionWithCompute(): boolean {
  const mode = process.env.AGENT_DISTRIBUTION_COMPUTE_TUNING?.trim().toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") {
    return false;
  }
  if (mode === "0g" || mode === "live" || mode === "on" || mode === "true" || mode === "1") {
    return true;
  }
  return false;
}

function parseVariants(content: string, draft: string, platforms: string[], prompt: string): Record<string, string> {
  try {
    const parsed = JSON.parse(extractFirstJsonObject(stripCodeFence(content))) as Record<string, string>;
    return Object.fromEntries(
      platforms.map((platform) => {
        const fallback = draft || prompt;
        return [platform, formatVariantForPlatform(platform, parsed[platform] ?? fallback, fallback)];
      })
    );
  } catch {
    return variantsFromDraft(draft, platforms, prompt);
  }
}

function variantsFromDraft(draft: string, platforms: string[], prompt: string): Record<string, string> {
  return Object.fromEntries(
    platforms.map((platform) => {
      const fallback = draft || prompt;
      return [platform, formatVariantForPlatform(platform, draft, fallback)];
    })
  );
}

function finalizeGeneratedDraft(draft: string): string {
  const cleaned = cleanGeneratedText(draft);
  if (!cleaned) {
    throw new Error("0G Compute returned an empty draft");
  }
  return cleaned;
}

function cleanVariantText(value: string, fallback: string): string {
  const cleaned = cleanGeneratedText(value);
  return cleaned || cleanGeneratedText(fallback) || fallback.trim();
}

function formatVariantForPlatform(platform: string, value: string, fallback: string): string {
  const cleaned = cleanVariantText(value, fallback);
  if (platform === "x") {
    return tweetSized(cleaned, 260);
  }
  if (platform === "thread") {
    return tweetThread(cleaned, fallback);
  }
  return cleaned;
}

function tweetThread(value: string, fallback: string): string {
  let parts = threadPartsFrom(value);
  if (parts.length < 3) {
    const fallbackParts = threadPartsFrom(fallback);
    if (threadWordCount(fallbackParts) > threadWordCount(parts)) {
      parts = fallbackParts;
    }
  }
  parts = splitLongThreadParts(
    mergeThreadFragments(ensureThreadIdeaCount(parts, fallback || value)),
    THREAD_TWEET_MAX_CHARS - 6,
    THREAD_MAX_TWEETS
  ).slice(0, THREAD_MAX_TWEETS);
  const selected = parts.length > 0 ? parts : [stripThreadPrefix(value)];
  const count = Math.min(THREAD_MAX_TWEETS, selected.length);
  const tweets = selected.slice(0, count).map((part, index) => {
    const prefix = `${index + 1}/${count} `;
    return `${prefix}${tweetSized(part, THREAD_TWEET_MAX_CHARS - prefix.length)}`;
  });
  return tweets.join("\n\n");
}

function threadPartsFrom(value: string): string[] {
  const numbered = splitNumberedThread(value);
  const parts = numbered.length >= 2 ? numbered : splitIntoTweetIdeas(value);
  return normalizeThreadParts(parts);
}

function splitNumberedThread(value: string): string[] {
  const cleaned = cleanGeneratedText(value).replace(/\r/g, "").trim();
  const markerPattern = /(^|\n)\s*(?:\d+\s*\/\s*\d+|\d+\s*[\).:-])\s*(?:[-*\u2022]\s*)?/g;
  const markers = [...cleaned.matchAll(markerPattern)];
  if (markers.length < 2) {
    return [];
  }
  return markers.map((marker, index) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? cleaned.length;
    return cleaned.slice(start, end).trim();
  });
}

function normalizeThreadParts(parts: string[]): string[] {
  return parts
    .map(stripThreadPrefix)
    .filter((part) => part.length > 0 && !/^(?:#\w+\s*)+$/.test(part));
}

function stripThreadPrefix(value: string): string {
  let result = cleanGeneratedText(value).replace(/\s+/g, " ").trim();
  for (let index = 0; index < 4; index += 1) {
    const stripped = result
      .replace(/^(?:[-*\u2022]\s*)?(?:\d+\s*\/\s*\d+|\d+\s*[\).:-])\s*(?:[-*\u2022]\s*)?/, "")
      .trim();
    if (stripped === result) {
      break;
    }
    result = stripped;
  }
  return result.replace(/^[-*\u2022]\s+/, "").trim();
}

function threadWordCount(parts: string[]): number {
  return parts.reduce((count, part) => count + part.split(/\s+/).filter(Boolean).length, 0);
}

function mergeThreadFragments(parts: string[]): string[] {
  const merged: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const current = stripThreadPrefix(parts[index] ?? "");
    if (!current) {
      continue;
    }
    const next = stripThreadPrefix(parts[index + 1] ?? "");
    if (next && shouldMergeThreadFragment(current, next)) {
      merged.push(`${current.replace(/:\s*$/, "")}: ${next}`);
      index += 1;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function shouldMergeThreadFragment(current: string, next: string): boolean {
  const currentWords = current.split(/\s+/).filter(Boolean).length;
  const nextWords = next.split(/\s+/).filter(Boolean).length;
  return /:\s*$/.test(current) && currentWords <= 8 && nextWords <= 12;
}

function splitLongThreadParts(parts: string[], maxBodyChars: number, maxParts: number): string[] {
  const result: string[] = [];
  for (const part of parts) {
    const cleaned = stripThreadPrefix(part);
    if (!cleaned) {
      continue;
    }
    const remaining = maxParts - result.length;
    if (cleaned.length <= maxBodyChars || remaining <= 1) {
      result.push(cleaned);
      continue;
    }
    result.push(...splitThreadPart(cleaned, maxBodyChars, remaining));
    if (result.length >= maxParts) {
      break;
    }
  }
  return result.slice(0, maxParts);
}

function splitThreadPart(value: string, maxBodyChars: number, maxChunks: number): string[] {
  const clauses = value
    .split(/(?<=[.!?])\s+|;\s+|\s+-\s+|\s+(?=(?:and|while|without|then|those|others|creators|the platform)\b)/i)
    .map(tidyThreadChunk)
    .filter(Boolean);
  const chunks: string[] = [];
  for (const clause of clauses.length > 1 ? clauses : chunkWords(value, maxBodyChars)) {
    const cleaned = tidyThreadChunk(clause);
    if (!cleaned) {
      continue;
    }
    const last = chunks[chunks.length - 1];
    const joined = last ? `${last} ${cleaned}` : cleaned;
    if (last && joined.length <= maxBodyChars) {
      chunks[chunks.length - 1] = joined;
    } else if (cleaned.length <= maxBodyChars) {
      chunks.push(cleaned);
    } else {
      chunks.push(...chunkWords(cleaned, maxBodyChars));
    }
    if (chunks.length >= maxChunks) {
      break;
    }
  }
  return chunks.slice(0, maxChunks);
}

function chunkWords(value: string, maxBodyChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxBodyChars) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = word;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function tidyThreadChunk(value: string): string {
  return stripThreadPrefix(value)
    .replace(/^(?:and|while|then)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureThreadIdeaCount(parts: string[], fallback: string): string[] {
  const normalized = normalizeThreadParts(parts);
  if (normalized.length >= 3) {
    return normalized;
  }
  const cleaned = stripThreadMarkers(fallback).replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 12) {
    return normalized.length > 0 ? normalized : cleaned ? [cleaned] : [];
  }
  const chunkSize = Math.ceil(words.length / 3);
  const chunks = [0, 1, 2]
    .map((index) => words.slice(index * chunkSize, (index + 1) * chunkSize).join(" ").trim())
    .filter(Boolean);
  return chunks.length >= 3 ? chunks : normalized;
}

function splitIntoTweetIdeas(value: string): string[] {
  const cleaned = cleanGeneratedText(value)
    .replace(/^[-*\u2022]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
  const blocks = cleaned
    .split(/\n{2,}/)
    .map(stripThreadPrefix)
    .filter((part) => part.length > 0 && !/^#\w+/.test(part));
  if (blocks.length >= 3) {
    return blocks;
  }
  return cleaned
    .split(/(?<=[.!?])\s+/)
    .map(stripThreadPrefix)
    .filter((part) => part.length > 0 && !/^#\w+/.test(part));
}

function stripThreadMarkers(value: string): string {
  return cleanGeneratedText(value)
    .replace(/(^|\n)\s*(?:\d+\s*\/\s*\d+|\d+\s*[\).:-])\s*(?:[-*\u2022]\s*)?/g, "$1")
    .replace(/^[-*\u2022]\s+/gm, "")
    .trim();
}

function tweetSized(value: string, maxLength: number): string {
  const cleaned = cleanGeneratedText(value).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const slice = cleaned.slice(0, maxLength + 1);
  const breakAt = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "), slice.lastIndexOf("; "), slice.lastIndexOf(", "), slice.lastIndexOf(" "));
  const shortened = cleaned.slice(0, breakAt > maxLength * 0.55 ? breakAt : maxLength - 1).trim();
  return `${shortened.replace(/[,:;.!?]+$/, "")}…`;
}

function cleanGeneratedText(value: string): string {
  return stripCodeFence(value)
    .replace(/^<draft[^>]*>/i, "")
    .replace(/<\/draft>$/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\r/g, "")
    .trim();
}

function matchTaggedContent(content: string, tag: string): string | undefined {
  const pattern = new RegExp(`<\\s*${tag}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, "i");
  return content.match(pattern)?.[1]?.trim();
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

function normalizeSampleExcerpts(profile: Record<string, unknown>, samples: string[]): string[] {
  const fromProfile = stringArray(profile.sample_excerpts).concat(stringArray(profile.sampleExcerpts));
  if (fromProfile.length > 0) {
    return fromProfile.map(cleanSampleExcerpt).filter(Boolean).slice(0, 5);
  }
  return samples
    .map((sample) => cleanSampleExcerpt(sample))
    .filter(Boolean)
    .slice(0, 5)
    .map((sample) => sample.slice(0, 240));
}

function styleExcerptsFromProfile(profile: Record<string, unknown>): string[] {
  const guide = recordValue(profile.detailed_style_guide);
  const sourceProfile = recordValue(profile.source_profile);
  const examples = [
    ...stringArray(profile.sample_excerpts),
    ...stringArray(profile.sampleExcerpts),
    ...exampleTexts(guide.actual_examples),
    ...exampleTexts(recordValue(sourceProfile.twitter_profile).actual_examples),
    ...exampleTexts(recordValue(sourceProfile.readme_profile).actual_examples),
    ...exampleTexts(recordValue(sourceProfile.article_profile).actual_examples)
  ]
    .map(cleanSampleExcerpt)
    .map((example) => example.slice(0, 900))
    .filter(Boolean);

  return [...new Set(examples)].slice(0, 8);
}

function exampleTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return stringValue((item as Record<string, unknown>).text, stringValue((item as Record<string, unknown>).example, ""));
      }
      return "";
    })
    .filter(Boolean);
}

function hasDetailedStyleGuide(profile: Record<string, unknown>): boolean {
  const guide = recordValue(profile.detailed_style_guide);
  return Boolean(stringValue(guide.prompt_ready_style_brief, undefined)) && Array.isArray(guide.actual_examples) && guide.actual_examples.length > 0;
}

function buildFallbackDetailedStyleGuide(
  profile: Record<string, unknown>,
  samples: string[],
  metadata: Record<string, unknown>,
  reason: string
): Record<string, unknown> {
  const sourceKind = stringValue(metadata.sourceKind, "unknown");
  const sourceSummary = stringValue(metadata.sourceSummary, `${samples.length} submitted sample${samples.length === 1 ? "" : "s"}`);
  const examples = normalizeSampleExcerpts(profile, samples).slice(0, 5).map((text, index) => ({
    label: `Example ${index + 1}`,
    source_label: sourceSummary,
    text,
    observed_patterns: ["Representative creator-owned excerpt retained for style transfer."]
  }));
  const guideByFormat = recordValue(recordValue(profile.source_profile).generation_guidelines_by_format);
  const tweetRecipe = stringArray(guideByFormat.tweet);
  const readmeRecipe = stringArray(guideByFormat.readme);
  const articleRecipe = stringArray(guideByFormat.article);
  const doRules = stringArray(profile.do_rules).concat(stringArray(profile.doRules)).slice(0, 16);
  const dontRules = stringArray(profile.dont_rules).concat(stringArray(profile.dontRules)).slice(0, 12);

  return {
    guide_version: 1,
    generated_by: "profile-fallback",
    source_type: sourceKind,
    source_summary: sourceSummary,
    source_preservation: {
      full_input_stored_encrypted: true,
      public_report_contains_selected_examples_only: true,
      analyzed_unit_count: samples.length,
      analyzed_character_count: samples.join("\n").length
    },
    prompt_ready_style_brief: stringValue(
      profile.voice_essence,
      "Use the extracted tone, rhythm, structure, and examples as style signals while keeping all topic facts limited to the user prompt."
    ),
    voice_summary: stringValue(recordValue(profile.voice_fingerprint).fingerprint_text, stringValue(profile.voice_essence, "Profile-derived voice guide.")),
    actual_examples: examples.length > 0 ? examples : [],
    writing_patterns: {
      length_and_density: stringValue(recordValue(profile.sentence_rhythm).average_sentence_length, "balanced"),
      hooks_or_openings: stringArray(recordValue(profile.structural_patterns).openings),
      structure: stringValue(recordValue(profile.structural_patterns).argument_shape, "Concrete opening, mechanism, and careful close."),
      line_breaks_or_sectioning: stringValue(recordValue(profile.structural_patterns).paragraphing, "Use source-like paragraphing."),
      vocabulary_signals: stringArray(recordValue(profile.vocabulary).distinctive_words),
      punctuation_and_casing: stringArray(recordValue(profile.sentence_rhythm).punctuation_habits).join(", "),
      emoji_hashtag_link_cta_usage: sourceKind === "twitter" ? "Follow observed source profile; do not invent hashtags or links." : "Use only if supported by the source.",
      argument_shape: stringValue(recordValue(profile.structural_patterns).argument_shape, "State the visible mechanism and avoid unsupported certainty.")
    },
    voice_rules: doRules.length > 0 ? doRules : ["Use concrete nouns.", "Keep claims grounded in the prompt.", "Match the extracted cadence without copying source sentences."],
    avoid_rules: dontRules.length > 0 ? dontRules : ["Do not copy private examples.", "Do not invent metrics, links, or motives.", "Do not output writing instructions."],
    generation_recipe: {
      tweet: tweetRecipe.length > 0 ? tweetRecipe : ["Write one finished tweet.", "Open with the concrete point.", "Keep unsupported facts out."],
      thread: ["Use one idea per post.", "Move from mechanism to consequence."],
      readme: readmeRecipe.length > 0 ? readmeRecipe : ["Use clear headings.", "Do not invent commands, APIs, or badges."],
      article: articleRecipe.length > 0 ? articleRecipe : ["Open with a thesis.", "Use sections and careful evidence."],
      generic: ["Transfer cadence and structure, not private subject matter."]
    },
    fallback_reason: reason,
    confidence: Number(profile.confidence ?? 0.55)
  };
}

function buildProfileFromHint(hint: Record<string, unknown>): Record<string, unknown> {
  const blurb = stringValue(hint.blurb, "");
  const about = stringValue(hint.about, "");
  const tags = stringArray(hint.tags);
  const bestFor = stringArray(hint.bestFor);
  const traits = Array.isArray(hint.traits)
    ? (hint.traits as Array<Record<string, unknown>>).filter((t) => t && typeof t === "object")
    : [];
  const samples = Array.isArray(hint.samples)
    ? (hint.samples as Array<Record<string, unknown>>).filter((s) => s && typeof s === "object")
    : [];
  const sampleTexts = samples
    .map((s) => stringValue(s.text, ""))
    .filter(Boolean)
    .slice(0, 6);
  const voiceEssence = blurb || about || `A ${tags[0] ?? "distinctive"} voice.`;
  const doRules: string[] = [
    ...traits.map((t) => `${stringValue(t.label, "")} — ${stringValue(t.value, "")}`).filter((r) => r.length > 3),
    about ? `About this voice: ${about}` : "",
    ...bestFor.map((b) => `Strong for: ${b}`)
  ].filter(Boolean).slice(0, 12);
  const baseProfile: Record<string, unknown> = {
    tone: {
      labels: tags,
      primary: tags[0] ?? "direct",
      secondary: tags.slice(1, 4),
      confidence: 0.8
    },
    vocabulary: {
      distinctive_words: traits.flatMap((t) => stringValue(t.value, "").toLowerCase().split(/\W+/).filter((w) => w.length > 3)).slice(0, 12),
      favorite_phrases: [],
      avoided_patterns: [],
      register_notes: about
    },
    sentence_rhythm: { average_sentence_length: "medium", variance: "medium", cadence_notes: about },
    structural_patterns: {
      argument_shape: traits.find((t) => /structure|cadence|format/i.test(stringValue(t.label, "")))
        ? stringValue(traits.find((t) => /structure|cadence|format/i.test(stringValue(t.label, "")))!.value, "")
        : "Concrete opening, explanation, then implication."
    },
    voice_essence: voiceEssence,
    do_rules: doRules,
    dont_rules: ["Do not write generic hype or vague abstractions.", "Do not copy sample sentences."],
    sample_excerpts: sampleTexts.map((t) => t.slice(0, 240)),
    source_profile: { primary_source_type: "file_upload" },
    confidence: 0.75,
    _source: "style_hint"
  };
  const detailedGuide = buildFallbackDetailedStyleGuide(
    baseProfile,
    sampleTexts,
    { sourceKind: "file_upload", sourceSummary: `${sampleTexts.length} style sample(s) from hint` },
    "profile_from_hint"
  );
  return { ...baseProfile, detailed_style_guide: detailedGuide };
}

function cleanSampleExcerpt(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text.startsWith("<source")) {
    return text;
  }
  const fullTextIndex = text.toLowerCase().indexOf("full source text:");
  if (fullTextIndex !== -1) {
    return text.slice(fullTextIndex + "full source text:".length).replace(/<\/source>\s*$/i, "").trim();
  }
  return "";
}

function buildStyleExtractionMetadata(
  payload: Record<string, unknown>,
  wallet: string,
  allSamples: string[],
  promptSamples: string[]
): StyleExtractionMetadata {
  const sourceMaterials = sourceMaterialsFromPayload(payload);
  const sourceKind = stringValue(payload.sourceKind, undefined) ?? inferSourceKind(sourceMaterials);
  const fullSampleBytes = Buffer.byteLength(allSamples.join("\n"), "utf8");
  const promptSampleBytes = Buffer.byteLength(promptSamples.join("\n"), "utf8");
  const keywords = stringArray(payload.keywords).slice(0, 8);
  const sourceContext = {
    sourceKind,
    sourceSummary: stringValue(payload.sourceSummary, undefined),
    sourceMaterials,
    sourceTypeCounts: countSourceTypes(sourceMaterials),
    fullSampleCount: allSamples.length,
    fullSampleBytes,
    promptSampleCount: promptSamples.length,
    promptSampleBytes,
    fullMaterialPreservedInEncryptedStorage: true,
    extractionWindow:
      promptSampleBytes >= fullSampleBytes
        ? "all submitted text was passed to 0G Compute"
        : "full submitted text was encrypted and stored; a source-balanced analysis window was passed to 0G Compute"
  };

  return {
    wallet,
    language: stringValue(payload.language, "en"),
    genres: stringArray(payload.genres),
    styleName: stringValue(payload.styleName, undefined),
    description: stringValue(payload.description, undefined),
    keywords,
    sourceKind,
    sourceSummary: stringValue(payload.sourceSummary, undefined),
    sourceMaterials,
    sourceContext,
    sourceSampleCount: allSamples.length,
    promptSampleCount: promptSamples.length,
    sampleBudget: "source-aware-profile"
  };
}

function sourceMaterialsFromPayload(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = payload.sourceMaterials;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      id: stringValue(item.id, undefined),
      kind: stringValue(item.kind, "unknown"),
      label: stringValue(item.label, "Untitled source"),
      characterCount: typeof item.characterCount === "number" ? item.characterCount : undefined,
      unitCount: typeof item.unitCount === "number" ? item.unitCount : undefined,
      importedAt: stringValue(item.importedAt, undefined),
      metadata: recordValue(item.metadata)
    }));
}

function inferSourceKind(sourceMaterials: Array<Record<string, unknown>>): string {
  const kinds = [...new Set(sourceMaterials.map((source) => stringValue(source.kind, "unknown")))].filter((kind) => kind !== "unknown");
  if (kinds.length === 0) return "unknown";
  return kinds.length === 1 ? kinds[0] : "mixed";
}

function countSourceTypes(sourceMaterials: Array<Record<string, unknown>>): Record<string, number> {
  return sourceMaterials.reduce<Record<string, number>>((counts, source) => {
    const kind = stringValue(source.kind, "unknown");
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});
}

function budgetSamplesForExtraction(samples: string[]): string[] {
  const budget = Number(process.env.OG_AGENT_STYLE_SAMPLE_CHAR_BUDGET ?? DEFAULT_STYLE_SAMPLE_CHAR_BUDGET);
  const safeBudget = Number.isFinite(budget) && budget > 1_000 ? budget : DEFAULT_STYLE_SAMPLE_CHAR_BUDGET;
  const normalized = samples.map((sample) => sample.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (normalized.join("").length <= safeBudget) {
    return normalized;
  }
  const sampleWindow = normalized.slice(0, 12);
  const chunkBudget = Math.max(1_200, Math.floor(safeBudget / Math.min(sampleWindow.length || 1, 12)));
  const chunks: string[] = [];

  for (const sample of sampleWindow) {
    if (chunks.join("").length >= safeBudget || chunks.length >= 12) {
      break;
    }
    chunks.push(sample.slice(0, chunkBudget));
  }

  return chunks.length > 0 ? chunks : samples.slice(0, 1);
}

function compactSamplesForParseRetry(samples: string[]): string[] {
  const budget = 18_000;
  const normalized = samples.map((sample) => sample.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (normalized.join("").length <= budget) {
    return normalized;
  }
  const sampleWindow = normalized.slice(0, 8);
  const chunkBudget = Math.max(1_200, Math.floor(budget / Math.min(sampleWindow.length || 1, 8)));
  return sampleWindow.map((sample) => sample.slice(0, chunkBudget)).filter(Boolean);
}

function isMeaningfulFeedback(feedback: string, payload: Record<string, unknown>): boolean {
  if (feedback.trim().length >= 20) {
    return true;
  }
  return Boolean(payload.editedDraft || payload.rejected || payload.rating === "negative");
}

function feedbackText(payload: Record<string, unknown>): string {
  return [
    stringValue(payload.feedback, ""),
    stringValue(payload.editSummary, ""),
    stringValue(payload.rejectionReason, ""),
    stringValue(payload.editedDraft, "")
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown, fallback: string): string;
function stringValue(value: unknown, fallback: undefined): string | undefined;
function stringValue(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" ? value : fallback;
}

function arrayValue(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

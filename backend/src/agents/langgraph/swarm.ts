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
import {
  buildAgentBrain,
  generateContentKey,
  protectContentKeyForRuntime,
  recoverRuntimeContentKey,
  uploadAgentBrain,
  wrapKeyForOwner
} from "../../inft/agent-brain.js";
import {
  contentGenerationPrompt,
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

type AgentActivityStatus = "started" | "completed" | "failed" | "handoff";

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
const DENYLIST = ["paul graham", "j.k. rowling", "jk rowling", "stephen king"];

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
      subscribedEvents: ["generation.drafted", "credit.low"],
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
        this.checkDistributionCreditBalanceTool(),
        this.deductCreditViaKeeperTool(),
        this.depositRoyaltyViaKeeperTool(),
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
        await this.publishToolActivity(state, "style_curator", "encrypt_and_store_samples", "started", "Checking sample size, denylist, and encrypting the creator samples.");
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
        description: "Validate sample size and denylist, encrypt the raw samples, and upload the encrypted bytes to 0G Storage.",
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
            : await this.generateDetailedStyleGuide(samples, baseProfile, extractionMetadata);
          const profile = guideResult
            ? { ...baseProfile, detailed_style_guide: guideResult.guide, styleGuideCompute: computeEvidence(guideResult.compute, "detailed_style_guide") }
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
            styleGuideCompute: guideResult
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
            styleGuideCompute: guideResult ? computeEvidence(guideResult.compute, "detailed_style_guide") : undefined,
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
        const profile = await this.getProfile(styleId, style.profileURI);
        await this.publishToolActivity(state, "content_creator", "read_style_profile", "completed", "Style profile loaded from 0G KV.", {
          styleId,
          creatorAddress: style.creator
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
        const selectedSamples = stringArray(profile.sampleExcerpts).slice(0, 5);
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
        await this.publishToolActivity(state, "content_creator", "generate_with_voice", "started", "Calling 0G Compute for a voice-matched draft with strict sample-boundary rules.", {
          styleId,
          prompt: prompt.slice(0, 160)
        });
        try {
          const compute = await this.deps.compute.chat(
            contentGenerationPrompt({
              styleProfile: state.styleProfile ?? {},
              prompt,
              excerpts: state.selectedSamples.length > 0 ? state.selectedSamples : stringArray(state.styleProfile?.sampleExcerpts).slice(0, 5)
            }),
            { maxRetries: 1, maxTokens: 500 }
          );
          const rawDraft = extractTagged(compute.content, "draft");
          const draft = guardGeneratedDraft(rawDraft, prompt, state.styleProfile ?? {});
          await this.publishToolActivity(state, "content_creator", "generate_with_voice", "completed", "Draft generated and checked for sample-content leakage.", {
            styleId,
            teeVerified: compute.teeVerified ?? compute.verified,
            qualityGuard: draft === rawDraft.trim() ? "passed" : "fallback_rewrite",
            compute: computeEvidence(compute, "voice_generation")
          });
          return new Command({
            update: {
              ...appendAgentMessage("content_creator", `Draft generated for style ${styleId}.`),
              requestId,
              currentStyleId: styleId,
              prompt,
              draftText: draft,
              teeVerified: compute.teeVerified ?? compute.verified,
              lastCompute: computeEvidence(compute, "voice_generation"),
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
        description: "Call 0G Compute with the detailed voice-matching prompt and produce a draft wrapped in draft tags.",
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
        await this.publishToolActivity(state, "content_creator", "log_draft", "started", "Writing the draft to the consumer 0G history log.", {
          styleId,
          consumerAddress
        });
        await this.deps.storage.logAppend(`consumer:${consumerAddress}:history`, `gen:${event.id}`, {
          styleId,
          draft,
          prompt: state.prompt ?? stringValue(event.payload.prompt, ""),
          teeVerified: state.teeVerified,
          compute: state.lastCompute,
          langGraphThread: `voices:${requestId}`,
          timestamp: Date.now()
        });
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
            platforms: state.targetPlatforms.length > 0 ? state.targetPlatforms : arrayValue(event.payload.platforms, ["x", "linkedin", "instagram"]),
            teeVerified: state.teeVerified,
            compute: state.lastCompute,
            langGraphThread: `voices:${requestId}`
          }
        });
        await this.publishToolActivity(state, "content_creator", "log_draft", "completed", "Draft log entry written and generation.drafted emitted.", {
          styleId,
          consumerAddress
        });
        return new Command({
          update: {
            ...appendAgentMessage("content_creator", "Draft written to 0G Storage Log and generation.drafted emitted."),
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
        await this.publishToolActivity(state, "content_creator", "handoff_to_distribution", "handoff", "Handing the draft to Distribution Manager for platform variants and settlement intent.", {
          styleId,
          consumerAddress
        });
        return new Command({
          goto: "distribution_mgr",
          graph: Command.PARENT,
          update: {
            ...appendAgentMessage("content_creator", `Handing off style ${styleId} draft to Distribution Manager.`),
            activeAgent: "distribution_mgr",
            workflowKind: "generation",
            currentStyleId: styleId,
            consumerAddress,
            targetPlatforms: state.targetPlatforms.length > 0 ? state.targetPlatforms : arrayValue(event.payload.platforms, ["x", "linkedin", "instagram"]),
            draftText: state.draftText,
            royaltyAmount: state.royaltyAmount,
            lastEventType: "generation.drafted"
          }
        });
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
        const event = requireIncomingEvent(state);
        const requestId = state.requestId ?? requestIdFromEvent(event) ?? event.id;
        const styleId = state.currentStyleId ?? event.styleId ?? stringValue(event.payload.styleId, "");
        const consumerAddress = state.consumerAddress ?? event.consumerAddress ?? stringValue(event.payload.consumerAddress, event.actor);
        const draft = state.draftText ?? stringValue(event.payload.draft, "");
        const platforms = state.targetPlatforms.length > 0 ? state.targetPlatforms : arrayValue(event.payload.platforms, ["x", "linkedin", "instagram"]);
        await this.publishToolActivity(state, "distribution_mgr", "tune_for_platform", "started", "Calling 0G Compute once to create platform variants.", {
          styleId,
          platforms
        });
        const compute = await this.deps.compute.chat(platformTuningPrompt(draft, platforms), {
          maxRetries: 1,
          maxTokens: 650
        });
        const variants = parseVariants(compute.content, draft, platforms);
        const spendIntent = this.deps.chain.spendCreditIntent(styleId);
        await this.deps.storage.logAppend(`consumer:${consumerAddress}:history`, `published:${event.id}`, {
          styleId,
          variants,
          teeVerified: compute.teeVerified ?? compute.verified,
          compute: computeEvidence(compute, "platform_tuning"),
          langGraphThread: `voices:${requestId}`,
          timestamp: Date.now()
        });
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
            teeVerified: compute.teeVerified ?? compute.verified,
            compute: computeEvidence(compute, "platform_tuning"),
            settlementStatus: "awaiting_wallet_signature",
            spendIntent,
            langGraphThread: `voices:${requestId}`
          }
        });
        await this.publishToolActivity(state, "distribution_mgr", "tune_for_platform", "completed", "Variants written to the consumer log and spend-credit intent prepared.", {
          styleId,
          platforms,
          teeVerified: compute.teeVerified ?? compute.verified,
          compute: computeEvidence(compute, "platform_tuning")
        });
        return new Command({
          update: {
            ...appendAgentMessage("distribution_mgr", "Platform variants created in one 0G Compute call."),
            platformVariants: variants,
            spendIntent,
            teeVerified: compute.teeVerified ?? compute.verified,
            lastEventType: "generation.published",
            lastError: undefined
          }
        });
      },
      {
        name: "tune_for_platform",
        description: "Produce X, LinkedIn, and Instagram variants in one 0G Compute call and write them to the consumer log.",
        schema: z.object({})
      }
    );
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
          maxTokens: attempt.maxTokens
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
      { maxRetries: 1, maxTokens: 4200 }
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
        { maxRetries: 1, maxTokens: tag === "style_guide" ? 4200 : 2800 }
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
  const useZeroGPlanner = plannerMode === "0g" || (plannerMode !== "deterministic" && liveCompute);
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
    return ["check_credit_balance", "topup_credits_via_keeper"];
  }

  return ["tune_for_platform", "check_credit_balance", "deduct_credit_via_keeper", "deposit_royalty_via_keeper"];
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
    check_credit_balance: ["generation credit", "No credits available", "Settlement check sees"],
    read_style_profile: ["Loaded style profile", "is no longer listed"],
    pull_relevant_samples: ["voice example"],
    generate_with_voice: ["Draft generated", "Generation failed"],
    log_draft: ["generation.drafted emitted"],
    handoff_to_distribution: ["Handing off style"],
    tune_for_platform: ["Platform variants created"],
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
    "Style is no longer listed"
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

function messagesToPlannerText(messages: BaseMessage[]): string {
  return messages
    .slice(-10)
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
  "Tune drafts for X, LinkedIn, and Instagram in one 0G Compute call where possible.",
  "Prepare credit spend, royalty settlement, and low-credit top-up intents without pretending a wallet signature or KeeperHub confirmation happened."
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
    targetPlatforms: arrayValue(event.payload.platforms, ["x", "linkedin", "instagram"]),
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
  const lower = text.toLowerCase();
  if (DENYLIST.some((author) => lower.includes(author))) {
    throw new Error("Sample matches a known-author denylist entry");
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

function parseVariants(content: string, draft: string, platforms: string[]): Record<string, string> {
  try {
    const parsed = JSON.parse(extractFirstJsonObject(stripCodeFence(content))) as Record<string, string>;
    return Object.fromEntries(
      platforms.map((platform) => [
        platform,
        enforcePlatformLimit(guardVariant(parsed[platform] ?? tuneFallback(draft, platform), draft, platform), platform)
      ])
    );
  } catch {
    return Object.fromEntries(platforms.map((platform) => [platform, tuneFallback(draft, platform)]));
  }
}

const SAMPLE_BLEED_TERMS = [
  "agent demo",
  "agent workflow",
  "workflow trail",
  "style profile",
  "profile hash",
  "encrypted sample",
  "encrypted samples",
  "0g",
  "inft",
  "wallet",
  "transaction",
  "settlement",
  "royalty",
  "credit spend",
  "event log",
  "event trail",
  "langgraph",
  "keeperhub",
  "creditsystem"
];

function guardGeneratedDraft(draft: string, prompt: string, styleProfile: unknown): string {
  const cleaned = draft.trim();
  if (!cleaned) {
    return fallbackVoiceDraft(prompt, styleProfile);
  }
  if (leaksSampleMatter(cleaned, prompt) || hasUnsupportedPrecision(cleaned, prompt) || containsMetaInstruction(cleaned)) {
    return fallbackVoiceDraft(prompt, styleProfile);
  }
  return cleaned;
}

function guardVariant(variant: string, draft: string, platform: string): string {
  const cleaned = variant.trim();
  if (!cleaned || leaksSampleMatter(cleaned, draft) || hasUnsupportedPrecision(cleaned, draft) || containsMetaInstruction(cleaned) || hasUnsupportedHashtags(cleaned, draft)) {
    return tuneFallback(draft, platform);
  }
  return cleaned;
}

function leaksSampleMatter(text: string, allowedContext: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerAllowed = allowedContext.toLowerCase();
  return SAMPLE_BLEED_TERMS.some((term) => lowerText.includes(term) && !lowerAllowed.includes(term));
}

function hasUnsupportedPrecision(text: string, allowedContext: string): boolean {
  const lowerAllowed = allowedContext.toLowerCase();
  if (/[#$€£]\s?\d/.test(text) && !/[#$€£]\s?\d/.test(allowedContext)) {
    return true;
  }
  if (/\b\d+(?:\.\d+)?\s*(?:billion|million|trillion|percent|%)\b/i.test(text) && !/\b\d+(?:\.\d+)?\s*(?:billion|million|trillion|percent|%)\b/i.test(allowedContext)) {
    return true;
  }
  return /\b(?:according to|reportedly|sources say|it is widely reported)\b/i.test(text) && !/\b(?:according to|reportedly|sources say|widely reported)\b/i.test(lowerAllowed);
}

function containsMetaInstruction(text: string): boolean {
  return /\b(?:the voice should|voice should|style should|draft turns|output should|write in the voice|keep the claim careful)\b/i.test(text);
}

function hasUnsupportedHashtags(text: string, allowedContext: string): boolean {
  return /#[\p{L}\p{N}_]+/u.test(text) && !/#[\p{L}\p{N}_]+/u.test(allowedContext);
}

function fallbackVoiceDraft(prompt: string, styleProfile: unknown): string {
  const subject = normalizePromptSubject(prompt);
  const profile = recordValue(styleProfile);
  const tone = recordValue(profile.tone);
  const primaryTone = stringValue(tone.primary, "clear");
  const voiceEssence = stringValue(profile.voice_essence, stringValue(profile.voiceEssence, ""));
  const finalBeat = voiceEssence || primaryTone
    ? "No fake precision, no invented motives, no pretending the consequences are settled."
    : "No fake precision. No invented motives. No pretending the consequences are settled.";

  return [
    `${subject} is bigger than the headline. The useful question is what changed, who had to react, and which assumptions stopped being safe.`,
    "The concrete part matters most: ownership changed, incentives shifted, and people who depended on the platform had to re-check what they could trust.",
    `${finalBeat} Say the visible mechanism plainly, then stop before speculation starts sounding like evidence.`
  ].join("\n\n");
}

function normalizePromptSubject(prompt: string): string {
  const stripped = prompt
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(write|draft|create|make)\s+(me\s+)?(a\s+|an\s+)?(post|tweet|thread|caption|linkedin post|article)?\s*(about|on|for)?\s*/i, "")
    .replace(/^about\s+/i, "")
    .replace(/[.?!]+$/, "")
    .trim();
  const normalized = rephraseHowSubject(stripped)
    .replace(/\belon\s+(?:much|mush|musk)\b/gi, "Elon Musk")
    .replace(/\bthe\s+x\b/gi, "X")
    .replace(/\bx\b/gi, "X")
    .replace(/\belon\s+mush\b/gi, "Elon Musk")
    .replace(/\belon\s+musk\b/gi, "Elon Musk")
    .replace(/\bthe\s+twitter\b/gi, "Twitter")
    .replace(/\btwitter\b/gi, "Twitter");
  const subject = normalized || "This topic";
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

function rephraseHowSubject(input: string): string {
  const match = input.match(/^how\s+(.+?)\s+(bought|acquired)\s+(.+)$/i);
  if (!match) {
    return input;
  }
  return `${match[1]} ${match[2].toLowerCase() === "acquired" ? "acquiring" : "buying"} ${match[3]}`;
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

function hasDetailedStyleGuide(profile: Record<string, unknown>): boolean {
  const guide = recordValue(profile.detailed_style_guide);
  return Boolean(stringValue(guide.prompt_ready_style_brief, undefined)) && Array.isArray(guide.actual_examples) && guide.actual_examples.length > 0;
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

function tuneFallback(draft: string, platform: string): string {
  const cleaned = draft.replace(/\s+/g, " ").trim();
  if (platform === "x") {
    return truncate(cleaned, 280);
  }
  if (platform === "instagram") {
    return cleaned;
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

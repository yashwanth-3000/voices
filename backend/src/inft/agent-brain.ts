import { Buffer } from "node:buffer";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { decryptBytes, encryptBytes, resolveAesKey } from "../crypto.js";
import { AgentStorage, ChatResult } from "../infra/types.js";

export type KeyWrapResult = {
  wrappedKey: string;
  keyHash: string;
  ownerPublicKey?: string;
  wrapMode: "ecies-secp256k1-attestation" | "address-derived-demo";
};

export type UploadedRef = {
  rootHash: string;
  txHash?: string;
};

export type AgentBrainManifest = {
  manifest_version: 1;
  agent_type: "voices-style-agent";
  style_id: string;
  creator: string;
  created_at: number;
  updated_at: number;
  encryption: {
    algo: "aes-256-gcm";
    key_hash: string;
    wrap_mode: KeyWrapResult["wrapMode"];
  };
  samples: {
    encrypted_root_hash: string;
    storage_tx_hash?: string;
    count: number;
    size_bytes: number;
  };
  profile: {
    encrypted_root_hash: string;
    storage_tx_hash?: string;
    kv_key: string;
    voice_essence?: string;
    refinement_count: number;
  };
  memory: {
    log_stream: string;
    feedback_count: number;
  };
  compute: {
    provider?: string;
    model?: string;
    last_chat_id?: string | null;
    tee_verified?: boolean | null;
  };
};

export type AgentBrainBuildInput = {
  styleId: string;
  creator: string;
  contentKey: Uint8Array;
  samplesUpload: UploadedRef;
  profileUpload: UploadedRef;
  profileKey: string;
  profile: Record<string, unknown>;
  sampleCount: number;
  sampleSizeBytes: number;
  memoryLogStream: string;
  feedbackCount?: number;
  compute?: ChatResult;
  now?: number;
  wrapMode: KeyWrapResult["wrapMode"];
};

export function generateContentKey(): Buffer {
  return randomBytes(32);
}

export function contentKeyHash(contentKey: Uint8Array): string {
  return `0x${createHash("sha256").update(contentKey).digest("hex")}`;
}

export function protectContentKeyForRuntime(contentKey: Uint8Array): string {
  return ethers.hexlify(encryptBytes(contentKey, runtimeProtectionKey()));
}

export function recoverRuntimeContentKey(protectedKey: string): Buffer {
  return decryptBytes(ethers.getBytes(protectedKey), runtimeProtectionKey());
}

export function wrapKeyForOwner(
  contentKey: Uint8Array,
  ownerAddress: string,
  options: { attestationMessage?: string; attestationSignature?: string; ownerPublicKey?: string } = {}
): KeyWrapResult {
  const publicKey = options.ownerPublicKey ?? recoverOwnerPublicKey(ownerAddress, options.attestationMessage, options.attestationSignature);
  if (!publicKey) {
    return wrapKeyWithAddressDerivedFallback(contentKey, ownerAddress);
  }

  const recipientPublicKey = Buffer.from(publicKey.replace(/^0x/, ""), "hex");
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(recipientPublicKey);
  const wrapKey = createHash("sha256")
    .update("voices-agent-brain-key-wrap:v1")
    .update(sharedSecret)
    .update(ownerAddress.toLowerCase())
    .digest();
  const encryptedKey = encryptBytes(contentKey, wrapKey);
  const envelope = {
    v: 1,
    mode: "ecies-secp256k1-attestation",
    owner: ethers.getAddress(ownerAddress),
    ephemeralPublicKey: `0x${ecdh.getPublicKey(undefined, "uncompressed").toString("hex")}`,
    encryptedKey: Buffer.from(encryptedKey).toString("base64")
  };

  return {
    wrappedKey: ethers.hexlify(Buffer.from(JSON.stringify(envelope), "utf8")),
    keyHash: contentKeyHash(contentKey),
    ownerPublicKey: publicKey,
    wrapMode: "ecies-secp256k1-attestation"
  };
}

export function buildAgentBrain(input: AgentBrainBuildInput): { manifest: AgentBrainManifest; manifestHash: string } {
  const now = input.now ?? Date.now();
  const voiceEssence = stringValue(input.profile.voice_essence) ?? stringValue(input.profile.voiceEssence);
  const manifest: AgentBrainManifest = {
    manifest_version: 1,
    agent_type: "voices-style-agent",
    style_id: input.styleId,
    creator: ethers.getAddress(input.creator),
    created_at: now,
    updated_at: now,
    encryption: {
      algo: "aes-256-gcm",
      key_hash: contentKeyHash(input.contentKey),
      wrap_mode: input.wrapMode
    },
    samples: {
      encrypted_root_hash: input.samplesUpload.rootHash,
      storage_tx_hash: input.samplesUpload.txHash,
      count: input.sampleCount,
      size_bytes: input.sampleSizeBytes
    },
    profile: {
      encrypted_root_hash: input.profileUpload.rootHash,
      storage_tx_hash: input.profileUpload.txHash,
      kv_key: input.profileKey,
      voice_essence: voiceEssence,
      refinement_count: Number(input.profile.refinementCount ?? 0)
    },
    memory: {
      log_stream: input.memoryLogStream,
      feedback_count: input.feedbackCount ?? 0
    },
    compute: {
      provider: input.compute?.providerAddress,
      model: input.compute?.model,
      last_chat_id: input.compute?.chatId ?? null,
      tee_verified: input.compute?.teeVerified ?? input.compute?.verified ?? null
    }
  };
  return { manifest, manifestHash: hashJson(manifest) };
}

export async function uploadAgentBrain(
  storage: AgentStorage,
  manifest: AgentBrainManifest
): Promise<UploadedRef & { manifestHash: string }> {
  const bytes = Buffer.from(canonicalJson(manifest), "utf8");
  const upload = await storage.uploadRaw(bytes);
  return { ...upload, manifestHash: hashBytes(bytes) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

export function hashJson(value: unknown): string {
  return hashBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function hashBytes(bytes: Uint8Array): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function recoverOwnerPublicKey(ownerAddress: string, message?: string, signature?: string): string | undefined {
  if (!message || !signature) {
    return undefined;
  }
  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error("Cannot wrap content key: attestation signature does not match owner wallet");
  }
  return ethers.SigningKey.recoverPublicKey(ethers.hashMessage(message), signature);
}

function wrapKeyWithAddressDerivedFallback(contentKey: Uint8Array, ownerAddress: string): KeyWrapResult {
  const wrapKey = createHash("sha256")
    .update("voices-agent-brain-address-wrap:v1")
    .update(ownerAddress.toLowerCase())
    .digest();
  const encryptedKey = encryptBytes(contentKey, wrapKey);
  const envelope = {
    v: 1,
    mode: "address-derived-demo",
    owner: ethers.getAddress(ownerAddress),
    encryptedKey: Buffer.from(encryptedKey).toString("base64")
  };
  return {
    wrappedKey: ethers.hexlify(Buffer.from(JSON.stringify(envelope), "utf8")),
    keyHash: contentKeyHash(contentKey),
    wrapMode: "address-derived-demo"
  };
}

function runtimeProtectionKey(): Buffer {
  return resolveAesKey(
    process.env.AGENT_RUNTIME_KEY ||
      process.env.OG_STORAGE_ENCRYPTION_KEY ||
      process.env.PRIVATE_KEY ||
      "voices-local-runtime-key"
  );
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForJson(item)])
    );
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

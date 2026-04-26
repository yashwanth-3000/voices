import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type EncryptionEnvelope = {
  v: 1;
  alg: "AES-256-GCM";
  iv: string;
  tag: string;
  ciphertext: string;
};

export function resolveAesKey(input?: string): Buffer {
  if (!input) {
    return randomBytes(32);
  }

  const trimmed = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed.replace(/^0x/, ""), "hex");
  }

  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32) {
    return base64;
  }

  return createHash("sha256").update(trimmed).digest();
}

export function encryptBytes(plaintext: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptionEnvelope = {
    v: 1,
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };

  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function decryptBytes(envelopeBytes: Uint8Array, key: Buffer): Buffer {
  const envelope = JSON.parse(Buffer.from(envelopeBytes).toString("utf8")) as EncryptionEnvelope;
  if (envelope.v !== 1 || envelope.alg !== "AES-256-GCM") {
    throw new Error("Unsupported encryption envelope");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);
}

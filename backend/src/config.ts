import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function normalizePrivateKey(privateKey: string): string {
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

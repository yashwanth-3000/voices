import { webcrypto } from "node:crypto";

type CryptoLike = typeof webcrypto;

export function installNodeGlobals(): void {
  const scope = globalThis as typeof globalThis & { crypto?: CryptoLike };
  const currentCrypto = scope.crypto;
  if (
    currentCrypto &&
    typeof currentCrypto.getRandomValues === "function" &&
    typeof currentCrypto.randomUUID === "function"
  ) {
    return;
  }

  Object.defineProperty(scope, "crypto", {
    value: webcrypto,
    configurable: true,
    enumerable: false
  });
}

installNodeGlobals();

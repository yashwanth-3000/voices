import assert from "node:assert/strict";
import test from "node:test";
import { installNodeGlobals } from "./node-globals.js";

test("installNodeGlobals repairs a missing Web Crypto global", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    value: {},
    configurable: true
  });

  try {
    installNodeGlobals();
    assert.equal(typeof crypto.getRandomValues, "function");
    assert.equal(typeof crypto.randomUUID, "function");
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "crypto", original);
    }
  }
});

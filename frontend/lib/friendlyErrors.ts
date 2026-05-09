type FriendlyErrorOptions = {
  action?: string;
  fallback?: string;
};

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function friendlyErrorMessage(error: unknown, options: FriendlyErrorOptions = {}): string {
  const fallback = options.fallback ?? "Something went wrong. Please try again.";
  const raw = compactWhitespace(collectErrorText(error).replace(ANSI_ESCAPE_RE, ""));
  if (!raw || raw === "[object Object]") return fallback;

  const lower = raw.toLowerCase();
  const insufficientFundsMessage = formatInsufficientFundsError(raw, options.action);
  if (insufficientFundsMessage) return insufficientFundsMessage;

  const payerMismatchMessage = formatPayerMismatchError(raw);
  if (payerMismatchMessage) return payerMismatchMessage;

  if (
    lower.includes("replacement_underpriced") ||
    lower.includes("replacement transaction underpriced") ||
    lower.includes("replacement fee too low") ||
    lower.includes("transaction underpriced")
  ) {
    return "Your wallet already has a pending transaction with this nonce. Open MetaMask and Speed up or Cancel the pending transaction, or wait for it to confirm before trying again.";
  }

  if (lower.includes("nonce too low")) {
    return "This wallet nonce was already used by another pending or confirmed transaction. Refresh the page, check MetaMask activity, then try again after the wallet syncs.";
  }

  if (
    lower.includes("user rejected") ||
    lower.includes("action_rejected") ||
    lower.includes("rejected the request") ||
    lower.includes("user denied")
  ) {
    return "The wallet transaction was rejected. No funds moved.";
  }

  if (lower.includes("wallet_switchethereumchain") || lower.includes("wallet_addethereumchain")) {
    return "The wallet could not switch to 0G Galileo. Open MetaMask, check the network prompt, and try again.";
  }

  if (lower.includes("estimate gas") || lower.includes("eth_estimategas")) {
    return `The wallet could not estimate gas${options.action ? ` to ${options.action}` : " for this transaction"}. Check your 0G Galileo balance and network, then try again.`;
  }

  if (lower.includes("fetch failed") || lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Could not reach the backend or provider. Make sure the servers are running and your network is available, then try again.";
  }

  if (lower.includes("unsupported parameter")) {
    return "The compute provider rejected an unsupported request option. The backend should retry with only the parameters this model supports.";
  }

  if (looksLikeRawProviderError(raw)) {
    return `The wallet or RPC provider could not complete ${options.action ? `the ${options.action} action` : "this transaction"}. Check your 0G Galileo balance, network, and pending MetaMask activity, then try again.`;
  }

  return raw.length > 600 ? `${raw.slice(0, 597)}...` : raw;
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  collectTextParts(error, parts, new Set(), 0);
  return unique(parts.filter(Boolean)).join(" ");
}

function collectTextParts(value: unknown, parts: string[], seen: Set<unknown>, depth: number) {
  if (value === undefined || value === null || depth > 3) return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    parts.push(String(value));
    return;
  }
  if (typeof value !== "object") {
    parts.push(String(value));
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    if (value.message) parts.push(value.message);
    collectTextParts(value.cause, parts, seen, depth + 1);
  }

  const record = value as Record<string, unknown>;
  for (const key of ["shortMessage", "reason", "message", "code", "details"]) {
    collectTextParts(record[key], parts, seen, depth + 1);
  }
  for (const key of ["error", "info", "cause", "data"]) {
    collectTextParts(record[key], parts, seen, depth + 1);
  }
}

function formatInsufficientFundsError(raw: string, requestedAction?: string): string | null {
  const lower = raw.toLowerCase();
  if (!lower.includes("insufficient funds")) return null;

  const haveWei = raw.match(/\bhave\s+(\d+)/i)?.[1];
  const wantWei = raw.match(/\bwant\s+(\d+)/i)?.[1];
  const txValueHex = raw.match(/"value"\s*:\s*"(0x[0-9a-f]+)"/i)?.[1];
  const available = haveWei ? formatWeiAmount(haveWei) : null;
  const needed = wantWei
    ? formatWeiAmount(wantWei)
    : txValueHex
      ? formatWeiAmount(BigInt(txValueHex))
      : null;
  const action = requestedAction ?? inferAction(raw);

  if (available && needed) {
    return `Not enough OG to ${action}. This wallet has about ${available}, but the transaction needs at least ${needed} plus gas. Add OG on 0G Galileo and try again.`;
  }
  if (needed) {
    return `Not enough OG to ${action}. The transaction needs at least ${needed} plus gas. Add OG on 0G Galileo and try again.`;
  }
  return `Not enough OG to ${action}. Add OG on 0G Galileo for the transaction value and gas, then try again.`;
}

function formatPayerMismatchError(raw: string): string | null {
  if (!raw.toLowerCase().includes("royalty payer mismatch")) return null;
  const match = raw.match(/royalty payer mismatch:\s*expected\s+([^,]+),\s*got\s+([^\s,]+)/i);
  if (!match) {
    return "The royalty transaction was signed by the wrong wallet. Connect the wallet that created this generation request, then try again.";
  }
  return `The royalty transaction was signed by the wrong wallet. Expected ${shortAddress(match[1])}, but got ${shortAddress(match[2])}. Connect the request wallet, then try again.`;
}

function inferAction(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("buycredits") || lower.includes("credit purchase")) return "buy credits";
  if (lower.includes("spendcredit") || lower.includes("royalty")) return "pay the royalty";
  if (lower.includes("mintstyle") || lower.includes("mint")) return "mint the voice";
  return "submit this transaction";
}

function looksLikeRawProviderError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes("transaction={") ||
    lower.includes("jsonrpc") ||
    lower.includes("eth_estimategas") ||
    lower.includes("version=6.") ||
    lower.includes("code=") ||
    lower.includes('"payload"') ||
    lower.includes('"params"')
  );
}

function formatWeiAmount(value: bigint | string | undefined): string {
  const wei = parseWeiAmount(value);
  const unit = 1_000_000_000_000_000_000n;
  const whole = wei / unit;
  const fraction = wei % unit;
  if (fraction === 0n) return `${whole.toString()} OG`;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toString()}.${fractionText || "0"} OG`;
}

function parseWeiAmount(value: bigint | string | undefined): bigint {
  if (typeof value === "bigint") return value;
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function shortAddress(value: string) {
  const trimmed = value.trim();
  return /^0x[a-f0-9]{40}$/i.test(trimmed) ? `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}` : trimmed;
}

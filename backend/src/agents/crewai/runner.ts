import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIComputeClient } from "../../infra/compute.js";
import { AgentCompute, ChatMessage, ChatOptions, ChatResult } from "../../infra/types.js";

export type CrewAiActivity = {
  agent: "voice_context" | "style_writer" | "voice_critic_memory" | string;
  agentLabel: string;
  tool: string;
  status: "started" | "progress" | "completed" | "failed" | "handoff";
  message: string;
  payload?: Record<string, unknown>;
};

export type CrewAiGenerationInput = {
  requestId: string;
  styleId: string;
  consumerAddress?: string;
  creatorAddress?: string;
  prompt: string;
  platforms: string[];
  profileKey?: string;
  styleRegistry?: Record<string, unknown>;
  styleProfile: Record<string, unknown>;
  excerpts: string[];
  agentBrain?: Record<string, unknown>;
  memoryEntries?: Array<Record<string, unknown>>;
  computeOptions?: ChatOptions;
};

export type CrewAiGenerationResult = {
  draft: string;
  critique?: Record<string, unknown>;
  memoryPatch?: Record<string, unknown>;
  runtime: string;
  revisionCount?: number;
  voicePacket?: Record<string, unknown>;
  computeCalls: CrewAiComputeCall[];
};

type CrewAiComputeCall = {
  purpose?: string;
  model?: string;
  provider?: string;
  serviceUrl?: string;
  chatId?: string;
  teeVerified?: boolean | null;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  path?: string;
};

type RunnerRecord =
  | ({ type: "agent_activity" } & CrewAiActivity)
  | ({ type: "result" } & Omit<CrewAiGenerationResult, "computeCalls">)
  | { type: "error"; message?: string };

export async function runCrewAiGeneration(
  input: CrewAiGenerationInput,
  options: {
    compute: AgentCompute;
    onActivity?: (activity: CrewAiActivity) => Promise<void> | void;
    timeoutMs?: number;
  }
): Promise<CrewAiGenerationResult> {
  const bridge = await startComputeBridge(crewAiCompute(options.compute));
  let child: ReturnType<typeof spawn> | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let activityQueue = Promise.resolve();
  let result: Omit<CrewAiGenerationResult, "computeCalls"> | undefined;
  const stderr: string[] = [];
  const stdoutNoise: string[] = [];

  try {
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../crewai_runtime/voices_crew.py");
    const python = process.env.CREWAI_PYTHON_BIN?.trim() || "python3";
    child = spawn(python, [runnerPath], {
      cwd: resolve(dirname(runnerPath), ".."),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        CI: process.env.CI ?? "1",
        NO_COLOR: process.env.NO_COLOR ?? "1",
        OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? "true",
        CREWAI_DISABLE_TELEMETRY: process.env.CREWAI_DISABLE_TELEMETRY ?? "true",
        CREWAI_DISABLE_TRACING: process.env.CREWAI_DISABLE_TRACING ?? "true",
        VOICES_CREWAI_COMPUTE_BRIDGE_URL: bridge.url,
        VOICES_CREWAI_COMPUTE_BRIDGE_TOKEN: bridge.token,
        VOICES_CREWAI_MODEL: input.computeOptions?.model ?? process.env.OG_COMPUTE_GENERATION_MODEL ?? "",
        VOICES_CREWAI_MAX_TOKENS: String(input.computeOptions?.maxTokens ?? ""),
        VOICES_CREWAI_TEMPERATURE: String(input.computeOptions?.temperature ?? ""),
        VOICES_CREWAI_TOP_P: String(input.computeOptions?.topP ?? "")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timeoutMs = options.timeoutMs ?? crewAiTimeoutMs();
    timeout = setTimeout(() => {
      child?.kill("SIGKILL");
    }, timeoutMs);

    const stdoutDone = new Promise<void>((resolveDone) => {
      let buffer = "";
      child?.stdout?.setEncoding("utf8");
      child?.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            handleRunnerLine(line.trim());
          }
        }
      });
      child?.stdout?.on("end", () => {
        if (buffer.trim()) {
          handleRunnerLine(buffer.trim());
        }
        resolveDone();
      });
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
    });

    child.stdin?.end(JSON.stringify(input));
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child?.on("error", rejectExit);
      child?.on("close", (code) => resolveExit(code));
    });
    await stdoutDone;
    await activityQueue;

    if (exitCode !== 0) {
      const errorMessage = stderr.join("").trim() || stdoutNoise.join("\n").trim() || `CrewAI runner exited with code ${exitCode}`;
      throw new Error(errorMessage);
    }
    if (!result?.draft) {
      throw new Error(stdoutNoise.join("\n").trim() || "CrewAI runner did not return a draft");
    }
    return {
      ...result,
      computeCalls: bridge.calls
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    child?.kill();
    await bridge.close();
  }

  function handleRunnerLine(line: string): void {
    let parsed: RunnerRecord;
    try {
      parsed = JSON.parse(line) as RunnerRecord;
    } catch {
      stdoutNoise.push(line);
      return;
    }

    if (parsed.type === "agent_activity") {
      const { type: _type, ...activity } = parsed;
      activityQueue = activityQueue.then(() => options.onActivity?.(activity) ?? undefined);
      return;
    }
    if (parsed.type === "result") {
      const { type: _type, ...value } = parsed;
      result = value;
      return;
    }
    if (parsed.type === "error") {
      stdoutNoise.push(parsed.message ?? "CrewAI runner error");
    }
  }
}

function crewAiCompute(defaultCompute: AgentCompute): AgentCompute {
  const mode = (process.env.CREWAI_COMPUTE_MODE || process.env.VOICES_CREWAI_COMPUTE_MODE || "").trim().toLowerCase();
  return mode === "openai" || mode === "chatgpt" ? new OpenAIComputeClient() : defaultCompute;
}

async function startComputeBridge(compute: AgentCompute): Promise<{
  url: string;
  token: string;
  calls: CrewAiComputeCall[];
  close: () => Promise<void>;
}> {
  const token = randomBytes(24).toString("hex");
  const calls: CrewAiComputeCall[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const messages = normalizeMessages(body.messages);
      const optionRecord = recordValue(body.options);
      const options = normalizeOptions(optionRecord);
      const purpose = typeof optionRecord.purpose === "string" ? optionRecord.purpose : undefined;
      const result = await compute.chat(messages, options);
      calls.push(computeCallEvidence(result, purpose));
      sendJson(response, 200, {
        content: result.content,
        chatId: result.chatId,
        provider: result.providerAddress,
        serviceUrl: result.serviceUrl,
        model: result.model,
        teeVerified: result.teeVerified ?? result.verified ?? null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        path: result.computePath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: "compute_bridge_failed", message });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not open CrewAI compute bridge");
  }
  return {
    url: `http://127.0.0.1:${address.port}/chat`,
    token,
    calls,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      })
  };
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      const role: ChatMessage["role"] = record.role === "system" || record.role === "assistant" ? record.role : "user";
      return {
        role,
        content: typeof record.content === "string" ? record.content : JSON.stringify(record.content ?? "")
      };
    })
    .filter((message) => message.content.trim().length > 0);
}

function normalizeOptions(value: unknown): ChatOptions {
  const record = recordValue(value);
  return {
    model: typeof record.model === "string" && record.model.trim() ? record.model : undefined,
    maxRetries: numberValue(record.maxRetries),
    maxTokens: numberValue(record.maxTokens),
    temperature: numberValue(record.temperature),
    topP: numberValue(record.topP)
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function computeCallEvidence(result: ChatResult, purpose?: string): CrewAiComputeCall {
  return {
    purpose,
    model: result.model,
    provider: result.providerAddress,
    serviceUrl: result.serviceUrl,
    chatId: result.chatId,
    teeVerified: result.teeVerified ?? result.verified ?? null,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    path: result.computePath
  };
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveRead, rejectRead) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        rejectRead(new Error("CrewAI compute bridge request is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveRead(JSON.parse(body || "{}") as Record<string, unknown>);
      } catch (error) {
        rejectRead(error);
      }
    });
    request.on("error", rejectRead);
  });
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function crewAiTimeoutMs(): number {
  const raw = process.env.CREWAI_RUNNER_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 180_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}

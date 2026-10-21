import { beginCommandFileObservation, finishCommandFileObservation } from "../execution/command-file-evidence.js";
import { HostWorkspaceFiles } from "../execution/host-workspace-files.js";
import type { HostExecutionLease } from "../execution/host-environment.js";
import { HostProcessScope, type HostProcesses } from "../execution/host-processes.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDB } from "../contracts/session.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolExecutor } from "./tool-executor.js";

export type ExecuteCodeToolOptions = {
  workspaceRoot: string;
  executionLease?: HostExecutionLease;
  childProcessEnv?: import("../contracts/tool-context.js").SessionToolContext["childProcessEnv"];
  toolExecutor: ToolExecutor;
  sessionDb: SessionDB;
  trajectoryRecorder: TrajectoryRecorder;
  sessionId: string | (() => string);
  trustedWorkspace: () => Promise<boolean>;
  allowedTools?: string[];
  pythonBinary?: string;
};

const DEFAULT_ALLOWED_TOOLS = new Set([
  "file.read",
  "file.search",
  "file.write",
  "file.patch",
  "process.start",
  "process.list",
  "process.logs",
  "process.stop",
  "terminal.run",
  "document.probe",
  "python.probe"
]);

export function createExecuteCodeTool(options: ExecuteCodeToolOptions): RegisteredTool {
  const allowedTools = new Set(options.allowedTools ?? DEFAULT_ALLOWED_TOOLS);

  return {
    name: "execute_code",
    description: "Run bounded Python code in the workspace. Python can call approved EstaCoda tools through tool(name, input).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        input: { type: "object" },
        timeoutMs: { type: "number" },
        maxOutputChars: { type: "number" }
      },
      required: ["code"]
    },
    riskClass: "workspace-write",
    toolsets: ["coding", "research"],
    progressLabel: "executing code",
    maxResultSizeChars: 48_000,
    isAvailable: () => true,
    run: async (input: Record<string, unknown>, context) => {
      if (typeof input.code !== "string" || input.code.trim().length === 0) {
        return errorResult("execute_code requires non-empty Python code");
      }

      if (Buffer.byteLength(input.code) > 256 * 1024 || Buffer.byteLength(JSON.stringify(asRecord(input.input))) > MAX_FRAME_BYTES) {
        return errorResult("execute_code code or input exceeds its limit.");
      }
      try { await options.executionLease?.content.assertMaterialized(); }
      catch (error) { return errorResult(error instanceof Error ? error.message : "Editor content is not materialized."); }
      const files = options.executionLease?.files ?? new HostWorkspaceFiles(options.workspaceRoot);
      const observation = await beginCommandFileObservation(files, context?.requestContract?.requirements, context?.visibleTurnId);
      const result = await runCode({
        signal: context?.signal,
        code: input.code,
        input: asRecord(input.input),
        timeoutMs: boundedNumber(input.timeoutMs, 5_000, 1, 30_000),
        maxOutputChars: boundedNumber(input.maxOutputChars, 12_000, 1_000, 48_000),
        pythonBinary: options.pythonBinary ?? "python3",
        workspaceRoot: options.executionLease?.workspaceRoot ?? options.workspaceRoot,
        executionLease: options.executionLease,
        childProcessEnv: options.childProcessEnv,
        allowedTools,
        executeTool: async (tool, toolInput, signal) => {
          if (!allowedTools.has(tool)) {
            return {
              ok: false,
              content: `Tool is not available inside execute_code: ${tool}`,
              metadata: {
                tool,
                allowedTools: [...allowedTools].sort()
              }
            };
          }

          const execution = await options.toolExecutor.executeTool({
            tool,
            input: toolInput,
            trustedWorkspace: await options.trustedWorkspace(),
            sessionId: typeof options.sessionId === "function" ? options.sessionId() : options.sessionId,
            visibleTurnId: context?.visibleTurnId,
            requestContract: context?.requestContract,
            providerUsageLineage: context?.providerUsageLineage,
            visionInputProvenance: context?.visionInputProvenance,
            signal,
            onEvent: context?.onEvent,
            onApprovalRequest: context?.onApprovalRequest,
            onSecureInputRequest: context?.onSecureInputRequest
          });

          if (execution === undefined) {
            return {
              ok: false,
              content: `Tool not found or unavailable: ${tool}`,
              metadata: { tool }
            };
          }

          if (execution.result === undefined) {
            return {
              ok: false,
              content: `Tool was not allowed: ${tool} (${execution.decision})`,
              metadata: {
                tool,
                decision: execution.decision
              }
            };
          }

          return execution.result;
        }
      });
      return { ...result, metadata: { ...result.metadata, commandFileObservation: await finishCommandFileObservation(files, observation) } };
    }
  };
}

export const executeCodeToolProvider: SessionToolProvider = {
  name: "executeCode",
  kind: "session",
  createTools(ctx) {
    return [
      createExecuteCodeTool({
        workspaceRoot: ctx.workspaceRoot,
        executionLease: ctx.executionLease,
        childProcessEnv: ctx.childProcessEnv,
        toolExecutor: requireProviderDependency("executeCode", "toolExecutor", ctx.toolExecutor),
        sessionDb: requireProviderDependency("executeCode", "sessionDb", ctx.sessionDb),
        trajectoryRecorder: requireProviderDependency("executeCode", "trajectoryRecorder", ctx.trajectoryRecorder),
        sessionId: ctx.currentSessionId,
        trustedWorkspace: requireProviderDependency("executeCode", "trustedWorkspace", ctx.trustedWorkspace)
      })
    ];
  }
};

function requireProviderDependency<T>(provider: string, dependency: string, value: T | undefined): T {
  if (value === undefined) {
    throw new TypeError(`${provider}ToolProvider requires ${dependency}.`);
  }
  return value;
}

type RunCodeOptions = {
  code: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  maxOutputChars: number;
  pythonBinary: string;
  workspaceRoot: string;
  executionLease?: HostExecutionLease;
  childProcessEnv?: import("../contracts/tool-context.js").SessionToolContext["childProcessEnv"];
  allowedTools: Set<string>;
  signal?: AbortSignal;
  executeTool(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
};

async function runCode(options: RunCodeOptions): Promise<ToolResult> {
  options.executionLease?.assertActive();
  await options.executionLease?.files.realpath(options.workspaceRoot);
  const ownedProcesses = options.executionLease ? undefined : new HostProcessScope(options.workspaceRoot);
  const processes = options.executionLease?.processes ?? ownedProcesses!;
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  const detach = options.executionLease?.own({ release: () => completed });
  let tempDir: string | undefined;
  let cleanupUncertain = false;
  try {
    if (options.executionLease?.facts.backend !== "docker") tempDir = await mkdtemp(join(tmpdir(), "estacoda-execute-code-"));
    const result = await runHarness(options, processes, tempDir);
    cleanupUncertain = result.metadata?.cleanupUncertain === true;
    return result;
  } finally {
    try {
      await ownedProcesses?.release();
      if (tempDir && !cleanupUncertain) await rm(tempDir, { recursive: true, force: true });
    } finally { detach?.(); complete(); }
  }
}

async function runHarness(options: RunCodeOptions, processes: HostProcesses, tempDir?: string): Promise<ToolResult> {
  const scriptPath = tempDir ? join(tempDir, "script.py") : undefined;
  const sandboxHome = tempDir ? join(tempDir, "sandbox-home") : "/tmp";
  if (tempDir) { await mkdir(sandboxHome, { recursive: true }); await writeFile(scriptPath!, renderPythonHarness(options.code), "utf8"); }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...[options.signal, options.executionLease?.signal].filter((value): value is AbortSignal => value !== undefined)]);
  if (signal.aborted) return errorResult("execute_code cancelled before dispatch.");
  const childEnv = processes.environment({ homeDir: sandboxHome, extra: options.childProcessEnv?.extra });
  childEnv["ESTACODA_INPUT_JSON"] = JSON.stringify(options.input);
  childEnv["ESTACODA_ALLOWED_TOOLS_JSON"] = JSON.stringify([...options.allowedTools].sort());
  return new Promise<ToolResult>((resolve) => {
    const child = processes.spawn(tempDir ? options.pythonBinary : "python3", tempDir ? ["-u", scriptPath!] : ["-u", "-c", renderPythonHarness(options.code)], { input: true, env: childEnv });
    let stdout = "", stderr = "", pendingLine = "";
    let outputTruncated = false, settled = false, stopping = false;
    let activeCall: Promise<void> | undefined;
    const callIds = new Set<string>();
    const timeout = setTimeout(() => { void stop(`execute_code timed out after ${options.timeoutMs}ms`, true); }, options.timeoutMs);
    const onAbort = () => { void stop("execute_code cancelled."); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopping || settled) return;
      pendingLine += chunk;
      // A frame is bounded even when its terminating newline never arrives.
      while (pendingLine.includes("\n")) {
        const end = pendingLine.indexOf("\n");
        const line = pendingLine.slice(0, end);
        pendingLine = pendingLine.slice(end + 1);
        if (line.startsWith(TOOL_CALL_PREFIX)) {
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { void stop("execute_code tool-call payload exceeds its limit."); return; }
          try {
            const call = JSON.parse(line.slice(TOOL_CALL_PREFIX.length)) as Partial<ToolCall>;
            if (!call || typeof call.id !== "string" || !call.id.length || call.id.length > 128 || typeof call.tool !== "string" || call.tool.length > 128 ||
                call.input === null || typeof call.input !== "object" || Array.isArray(call.input) || callIds.has(call.id)) throw new Error("invalid frame");
            if (activeCall || callIds.size >= MAX_TOOL_CALLS) { void stop("execute_code tool-call count or concurrency limit exceeded."); return; }
            callIds.add(call.id);
            activeCall = (async () => {
              if (signal.aborted) return;
              const result = await options.executeTool(call.tool!, call.input!, signal);
              if (signal.aborted || stopping || settled) return;
              const response = JSON.stringify({ kind: "tool_result", id: call.id, result });
              if (Buffer.byteLength(response) > MAX_FRAME_BYTES) { void stop("execute_code tool-result payload exceeds its limit."); return; }
              child.stdin.write(`${response}\n`);
            })().catch(() => { void stop("execute_code nested tool failed."); }).finally(() => { activeCall = undefined; });
          } catch { void stop("execute_code received an invalid tool-call frame."); return; }
        } else appendStdout(`${line}\n`);
      }
      if (pendingLine.startsWith(TOOL_CALL_PREFIX) || TOOL_CALL_PREFIX.startsWith(pendingLine)) {
        if (Buffer.byteLength(pendingLine) > MAX_FRAME_BYTES) void stop("execute_code tool-call payload exceeds its limit.");
      } else if (pendingLine.length > options.maxOutputChars) {
        appendStdout(pendingLine.slice(0, -options.maxOutputChars));
        pendingLine = pendingLine.slice(-options.maxOutputChars);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      outputTruncated ||= stderr.length + chunk.length > options.maxOutputChars;
      stderr = (stderr + chunk).slice(-options.maxOutputChars);
    });
    child.once("error", () => { void stop("Failed to start execute_code."); });
    child.once("close", async (code, exitSignal) => {
      if (stopping) return;
      await activeCall;
      if (stopping || settled) return;
      if (pendingLine.startsWith(TOOL_CALL_PREFIX)) { await stop("execute_code ended with an incomplete tool-call frame."); return; }
      appendStdout(pendingLine);
      finish({ ok: code === 0 && !signal.aborted, content: formatCodeOutput(stdout, stderr, options.maxOutputChars),
        metadata: { exitCode: code, signal: exitSignal, timeoutMs: options.timeoutMs, maxOutputChars: options.maxOutputChars, toolCalls: callIds.size, outputTruncated } });
    });
    child.stdin.write(`${JSON.stringify({ kind: "ready" })}\n`);
    function appendStdout(chunk: string): void {
      outputTruncated ||= stdout.length + chunk.length > options.maxOutputChars;
      stdout = (stdout + chunk).slice(-options.maxOutputChars);
    }
    async function stop(content: string, timedOut = false): Promise<void> {
      if (stopping || settled) return;
      stopping = true;
      controller.abort();
      try { await processes.terminate(child, "SIGKILL"); }
      catch { await activeCall; finish({ ok: false, content: "execute_code termination could not be confirmed.", metadata: { cleanupUncertain: true } }); return; }
      // Abort delivery is not nested execution settlement. Keep the harness resource
      // registered until every accepted nested call has settled.
      await activeCall;
      finish({ ok: false, content, metadata: { timedOut, cancelled: !timedOut && signal.aborted, toolCalls: callIds.size } });
    }
    function finish(result: ToolResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }
  });
}

const TOOL_CALL_PREFIX = "__ESTACODA_TOOL_CALL__";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_TOOL_CALLS = 64;
type ToolCall = { id: string; tool: string; input: Record<string, unknown> };

function renderPythonHarness(userCode: string): string {
  return `import json
import os
import sys
import uuid

ESTACODA_INPUT = json.loads(os.environ.get("ESTACODA_INPUT_JSON", "{}"))
ESTACODA_ALLOWED_TOOLS = json.loads(os.environ.get("ESTACODA_ALLOWED_TOOLS_JSON", "[]"))

def tool(name, input=None):
    if input is None:
        input = {}
    call_id = str(uuid.uuid4())
    print("__ESTACODA_TOOL_CALL__" + json.dumps({"id": call_id, "tool": name, "input": input}, ensure_ascii=False), flush=True)
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("EstaCoda tool bridge closed before result arrived")
        event = json.loads(line)
        if event.get("kind") == "tool_result" and event.get("id") == call_id:
            return event.get("result")

${userCode}
`;
}

function formatCodeOutput(stdout: string, stderr: string, maxOutputChars: number): string {
  const cleanStdout = stdout.trim();
  const cleanStderr = stderr.trim();
  const content = [
    cleanStdout.length === 0 ? "(no stdout)" : cleanStdout,
    cleanStderr.length === 0 ? undefined : `stderr:\n${cleanStderr}`
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  return content.slice(-maxOutputChars);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}

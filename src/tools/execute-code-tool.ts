import { spawn } from "node:child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDB } from "../contracts/session.js";
import type { RegisteredTool, SessionToolProvider, ToolResult } from "../contracts/tool.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { buildSafeChildEnv } from "../security/process-env.js";
import type { ToolExecutor } from "./tool-executor.js";

export type ExecuteCodeToolOptions = {
  workspaceRoot: string;
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
    run: async (input: Record<string, unknown>) => {
      if (typeof input.code !== "string" || input.code.trim().length === 0) {
        return errorResult("execute_code requires non-empty Python code");
      }

      return runCode({
        code: input.code,
        input: asRecord(input.input),
        timeoutMs: boundedNumber(input.timeoutMs, 5_000, 1, 30_000),
        maxOutputChars: boundedNumber(input.maxOutputChars, 12_000, 1_000, 48_000),
        pythonBinary: options.pythonBinary ?? "python3",
        workspaceRoot: options.workspaceRoot,
        allowedTools,
        executeTool: async (tool, toolInput) => {
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
            sessionId: typeof options.sessionId === "function" ? options.sessionId() : options.sessionId
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
  allowedTools: Set<string>;
  executeTool(tool: string, input: Record<string, unknown>): Promise<ToolResult>;
};

async function runCode(options: RunCodeOptions): Promise<ToolResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "estacoda-execute-code-"));
  const scriptPath = join(tempDir, "script.py");
  const script = renderPythonHarness(options.code);
  const sandboxHome = join(tempDir, "sandbox-home");
  await mkdir(sandboxHome, { recursive: true });

  await writeFile(scriptPath, script, "utf8");

  return new Promise<ToolResult>((resolve) => {
    const childEnv = buildSafeChildEnv({ homeDir: sandboxHome });
    childEnv["ESTACODA_INPUT_JSON"] = JSON.stringify(options.input);
    childEnv["ESTACODA_ALLOWED_TOOLS_JSON"] = JSON.stringify([...options.allowedTools].sort());

    const child = spawn(options.pythonBinary, ["-u", scriptPath], {
      cwd: options.workspaceRoot,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const toolCallQueue: Promise<void>[] = [];
    const timeout = setTimeout(() => {
      finish({
        ok: false,
        content: `execute_code timed out after ${options.timeoutMs}ms`,
        metadata: {
          timedOut: true,
          timeoutMs: options.timeoutMs
        }
      });
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const { plainStdout, calls } = extractToolCalls(stdout);
      stdout = plainStdout;

      for (const call of calls) {
        toolCallQueue.push(handleToolCall(child, call, options.executeTool));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        content: `Failed to start execute_code: ${error.message}`,
        metadata: {
          errorType: error.name
        }
      });
    });
    child.on("close", async (code, signal) => {
      await Promise.allSettled(toolCallQueue);
      finish({
        ok: code === 0,
        content: formatCodeOutput(stdout, stderr, options.maxOutputChars),
        metadata: {
          exitCode: code,
          signal,
          timeoutMs: options.timeoutMs,
          maxOutputChars: options.maxOutputChars,
          toolCalls: toolCallQueue.length
        }
      });
    });

    child.stdin.write(`${JSON.stringify({ kind: "ready" })}\n`);

    function finish(result: ToolResult): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      void unlink(scriptPath).catch(() => undefined);
      resolve(result);
    }
  });
}

type ToolCall = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
};

function extractToolCalls(stdout: string): { plainStdout: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const lines = stdout.split("\n");
  const keptLines = [];

  for (const line of lines) {
    if (line.startsWith("__ESTACODA_TOOL_CALL__")) {
      const raw = line.slice("__ESTACODA_TOOL_CALL__".length);
      const parsed = JSON.parse(raw) as Partial<ToolCall>;

      if (typeof parsed.id === "string" && typeof parsed.tool === "string") {
        calls.push({
          id: parsed.id,
          tool: parsed.tool,
          input: asRecord(parsed.input)
        });
      }
    } else {
      keptLines.push(line);
    }
  }

  return {
    plainStdout: keptLines.join("\n"),
    calls
  };
}

async function handleToolCall(
  child: ReturnType<typeof spawn>,
  call: ToolCall,
  executeTool: RunCodeOptions["executeTool"]
): Promise<void> {
  const result = await executeTool(call.tool, call.input);
  if (child.stdin === null) {
    return;
  }

  child.stdin.write(`${JSON.stringify({
    kind: "tool_result",
    id: call.id,
    result
  })}\n`);
}

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
  if (typeof value !== "number" || Number.isNaN(value)) {
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

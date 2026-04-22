import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolResult } from "../contracts/tool.js";

export type PythonWorkerRequest = {
  tool: string;
  input: Record<string, unknown>;
};

export type PythonWorkerOptions = {
  pythonBinary?: string;
  runnerPath?: string;
  timeoutMs?: number;
  cwd?: string;
};

export async function runPythonWorker(
  request: PythonWorkerRequest,
  options: PythonWorkerOptions = {}
): Promise<ToolResult> {
  const pythonBinary = options.pythonBinary ?? "python3";
  const runnerPath = options.runnerPath ?? defaultRunnerPath();
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(pythonBinary, [runnerPath], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        ok: false,
        content: `Python worker timed out after ${timeoutMs}ms`,
        metadata: { tool: request.tool, timeoutMs }
      });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        content: `Failed to start Python worker: ${error.message}`,
        metadata: { tool: request.tool }
      });
    });

    child.on("close", () => {
      clearTimeout(timeout);
      resolve(parseWorkerResult(stdout, stderr, request.tool));
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function parseWorkerResult(stdout: string, stderr: string, tool: string): ToolResult {
  try {
    const parsed = JSON.parse(stdout) as ToolResult;
    return {
      ok: Boolean(parsed.ok),
      content: String(parsed.content ?? ""),
      metadata: {
        ...(isRecord(parsed.metadata) ? parsed.metadata : {}),
        stderr: stderr.trim() || undefined
      }
    };
  } catch (error) {
    return {
      ok: false,
      content: `Invalid Python worker response: ${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        tool,
        stdout,
        stderr
      }
    };
  }
}

function defaultRunnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../workers/python/runner.py");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

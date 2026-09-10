import type { HostExecutionLease } from "../execution/host-environment.js";
import { HostProcessScope } from "../execution/host-processes.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolResult } from "../contracts/tool.js";

export type PythonWorkerRequest = {
  tool: string;
  input: Record<string, unknown>;
};

export type PythonWorkerOptions = {
  executionLease?: HostExecutionLease;
  signal?: AbortSignal;
  pythonBinary?: string;
  runnerPath?: string;
  timeoutMs?: number;
  cwd?: string;
};

export async function runPythonWorker(request: PythonWorkerRequest, options: PythonWorkerOptions = {}): Promise<ToolResult> {
  const lease = options.executionLease;
  const signal = AbortSignal.any([...[options.signal, lease?.signal].filter((value): value is AbortSignal => value !== undefined)]);
  if (signal.aborted) return { ok: false, content: "Python worker cancelled before dispatch." };
  await lease?.files.realpath(lease.workspaceRoot);
  await lease?.content.assertMaterialized();
  const owned = lease ? undefined : new HostProcessScope(options.cwd ?? process.cwd());
  const processes = lease?.processes ?? owned!;
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > 64 * 1024) return { ok: false, content: "Python worker input exceeds its limit." };
  try {
    return await new Promise<ToolResult>((resolve) => {
      const child = processes.spawn(lease?.facts.backend === "docker" ? "python3" : options.pythonBinary ?? "python3", [lease?.facts.backend === "docker" ? "/opt/estacoda/python/runner.py" : options.runnerPath ?? defaultRunnerPath()], { input: true });
      let stdout = "", stderr = "", stopped = false;
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 30_000));
      const finish = (result: ToolResult) => { clearTimeout(timer); signal.removeEventListener("abort", cancel); resolve(result); };
      const stop = (content: string) => {
        if (stopped) return;
        stopped = true;
        void processes.terminate(child, "SIGKILL").then(() => finish({ ok: false, content }))
          .catch(() => finish({ ok: false, content: "Python worker termination could not be confirmed." }));
      };
      const cancel = () => stop("Python worker cancelled.");
      const timer = setTimeout(() => stop(`Python worker timed out after ${timeoutMs}ms`), timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { if (stdout.length + chunk.length > 64 * 1024) stop("Python worker response exceeds its limit."); else stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 4000); });
      child.once("error", () => stop("Failed to start Python worker."));
      child.once("close", () => { if (!stopped) finish(parseWorkerResult(stdout, stderr, request.tool)); });
      child.stdin.end(`${serialized}\n`);
    });
  } finally { await owned?.release(); }
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

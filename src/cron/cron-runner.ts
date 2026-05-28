import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { CronExecutionStore } from "./cron-execution-store.js";
import { classifyCronFailure, classifyCronScriptFailure } from "./cron-failure-classifier.js";
import type { CronJobLock } from "./cron-lock.js";
import type { CronJob } from "./cron-store.js";
import { CronStore } from "./cron-store.js";
import {
  HookRegistry,
  type GatewayHookEventName,
  type GatewayHookPayloadByName,
} from "../gateway/hook-registry.js";

function emitCronHook<N extends GatewayHookEventName>(
  hookRegistry: HookRegistry | undefined,
  name: N,
  payload: GatewayHookPayloadByName[N],
): void {
  try {
    const p = hookRegistry?.emit(name, payload);
    if (p) {
      p.catch(() => {});
    }
  } catch {
    // ignore sync throws from HookRegistry internals
  }
}

export type CronDeliveryResult = {
  success: boolean;
  perTarget: Map<string, { success: boolean; error?: string }>;
};

export type CronRunResult = {
  job: CronJob;
  ok: boolean;
  output: string;
  delivered: boolean;
  deliveryResults: Map<string, { success: boolean; error?: string }>;
  failureClass?: string;
  executionId?: string;
  skipped?: boolean;
  lockStale?: boolean;
};

export type CronRunner = {
  runJob(job: CronJob, executionId?: string): Promise<CronRunResult>;
};

type CronScriptResult = {
  ok: boolean;
  summary: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  timedOut: boolean;
};

export type TickCronInput = {
  store: CronStore;
  runner: CronRunner;
  now?: Date;
  lockPath?: string;
  executionStore?: CronExecutionStore;
  jobLock?: CronJobLock;
  hookRegistry?: HookRegistry;
};

export async function tickCron(input: TickCronInput): Promise<CronRunResult[]> {
  return withCronTickLock(input.lockPath ?? defaultLockPath(input.store), async () => {
    const due = await input.store.due(input.now);
    const results: CronRunResult[] = [];

    emitCronHook(input.hookRegistry, "cron:tick:start", { dueCount: due.length });

    for (const job of due) {
      // Per-job locking
      if (input.jobLock !== undefined) {
        const lockResult = await input.jobLock.acquire(job.id);
        if (!lockResult.acquired) {
          results.push({
            job,
            ok: false,
            output: "Job skipped: another execution is already in progress.",
            delivered: false,
            deliveryResults: new Map(),
            skipped: true
          });
          continue;
        }

        // Create execution record
        let executionId: string | undefined;
        if (input.executionStore !== undefined) {
          const scheduledAt = job.nextRunAt !== undefined ? new Date(job.nextRunAt) : undefined;
          const record = await input.executionStore.create({ jobId: job.id, scheduledAt });
          executionId = record.id;
        }

        // Advance nextRunAt under lock before execution to prevent duplicate runs
        await input.store.advanceNextRun(job.id, input.now);

        try {
          const result = await input.runner.runJob(job, executionId);
          const enriched: CronRunResult = { ...result, executionId, lockStale: lockResult.stale };

          // Complete execution record
          if (input.executionStore !== undefined && executionId !== undefined) {
            await input.executionStore.complete(executionId, {
              status: enriched.ok ? "success" : "failed",
              outputSummary: enriched.output.slice(0, 2000),
              deliveryResults: enriched.deliveryResults,
              failureClass: enriched.failureClass,
              failureMessage: enriched.failureClass !== undefined ? enriched.output.slice(0, 2000) : undefined
            });
          }

          await input.store.markRunResult(job.id, {
            ok: enriched.ok,
            output: enriched.output
          });

          if (!enriched.ok && !enriched.skipped) {
            emitCronHook(input.hookRegistry, "cron:job:fail", {
              jobId: job.id,
              executionId: enriched.executionId,
              failureClass: enriched.failureClass ?? "unknown",
              delivered: enriched.delivered,
            });
          }

          results.push(enriched);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = classifyCronFailure({ runtimeError: message });

          if (input.executionStore !== undefined && executionId !== undefined) {
            await input.executionStore.complete(executionId, {
              status: "failed",
              outputSummary: message,
              failureClass: failure.class,
              failureMessage: failure.message
            });
          }

          await input.store.markRunResult(job.id, {
            ok: false,
            output: message
          });

          emitCronHook(input.hookRegistry, "cron:job:fail", {
            jobId: job.id,
            executionId,
            failureClass: failure.class,
            delivered: false,
          });

          results.push({
            job,
            ok: false,
            output: message,
            delivered: false,
            deliveryResults: new Map(),
            failureClass: failure.class,
            executionId
          });
        } finally {
          await input.jobLock.release(job.id);
        }
      } else {
        // Legacy path: no per-job locking or execution recording
        const result = await input.runner.runJob(job);
        await input.store.markRunResult(job.id, {
          ok: result.ok,
          output: result.output
        });
        results.push(result);
      }
    }

    emitCronHook(input.hookRegistry, "cron:tick:complete", {
      total: results.length,
      passed: results.filter(r => r.ok && !r.skipped).length,
      failed: results.filter(r => !r.ok && !r.skipped).length,
      skipped: results.filter(r => r.skipped).length,
    });

    return results;
  });
}

export function createRuntimeCronRunner(input: {
  runtimeFactory: (job: CronJob) => Promise<Runtime>;
  deliver?: (job: CronJob, content: string) => Promise<CronDeliveryResult>;
  wrapResponse?: boolean;
  disposeRuntime?: boolean;
  workspaceRoot?: string;
}): CronRunner {
  return {
    async runJob(job, executionId) {
      const scriptResult = job.script === undefined
        ? undefined
        : await runCronScript(job, input.workspaceRoot);

      if (scriptResult !== undefined && !scriptResult.ok) {
        const classified = classifyCronScriptFailure(scriptResult.summary, scriptResult.timedOut);
        const content = formatCronOutput(job, `Cron script failed: ${scriptResult.summary}\n\n${renderScriptResult(scriptResult)}`, input.wrapResponse ?? true);
        const rawDelivery = await input.deliver?.(job, content);
        const deliveryResult: CronDeliveryResult = typeof rawDelivery === "boolean"
          ? { success: rawDelivery, perTarget: new Map() }
          : (rawDelivery ?? { success: false, perTarget: new Map() });
        return {
          job,
          ok: false,
          output: content,
          delivered: deliveryResult.success,
          deliveryResults: deliveryResult.perTarget,
          failureClass: classified.class,
          executionId
        };
      }

      const runtime = await input.runtimeFactory(job);
      try {
        const response = await runtime.handle({
          text: buildCronPrompt(job, scriptResult),
          channel: "cli",
          trustedWorkspace: true
        });
        if (response.text.trim().length === 0) {
          const message = "Agent completed but produced empty response (model error, timeout, or misconfiguration)";
          const failure = classifyCronFailure({ runtimeError: message });
          const content = formatCronOutput(job, message, input.wrapResponse ?? true);
          return {
            job,
            ok: false,
            output: content,
            delivered: false,
            deliveryResults: new Map(),
            failureClass: failure.class,
            executionId
          };
        }
        const content = formatCronOutput(job, response.text, input.wrapResponse ?? true);
        const silent = response.text.trimStart().startsWith("[SILENT]");
        const rawDelivery = silent ? undefined : await input.deliver?.(job, content);
        const deliveryResult: CronDeliveryResult = typeof rawDelivery === "boolean"
          ? { success: rawDelivery, perTarget: new Map() }
          : (silent ? { success: true, perTarget: new Map<string, { success: boolean; error?: string }>() } : (rawDelivery ?? { success: false, perTarget: new Map() }));
        return {
          job,
          ok: true,
          output: content,
          delivered: deliveryResult.success,
          deliveryResults: deliveryResult.perTarget,
          executionId
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = classifyCronFailure({ runtimeError: message });
        const content = formatCronOutput(job, `Cron job failed: ${message}`, input.wrapResponse ?? true);
        const rawDelivery = await input.deliver?.(job, content);
        const deliveryResult: CronDeliveryResult = typeof rawDelivery === "boolean"
          ? { success: rawDelivery, perTarget: new Map() }
          : (rawDelivery ?? { success: false, perTarget: new Map() });
        return {
          job,
          ok: false,
          output: content,
          delivered: deliveryResult.success,
          deliveryResults: deliveryResult.perTarget,
          failureClass: failure.class,
          executionId
        };
      } finally {
        if (input.disposeRuntime !== false) {
          await runtime.dispose();
        }
      }
    }
  };
}

export function buildCronPrompt(job: CronJob, scriptResult?: CronScriptResult): string {
  return [
    "Scheduled task execution.",
    "The task prompt must be treated as self-contained; do not ask clarifying questions.",
    job.skills.length === 0 ? undefined : `Attached skills: ${job.skills.join(", ")}`,
    scriptResult === undefined ? undefined : renderScriptResult(scriptResult),
    "",
    job.prompt
  ].filter((line) => line !== undefined).join("\n");
}

export function formatCronOutput(job: CronJob, output: string, wrap: boolean): string {
  if (!wrap) return output;
  return [
    `Cronjob Response: ${job.name}`,
    "-------------",
    output,
    "",
    "Note: The agent cannot see this message, and therefore cannot respond to it."
  ].join("\n");
}

export function originFromSessionKey(sessionKey: ChannelSessionKey, channel: string): CronJob["origin"] {
  return {
    channel,
    chatId: sessionKey.chatId,
    userId: sessionKey.userId,
    threadId: sessionKey.threadId
  };
}

async function withCronTickLock<T>(path: string, fn: () => Promise<T>, staleTimeoutMs = 300_000): Promise<T> {
  await mkdirSafe(dirname(path));

  async function tryAcquire(): Promise<Awaited<ReturnType<typeof open>>> {
    try {
      return await open(path, "wx");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EEXIST") {
        // Check if stale (only reclaim if we can parse it and prove it's stale)
        const lockedAt = await readTickLockTimestamp(path);
        if (lockedAt !== undefined) {
          const elapsed = Date.now() - lockedAt.getTime();
          if (elapsed > staleTimeoutMs) {
            await rm(path, { force: true });
            return await open(path, "wx");
          }
        }
        // Lock exists and is either fresh or unreadable - skip tick
        throw new TickLockInUseError();
      }
      throw error;
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await tryAcquire();
  } catch (error) {
    if (error instanceof TickLockInUseError) {
      return [] as unknown as T;
    }
    throw error;
  }

  try {
    const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    await handle.writeFile(content, "utf8");
    return await fn();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}

class TickLockInUseError extends Error {
  constructor() {
    super("Cron tick lock is already held");
    this.name = "TickLockInUseError";
  }
}

async function readTickLockTimestamp(path: string): Promise<Date | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { startedAt?: string };
    if (typeof parsed.startedAt === "string") {
      const d = Date.parse(parsed.startedAt);
      if (!Number.isNaN(d)) return new Date(d);
    }
  } catch {
    // Not valid JSON - try raw ISO string fallback below
  }
  try {
    const raw = await readFile(path, "utf8");
    const d = Date.parse(raw.trim());
    if (!Number.isNaN(d)) return new Date(d);
  } catch {
    // ignore
  }
  return undefined;
}

async function mkdirSafe(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

function defaultLockPath(store: CronStore): string {
  return join(dirname(store.path), ".tick.lock");
}

async function runCronScript(job: CronJob, workspaceRoot: string | undefined): Promise<CronScriptResult> {
  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    return failedScript("script-backed cron jobs require a workspace root");
  }

  const rawScript = job.script;
  if (rawScript === undefined || rawScript.trim().length === 0) {
    return failedScript("script path is empty");
  }

  try {
    const workspaceReal = await realpath(workspaceRoot);
    const scriptCandidate = isAbsolute(rawScript) ? rawScript : resolve(workspaceReal, rawScript);
    const scriptReal = await realpath(scriptCandidate);
    const relativePath = relative(workspaceReal, scriptReal);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return failedScript("script path must stay inside the active workspace");
    }

    const invocation = scriptInvocation(scriptReal);
    if (invocation === undefined) {
      return failedScript("script extension is not supported; use .sh, .bash, .zsh, .py, .js, .mjs, or .ts");
    }

    return await spawnCronScript({
      command: invocation.command,
      args: [...invocation.args, ...(job.scriptArgs ?? [])],
      cwd: workspaceReal,
      timeoutMs: boundedTimeout(job.scriptTimeoutMs)
    });
  } catch (error) {
    return failedScript(error instanceof Error ? error.message : String(error));
  }
}

function scriptInvocation(scriptPath: string): { command: string; args: string[] } | undefined {
  const extension = extname(scriptPath).toLowerCase();
  if (extension === ".sh" || extension === ".bash") return { command: "bash", args: [scriptPath] };
  if (extension === ".zsh") return { command: "zsh", args: [scriptPath] };
  if (extension === ".py") return { command: "python3", args: [scriptPath] };
  if (extension === ".js" || extension === ".mjs") return { command: "node", args: [scriptPath] };
  if (extension === ".ts") return { command: process.execPath, args: [scriptPath] };
  return undefined;
}

function spawnCronScript(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<CronScriptResult> {
  return new Promise((resolveScript) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveScript({
        ok: false,
        summary: error.message,
        stdout,
        stderr,
        timedOut: false
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveScript({
          ok: false,
          summary: `script timed out after ${input.timeoutMs}ms`,
          stdout,
          stderr,
          timedOut: true
        });
        return;
      }
      resolveScript({
        ok: code === 0,
        summary: code === 0 ? "script completed successfully" : `script exited with code ${code ?? "unknown"}`,
        stdout,
        stderr,
        exitCode: code ?? undefined,
        timedOut: false
      });
    });
  });
}

function failedScript(summary: string): CronScriptResult {
  return {
    ok: false,
    summary,
    stdout: "",
    stderr: "",
    timedOut: false
  };
}

function renderScriptResult(result: CronScriptResult): string {
  return [
    "Cron script result:",
    `status: ${result.ok ? "succeeded" : "failed"}`,
    `summary: ${result.summary}`,
    result.exitCode === undefined ? undefined : `exit code: ${result.exitCode}`,
    "stdout:",
    result.stdout.trim().length === 0 ? "(empty)" : result.stdout.trim(),
    "stderr:",
    result.stderr.trim().length === 0 ? "(empty)" : result.stderr.trim()
  ].filter((line) => line !== undefined).join("\n");
}

function appendBounded(current: string, chunk: string): string {
  const maxChars = 8_000;
  const next = `${current}${chunk}`;
  return next.length <= maxChars ? next : `${next.slice(0, maxChars)}\n[truncated]`;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30_000;
  return Math.max(1_000, Math.min(120_000, Math.floor(value)));
}

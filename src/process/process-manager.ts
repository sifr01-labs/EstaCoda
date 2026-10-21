import { beginCommandFileObservation, finishCommandFileObservation, type CommandFileObservation } from "../execution/command-file-evidence.js";
import { HostWorkspaceFiles, type WorkspaceFiles } from "../execution/host-workspace-files.js";
import type { RequestRequirements } from "../contracts/intent.js";
import { HostProcessScope, type HostProcesses } from "../execution/host-processes.js";
import type { HostExecutionLease } from "../execution/host-environment.js";
import { type ChildProcessByStdio } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { platform } from "node:os";

export type ManagedProcessStatus = "prepared" | "running" | "exited" | "stopped" | "failed";

export type ManagedProcessRecord = {
  id: string;
  command: string;
  cwd: string;
  status: ManagedProcessStatus;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export type ManagedProcessLog = {
  stream: "stdout" | "stderr" | "system";
  text: string;
  timestamp: string;
};

type InternalManagedProcess = ManagedProcessRecord & {
  fileObservation?: CommandFileObservation;
  finalFileObservation?: Promise<CommandFileObservation | undefined>;
  child?: ChildProcessByStdio<Writable, Readable, Readable>;
  logs: ManagedProcessLog[];
  protectedEnvironmentVariable?: string;
  sensitiveOutput?: boolean;
};

export type ProcessManagerOptions = {
  executionLease?: HostExecutionLease;
  workspaceRoot: string;
  childProcessEnv?: import("../contracts/tool-context.js").SessionToolContext["childProcessEnv"];
  maxLogChars?: number;
  now?: () => Date;
  id?: () => string;
};

const DEFAULT_MAX_LOG_CHARS = 96_000;

export class ProcessManager {
  readonly #files: WorkspaceFiles;
  readonly #workspaceRoot: string;
  readonly #childProcessEnv: ProcessManagerOptions["childProcessEnv"];
  readonly #processScope: HostProcesses;
  readonly #lease?: HostExecutionLease;
  readonly #ownedScope?: HostProcessScope;
  readonly #maxLogChars: number;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #processes = new Map<string, InternalManagedProcess>();
  #disposed = false;
  #closing?: Promise<void>;

  constructor(options: ProcessManagerOptions) {
    this.#lease = options.executionLease;
    this.#childProcessEnv = options.childProcessEnv;
    this.#workspaceRoot = options.executionLease?.workspaceRoot ?? resolve(options.workspaceRoot);
    this.#files = options.executionLease?.files ?? new HostWorkspaceFiles(this.#workspaceRoot);
    this.#ownedScope = options.executionLease === undefined ? new HostProcessScope(this.#workspaceRoot) : undefined;
    this.#processScope = options.executionLease?.processes ?? this.#ownedScope!;
    this.#maxLogChars = Math.max(1, Math.min(options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS, DEFAULT_MAX_LOG_CHARS));
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomId;
    options.executionLease?.own({ release: () => this.dispose() });
  }

  async start(command: string, signal?: AbortSignal, options: { input?: boolean; continuationSignal?: AbortSignal; requirements?: RequestRequirements; visibleTurnId?: string } = {}): Promise<ManagedProcessRecord> {
    signal?.throwIfAborted();
    options.continuationSignal?.throwIfAborted();
    const record = await this.#createRecord(command, "running");
    if (signal?.aborted) { this.#processes.delete(record.id); signal.throwIfAborted(); }
    if (options.continuationSignal?.aborted) { this.#processes.delete(record.id); options.continuationSignal.throwIfAborted(); }
    record.fileObservation = await beginCommandFileObservation(this.#files, options.requirements, options.visibleTurnId);
    if (signal?.aborted || options.continuationSignal?.aborted) { this.#processes.delete(record.id); (signal?.aborted ? signal : options.continuationSignal)!.throwIfAborted(); }
    this.#spawn(record, undefined, options.input ?? true);
    if (record.child && record.status === "running" && options.continuationSignal) {
      const continuationSignal = options.continuationSignal;
      const onAbort = () => {
        void this.stop(record.id).catch(() => this.#appendLog(record, "system", "Process cancellation could not be confirmed; execution scope retains cleanup ownership."));
      };
      record.child.once("close", () => continuationSignal.removeEventListener("abort", onAbort));
      continuationSignal.addEventListener("abort", onAbort, { once: true });
      if (continuationSignal.aborted) onAbort();
    }
    return toRecord(record);
  }

  /** Yield without killing the process. Cancellation while waiting still settles it. */
  async wait(id: string, waitMs: number, signal?: AbortSignal): Promise<ManagedProcessRecord | undefined> {
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("Process wait must be between 0 and 30000 ms.");
    const record = this.#processes.get(id);
    if (record === undefined) return undefined;
    if (signal?.aborted) { await this.stop(id); signal.throwIfAborted(); }
    if (record.status !== "running" || record.child === undefined) return toRecord(record);
    const child = record.child;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onClose = () => { cleanup(); resolve(); };
      const onAbort = () => {
        cleanup();
        void this.stop(id).then(() => reject(signal?.reason ?? new Error("Process wait cancelled.")), reject);
      };
      const timer = setTimeout(onClose, waitMs);
      child.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return toRecord(record);
  }

  async fileObservation(id: string): Promise<CommandFileObservation | undefined> {
    const record = this.#processes.get(id);
    if (!record || record.status === "prepared") return undefined;
    return record.finalFileObservation ?? record.fileObservation;
  }

  async prepareProtectedEnvironment(command: string, variableName: string): Promise<ManagedProcessRecord> {
    assertEnvironmentVariableName(variableName);
    return toRecord(await this.#createRecord(command, "prepared", variableName));
  }

  canStartProtectedEnvironment(id: string, variableName: string): boolean {
    const record = this.#processes.get(id);
    return record?.status === "prepared" && record.protectedEnvironmentVariable === variableName;
  }

  startProtectedEnvironment(id: string, variableName: string, value: Uint8Array): ManagedProcessRecord | undefined {
    const record = this.#processes.get(id);
    if (record === undefined || !this.canStartProtectedEnvironment(id, variableName)) return undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    record.sensitiveOutput = true;
    record.logs.length = 0;
    record.status = "running";
    record.updatedAt = this.#now().toISOString();
    this.#spawn(record, { [variableName]: decoded });
    return toRecord(record);
  }

  hasObservedPrompt(id: string, promptLabel: string): boolean {
    const record = this.#processes.get(id);
    if (record?.status !== "running" || record.child?.stdin.destroyed === true) return false;
    const label = promptLabel.trim();
    const observedOutput = record.logs
      .filter((entry) => entry.stream === "stdout" || entry.stream === "stderr")
      .map((entry) => entry.text)
      .join("")
      .slice(-12_000);
    return label.length > 0 && label.length <= 200 && observedOutput.includes(label);
  }

  writeProtectedInput(id: string, promptLabel: string, value: Uint8Array): boolean {
    const record = this.#processes.get(id);
    if (record === undefined || !this.hasObservedPrompt(id, promptLabel) || record.child === undefined) return false;
    record.sensitiveOutput = true;
    record.logs.length = 0;
    record.child.stdin.write(value);
    record.child.stdin.write("\n");
    return true;
  }

  releasePrepared(id: string): void {
    const record = this.#processes.get(id);
    if (record?.status === "prepared") this.#processes.delete(id);
  }

  async #createRecord(
    command: string,
    status: "prepared" | "running",
    protectedEnvironmentVariable?: string
  ): Promise<InternalManagedProcess> {
    if (this.#disposed) throw new Error("Process manager has been disposed.");
    await this.#lease?.content.assertMaterialized();
    const cwd = this.#lease === undefined ? await realpath(this.#workspaceRoot) : await this.#lease.files.realpath(this.#workspaceRoot);
    if (this.#disposed) throw new Error("Process manager has been disposed.");
    if (this.#processes.size >= 128) {
      for (const [id, record] of this.#processes) {
        if (["exited", "stopped", "failed"].includes(record.status) && record.child?.exitCode !== null) this.#processes.delete(id);
      }
      if (this.#processes.size >= 128) throw new Error("Process scope record limit reached. Stop existing processes first.");
    }
    const id = this.#id();
    const startedAt = this.#now().toISOString();
    const record: InternalManagedProcess = {
      id,
      command,
      cwd,
      status,
      startedAt,
      updatedAt: startedAt,
      logs: [],
      protectedEnvironmentVariable
    };

    this.#processes.set(id, record);
    return record;
  }

  #spawn(record: InternalManagedProcess, protectedEnvironment?: Record<string, string>, input = true): void {
    try {
      const shell = this.#processScope.shell?.() ?? resolveShell();
      const child = this.#processScope.spawn(shell.command, [...shell.args, record.command], {
        env: {
          ...this.#processScope.environment({ homeDir: this.#childProcessEnv?.homeDir, extra: this.#childProcessEnv?.extra }),
          PWD: record.cwd,
          ...protectedEnvironment
        },
        input
      });
      record.child = child;
      this.#appendLog(record, "system", `started pid ${child.pid ?? "unknown"}`);

      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.#appendLog(record, "stdout", chunk));
      child.stderr.on("data", (chunk: string) => this.#appendLog(record, "stderr", chunk));
      child.on("error", (error) => {
        record.status = "failed";
        record.updatedAt = this.#now().toISOString();
        this.#appendLog(record, "system", error.message);
      });
      child.on("close", (code, signal) => {
        record.finalFileObservation = finishCommandFileObservation(this.#files, record.fileObservation);
        record.protectedEnvironmentVariable = undefined;
        if (record.status === "stopped") {
          record.exitCode = code;
          record.signal = signal;
          record.updatedAt = this.#now().toISOString();
          return;
        }

        record.status = code === 0 ? "exited" : "failed";
        record.exitCode = code;
        record.signal = signal;
        record.updatedAt = this.#now().toISOString();
        this.#appendLog(record, "system", `closed with code ${code ?? "null"} signal ${signal ?? "null"}`);
      });
    } catch (error) {
      record.protectedEnvironmentVariable = undefined;
      record.status = "failed";
      record.updatedAt = this.#now().toISOString();
      this.#appendLog(record, "system", error instanceof Error ? error.message : "failed to start process");
    }

  }

  list(): ManagedProcessRecord[] {
    return [...this.#processes.values()].map(toRecord);
  }

  get(id: string): ManagedProcessRecord | undefined {
    const process = this.#processes.get(id);
    return process === undefined ? undefined : toRecord(process);
  }

  logs(id: string, options: { tailChars?: number } = {}): ManagedProcessLog[] | undefined {
    const process = this.#processes.get(id);

    if (process === undefined) {
      return undefined;
    }
    if (process.sensitiveOutput === true) return [];

    const tailChars = options.tailChars ?? 12_000;
    const logs: ManagedProcessLog[] = [];
    let remaining = tailChars;

    for (const log of [...process.logs].reverse()) {
      if (remaining <= 0) {
        break;
      }

      const text = log.text.length > remaining ? log.text.slice(log.text.length - remaining) : log.text;
      logs.push({
        ...log,
        text
      });
      remaining -= text.length;
    }

    return logs.reverse();
  }

  async stop(id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<ManagedProcessRecord | undefined> {
    const process = this.#processes.get(id);

    if (process === undefined) {
      return undefined;
    }

    if ((process.status !== "running" && process.status !== "stopped") || process.child === undefined) {
      return toRecord(process);
    }

    if (process.status === "running") {
      process.status = "stopped";
      process.updatedAt = this.#now().toISOString();
      this.#appendLog(process, "system", `stopping with ${signal}`);
    }
    // Concurrent cancellation and explicit stop must await the same OS cleanup.
    await this.#processScope.terminate(process.child, signal);

    return toRecord(process);
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    return this.#closing ??= (async () => {
      const results = await Promise.allSettled([...this.#processes.values()].map((record) => record.child === undefined ? undefined : this.#processScope.terminate(record.child)));
      await this.#ownedScope?.release();
      this.#processes.clear();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Managed processes did not settle.");
    })();
  }

  #appendLog(process: InternalManagedProcess, stream: ManagedProcessLog["stream"], text: string): void {
    if (process.sensitiveOutput === true) return;
    if (!text.length) return;
    process.logs.push({
      stream,
      text: text.slice(-this.#maxLogChars),
      timestamp: this.#now().toISOString()
    });

    let totalChars = process.logs.reduce((total, log) => total + log.text.length, 0);
    while ((totalChars > this.#maxLogChars || process.logs.length > 1024) && process.logs.length > 1) {
      const removed = process.logs.shift();
      totalChars -= removed?.text.length ?? 0;
    }
  }
}

function assertEnvironmentVariableName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error("Protected environment variable name is invalid.");
  }
}

function resolveShell(): { command: string; args: string[] } {
  const shell = process.env.SHELL;
  if (typeof shell === "string" && shell.trim().length > 0) {
    return {
      command: shell,
      args: ["-lc"]
    };
  }

  if (platform() === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c"]
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc"]
  };
}

function toRecord(process: InternalManagedProcess): ManagedProcessRecord {
  return {
    id: process.id,
    command: process.command,
    cwd: process.cwd,
    status: process.status,
    startedAt: process.startedAt,
    updatedAt: process.updatedAt,
    exitCode: process.exitCode,
    signal: process.signal
  };
}

function randomId(): string {
  return `proc_${Math.random().toString(36).slice(2, 10)}`;
}

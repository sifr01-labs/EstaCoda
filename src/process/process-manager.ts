import { spawn, type ChildProcessByStdio } from "node:child_process";
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
  child?: ChildProcessByStdio<Writable, Readable, Readable>;
  logs: ManagedProcessLog[];
  protectedEnvironmentVariable?: string;
  sensitiveOutput?: boolean;
};

export type ProcessManagerOptions = {
  workspaceRoot: string;
  maxLogChars?: number;
  now?: () => Date;
  id?: () => string;
};

const DEFAULT_MAX_LOG_CHARS = 96_000;

export class ProcessManager {
  readonly #workspaceRoot: string;
  readonly #maxLogChars: number;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #processes = new Map<string, InternalManagedProcess>();

  constructor(options: ProcessManagerOptions) {
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#maxLogChars = options.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomId;
  }

  async start(command: string): Promise<ManagedProcessRecord> {
    const record = await this.#createRecord(command, "running");
    this.#spawn(record);
    return toRecord(record);
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
    const cwd = await realpath(this.#workspaceRoot);
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

  #spawn(record: InternalManagedProcess, protectedEnvironment?: Record<string, string>): void {
    try {
      const shell = resolveShell();
      const child = spawn(shell.command, [...shell.args, record.command], {
        cwd: record.cwd,
        env: {
          ...process.env,
          PWD: record.cwd,
          ...protectedEnvironment
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      record.child = child;
      this.#appendLog(record, "system", `started pid ${child.pid ?? "unknown"}`);

      child.stdout.on("data", (chunk: Buffer) => this.#appendLog(record, "stdout", chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => this.#appendLog(record, "stderr", chunk.toString("utf8")));
      child.on("error", (error) => {
        record.status = "failed";
        record.updatedAt = this.#now().toISOString();
        this.#appendLog(record, "system", error.message);
      });
      child.on("close", (code, signal) => {
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

    if (process.status !== "running" || process.child === undefined) {
      return toRecord(process);
    }

    process.status = "stopped";
    process.updatedAt = this.#now().toISOString();
    this.#appendLog(process, "system", `stopping with ${signal}`);
    process.child.kill(signal);

    return toRecord(process);
  }

  #appendLog(process: InternalManagedProcess, stream: ManagedProcessLog["stream"], text: string): void {
    if (process.sensitiveOutput === true) return;
    process.logs.push({
      stream,
      text,
      timestamp: this.#now().toISOString()
    });

    let totalChars = process.logs.reduce((total, log) => total + log.text.length, 0);
    while (totalChars > this.#maxLogChars && process.logs.length > 1) {
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

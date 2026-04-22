import { spawn, type ChildProcessByStdio } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { Readable } from "node:stream";
import { resolve } from "node:path";

export type ManagedProcessStatus = "running" | "exited" | "stopped" | "failed";

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
  child?: ChildProcessByStdio<null, Readable, Readable>;
  logs: ManagedProcessLog[];
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
    const cwd = await realpath(this.#workspaceRoot);
    const id = this.#id();
    const startedAt = this.#now().toISOString();
    const record: InternalManagedProcess = {
      id,
      command,
      cwd,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      logs: []
    };

    this.#processes.set(id, record);

    try {
      const child = spawn("/bin/zsh", ["-lc", command], {
        cwd,
        env: {
          ...process.env,
          PWD: cwd
        },
        stdio: ["ignore", "pipe", "pipe"]
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
      record.status = "failed";
      record.updatedAt = this.#now().toISOString();
      this.#appendLog(record, "system", error instanceof Error ? error.message : "failed to start process");
    }

    return toRecord(record);
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

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSafeChildEnv, type SafeChildEnvOptions } from "../security/process-env.js";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

export type HostSpawnOptions = { env?: NodeJS.ProcessEnv; input?: boolean };
export type HostProcesses = Pick<HostProcessScope, "spawn" | "terminate" | "environment">;
type OwnedChild = { child: ChildProcess; closed: Promise<void>; settled: boolean; cleanupError?: unknown; stopping?: Promise<void> };

/** One resource owner, even when several owners share a workspace/environment.
 * POSIX children receive a fresh process group; Windows uses taskkill /T. */
export class HostProcessScope {
  readonly #root: string;
  readonly #children = new Map<ChildProcess, OwnedChild>();
  #released = false;
  #home: string | undefined;

  environment(options: SafeChildEnvOptions = {}): Record<string, string> {
    if (this.#released) throw new Error("Process scope has been released.");
    if (options.homeDir === undefined) this.#home ??= mkdtempSync(join(tmpdir(), "estacoda-process-home-"));
    return buildSafeChildEnv({ ...options, homeDir: options.homeDir ?? this.#home });
  }
  constructor(workspaceRoot: string) { this.#root = workspaceRoot; }

  spawn(command: string, args: readonly string[], options: HostSpawnOptions = {}): ChildProcessWithoutNullStreams {
    if (this.#released) throw new Error("Process scope has been released.");
    const child = spawn(command, [...args], { cwd: this.#root, env: options.env ?? this.environment(),
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let settle!: () => void;
    const record: OwnedChild = { child, settled: false, closed: new Promise<void>((resolve) => { settle = resolve; }) };
    this.#children.set(child, record);
    child.once("error", () => { /* The caller receives the error; close settles ownership. */ });
    child.once("exit", () => {
      // Descendants may retain stdout and prevent close after their leader exits.
      try { if (process.platform !== "win32") signalGroup(child, "SIGKILL"); }
      catch (error) { record.cleanupError = error; }
    });
    child.once("close", () => {
      record.settled = true;
      if (!record.cleanupError) this.#children.delete(child);
      settle();
    });
    child.stdin.on("error", () => { /* A terminated child may close stdin during an authorized write. */ });
    if (options.input !== true) child.stdin.end();
    return child;
  }

  async terminate(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const record = this.#children.get(child);
    if (record === undefined) return; // A foreign handle grants no process control.
    record.stopping ??= (async () => {
      if (process.platform === "win32" && child.pid !== undefined) {
        await terminateWindowsTree(child.pid);
      } else {
        signalGroup(child, signal);
        if (signal !== "SIGKILL") {
          await Promise.race([record.closed, delay(1_000)]);
          if (!record.settled) signalGroup(child, "SIGKILL");
        }
      }
      await Promise.race([record.closed, delay(2_000)]);
      if (record.cleanupError) throw new Error("Owned descendant cleanup could not be confirmed.");
      if (!record.settled) throw new Error("Owned process termination could not be confirmed.");
    })();
    await record.stopping;
  }

  async release(): Promise<void> {
    this.#released = true;
    const results = await Promise.allSettled([...this.#children.keys()].map((child) => this.terminate(child)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Owned processes did not settle.");
    if (this.#home) await rm(this.#home, { recursive: true, force: true });
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); }); }
function terminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    const timer = setTimeout(() => { killer.kill(); reject(new Error("Windows process cleanup timed out.")); }, 3_000);
    killer.once("error", (error) => { clearTimeout(timer); reject(error); });
    killer.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Owned Windows process tree could not be terminated.")); });
  });
}

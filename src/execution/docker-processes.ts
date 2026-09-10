import { retainCurrentExecutionOperation } from "../runtime/live-execution-authority.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SafeChildEnvOptions } from "../security/process-env.js";
import { HostProcessScope, type HostProcesses, type HostSpawnOptions } from "./host-processes.js";
import { type DockerContainer, type DockerReceipt } from "./docker-container.js";

export class DockerProcessScope implements HostProcesses {
  readonly #local: HostProcessScope;
  readonly #children = new Map<ChildProcess, { receipt: DockerReceipt; releaseAuthority(): void; cleanup?: Promise<void> }>();
  #released = false;
  constructor(readonly container: DockerContainer, readonly homeDir?: string) { this.#local = new HostProcessScope(container.workspace.canonicalPath); }
  environment(options: SafeChildEnvOptions = {}): Record<string, string> {
    if (this.#released) throw new Error("Docker process scope was released.");
    if (Object.keys(options.extra ?? {}).length) throw new Error("Docker credential/environment injection is not configured. Use an approved execution capability.");
    return { HOME: "/tmp", TMPDIR: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
  }
  spawn(command: string, args: readonly string[], options: HostSpawnOptions = {}): ChildProcessWithoutNullStreams {
    if (this.#released) throw new Error("Docker process scope was released.");
    const receipt: DockerReceipt = { name: `estacoda-exec-${randomUUID()}`, owner: randomUUID() };
    const env = options.env ?? this.environment();
    const allowed = new Set([...Object.keys(this.environment()), "ESTACODA_INPUT_JSON", "ESTACODA_ALLOWED_TOOLS_JSON"]);
    if (Object.keys(env).some((key) => !allowed.has(key))) throw new Error("Docker command requested an unapproved environment capability.");
    const packet = JSON.stringify({ endpoint: this.container.client.endpoint, receipt, profileId: this.container.profileId,
      workspaceRoot: this.container.workspace.canonicalPath, homeDir: this.homeDir ?? this.container.receipts.homeDir, policy: this.container.policy, command, args, env });
    if (Buffer.byteLength(packet) > 1024 * 1024) throw new Error("Docker command input exceeds its limit.");
    this.container.receipts.write({ ...receipt, schemaVersion: 1, profileId: this.container.profileId,
      workspaceHash: this.container.workspace.identityHash, endpoint: this.container.client.endpoint, creatorPid: process.pid, phase: "planned" });
    const source = import.meta.url.endsWith(".ts");
    const controller = fileURLToPath(new URL("../../workers/docker/process-client.mjs", import.meta.url));
    const child = this.#local.spawn(process.execPath, [...(source ? ["--import", import.meta.resolve("tsx")] : []), controller,
      new URL(`./docker-container.${source ? "ts" : "js"}`, import.meta.url).href,
      new URL(`./docker-client.${source ? "ts" : "js"}`, import.meta.url).href], { input: true });
    const record = { receipt, releaseAuthority: retainCurrentExecutionOperation() };
    this.#children.set(child, record);
    child.once("close", () => { void this.#clean(child).catch(() => { /* Retain the receipt and authority until explicit settlement. */ }); });
    child.stdin.write(packet + "\n");
    if (!options.input) child.stdin.end();
    return child;
  }
  async #clean(child: ChildProcess): Promise<void> {
    const record = this.#children.get(child); if (!record) return;
    record.cleanup ??= (async () => {
      await this.container.receipts.clean(this.container.client, record.receipt);
      this.#children.delete(child); record.releaseAuthority();
    })();
    await record.cleanup;
  }
  async terminate(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.#children.has(child)) return;
    await this.#local.terminate(child, signal);
    await this.#clean(child);
  }
  async release(): Promise<void> {
    this.#released = true;
    const results = await Promise.allSettled([...this.#children.keys()].map((child) => this.terminate(child)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), "Owned Docker processes did not settle.");
    await this.#local.release();
  }
}

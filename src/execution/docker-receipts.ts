import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { processDefinitelyAbsent } from "../session/execution-ownership.js";
import type { DockerClient } from "./docker-client.js";
import { cleanupDockerReceipt, type DockerReceipt } from "./docker-container.js";
export type DockerJournalEntry = DockerReceipt & { schemaVersion: 1; profileId: string; workspaceHash: string; endpoint: string; creatorPid: number; controllerPid?: number; phase: "planned" | "creating" | "created" | "settled" };
/** Private creation receipts contain no command, environment, or credentials. */
export class DockerReceipts {
  readonly directory: string;
  readonly homeDir: string;
  constructor(readonly profileId: string, homeDir?: string) { this.homeDir = resolveGlobalStateHome({ homeDir }).homeDir; this.directory = join(resolveProfileStateHome({ profileId, homeDir }).profileRoot, "execution", "docker"); }
  path(owner: string): string { if (!/^[a-f0-9-]{36}$/u.test(owner)) throw new Error("Invalid Docker receipt key."); return join(this.directory, owner + ".json"); }
  read(owner: string): DockerJournalEntry | undefined {
    const path = this.path(owner);
    try {
      const stat = lstatSync(path); if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid Docker receipt file.");
      const value = JSON.parse(readFileSync(path, "utf8")) as DockerJournalEntry;
      if (value.schemaVersion !== 1 || value.profileId !== this.profileId || value.owner !== owner || !/^estacoda-exec-[a-f0-9-]{36}$/u.test(value.name) ||
        !/^[a-f0-9]{64}$/u.test(value.workspaceHash) || !Number.isSafeInteger(value.creatorPid) || value.creatorPid <= 0 ||
        (value.controllerPid !== undefined && (!Number.isSafeInteger(value.controllerPid) || value.controllerPid <= 0)) ||
        !["planned", "creating", "created", "settled"].includes(value.phase) || (value.id !== undefined && !/^[a-f0-9]{64}$/u.test(value.id))) throw new Error("Invalid Docker ownership journal.");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  write(entry: DockerJournalEntry): void {
    if (entry.profileId !== this.profileId) throw new Error("Docker receipt profile mismatch.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(entry.owner), temporary = path + `.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  async clean(client: DockerClient, receipt: DockerReceipt, keepReceipt = false): Promise<void> {
    const entry = this.read(receipt.owner);
    if (!entry || entry.name !== receipt.name || entry.endpoint !== client.endpoint) throw new Error("Docker cleanup lacks its durable creation receipt.");
    await cleanupDockerReceipt(client, { ...entry, id: receipt.id ?? entry.id }, entry.phase === "creating");
    if (keepReceipt) { this.write({ ...entry, phase: "settled" }); return; }
    try { unlinkSync(this.path(receipt.owner)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async recover(client: DockerClient, workspaceHash: string): Promise<void> {
    let names: string[];
    try { names = readdirSync(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (names.length > 4096) throw new Error("Docker ownership journal needs operator maintenance.");
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const entry = this.read(name.slice(0, -5))!;
      if (entry.workspaceHash !== workspaceHash || entry.endpoint !== client.endpoint) continue;
      // PID reuse/EPERM/liveness is unknown ownership, never a reason to adopt.
      if (!processDefinitelyAbsent(entry.creatorPid) || (entry.controllerPid && !processDefinitelyAbsent(entry.controllerPid))) continue;
      await this.clean(client, entry);
    }
  }
}

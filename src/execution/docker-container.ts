import { randomUUID, createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { DockerClient } from "./docker-client.js";
import { DOCKER_IMAGE_LABEL, parseExecutionPolicy } from "./docker-policy.js";
import type { RequestedExecutionPolicy } from "../contracts/execution-authority.js";
import type { WorkspaceIdentity } from "../contracts/workspace.js";
import { resolveWorkspaceDirectory } from "../workspaces/workspace-registry.js";
import { resolveGlobalStateHome } from "../config/profile-home.js";

export type DockerReceipt = { name: string; owner: string; id?: string };
export const DOCKER_OWNER_LABEL = "io.estacoda.execution.owner";
export const DOCKER_DEFAULT_LIMITS = Object.freeze({ cpu: 1, memoryBytes: 512 * 1024 * 1024, pids: 128, outputBytes: 4 * 1024 * 1024, timeoutMs: 120_000 });
export type DockerExecutionFacts = {
  schemaVersion: 1; backend: "docker"; environmentInstanceId: string; workspace: WorkspaceIdentity;
  workspaceAccess: "read-only" | "read-write"; filesystemContainment: true;
  commandNetwork: "disabled" | "unrestricted"; networkContainment: boolean;
  credentialIsolation: "no-host-process-environment"; lifetime: "session";
  limits: Readonly<typeof DOCKER_DEFAULT_LIMITS>; imageId: string; user: string;
  policyRevision: "docker-v1"; verificationGeneration: 1; verifiedAt: string; advisoryDegradations: readonly string[];
};
const issued = new WeakSet<object>();
export function isVerifiedDockerExecution(value: unknown): value is Readonly<DockerExecutionFacts> {
  return !!value && typeof value === "object" && issued.has(value);
}
export function dockerAuthorityFingerprint(facts: Readonly<DockerExecutionFacts>): string {
  if (!isVerifiedDockerExecution(facts)) throw new Error("Docker facts were not verified by this runtime.");
  return createHash("sha256").update(JSON.stringify([facts.backend, facts.workspace.identityHash, facts.workspaceAccess,
    facts.commandNetwork, facts.credentialIsolation, facts.limits, facts.imageId, facts.user, facts.policyRevision])).digest("hex");
}

/** One container, one unguessable creation receipt. Names and labels are checked
 * before resolving a full ID; foreign resources are never adopted or pruned. */
export class DockerContainer {
  readonly name: string;
  readonly owner: string;
  readonly user = `${process.getuid?.() || 65532}:${process.getgid?.() || 65532}`;
  readonly client: DockerClient;
  readonly profileId: string;
  readonly workspace: WorkspaceIdentity;
  readonly policy: RequestedExecutionPolicy;
  readonly degradations: string[] = [];
  #id?: string;
  #released = false;
  #facts?: Readonly<DockerExecutionFacts>;
  private constructor(input: { client: DockerClient; profileId: string; workspace: WorkspaceIdentity; policy: RequestedExecutionPolicy; receipt?: DockerReceipt }) {
    this.name = input.receipt?.name ?? `estacoda-exec-${randomUUID()}`; this.owner = input.receipt?.owner ?? randomUUID();
    if (!/^estacoda-exec-[a-f0-9-]{36}$/u.test(this.name) || !/^[a-f0-9-]{36}$/u.test(this.owner)) throw new Error("Invalid Docker ownership receipt.");
    this.client = input.client; this.profileId = input.profileId; this.workspace = input.workspace; this.policy = input.policy;
  }
  get id(): string { if (!this.#id || this.#released) throw new Error("Docker lease is unavailable."); return this.#id; }
  get facts(): Readonly<DockerExecutionFacts> { if (!this.#facts) throw new Error("Docker controls have not been verified."); return this.#facts; }
  static async prepare(input: { profileId: string; workspaceRoot: string; homeDir?: string; policy: RequestedExecutionPolicy; client?: DockerClient; receipt?: DockerReceipt }): Promise<DockerContainer> {
    const policy = parseExecutionPolicy(input.policy);
    if (policy.backend !== "docker" || !input.profileId) throw new Error("Docker acquisition requires a selected profile and policy.");
    const workspace = await resolveWorkspaceDirectory(input.workspaceRoot);
    await assertSafeDockerWorkspace(workspace.canonicalPath, input.homeDir);
    const client = input.client ?? await DockerClient.connect();
    const container = new DockerContainer({ client, profileId: input.profileId, workspace, policy, receipt: input.receipt });
    for (const key of ["lifetime", "credentialCapabilities", "limits"] as const) {
      const control = policy[key];
      if (!control || (key === "lifetime" && control.value === "session") || (key === "credentialCapabilities" && Array.isArray(control.value) && control.value.length === 0)) continue;
      if (control.requirement === "mandatory") throw new Error(`Docker cannot yet verify requested ${key}.`);
      container.degradations.push(`${key}: requested control unavailable; verified Docker defaults apply`);
    }
    const image = JSON.parse(await client.run(["image", "inspect", policy.imageId!]))[0];
    if (image?.Id !== policy.imageId || image?.Config?.Labels?.[DOCKER_IMAGE_LABEL] !== "1" || Object.keys(image?.Config?.Volumes ?? {}).length) throw new Error("Docker image is not the approved execution image.");
    try {
      const id = (await client.run(container.createArgs())).trim();
      if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Docker creation returned an invalid receipt.");
      container.#id = id;
      await client.run(["start", id]);
      await container.verify();
      const effective = JSON.parse(await client.run(["exec", "--user", container.user, id, "python3", "-c", 'import os,json; print(json.dumps({"uid":os.getuid(),"status":open("/proc/self/status").read()}))']));
      if (effective.uid === 0 || !/^NoNewPrivs:\s+1$/mu.test(effective.status) || !/^Seccomp:\s+2$/mu.test(effective.status) || !/^CapEff:\s+0+$/mu.test(effective.status)) throw new Error("Docker effective user or security floor was not enforced.");
      const facts: Readonly<DockerExecutionFacts> = Object.freeze({ schemaVersion: 1, backend: "docker", environmentInstanceId: id,
        workspace: Object.freeze(workspace), workspaceAccess: policy.workspaceAccess?.value ?? "read-write", filesystemContainment: true,
        commandNetwork: policy.commandNetwork?.value ?? "disabled", networkContainment: policy.commandNetwork?.value !== "unrestricted",
        credentialIsolation: "no-host-process-environment", lifetime: "session", limits: DOCKER_DEFAULT_LIMITS,
        imageId: policy.imageId!, user: container.user, policyRevision: "docker-v1", verificationGeneration: 1,
        verifiedAt: new Date().toISOString(), advisoryDegradations: Object.freeze(container.degradations) });
      issued.add(facts); container.#facts = facts;
      return container;
    } catch (error) {
      try { await container.release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Docker preparation failed and owned cleanup is uncertain."); }
      throw error;
    }
  }
  createArgs(): string[] {
    const root = this.workspace.canonicalPath;
    return ["create", "--pull=never", "--name", this.name, "--label", `${DOCKER_OWNER_LABEL}=${this.owner}`,
      "--label", `io.estacoda.execution.profile=${createHash("sha256").update(this.profileId).digest("hex")}`,
      "--user", this.user, "--workdir", root, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--network", this.policy.commandNetwork?.value === "unrestricted" ? "bridge" : "none", "--ipc=private", "--cgroupns=private",
      "--mount", `type=bind,source=${root},target=${root},bind-recursive=disabled${this.policy.workspaceAccess?.value === "read-only" ? ",readonly" : ""}`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=67108864,mode=1777", "--shm-size=16777216", "--memory", String(DOCKER_DEFAULT_LIMITS.memoryBytes),
      "--memory-swap", String(DOCKER_DEFAULT_LIMITS.memoryBytes), "--cpus", String(DOCKER_DEFAULT_LIMITS.cpu), "--pids-limit", String(DOCKER_DEFAULT_LIMITS.pids),
      "--restart=no", "--env", "HOME=/tmp", this.policy.imageId!];
  }
  async verify(): Promise<void> {
    const record = JSON.parse(await this.client.run(["inspect", this.id]))[0];
    verifyDockerInspection(record, { id: this.id, owner: this.owner, workspaceRoot: this.workspace.canonicalPath, imageId: this.policy.imageId!, user: this.user,
      writable: this.policy.workspaceAccess?.value !== "read-only", network: this.policy.commandNetwork?.value === "unrestricted" ? "bridge" : "none" });
    const current = await resolveWorkspaceDirectory(this.workspace.canonicalPath);
    if (current.identityHash !== this.workspace.identityHash) throw new Error("Docker workspace identity changed.");
  }
  async release(): Promise<void> {
    if (this.#released) return;
    await cleanupDockerReceipt(this.client, { name: this.name, owner: this.owner, id: this.#id });
    this.#released = true;
  }
}

export function verifyDockerInspection(record: any, expected: { id: string; owner: string; workspaceRoot: string; imageId: string; user: string; writable: boolean; network: string }): void {
  const host = record?.HostConfig, config = record?.Config, mounts = record?.Mounts;
  if (record?.Id !== expected.id || !record.State?.Running || record.Image !== expected.imageId || config?.User !== expected.user || config.Labels?.[DOCKER_OWNER_LABEL] !== expected.owner ||
    !host?.ReadonlyRootfs || host.Privileged || (host.CapAdd ?? []).length || !(host.CapDrop ?? []).includes("ALL") ||
    !(host.SecurityOpt ?? []).some((s: string) => /^no-new-privileges(?::true)?$/u.test(s)) || (host.SecurityOpt ?? []).some((s: string) => /unconfined/u.test(s)) ||
    !["", "private"].includes(host.PidMode) || host.IpcMode !== "private" || host.CgroupnsMode !== "private" || host.UsernsMode === "host" ||
    (host.Devices ?? []).length || (host.DeviceRequests ?? []).length || (host.VolumesFrom ?? []).length ||
    host.NetworkMode !== expected.network || Object.keys(record.NetworkSettings?.Networks ?? {}).some((n) => n !== expected.network) ||
    !Array.isArray(mounts) || mounts.length !== 1 || mounts[0].Type !== "bind" || mounts[0].Source !== expected.workspaceRoot || mounts[0].Destination !== expected.workspaceRoot || mounts[0].RW !== expected.writable || mounts[0].Propagation !== "rprivate" ||
    host.Mounts?.length !== 1 || host.Mounts[0].BindOptions?.NonRecursive !== true ||
    host.Memory !== DOCKER_DEFAULT_LIMITS.memoryBytes || host.MemorySwap !== DOCKER_DEFAULT_LIMITS.memoryBytes || host.NanoCpus !== DOCKER_DEFAULT_LIMITS.cpu * 1e9 || host.PidsLimit !== DOCKER_DEFAULT_LIMITS.pids) throw new Error("Docker effective controls differ from approved policy.");
}

export async function assertSafeDockerWorkspace(root: string, homeDir?: string): Promise<void> {
  if (/[\r\n\0,]/u.test(root)) throw new Error("Docker bind paths cannot contain commas or control characters.");
  const state = resolveGlobalStateHome({ homeDir }).stateRoot;
  const protectedRoots = [homedir(), state, ...[".ssh", ".docker", ".aws", ".gnupg", ".config"].map((name) => resolve(homedir(), name)), "/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", "/var/lib/containerd"];
  for (const candidate of protectedRoots) {
    const sensitive = await realpath(candidate).catch(() => resolve(candidate));
    const rel = relative(root, sensitive);
    if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) throw new Error("Docker workspace includes a protected host or state directory. Choose a project directory.");
    if (candidate !== homedir()) {
      const inverse = relative(resolve(sensitive), root);
      if (inverse === "" || (inverse !== ".." && !inverse.startsWith("../") && !isAbsolute(inverse))) throw new Error("Docker workspace is inside protected host state.");
    }
  }
  let count = 0;
  const scan = async (directory: string): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      if (++count > 200_000) throw new Error("Docker workspace safety scan exceeded its bound. Select a smaller project.");
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSocket() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO()) throw new Error("Docker workspace contains a socket, device or FIFO; it cannot be mounted.");
      if (info.isDirectory()) await scan(path);
    }
  };
  await scan(root);
}

export async function cleanupDockerReceipt(client: DockerClient, receipt: DockerReceipt): Promise<void> {
  if (!/^estacoda-exec-[a-f0-9-]{36}$/u.test(receipt.name) || !/^[a-f0-9-]{36}$/u.test(receipt.owner)) throw new Error("Invalid Docker cleanup receipt.");
  const ids = (await client.run(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${receipt.name}$`])).trim().split(/\s+/u).filter(Boolean);
  if (!ids.length) return;
  if (ids.length !== 1 || (receipt.id && ids[0] !== receipt.id)) throw new Error("Docker cleanup ownership mismatch.");
  const record = JSON.parse(await client.run(["inspect", ids[0]!]))[0];
  if (record.Id !== ids[0] || record.Config?.Labels?.[DOCKER_OWNER_LABEL] !== receipt.owner) throw new Error("Docker cleanup ownership could not be verified.");
  try { await client.run(["rm", "--force", ids[0]!]); }
  catch { /* A cooperating owner can finish the same cleanup; require confirmed absence below. */ }
  if ((await client.run(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${ids[0]}`])).trim()) throw new Error("Docker cleanup did not settle.");
}

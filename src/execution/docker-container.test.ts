import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKER_DEFAULT_LIMITS, DOCKER_OWNER_LABEL, assertSafeDockerWorkspace, verifyDockerInspection } from "./docker-container.js";
const expected = { id: "a".repeat(64), owner: "owned", workspaceRoot: "/project", imageId: `sha256:${"b".repeat(64)}`, user: "1000:1000", writable: true, network: "none" };
function inspected() { return { Id: expected.id, Image: expected.imageId, State: { Running: true }, Config: { User: expected.user, Labels: { [DOCKER_OWNER_LABEL]: expected.owner } },
  HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PidMode: "", IpcMode: "private", CgroupnsMode: "private", NetworkMode: "none",
    Mounts: [{ BindOptions: { NonRecursive: true } }], Memory: DOCKER_DEFAULT_LIMITS.memoryBytes, MemorySwap: DOCKER_DEFAULT_LIMITS.memoryBytes, NanoCpus: 1e9, PidsLimit: 128 },
  NetworkSettings: { Networks: { none: {} } }, Mounts: [{ Type: "bind", Source: "/project", Destination: "/project", RW: true, Propagation: "rprivate" }] }; }
it("rejects effective privilege, namespace, networking, mount, image and ownership drift", () => {
  expect(() => verifyDockerInspection(inspected(), expected)).not.toThrow();
  for (const patch of [{ Privileged: true }, { PidMode: "host" }, { IpcMode: "host" }, { UsernsMode: "host" }, { ReadonlyRootfs: false }, { CapAdd: ["SYS_ADMIN"] }, { NetworkMode: "bridge" },
    { Devices: [{}] }, { DeviceRequests: [{}] }, { Memory: 0 }, { Mounts: [{ BindOptions: {} }] }, { SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"] }]) {
    const record = inspected(); Object.assign(record.HostConfig, patch);
    expect(() => verifyDockerInspection(record, expected)).toThrow("effective controls");
  }
  const mount = inspected(); mount.Mounts[0]!.Source = "/var/run/docker.sock";
  expect(() => verifyDockerInspection(mount, expected)).toThrow();
  expect(() => verifyDockerInspection(inspected(), { ...expected, owner: "foreign" })).toThrow();
  expect(() => verifyDockerInspection(inspected(), { ...expected, writable: false })).toThrow();
});
it("rejects host roots and profile state while permitting a project directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "docker-root-policy-"));
  try {
    await mkdir(join(home, "project"));
    await expect(assertSafeDockerWorkspace(join(home, "project"), home)).resolves.toBeUndefined();
    await expect(assertSafeDockerWorkspace(home, home)).rejects.toThrow("protected");
    await expect(assertSafeDockerWorkspace("/", home)).rejects.toThrow("protected");
    await expect(assertSafeDockerWorkspace(join(home, ".estacoda", "profiles"), home)).rejects.toThrow("protected");
  } finally { await rm(home, { recursive: true, force: true }); }
});

import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(), getSession: vi.fn(), close: vi.fn(), trust: vi.fn(), validate: vi.fn(),
  probe: vi.fn(), start: vi.fn(), spawn: vi.fn(), resolve: vi.fn()
}));
vi.mock("./gateway-lock.js", () => ({ inspectGatewayLockState: mocks.inspect }));
vi.mock("../session/sqlite-session-db.js", () => ({ SQLiteSessionDB: class {
  getSessionForProfile = mocks.getSession; close = mocks.close;
} }));
vi.mock("../security/workspace-trust-store.js", () => ({ WorkspaceTrustStore: class { isTrusted = mocks.trust; } }));
vi.mock("../session/session-workspace-ownership.js", () => ({ validateSessionWorkspaceOwnership: mocks.validate }));
vi.mock("./service-manager.js", () => ({ probeServiceState: mocks.probe, startService: mocks.start }));
vi.mock("./service-exec-resolver.js", () => ({ resolveGatewayExec: mocks.resolve }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { startSharedHostOnDemand } from "./shared-host-startup.js";
const input = { homeDir: "/tmp/estacoda-test", profileId: "default", sessionId: "session", targetId: "target" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue({ state: "absent" });
  mocks.getSession.mockResolvedValue({ executionTarget: { targetId: "target", workspace: { canonicalPath: "/tmp/workspace" } } });
  mocks.trust.mockResolvedValue(true);
  mocks.probe.mockResolvedValue({ installed: false });
});
it("does not launch a duplicate or reinterpret ambiguous singleton state", async () => {
  mocks.inspect.mockResolvedValue({ state: "active" });
  await startSharedHostOnDemand(input);
  expect(mocks.getSession).not.toHaveBeenCalled();
  mocks.inspect.mockResolvedValue({ state: "malformed" });
  await expect(startSharedHostOnDemand(input)).rejects.toThrow("ambiguous");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("requires the established target and current trust before starting a service", async () => {
  mocks.getSession.mockResolvedValue(undefined);
  await expect(startSharedHostOnDemand(input)).rejects.toThrow("established");
  mocks.getSession.mockResolvedValue({ executionTarget: { targetId: "target", workspace: { canonicalPath: "/tmp/workspace" } } });
  mocks.trust.mockResolvedValue(false);
  await expect(startSharedHostOnDemand(input)).rejects.toThrow("trust");
  expect(mocks.close).toHaveBeenCalledTimes(2);
  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("reuses the installed service and refuses ambiguous service scopes", async () => {
  mocks.probe.mockResolvedValueOnce({ installed: true, scope: "user" }).mockResolvedValueOnce({ installed: false });
  mocks.start.mockResolvedValue({ ok: true });
  await startSharedHostOnDemand(input);
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ profileId: "default", system: false }));
  expect(mocks.resolve).not.toHaveBeenCalled();
  mocks.probe.mockResolvedValueOnce({ installed: true, scope: "user" }).mockResolvedValueOnce({ installed: true, kind: "systemd-system", scope: "system" });
  await expect(startSharedHostOnDemand(input)).rejects.toThrow("Multiple service scopes");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("resolves a detached supervisor from the installation, never the workspace", async () => {
  const { EventEmitter } = await import("node:events");
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.resolve.mockReturnValue({ ok: true, resolved: { command: "/usr/bin/node", args: ["/installation/dist/index.js"] } });
  mocks.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  await startSharedHostOnDemand(input);
  expect(mocks.resolve.mock.calls[0]![0].workspaceRoot).not.toBe("/tmp/workspace");
  expect(mocks.spawn).toHaveBeenCalledWith("/usr/bin/node", ["/installation/dist/index.js", "gateway", "run", "--profile", "default"], expect.objectContaining({ cwd: "/tmp/workspace", detached: true, stdio: "ignore" }));
  expect(child.unref).toHaveBeenCalledOnce();
});

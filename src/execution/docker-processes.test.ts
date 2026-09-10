import { expect, it, vi } from "vitest";
import type { DockerContainer } from "./docker-container.js";
import { DockerProcessScope } from "./docker-processes.js";
it("does not inherit host credentials or accept arbitrary environment injection", async () => {
  const client = { run: vi.fn() };
  const scope = new DockerProcessScope({ workspace: { canonicalPath: "/" }, client } as unknown as DockerContainer);
  expect(scope.environment()).toEqual({ PWD: "/", HOME: "/tmp", TMPDIR: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" });
  expect(() => scope.environment({ extra: { AWS_SECRET_ACCESS_KEY: "example" } })).toThrow("not configured");
  expect(() => scope.spawn("echo", [], { env: { NODE_OPTIONS: "--require=/outside" } })).toThrow("unapproved");
  await scope.terminate({} as never);
  expect(client.run).not.toHaveBeenCalled();
  await scope.release();
  expect(() => scope.spawn("echo", [])).toThrow("released");
});

it("retries uncertain receipt cleanup on release after a child has closed", async () => {
  const { HostProcessScope } = await import("./host-processes.js");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const spawn = vi.spyOn(HostProcessScope.prototype, "spawn").mockReturnValue(child as never);
  const clean = vi.fn().mockRejectedValueOnce(new Error("daemon unavailable")).mockResolvedValue(undefined);
  const scope = new DockerProcessScope({ workspace: { canonicalPath: "/", identityHash: "test" }, client: { endpoint: "unix:///docker.sock" },
    receipts: { write: vi.fn(), clean }, profileId: "test", policy: {} } as unknown as DockerContainer);
  try {
    scope.spawn("echo", []); child.emit("close", 0);
    await vi.waitFor(() => expect(clean).toHaveBeenCalledOnce());
    await scope.release(); await scope.release();
    expect(clean).toHaveBeenCalledTimes(2);
  } finally { spawn.mockRestore(); }
});

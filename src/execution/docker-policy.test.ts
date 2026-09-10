import { expect, it, vi } from "vitest";
import { parseExecutionPolicy } from "./docker-policy.js";
import { DockerClient, probeDocker } from "./docker-client.js";
import { verifyHostExecution } from "./host-authority.js";

it("keeps host default and rejects unsupported Docker authority and mutable images", async () => {
  expect(parseExecutionPolicy(undefined)).toEqual({ backend: "host" });
  for (const value of [{ backend: "other" }, { backend: "docker", imageId: "latest" },
    { backend: "docker", imageId: `sha256:${"a".repeat(64)}`, privileged: true },
    { backend: "host", limits: { requirement: "mandatory", value: { memoryBytes: -1 } } }]) expect(() => parseExecutionPolicy(value)).toThrow();
  const policy = parseExecutionPolicy({ backend: "docker", imageId: `sha256:${"a".repeat(64)}`, commandNetwork: { value: "disabled", requirement: "mandatory" } });
  await expect(verifyHostExecution(process.cwd(), policy)).rejects.toThrow("host fallback");
  expect(() => new DockerClient("tcp://localhost:2375")).toThrow("local Unix socket");
});
it("probes without image acquisition and blocks a missing security floor", async () => {
  const client = new DockerClient("unix:///tmp/docker.sock");
  const run = vi.spyOn(client, "run").mockResolvedValueOnce(JSON.stringify({ OSType: "linux", SecurityOptions: ["name=seccomp,profile=builtin"] })).mockRejectedValueOnce(new Error("missing image"));
  expect(await probeDocker(client)).toEqual({ available: true, imageId: undefined });
  expect(run.mock.calls.map((call) => call[0][0])).toEqual(["info", "image"]);
  run.mockResolvedValue(JSON.stringify({ OSType: "linux", SecurityOptions: [] }));
  expect((await probeDocker(client)).available).toBe(false);
});

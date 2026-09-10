import { expect, it } from "vitest";
import { DOCKER_DEFAULT_LIMITS, dockerLimits, verifyDockerCgroups } from "./docker-limits.js";
it("negotiates supported limits and exposes advisory degradation without weakening mandatory controls", () => {
  const limits = dockerLimits({ backend: "docker", limits: { requirement: "mandatory", value: { cpu: 0.5, pids: 32, outputBytes: 4096, timeoutMs: 2000 } } }).limits;
  expect(limits).toEqual({ ...DOCKER_DEFAULT_LIMITS, cpu: 0.5, pids: 32, outputBytes: 4096, timeoutMs: 2000 });
  expect(() => dockerLimits({ backend: "docker", limits: { requirement: "mandatory", value: { memoryBytes: 1 } } })).toThrow("memoryBytes");
  const advisory = dockerLimits({ backend: "docker", limits: { requirement: "advisory", value: { memoryBytes: 1, pids: 64 } } });
  expect(advisory.degradations).toHaveLength(1); expect(advisory.limits.pids).toBe(64); expect(advisory.limits.memoryBytes).toBe(DOCKER_DEFAULT_LIMITS.memoryBytes);
});
it("requires effective cgroup values, including disabled swap", () => {
  const values = { "memory.max": String(DOCKER_DEFAULT_LIMITS.memoryBytes), "memory.swap.max": "0", "pids.max": "128", "cpu.max": "100000 100000" };
  expect(() => verifyDockerCgroups(values, DOCKER_DEFAULT_LIMITS)).not.toThrow();
  for (const patch of [{ "memory.max": "max" }, { "memory.swap.max": "max" }, { "pids.max": "max" }, { "cpu.max": "max 100000" }]) expect(() => verifyDockerCgroups({ ...values, ...patch }, DOCKER_DEFAULT_LIMITS)).toThrow("cgroup");
});

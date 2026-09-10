import type { RequestedExecutionPolicy } from "../contracts/execution-authority.js";
export type DockerLimits = Readonly<{ cpu: number; memoryBytes: number; pids: number; outputBytes: number; timeoutMs: number }>;
export const DOCKER_DEFAULT_LIMITS: DockerLimits = Object.freeze({ cpu: 1, memoryBytes: 512 * 1024 * 1024, pids: 128, outputBytes: 4 * 1024 * 1024, timeoutMs: 120_000 });
export function dockerLimits(policy: RequestedExecutionPolicy): { limits: DockerLimits; degradations: string[] } {
  const limits = { ...DOCKER_DEFAULT_LIMITS }, degradations: string[] = [];
  for (const [key, value] of Object.entries(policy.limits?.value ?? {}) as [keyof DockerLimits, number][]) {
    const supported = key === "cpu" ? value >= 0.001 && value <= 64 && Number.isInteger(value * 1000) :
      key === "memoryBytes" ? value >= 6 * 1024 * 1024 && value <= 64 * 1024 ** 3 :
      key === "pids" ? value <= 65536 : key === "outputBytes" ? value <= 16 * 1024 * 1024 : value <= 86_400_000;
    if (!supported) {
      if (policy.limits?.requirement === "mandatory") throw new Error(`Docker cannot enforce requested ${key} within supported bounds.`);
      degradations.push(`${key}: requested bound unsupported; verified default applies`);
    } else limits[key] = value;
  }
  return { limits: Object.freeze(limits), degradations };
}
export const CGROUP_PROBE = 'import json; from pathlib import Path; p=Path("/sys/fs/cgroup"); print(json.dumps({k:(p/k).read_text().strip() for k in ["memory.max","memory.swap.max","pids.max","cpu.max"]}))';
export function verifyDockerCgroups(values: Record<string, string>, limits: DockerLimits): void {
  const [quota, period] = (values["cpu.max"] ?? "").split(" ").map(Number);
  if (Number(values["memory.max"]) !== limits.memoryBytes || values["memory.swap.max"] !== "0" || Number(values["pids.max"]) !== limits.pids ||
      !quota || !period || Math.abs(quota / period - limits.cpu) > 1e-9) throw new Error("Docker effective cgroup v2 limits were not enforced.");
}

/** Shared read-only negotiation for doctor and acquisition; no engine or grants. */
export function dockerControls(policy: RequestedExecutionPolicy): { limits: DockerLimits; degradations: string[] } {
  const negotiated = dockerLimits(policy);
  for (const key of ["lifetime", "credentialCapabilities"] as const) {
    const control = policy[key];
    if (!control || (key === "lifetime" && control.value === "session") || (key === "credentialCapabilities" && Array.isArray(control.value) && control.value.length === 0)) continue;
    if (control.requirement === "mandatory") throw new Error(`Docker cannot yet verify requested ${key}.`);
    negotiated.degradations.push(`${key}: requested control unavailable; verified Docker defaults apply`);
  }
  return negotiated;
}

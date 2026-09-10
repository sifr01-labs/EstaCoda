import { readFile } from "node:fs/promises";
import { resolveProfileStateHome } from "../config/profile-home.js";
import type { RequestedExecutionPolicy } from "../contracts/execution-authority.js";

export const DOCKER_IMAGE_TAG = "estacoda-execution:v1";
export const DOCKER_IMAGE_LABEL = "io.estacoda.execution.version";
export function parseExecutionPolicy(value: unknown): RequestedExecutionPolicy {
  if (value === undefined) return { backend: "host" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid execution policy.");
  const p = value as Record<string, unknown>;
  if (!["host", "docker"].includes(String(p.backend))) throw new Error("Unsupported execution backend; no host fallback is authorized.");
  for (const key of Object.keys(p)) if (!["backend", "imageId", "workspaceAccess", "commandNetwork", "credentialCapabilities", "lifetime", "limits"].includes(key)) throw new Error("Unsupported execution control.");
  if (p.backend === "docker" && (typeof p.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(p.imageId))) throw new Error("Docker execution requires a prepared, immutable image ID. Use Setup Editor.");
  if (p.backend === "host" && p.imageId !== undefined) throw new Error("Host policy cannot select a Docker image.");
  for (const key of ["workspaceAccess", "commandNetwork", "credentialCapabilities", "lifetime", "limits"] as const) {
    if (p[key] === undefined) continue;
    const c = p[key] as { value?: unknown; requirement?: unknown };
    if (!c || typeof c !== "object" || Object.keys(c).some((k) => !["value", "requirement"].includes(k)) || !["mandatory", "advisory"].includes(String(c.requirement))) throw new Error("Invalid execution control requirement.");
    const choices = { workspaceAccess: ["read-only", "read-write"], commandNetwork: ["unrestricted", "disabled"], lifetime: ["host", "session"] };
    if (key in choices && !choices[key as keyof typeof choices].includes(c.value as string)) throw new Error(`Invalid ${key}.`);
    if (key === "credentialCapabilities" && (!Array.isArray(c.value) || c.value.some((v) => typeof v !== "string"))) throw new Error("Invalid credential capabilities.");
    if (key === "limits") {
      if (!c.value || typeof c.value !== "object" || Array.isArray(c.value)) throw new Error("Invalid resource limits.");
      for (const [limit, amount] of Object.entries(c.value)) {
        if (!["cpu", "memoryBytes", "pids", "outputBytes", "timeoutMs"].includes(limit) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || (limit !== "cpu" && !Number.isSafeInteger(amount))) throw new Error("Invalid resource limit.");
      }
    }
  }
  return structuredClone(p) as RequestedExecutionPolicy;
}

export async function selectedExecutionPolicy(context: { profileId: string; homeDir?: string }, requested?: RequestedExecutionPolicy) {
  if (requested !== undefined) return parseExecutionPolicy(requested);
  let raw: string;
  try { raw = await readFile(resolveProfileStateHome(context).configPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { backend: "host" } as const; throw error; }
  return parseExecutionPolicy(JSON.parse(raw).execution);
}

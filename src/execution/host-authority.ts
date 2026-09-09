import { createHash, randomUUID } from "node:crypto";
import type { HostExecutionFacts, RequestedExecutionPolicy } from "../contracts/execution-authority.js";
import { resolveWorkspaceDirectory } from "../workspaces/workspace-registry.js";

const hostInstance = `host_${randomUUID()}`;
const issued = new WeakSet<object>();

/** Trusted construction boundary, never a tool-input deserializer. Host facts do
 * not assert sandboxing, secret filtering, or process cleanup that does not exist. */
export async function verifyHostExecution(workspaceRoot: string, policy: RequestedExecutionPolicy = { backend: "host" }): Promise<Readonly<HostExecutionFacts>> {
  if (policy.backend !== "host") throw new Error("Unsupported execution backend; host fallback is not authorized.");
  const advisoryDegradations: string[] = [];
  const supported = { workspaceAccess: "read-write", commandNetwork: "unrestricted", lifetime: "host" };
  for (const key of ["workspaceAccess", "commandNetwork", "credentialCapabilities", "lifetime", "limits"] as const) {
    const control = policy[key];
    if (control === undefined) continue;
    if (control.requirement !== "mandatory" && control.requirement !== "advisory") throw new Error("Invalid execution control requirement.");
    const enforced = key in supported && control.value === supported[key as keyof typeof supported];
    if (enforced) continue;
    if (control.requirement === "mandatory") throw new Error(`Host execution cannot verify mandatory ${key}. Select supported controls explicitly.`);
    advisoryDegradations.push(`${key}: unsupported or unverified on host`);
  }
  const workspace = Object.freeze(await resolveWorkspaceDirectory(workspaceRoot));
  const facts: Readonly<HostExecutionFacts> = Object.freeze({ schemaVersion: 1, backend: "host", environmentInstanceId: hostInstance,
    workspace, workspaceAccess: "read-write", filesystemContainment: false, commandNetwork: "unrestricted", networkContainment: false,
    credentialIsolation: "unverified-inherited-environment", lifetime: "host", limits: "unverified", policyRevision: "host-v1",
    verificationGeneration: 1, verifiedAt: new Date().toISOString(), advisoryDegradations: Object.freeze(advisoryDegradations) });
  issued.add(facts);
  return facts;
}

export function isVerifiedHostExecution(value: unknown): value is Readonly<HostExecutionFacts> {
  return typeof value === "object" && value !== null && issued.has(value);
}

/** Stable reusable authority excludes health timestamps, aliases and process IDs.
 * Exact pending actions additionally compare environmentInstanceId. */
export function hostAuthorityFingerprint(facts: Readonly<HostExecutionFacts>): string {
  if (!isVerifiedHostExecution(facts)) throw new Error("Execution facts were not verified by this runtime.");
  return createHash("sha256").update(JSON.stringify([facts.schemaVersion, facts.backend, facts.workspace.identityHash,
    facts.workspaceAccess, facts.filesystemContainment, facts.commandNetwork, facts.networkContainment,
    facts.credentialIsolation, facts.lifetime, facts.limits, facts.policyRevision])).digest("hex");
}

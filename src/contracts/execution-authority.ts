import type { WorkspaceIdentity } from "./workspace.js";

export type RequestedControl<T> = { value: T; requirement: "mandatory" | "advisory" };
/** Requested policy is validated separately from effective backend facts. */
export type RequestedExecutionPolicy = {
  backend: "host" | "docker";
  imageId?: string;
  workspaceAccess?: RequestedControl<"read-only" | "read-write">;
  commandNetwork?: RequestedControl<"unrestricted" | "disabled">;
  credentialCapabilities?: RequestedControl<readonly string[]>;
  lifetime?: RequestedControl<"host" | "session">;
  limits?: RequestedControl<{ cpu?: number; memoryBytes?: number; pids?: number; outputBytes?: number; timeoutMs?: number }>;
};

export type HostExecutionFacts = {
  schemaVersion: 1;
  backend: "host";
  environmentInstanceId: string;
  workspace: WorkspaceIdentity;
  workspaceAccess: "read-write";
  filesystemContainment: false;
  commandNetwork: "unrestricted";
  networkContainment: false;
  credentialIsolation: "unverified-inherited-environment";
  lifetime: "host";
  limits: "unverified";
  policyRevision: "host-v1";
  verificationGeneration: 1;
  verifiedAt: string;
  advisoryDegradations: readonly string[];
};

/** Path identity, not directory contents, an inode, or an authorization grant. */
export type WorkspaceIdentity = {
  canonicalPath: string;
  identityHash: string;
};

export type RegisteredWorkspace = {
  schemaVersion: 1;
  id: string;
  profileId: string;
  alias: string;
  identity: WorkspaceIdentity;
  locationRevision: number;
};

export type SourceWorkspaceBinding = {
  identity: WorkspaceIdentity;
  registeredWorkspaceId?: string;
  registeredWorkspaceRevision?: number;
};

export type ExecutionTargetBinding = {
  schemaVersion: 1;
  targetId: string;
  targetGeneration: number;
  workspace: WorkspaceIdentity;
};

export type LocalExecutionTarget = {
  schemaVersion: 1;
  profileId: string;
  id: string;
  kind: "local";
  generation: number;
  source: SourceWorkspaceBinding;
  workspace: WorkspaceIdentity;
  status: "available" | "archived";
};

export type TemporaryCopyTarget = Omit<LocalExecutionTarget, "kind"> & {
  kind: "temporary-copy";
  manifestHash: string;
  directoryStamp: { dev: number; ino: number };
};
export type ExecutionTarget = LocalExecutionTarget | TemporaryCopyTarget;

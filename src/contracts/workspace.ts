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
export type ManagedGitWorktreeTarget = Omit<LocalExecutionTarget, "kind"> & {
  kind: "git-worktree";
  repository: { commonDirectory: string; commonDirectoryStamp: { dev: number; ino: number } };
  directoryStamp: { dev: number; ino: number };
  sourceDirectoryStamp: { dev: number; ino: number };
  gitDirectory: string;
  gitDirectoryStamp: { dev: number; ino: number };
  creation: { owner: "estacoda"; operationId: string; branch: string; baseCommit: string };
  cleanup: "retained" | "removed";
};
export type ExecutionTarget = LocalExecutionTarget | TemporaryCopyTarget | ManagedGitWorktreeTarget;

/** Core lifecycle receipt; display clients cannot use it as execution authority. */
export type TargetOperationReceipt = {
  operationId:string; action:'create'|'archive'|'cleanup'|'unknown';
  state:'completed'|'uncertain'|'unknown'; target:Pick<ExecutionTargetBinding,'targetId'|'targetGeneration'>|null;
};

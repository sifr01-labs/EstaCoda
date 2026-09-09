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

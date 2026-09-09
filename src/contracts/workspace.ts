/** Path identity, not directory contents, an inode, or an authorization grant. */
export type WorkspaceIdentity = {
  canonicalPath: string;
  identityHash: string;
};

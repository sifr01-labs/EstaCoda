import type { TargetReference } from './projections.js';
/** Display-only core target snapshot. Paths are descriptive, never capabilities. */
export type TargetDetails = TargetReference & {
  kind: 'local' | 'temporary-copy' | 'git-worktree';
  label: string;
  workingRoot: string;
  sourceRoot: string;
  status: 'available' | 'archived';
  readiness: 'ready' | 'untrusted' | 'unavailable' | 'archived';
  managed: boolean;
};

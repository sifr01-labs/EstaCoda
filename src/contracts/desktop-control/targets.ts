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
export type TargetCreationReview = {
  reviewId:string; operationId:string; source:TargetReference; sourceRoot:string; destination:string;
  branch:string; baseCommit:string; expiresAt:number;
};
export type TargetOperation = {
  operationId:string; action:'create'|'archive'|'cleanup'|'unknown';
  state:'completed'|'uncertain'|'unknown'; target:TargetReference|null;
};
export type TargetInspection = TargetDetails & {
  dirty:boolean|null; borrowers:number; branch:string|null; cleanup:'retained'|'removed'|null;
};

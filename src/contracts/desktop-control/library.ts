export type LibrarySkill={id:string;name:string;description:string;source:'local'|'bundled'|'external';version:string|null;requiredToolsets:string[];optionalToolsets:string[]};
export type LibrarySkillDetail={skill:LibrarySkill;instructions:string;truncated:boolean};
export type LibraryMemory={kind:'USER.md'|'SOUL.md'|'MEMORY.md';scope:'profile';content:string;truncated:boolean};
export type LibraryProposal={id:string;skillName:string;status:'proposed'|'promoted'|'rejected';approval:string;reason:string;risk:string;changeKind:string};
export type LibraryProposalDetail={proposal:LibraryProposal;diff:string;gate:{status:'passed'|'failed'|'not-run';score:number|null;threshold:number|null;failures:string[]};evidence:{id:string;summary:string;sourceWorkId:string|null}[];evalRuns:{id:string;label:string;passed:boolean}[];manifest:{id:string;status:string;target:string;commands:string[]}|null;promotions:{id:string;appliedAt:string;snapshotAvailable:boolean}[];truncated:boolean};
export type EvolutionAction='test'|'approve'|'reject'|'promote';
export type EvolutionReview={reviewId:string;proposalId:string;action:EvolutionAction;diff:string;commands:string[];workspace:string|null;allowed:boolean;reason:'ready'|'stale'|'gates_failed'|'workspace_required'|'unsupported'|'review_too_large'|'approval_required'};

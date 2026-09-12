export const EVIDENCE_LIMITATION_CODES=["unclassified_effect", "unrecovered_execution", "turn_unbound", "outcome_unconfirmed", "mutation_unverified", "inspection_truncated", "receipts_missing", "conversation_only", "attempt_incomplete", "task_inspection_required", "outputs_truncated"] as const;
export const EVIDENCE_SUMMARY_CODES=["verified", "failed", "partial", "unverified", "attempt_incomplete", "task_verified", "task_unverified"] as const;
/** Display facts derived from canonical receipts, never raw tool output or model prose. */
export type EvidenceReport = {
 workId:string; state:'verified'|'unverified'|'partial'|'failed';
 completion:'completed'|'partial'|'failed'|'cancelled'|'unconfirmed';
 summaryCode?:typeof EVIDENCE_SUMMARY_CODES[number]; limitationCodes?:Array<typeof EVIDENCE_LIMITATION_CODES[number]>;
 summary:string; truncated:boolean; artifacts:import('./artifacts.js').ArtifactReference[];
 facts:{callId:string;tool:string;kind:'read'|'mutation'|'validation'|'failure'|'unverified_mutation'|'unknown';verifiedBy:string|null}[];
 limitations:string[];
};

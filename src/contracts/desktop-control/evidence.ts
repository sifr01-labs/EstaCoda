/** Display facts derived from canonical receipts, never raw tool output or model prose. */
export type EvidenceReport = {
 workId:string; state:'verified'|'unverified'|'partial'|'failed';
 completion:'completed'|'partial'|'failed'|'cancelled'|'unconfirmed';
 summary:string; truncated:boolean;
 facts:{callId:string;tool:string;kind:'read'|'mutation'|'validation'|'failure'|'unverified_mutation';verifiedBy:string|null}[];
 limitations:string[];
};

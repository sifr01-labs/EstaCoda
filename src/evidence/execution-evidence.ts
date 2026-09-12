import type {ExecutionEvidenceRecord} from '../contracts/execution-plan.js';
import type {EvidenceReport} from '../contracts/desktop-control/evidence.js';
import {normalizeExecutionEvidenceRecord} from '../session/execution-evidence-state.js';
/** Receipts must already be read from the canonical current-turn event stream. */
export function projectExecutionEvidence(input:{workId:string;turnId:string|null;outcome:{status:string;completionFloor:string}|null;events:unknown[];truncated:boolean}):EvidenceReport {
 const records=new Map<string,ExecutionEvidenceRecord>();
 for(const event of input.events.slice(0,1024)) {
  if(!event||typeof event!=='object'||(event as {kind?:unknown}).kind!=='execution-evidence-recorded')continue;
  const record=normalizeExecutionEvidenceRecord(event as ExecutionEvidenceRecord);
  if(record&&input.turnId&&record.visibleTurnId===input.turnId)records.set(record.toolCallId,record);
 }
 const successful=[...records.values()].filter(record=>record.status==='success');
 const mutations=successful.filter(record=>record.executionEffect?.kind==='mutation');
 const order=new Map([...records.keys()].map((id,index)=>[id,index]));
 const verification=new Map<string,string>();
 for(const record of successful)if(record.status==='success'&&record.verifiedMutation){
  const mutation=records.get(record.verifiedMutation.toolCallId);
  if(mutation?.status==='success'&&mutation.executionEffect?.kind==='mutation'&&mutation.tool===record.verifiedMutation.tool&&order.get(mutation.toolCallId)!<order.get(record.toolCallId)!)verification.set(mutation.toolCallId,record.toolCallId);
 }
 const status=input.outcome?.status;
 const completion:EvidenceReport['completion']=status==='completed'||status==='completed_with_recovered_errors'?'completed':status==='failed'?'failed':status==='cancelled'?'cancelled':status==='partially_completed'||status==='blocked'?'partial':'unconfirmed';
 const truncated=input.truncated||input.events.length>1024||records.size>64;
 const unverified=mutations.some(record=>!verification.has(record.toolCallId));
 const unknown=successful.some(record=>!record.executionEffect);
 const unresolved=[...records.values()].some(record=>record.status!=='success'&&!(record.status==='blocked'&&record.completedReplayOf&&records.get(record.completedReplayOf)?.status==='success'&&records.get(record.completedReplayOf)?.executionEffect?.kind==='mutation'&&records.get(record.completedReplayOf)?.tool===record.tool));
 const reads=successful.some(record=>record.executionEffect?.kind==='read');
 const floor=input.outcome?.completionFloor;
 const meetsFloor=floor==='read'?reads&&!unverified:(floor==='mutation'||floor==='mutation_with_verification')?mutations.length>0&&!unverified:false;
 const state:EvidenceReport['state']=completion==='failed'?'failed':completion==='completed'&&meetsFloor&&!truncated&&!unknown&&!unresolved?'verified':completion==='partial'||(mutations.length>0&&verification.size>0)?'partial':'unverified';
 const limitations:string[]=[];
 if(unknown)limitations.push('Some successful receipts lack a classified execution effect.');
 if(unresolved)limitations.push('Failed or unavailable executions are not established as recovered.');
 if(!input.turnId)limitations.push('No canonical turn binding is available.');
 if(completion==='unconfirmed')limitations.push('No confirmed final outcome is available for this turn.');
 if(unverified)limitations.push('Observed mutations lack compatible validation.');
 if(truncated)limitations.push('Evidence exceeds the inspection bound; completion cannot be fully verified.');
 if(!records.size)limitations.push('No current-turn execution receipts are available.');
 if(floor==='none')limitations.push('A conversational completion claim does not establish verified execution.');
 return {workId:input.workId,state,completion,truncated,artifacts:[],summary:state==='verified'?'Recorded executions satisfy the reported completion requirement.':state==='failed'?'Execution recorded a failure.':state==='partial'?'Only partial completion or validation is established.':'Completion has not been verified by recorded executions.',
 facts:[...records.values()].slice(0,64).map(record=>({callId:record.toolCallId,tool:record.tool,kind:record.status!=='success'?'failure':record.executionEffect?.kind==='mutation'?verification.has(record.toolCallId)?'mutation':'unverified_mutation':record.executionEffect?.kind==='verification'?'validation':record.executionEffect?.kind==='read'?'read':'unknown',verifiedBy:verification.get(record.toolCallId)??null})),limitations};
}

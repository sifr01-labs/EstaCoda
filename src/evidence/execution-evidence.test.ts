import {expect,it} from 'vitest';
import {projectExecutionEvidence} from './execution-evidence.js';
const mutation={kind:'execution-evidence-recorded',toolCallId:'write',tool:'file.write',status:'success',riskClass:'workspace-write',visibleTurnId:'turn',executionEffect:{kind:'mutation'}};
const check={...mutation,toolCallId:'check',tool:'file.check',executionEffect:{kind:'verification',verifies:['file.write']},verifiedMutation:{toolCallId:'write',tool:'file.write'}};
const input={workId:'session:s',turnId:'turn',outcome:{status:'completed',completionFloor:'mutation_with_verification'},truncated:false};
it('requires matching current-turn mutation and validation receipts',()=>{
 expect(projectExecutionEvidence({...input,events:[mutation]}).state).toBe('unverified');
 expect(projectExecutionEvidence({...input,events:[mutation,check]}).state).toBe('verified');
 expect(projectExecutionEvidence({...input,events:[mutation,{...check,visibleTurnId:'old'}]}).state).toBe('unverified');
 expect(projectExecutionEvidence({...input,events:[{kind:'message',content:'All tests passed'}]}).state).toBe('unverified');
 expect(projectExecutionEvidence({...input,events:[mutation,check],truncated:true}).state).not.toBe('verified');
});
it('does not promote unrelated, failed, unclassified or out-of-order receipts',()=>{
 for(const events of [[mutation,{...check,verifiedMutation:{toolCallId:'another',tool:'file.write'}}],[mutation,check,{...mutation,toolCallId:'failed',status:'failed'}],[mutation,check,{...mutation,toolCallId:'unknown',executionEffect:undefined}],[check,mutation],[mutation,check,mutation]])expect(projectExecutionEvidence({...input,events}).state).not.toBe('verified');
 expect(projectExecutionEvidence({...input,events:[mutation,check],outcome:{...input.outcome,status:'failed'}}).state).toBe('failed');
 expect(projectExecutionEvidence({...input,events:[mutation,check],outcome:{...input.outcome,status:'partially_completed'}}).state).toBe('partial');
 expect(projectExecutionEvidence({...input,events:[mutation,check],outcome:null}).state).not.toBe('verified');
});
it('distinguishes observed reads from conversational claims and limits',()=>{
 const read={...mutation,toolCallId:'read',tool:'file.read',riskClass:'read-only-local',executionEffect:{kind:'read'}};
 expect(projectExecutionEvidence({...input,events:[read],outcome:{status:'completed',completionFloor:'read'}}).state).toBe('verified');
 expect(projectExecutionEvidence({...input,events:[read],outcome:{status:'completed',completionFloor:'none'}}).state).toBe('unverified');
 const many=Array.from({length:65},(_,index)=>({...read,toolCallId:'read-'+index}));
 const bounded=projectExecutionEvidence({...input,events:many,outcome:{status:'completed',completionFloor:'read'}});expect(bounded.facts).toHaveLength(64);expect(bounded.truncated).toBe(true);expect(bounded.state).not.toBe('verified');
});

it('ignores planning/delegation proof-ineligible receipts without masking real failures',()=>{
 const read={...mutation,toolCallId:'read',tool:'file.read',executionEffect:{kind:'read'}};
 const outcome={status:'completed',completionFloor:'read'};
 const planning=['plan','delegate_task'].map(tool=>({kind:'execution-evidence-recorded',tool,toolCallId:tool,status:'ineligible',visibleTurnId:'turn'}));
 const report=projectExecutionEvidence({...input,outcome,events:[...planning,read]});
 expect(report.state).toBe('verified');expect(report.facts).toEqual([expect.objectContaining({tool:'file.read',kind:'read'})]);
 expect(projectExecutionEvidence({...input,outcome,events:planning}).state).toBe('unverified');
 expect(projectExecutionEvidence({...input,outcome,events:[...planning,read,{...read,toolCallId:'failed',status:'failed'}]}).state).toBe('unverified');
 expect(projectExecutionEvidence({...input,events:[...planning,mutation,check]}).state).toBe('verified');
});
it('projects stable localized explanation codes without changing the evidence outcome',()=>{
 const verified=projectExecutionEvidence({...input,events:[mutation,check]});expect(verified.summaryCode).toBe('verified');expect(verified.limitationCodes).toEqual([]);
 const missing=projectExecutionEvidence({...input,events:[mutation]});expect(missing.state).toBe('unverified');expect(missing.limitationCodes).toContain('mutation_unverified');expect(missing.limitations).toContain('Observed mutations lack compatible validation.');
 const absent=projectExecutionEvidence({...input,turnId:null,outcome:null,events:[]});expect(absent.limitationCodes).toEqual(['turn_unbound','outcome_unconfirmed','receipts_missing']);
});

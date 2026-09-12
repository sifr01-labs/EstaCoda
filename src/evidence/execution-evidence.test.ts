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

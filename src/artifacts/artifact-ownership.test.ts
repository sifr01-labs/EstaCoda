import {expect,it} from 'vitest';
import {sessionArtifactLinks,taskArtifactLinks} from './artifact-ownership.js';
import type {SessionRecord} from '../contracts/session.js';
import type {Task,TaskAttempt,TaskResult} from '../contracts/task.js';
it('derives Task and Attempt links only from matching canonical owners',()=>{
 const session={id:'worker',profileId:'p'} as SessionRecord,task={id:'t',profileId:'p',originSessionId:'origin'} as Task;
 const attempt={id:'a',profileId:'p',taskId:'t',workerSessionId:'worker'} as TaskAttempt,result={profileId:'p',taskId:'t',attemptId:'a'} as TaskResult;
 expect(sessionArtifactLinks('p',session,task,attempt).workIds).toEqual(['session:worker','attempt:a','task:t']);
 expect(taskArtifactLinks('p',task,result,attempt).workIds).toEqual(['attempt:a','task:t','session:origin']);
 expect(()=>sessionArtifactLinks('other',session)).toThrow();
 expect(()=>taskArtifactLinks('p',task,result,{...attempt,profileId:'other'})).toThrow();
 expect(()=>sessionArtifactLinks('p',session,task,{...attempt,workerSessionId:'foreign'})).toThrow();
});

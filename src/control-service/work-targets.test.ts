import {mkdtemp,rm} from 'node:fs/promises';
import {it,expect} from 'vitest';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {availableWorkTargets} from './work-targets.js';
it('offers only existing trusted targets in the selected profile',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-target-list-');const input={homeDir,profileId:'p'};const store=new ExecutionTargetStore(input);
 try{const target=await store.acquireLocal(homeDir);expect((await availableWorkTargets(input,new AbortController().signal)).items).toEqual([]);const trust=new WorkspaceTrustStore(input);await trust.grant(homeDir);expect((await availableWorkTargets(input,new AbortController().signal)).items).toMatchObject([{targetId:target.id,targetGeneration:1}]);expect((await availableWorkTargets({homeDir,profileId:'q'},new AbortController().signal)).items).toEqual([]);}finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});

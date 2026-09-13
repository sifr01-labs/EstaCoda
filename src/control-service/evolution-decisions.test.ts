vi.mock('./evolution-toolchain.js',async original=>{const actual=await original<typeof import('./evolution-toolchain.js')>();return{evolutionToolchain:()=>actual.evolutionToolchain(process.env.ESTACODA_TEST_ORIGINAL_HOME)};});
import {it,expect,vi} from 'vitest';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {EvolutionDecisions} from './evolution-decisions.js';
async function fixture(){const homeDir=await mkdtemp(join(tmpdir(),'evolution-decide-')),owner=new EvolutionDecisions({homeDir,profileId:'one'},join(homeDir,'absent')),dir=join(owner.paths.skillsPath,'example'),path=join(dir,'SKILL.md');await mkdir(dir,{recursive:true});await writeFile(path,'---\n'+JSON.stringify({name:'Example',description:'Example skill',requiredToolsets:['files'],routing:{labels:[],triggerPatterns:[]},playbook:[],evaluations:[]})+'\n---\nbefore');const {store}=await owner.open();const proposal=await store.proposePatch({skillName:'Example',reason:'Improve guidance',source:'local',sourceTrust:'user_direct',patch:{type:'text_patch',oldString:'before',newString:'after'}});return{owner,path,proposal,dispose:async()=>{owner.dispose();await rm(homeDir,{recursive:true,force:true});}};}
it('requires explicit approval, snapshots a governed promotion and keeps a durable receipt',async()=>{const f=await fixture();try{
 expect((await f.owner.review({proposalId:f.proposal.id,action:'promote'})).reason).toBe('approval_required');
 const approval=await f.owner.review({proposalId:f.proposal.id,action:'approve'});expect(approval.allowed).toBe(true);expect((await f.owner.execute({reviewId:approval.reviewId,operationId:'approve',confirmed:true},new AbortController().signal)).state).toBe('completed');
 const promotion=await f.owner.review({proposalId:f.proposal.id,action:'promote'});expect(promotion.allowed).toBe(true);expect((await f.owner.execute({reviewId:promotion.reviewId,operationId:'promote',confirmed:true},new AbortController().signal)).state).toBe('completed');expect(await readFile(f.path,'utf8')).toContain('after');expect((await f.owner.details(f.proposal.id)).promotions[0]?.snapshotAvailable).toBe(true);expect((await f.owner.operations.inspect('promote')).state).toBe('completed');await expect(f.owner.execute({reviewId:promotion.reviewId,operationId:'promote',confirmed:true},new AbortController().signal)).rejects.toThrow();
 }finally{await f.dispose();}});
it('cancels reviews and rejects changed skill contents before writing',async()=>{const f=await fixture();try{const r=await f.owner.review({proposalId:f.proposal.id,action:'approve'});f.owner.cancel(r.reviewId);await expect(f.owner.execute({reviewId:r.reviewId,operationId:'cancelled',confirmed:true},new AbortController().signal)).rejects.toThrow();const r2=await f.owner.review({proposalId:f.proposal.id,action:'approve'});await writeFile(f.path,(await readFile(f.path,'utf8'))+'\nchanged');await expect(f.owner.execute({reviewId:r2.reviewId,operationId:'changed',confirmed:true},new AbortController().signal)).rejects.toThrow();expect((await f.owner.operations.inspect('changed')).state).toBe('unknown');}finally{await f.dispose();}});

it('never turns an unsupported manifest command into executable approval',async()=>{const f=await fixture();try{const {store,manifests}=await f.owner.open();const m=await manifests.propose({target:'skill',filesChanged:[],evidence:{traces:[],failures:[],evalCases:[]},hypothesis:'Improve',predictedImpact:'Improve',riskLevel:'low',evalCommand:'sh -c echo unexpected',constraintGates:[],rollbackPlan:'Restore snapshot'});const p=await store.proposePatch({skillName:'Example',reason:'Manifest',changeManifestId:m.id,patch:{type:'text_patch',oldString:'before',newString:'after'}});const r=await f.owner.review({proposalId:p.id,action:'test'});expect(r).toMatchObject({allowed:false,reason:'unsupported'});await expect(f.owner.execute({reviewId:r.reviewId,operationId:'denied-gate',confirmed:true},new AbortController().signal)).rejects.toThrow();expect(await readFile(f.path,'utf8')).toContain('before');}finally{await f.dispose();}});

it('restores only the latest unchanged promoted skill and retains a recovery receipt',async()=>{const f=await fixture();try{
 for(const action of ['approve','promote'] as const){const r=await f.owner.review({proposalId:f.proposal.id,action});expect((await f.owner.execute({reviewId:r.reviewId,operationId:action,confirmed:true},new AbortController().signal)).state).toBe('completed');}
 const other=join(f.owner.paths.skillsPath,'example','notes.txt');await writeFile(other,'retain this asset');
 expect((await f.owner.details(f.proposal.id)).rollbackAvailable).toBe(true);
 const r=await f.owner.review({proposalId:f.proposal.id,action:'rollback'});expect(r.allowed).toBe(true);expect(r.diff).toContain('before');
 expect((await f.owner.execute({reviewId:r.reviewId,operationId:'restore',confirmed:true},new AbortController().signal)).state).toBe('completed');expect(await readFile(f.path,'utf8')).toContain('before');expect(await readFile(other,'utf8')).toBe('retain this asset');expect((await f.owner.details(f.proposal.id)).rollbackAvailable).toBe(false);
 const reopened=new EvolutionDecisions(f.owner.input,f.owner.bundledRoot);expect((await reopened.operations.inspect('restore')).state).toBe('completed');reopened.dispose();
 }finally{await f.dispose();}});
it('blocks rollback after later edits and does not claim missing snapshots are available',async()=>{const f=await fixture();try{
 for(const action of ['approve','promote'] as const){const r=await f.owner.review({proposalId:f.proposal.id,action});await f.owner.execute({reviewId:r.reviewId,operationId:action,confirmed:true},new AbortController().signal);}
 const r=await f.owner.review({proposalId:f.proposal.id,action:'rollback'});await writeFile(f.path,(await readFile(f.path,'utf8'))+'\nlater edit');await expect(f.owner.execute({reviewId:r.reviewId,operationId:'stale-restore',confirmed:true},new AbortController().signal)).rejects.toThrow();expect((await f.owner.review({proposalId:f.proposal.id,action:'rollback'})).allowed).toBe(false);
 await rm(join(f.owner.paths.skillsPath,'.snapshots'),{recursive:true});const d=await f.owner.details(f.proposal.id);expect(d.promotions[0]!.snapshotAvailable).toBe(false);expect(d.rollbackAvailable).toBe(false);expect(await readFile(f.path,'utf8')).toContain('later edit');
 }finally{await f.dispose();}});
it('blocks failing metadata gates, pinned rollback, and snapshot symlink destinations',async()=>{const f=await fixture();try{
 const {symlink}=await import('node:fs/promises');const original=await readFile(f.path,'utf8');await writeFile(f.path,original.replace('"evaluations":[]','"evaluations":[{"input":"Check","shouldUseToolsets":["browser"]}]'));
 expect((await f.owner.review({proposalId:f.proposal.id,action:'approve'})).reason).toBe('gates_failed');expect((await f.owner.review({proposalId:f.proposal.id,action:'reject'})).allowed).toBe(true);await writeFile(f.path,original);
 const approval=await f.owner.review({proposalId:f.proposal.id,action:'approve'});await f.owner.execute({reviewId:approval.reviewId,operationId:'approve',confirmed:true},new AbortController().signal);
 const outside=join(f.owner.input.homeDir,'outside');await mkdir(outside);await symlink(outside,join(f.owner.paths.skillsPath,'.snapshots'));const promotion=await f.owner.review({proposalId:f.proposal.id,action:'promote'});expect((await f.owner.execute({reviewId:promotion.reviewId,operationId:'linked',confirmed:true},new AbortController().signal)).state).not.toBe('completed');expect(await readFile(f.path,'utf8')).toBe(original);
 await rm(join(f.owner.paths.skillsPath,'.snapshots'));const r=await f.owner.review({proposalId:f.proposal.id,action:'promote'});await f.owner.execute({reviewId:r.reviewId,operationId:'promote',confirmed:true},new AbortController().signal);const {store}=await f.owner.open();await store.pinSkill('Example');expect((await f.owner.review({proposalId:f.proposal.id,action:'rollback'})).allowed).toBe(false);
 }finally{await f.dispose();}});
it('rejects cancelled and concurrent stale decisions without replaying effects',async()=>{const f=await fixture();try{
 const r=await f.owner.review({proposalId:f.proposal.id,action:'approve'}),cancel=new AbortController();cancel.abort();await expect(f.owner.execute({reviewId:r.reviewId,operationId:'aborted',confirmed:true},cancel.signal)).rejects.toThrow();expect((await f.owner.operations.inspect('aborted')).state).toBe('unknown');
 const other=await f.owner.review({proposalId:f.proposal.id,action:'reject'});await f.owner.execute({reviewId:r.reviewId,operationId:'approved',confirmed:true},new AbortController().signal);await expect(f.owner.execute({reviewId:other.reviewId,operationId:'stale',confirmed:true},new AbortController().signal)).rejects.toThrow();
 }finally{await f.dispose();}});
it('does not execute a truncated manifest gate',async()=>{const f=await fixture();try{
 const {store,manifests}=await f.owner.open();const manifest=await manifests.propose({target:'skill',filesChanged:[],evidence:{traces:[],failures:[],evalCases:[]},hypothesis:'Test',predictedImpact:'Test',riskLevel:'low',evalCommand:'pnpm run test'+' '.repeat(240)+'&& unexpected',constraintGates:[],rollbackPlan:'Restore'});const p=await store.proposePatch({skillName:'Example',reason:'Check',changeManifestId:manifest.id,patch:{type:'text_patch',oldString:'before',newString:'after'}});expect((await f.owner.review({proposalId:p.id,action:'test'})).allowed).toBe(false);
 }finally{await f.dispose();}});
it('runs manifest gates in a trusted canonical workspace and preserves failure before promotion',async()=>{const f=await fixture();const {ExecutionTargetStore}=await import('../workspaces/execution-target.js'),{WorkspaceTrustStore}=await import('../security/workspace-trust-store.js');const targets=new ExecutionTargetStore(f.owner.input);try{
 const root=join(f.owner.input.homeDir,'workspace');await mkdir(root);await writeFile(join(root,'package.json'),JSON.stringify({name:'gate-test',private:true,scripts:{test:'node gate.cjs'}}));await writeFile(join(root,'gate.cjs'),"require('node:fs').writeFileSync('gate-marker','ran');process.exit(1)");const target=await targets.acquireLocal(root),reference={targetId:target.id,targetGeneration:target.generation};
 const {store,manifests}=await f.owner.open();const m=await manifests.propose({target:'skill',filesChanged:[],evidence:{traces:[],failures:[],evalCases:[]},hypothesis:'Improve',predictedImpact:'Improve',riskLevel:'low',evalCommand:'pnpm run test',constraintGates:[],rollbackPlan:'Restore snapshot'});const p=await store.proposePatch({skillName:'Example',reason:'Manifest',sourceTrust:'user_direct',changeManifestId:m.id,patch:{type:'text_patch',oldString:'before',newString:'after'}});
 expect((await f.owner.review({proposalId:p.id,action:'test',target:reference})).allowed).toBe(false);await new WorkspaceTrustStore(f.owner.input).grant(root);
 const review=await f.owner.review({proposalId:p.id,action:'test',target:reference});expect(review.allowed).toBe(true);expect((await f.owner.execute({reviewId:review.reviewId,operationId:'gate-fail',confirmed:true},new AbortController().signal)).state).toBe('failed');expect(await readFile(join(root,'gate-marker'),'utf8')).toBe('ran');expect((await manifests.find(m.id))!.status).toBe('proposed');expect(await readFile(f.path,'utf8')).toContain('before');
 await writeFile(join(root,'gate.cjs'),"require('node:fs').writeFileSync('gate-marker','passed')");for(const action of ['test','approve','promote'] as const){const r=await f.owner.review({proposalId:p.id,action,target:reference});expect(r.allowed).toBe(true);expect((await f.owner.execute({reviewId:r.reviewId,operationId:'gate-'+action,confirmed:true},new AbortController().signal)).state).toBe('completed');}expect(await readFile(f.path,'utf8')).toContain('after');expect((await manifests.find(m.id))!.status).toBe('promoted');
 const restore=await f.owner.review({proposalId:p.id,action:'rollback',target:reference});expect(restore.allowed).toBe(true);expect((await f.owner.execute({reviewId:restore.reviewId,operationId:'gate-restore',confirmed:true},new AbortController().signal)).state).toBe('completed');expect((await manifests.find(m.id))!.status).toBe('reverted');
 }finally{targets.close();await f.dispose();}},20000);

it('acknowledges a durable operation while its work is still running, then reconciles completion',async()=>{
 const f=await fixture();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const execute=f.owner.operations.execute.bind(f.owner.operations);
 f.owner.operations.execute=(id,action,run,accepted)=>execute(id,action,async()=>{await held;return run();},accepted);
 try{
  const review=await f.owner.review({proposalId:f.proposal.id,action:'approve'});
  const receipt=await f.owner.start({reviewId:review.reviewId,operationId:'background',confirmed:true},new AbortController().signal);
  expect(receipt.state).toBe('uncertain');expect((await f.owner.store().findProposal(f.proposal.id))!.approvalState).toBe('required');
  expect(await f.owner.start({reviewId:review.reviewId,operationId:'background',confirmed:true},new AbortController().signal)).toEqual(receipt);
  release();await expect.poll(async()=>(await f.owner.operations.inspect('background')).state).toBe('completed');
 }finally{release();await f.dispose();}
});
it('records a stale review as definitely rejected and allows a fresh reviewed operation',async()=>{
 const f=await fixture();try{
  const review=await f.owner.review({proposalId:f.proposal.id,action:'approve'});await writeFile(f.path,(await readFile(f.path,'utf8'))+'\nchanged');
  const receipt=await f.owner.start({reviewId:review.reviewId,operationId:'rejected-review',confirmed:true},new AbortController().signal);await expect.poll(async()=>(await f.owner.operations.inspect(receipt.operationId)).state).toBe('failed');
  expect((await f.owner.operations.inspect(receipt.operationId)).state).toBe('failed');expect((await f.owner.store().findProposal(f.proposal.id))!.approvalState).toBe('required');
  const fresh=await f.owner.review({proposalId:f.proposal.id,action:'approve'});await f.owner.start({reviewId:fresh.reviewId,operationId:'fresh-review',confirmed:true},new AbortController().signal);
  await expect.poll(async()=>(await f.owner.operations.inspect('fresh-review')).state).toBe('completed');
 }finally{await f.dispose();}
});
it('does not rename or clear malformed usage during read-only review',async()=>{
 const f=await fixture();try{
  const {readdir}=await import('node:fs/promises');const path=join(f.owner.paths.skillsPath,'.usage.json');
  for(const value of ['{invalid',JSON.stringify({version:1,skills:[{skillName:'Example',pinned:'false',state:'active'}]})]){
   await writeFile(path,value);await expect(f.owner.review({proposalId:f.proposal.id,action:'approve'})).rejects.toThrow();
   expect(await readFile(path,'utf8')).toBe(value);expect((await readdir(f.owner.paths.skillsPath)).some(n=>n.includes('.corrupt-'))).toBe(false);
  }
 }finally{await f.dispose();}
});
it('pages and decides proposals beyond lifetime history bounds without truncating the stores',async()=>{
 const f=await fixture();try{
  const root=join(f.owner.paths.skillsPath,'.evolution');const rows=Array.from({length:1205},(_,i)=>({...f.proposal,id:'patch_'+i,reason:'History '+i+'x'.repeat(1000)}));
  await writeFile(join(root,'proposed-patches.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  await writeFile(join(root,'observations.jsonl'),Array.from({length:1205},(_,i)=>JSON.stringify({id:'obs_'+i,skillName:'Other',lesson:'x'.repeat(1000)})).join('\n')+'\n');
  let offset:number|null=0,count=0;while(offset!==null){const page=await f.owner.list(offset);count+=page.items.length;offset=page.nextOffset;}expect(count).toBe(1205);
  const r=await f.owner.review({proposalId:'patch_1204',action:'approve'});expect(r.allowed).toBe(true);
  expect((await f.owner.execute({reviewId:r.reviewId,operationId:'large-history',confirmed:true},new AbortController().signal)).state).toBe('completed');
  const saved=(await readFile(join(root,'proposed-patches.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(saved).toHaveLength(1205);expect(saved[0]).toEqual(rows[0]);expect(saved.at(-1).approvalState).toBe('approved');
 }finally{await f.dispose();}
});
it('settles a removed proposal as failed before running any decision effect',async()=>{
 const f=await fixture();try{const r=await f.owner.review({proposalId:f.proposal.id,action:'approve'});await writeFile(join(f.owner.paths.skillsPath,'.evolution','proposed-patches.jsonl'),'');await f.owner.start({reviewId:r.reviewId,operationId:'removed',confirmed:true},new AbortController().signal);await expect.poll(async()=>(await f.owner.operations.inspect('removed')).state).toBe('failed');expect(await readFile(f.path,'utf8')).toContain('before');}finally{await f.dispose();}
});

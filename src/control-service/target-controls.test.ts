import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TargetControls} from './target-controls.js';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
it('binds reviews to a bridge and source, expires cancellation, and reconciles lifecycle without replay',async()=>{
 const homeDir=realpathSync(await mkdtemp('/tmp/ec-target-service-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);
 execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Initial']);
 const store=new ExecutionTargetStore(input),controls=new TargetControls(input),signal=new AbortController().signal;
 try{
  const target=await store.acquireLocal(root);const source={targetId:target.id,targetGeneration:1};
  expect((await controls.list(signal)).items).toMatchObject([{readiness:'untrusted'}]);
  await new WorkspaceTrustStore(input).grant(root);
  const cancelled=await controls.review(source);expect(controls.cancel(cancelled.reviewId).cancelled).toBe(true);
  await expect(controls.create({reviewId:cancelled.reviewId,source,trustNewPath:true},signal)).rejects.toThrow();
  const review=await controls.review(source);
  await expect(new TargetControls(input).create({reviewId:review.reviewId,source,trustNewPath:true},signal)).rejects.toThrow();
  await expect(controls.create({reviewId:review.reviewId,source:{...source,targetGeneration:2},trustNewPath:true},signal)).rejects.toThrow();
  const result=await controls.create({reviewId:review.reviewId,source,trustNewPath:true},signal);
  expect(result).toMatchObject({action:'create',state:'completed'});
  expect(await controls.operation(review.operationId)).toEqual(result);
  expect(await controls.inspect(result.target!)).toMatchObject({kind:'git-worktree',readiness:'ready',dirty:false,borrowers:0});
  const request={operationId:randomUUID(),action:'archive' as const,target:result.target!,confirmed:true as const};
  const archived=await controls.execute(request,signal);expect(archived.state).toBe('completed');
  expect(await controls.execute(request,signal)).toEqual(archived);
  expect(await controls.inspect(archived.target!)).toMatchObject({readiness:'archived',cleanup:'retained'});
  const removed=await controls.execute({...request,operationId:randomUUID(),action:'cleanup',target:archived.target!},signal);
  expect(removed.state).toBe('completed');expect(await controls.inspect(removed.target!)).toMatchObject({cleanup:'removed',dirty:null});
 }finally{controls.dispose();store.close();await rm(homeDir,{recursive:true,force:true});}
});

import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DesktopTargetControls} from './target-controls.js';
import type {DesktopConnection} from './connection.js';
it('binds creation to the reviewed source and generation and preserves uncertain references across restart',async()=>{
 const directory=mkdtempSync('/tmp/ec-main-target-');
 const source={targetId:'source',targetGeneration:1},operationId=randomUUID();
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1},targetRequest:vi.fn(async(method:string,params:any)=>{
  if(method==='targets.reviewCreate')return{reviewId:'review',operationId,source,expiresAt:Date.now()+300000};
  if(method==='targets.inspectOperation')return{operationId:params.operationId,action:'create',state:'uncertain',target:null};
  if(method==='targets.cancelReview')return{cancelled:true};
  throw new Error('Connection lost');
 })});
 try{const main=new DesktopTargetControls(connection as unknown as DesktopConnection,directory);await main.review(source);await expect(main.create('review',true)).rejects.toThrow('Connection lost');
  expect(connection.targetRequest).toHaveBeenCalledWith('targets.create',{reviewId:'review',source,trustNewPath:true});
  await expect(main.create('review',true)).rejects.toThrow('expired');
  const restarted=new DesktopTargetControls(connection as unknown as DesktopConnection,directory);expect((await restarted.operation())?.state).toBe('uncertain');
  await restarted.review(source);connection.state.generation++;connection.emit('state');await expect(restarted.create('review',true)).rejects.toThrow('expired');
  connection.state.profileId='q';expect(await restarted.operation()).toBeNull();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

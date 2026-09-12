import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GatewayControls} from './gateway-controls.js';
it('reconciles completed and uncertain gateway operations across bridge restart without replay',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-gateway-control-'));let calls=0;
 try{const input={homeDir,profileId:'one',version:'test'},controls=new GatewayControls(input,async(scope,action)=>{expect(scope.profileId).toBe('one');calls++;if(action==='restart')throw new Error('sensitive diagnostic');return true;});
 expect((await controls.execute('op1','stop')).state).toBe('completed');expect((await controls.execute('op2','restart')).state).toBe('uncertain');
 const restarted=new GatewayControls(input,async()=>{calls++;return true;});expect((await restarted.execute('op1','stop')).state).toBe('completed');expect((await restarted.execute('op2','restart')).state).toBe('uncertain');expect(calls).toBe(2);
 await expect(restarted.execute('op1','install')).rejects.toThrow();expect((await new GatewayControls({...input,profileId:'two'}).operations.inspect('op1')).state).toBe('unknown');
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
it('reserves an operation before concurrent dispatch',async()=>{const homeDir=await mkdtemp(join(tmpdir(),'ec-gateway-control-'));let calls=0;try{const controls=new GatewayControls({homeDir,profileId:'one',version:'test'},async()=>{calls++;return true;});await Promise.all([controls.execute('same','stop'),controls.execute('same','stop')]);expect(calls).toBe(1);}finally{await rm(homeDir,{recursive:true,force:true});}});

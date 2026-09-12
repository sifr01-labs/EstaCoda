import {it,expect} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import type {DesktopConnection} from './connection.js';
import {DesktopTerminalControls} from './terminal-controls.js';
it('starts a native PTY after confirmation, keeps capability private and settles on close',async()=>{
 const root=await realpath(await mkdtemp('/tmp/ec-native-pty-')),calls:string[]=[],target={targetId:'t',targetGeneration:1};
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1},targetRequest:async()=>({workingRoot:root,readiness:'ready'}),inspectionRequest:async(method:string)=>{calls.push(method);return method==='terminal.acquire'?{capabilityId:'private-cap',target,workingRoot:root,backend:'host',container:null,expiresAt:Date.now()+3000}:method==='terminal.verify'?{expiresAt:Date.now()+3000}:{released:true};}}) as unknown as DesktopConnection;
 const terminal=new DesktopTerminalControls(connection,async()=>true,root);
 try{
  const opened=await terminal.open(target);expect(Object.keys(opened).sort()).toEqual(['backend','id']);
  terminal.resize(opened.id,100,30);terminal.write(opened.id,"printf 'EC_PTY_%s\\n' READY\r");
  let output='';await expect.poll(()=>{output+=terminal.read(opened.id).data;return output;}).toContain('EC_PTY_READY');
  await terminal.close(opened.id);expect(calls).toContain('terminal.release');expect(()=>terminal.write(opened.id,'x')).toThrow();
 }finally{await terminal.dispose();await rm(root,{recursive:true,force:true});}
});

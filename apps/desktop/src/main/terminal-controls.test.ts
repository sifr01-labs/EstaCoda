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
it.each(['disconnect','exit'] as const)('kills normal background descendants on %s',async mode=>{
 const {readFile}=await import('node:fs/promises'),{join}=await import('node:path');
 const root=await realpath(await mkdtemp('/tmp/ec-pty-tree-')),target={targetId:'t',targetGeneration:1};
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},targetRequest:async()=>({workingRoot:root,readiness:'ready'}),inspectionRequest:async(method:string)=>method==='terminal.acquire'?{capabilityId:'cap',target,workingRoot:root,backend:'host',container:null,expiresAt:Date.now()+3000}:method==='terminal.verify'?{expiresAt:Date.now()+3000}:{released:true}}) as unknown as DesktopConnection;
 const terminal=new DesktopTerminalControls(connection,async()=>true,root);let child=0;
 try{
  const opened=await terminal.open(target);terminal.write(opened.id,"sleep 60 & echo $! > child.pid\r");
  await expect.poll(async()=>{try{return child=Number((await readFile(join(root,'child.pid'),'utf8')).trim());}catch{return 0;}}).toBeGreaterThan(0);
  if(mode==='disconnect'){connection.state={...connection.state,status:'disconnected',generation:2,profileId:'other'};connection.emit('invalidate');expect(()=>terminal.read(opened.id)).toThrow();}
  else{terminal.write(opened.id,'exit\r');await expect.poll(()=>terminal.read(opened.id).state).toBe('closed');}
  expect(()=>terminal.write(opened.id,'x')).toThrow();
  await expect.poll(()=>{try{process.kill(child,0);return false;}catch{return true;}},{timeout:4000}).toBe(true);
 }finally{await terminal.dispose();await rm(root,{recursive:true,force:true});}
});
it('does not spawn after a cancelled confirmation or a profile change during confirmation',async()=>{
 const {vi}=await import('vitest');const spawn=vi.fn(),target={targetId:'t',targetGeneration:1};
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},targetRequest:async()=>({workingRoot:'/tmp',readiness:'ready'}),inspectionRequest:vi.fn()}) as unknown as DesktopConnection;
 for(const confirm of [async()=>false,async()=>{connection.state.generation++;return true;}]){
  const terminal=new DesktopTerminalControls(connection,confirm,'/tmp',spawn);
  await expect(terminal.open(target)).rejects.toThrow();await terminal.dispose();
 }
 expect(spawn).not.toHaveBeenCalled();expect(connection.inspectionRequest).not.toHaveBeenCalled();
});
it('closes a real PTY when core capability verification is revoked',async()=>{
 const root=await realpath(await mkdtemp('/tmp/ec-pty-revoke-')),target={targetId:'t',targetGeneration:1};let released=false;
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},targetRequest:async()=>({workingRoot:root,readiness:'ready'}),inspectionRequest:async(method:string)=>{if(method==='terminal.verify')throw new Error('Target revoked');if(method==='terminal.release'){released=true;return{released:true};}return{capabilityId:'cap',target,workingRoot:root,backend:'host',container:null,expiresAt:Date.now()+3000};}}) as unknown as DesktopConnection;
 const terminal=new DesktopTerminalControls(connection,async()=>true,root);
 try{const opened=await terminal.open(target);await expect.poll(()=>terminal.read(opened.id).state,{timeout:4000}).toBe('closed');expect(()=>terminal.write(opened.id,'x')).toThrow();await expect.poll(()=>released).toBe(true);}finally{await terminal.dispose();await rm(root,{recursive:true,force:true});}
});
it('reports stopping until process and capability settlement both complete',async()=>{
 const root=await realpath(await mkdtemp('/tmp/ec-pty-settle-')),target={targetId:'t',targetGeneration:1};let release:(()=>void)|undefined;
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},targetRequest:async()=>({workingRoot:root,readiness:'ready'}),inspectionRequest:async(method:string)=>{if(method==='terminal.release'){await new Promise<void>(resolve=>{release=resolve;});return{released:true};}return method==='terminal.verify'?{expiresAt:Date.now()+3000}:{capabilityId:'cap',target,workingRoot:root,backend:'host',container:null,expiresAt:Date.now()+3000};}}) as unknown as DesktopConnection;
 const terminal=new DesktopTerminalControls(connection,async()=>true,root);let closing:Promise<void>|undefined;
 try{const opened=await terminal.open(target);closing=terminal.close(opened.id);await expect.poll(()=>Boolean(release)).toBe(true);expect(terminal.read(opened.id).state).toBe('stopping');expect(()=>terminal.write(opened.id,'x')).toThrow();release!();await closing;expect(()=>terminal.read(opened.id)).toThrow();}finally{release?.();await closing;await terminal.dispose();await rm(root,{recursive:true,force:true});}
});
it('allows a closed terminal buffer to be drained in bounded chunks',async()=>{
 const root=await realpath(await mkdtemp('/tmp/ec-pty-drain-')),target={targetId:'t',targetGeneration:1};
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},targetRequest:async()=>({workingRoot:root,readiness:'ready'}),inspectionRequest:async(method:string)=>method==='terminal.acquire'?{capabilityId:'cap',target,workingRoot:root,backend:'host',container:null,expiresAt:Date.now()+3000}:method==='terminal.verify'?{expiresAt:Date.now()+3000}:{released:true}}) as unknown as DesktopConnection;
 const terminal=new DesktopTerminalControls(connection,async()=>true,root);
 try{const opened=await terminal.open(target);terminal.write(opened.id,"printf '%040000d' 0; exit\r");let output='';await expect.poll(()=>{const value=terminal.read(opened.id);expect(value.data.length).toBeLessThanOrEqual(16384);output+=value.data;return value.state==='closed'&&!value.more;}).toBe(true);expect(output).toContain('0'.repeat(40000));}finally{await terminal.dispose();await rm(root,{recursive:true,force:true});}
});

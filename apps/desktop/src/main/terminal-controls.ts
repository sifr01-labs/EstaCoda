import {terminalSession,stopTerminalSession,type TerminalProcessOwner} from './terminal-process-tree.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as pty from 'node-pty';
import type {MethodContracts,TargetReference} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
import type {DesktopTerminalApi} from '../shared/desktop-api.js';
type Capability=MethodContracts['terminal.acquire']['result'];
type Entry={temporary?:string;exitCode?:number;exitSignal?:number;session?:TerminalProcessOwner;generation:number;profileId:string;id:string;capability:Capability;process:pty.IPty;buffer:string;truncated:boolean;exited:boolean;state:'running'|'stopping'|'closed';exit:Promise<void>;stop?:Promise<void>;deadline:ReturnType<typeof setTimeout>;heartbeat:ReturnType<typeof setInterval>;checking:boolean};
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Main owns the PTY and capability. No raw capability, cwd, environment or
 * executable is exposed through preload, and input never resolves approvals. */
export class DesktopTerminalControls{
 #entry?:Entry;#opening=false;#epoch=0;#disposed=false;
 readonly #invalidate=()=>{this.#epoch++;if(this.#entry)this.#entry.buffer='';void this.closeCurrent().catch(()=>{});};
 constructor(readonly connection:DesktopConnection,readonly confirm:(root:string)=>Promise<boolean>,readonly homeDir:string,readonly spawn:typeof pty.spawn=pty.spawn){connection.on('invalidate',this.#invalidate);}
 async open(target:TargetReference):ReturnType<DesktopTerminalApi['open']>{
  if(this.#disposed||this.#opening||this.#entry)throw new Error('Close the current terminal first.');
  this.#opening=true;const epoch=this.#epoch,generation=this.connection.state.generation;
  const assert=()=>{if(this.#disposed||epoch!==this.#epoch||generation!==this.connection.state.generation||this.connection.state.status!=='ready')throw new Error('Terminal context changed.');};
  let capability:Capability|undefined,temporary:string|undefined;
  try{
   assert();const detail=await this.connection.targetRequest('targets.inspect',{target});assert();
   if(detail.readiness!=='ready'||!await this.confirm(detail.workingRoot))throw new Error('Terminal opening cancelled.');assert();
   capability=await this.connection.inspectionRequest('terminal.acquire',{target});assert();
   if(capability.expiresAt<=Date.now()||capability.target.targetId!==target.targetId||capability.target.targetGeneration!==target.targetGeneration||capability.workingRoot!==detail.workingRoot)throw new Error('Terminal target changed.');
   const container=capability.container;
   if(capability.backend==='docker'&&(!container||!/^unix:\/\/\//u.test(container.endpoint)||/[\r\n\0]/u.test(container.endpoint)||!/^[a-f0-9]{64}$/u.test(container.id)||!/^\d+:\d+$/u.test(container.user)))throw new Error('Invalid Docker terminal capability.');
   if(capability.backend==='host'){temporary=await mkdtemp(join(tmpdir(),'estacoda-terminal-'));await writeFile(join(temporary,'bashrc'),"trap 'for ec_job in $(jobs -p); do kill -KILL -- -\"$ec_job\" 2>/dev/null; done' EXIT\n",{mode:0o600});assert();}
   const command=capability.backend==='docker'?'docker':'/bin/bash';
   const args=capability.backend==='docker'?['--host',container!.endpoint,'exec','-it','--user',container!.user,'--workdir',capability.workingRoot,container!.id,'/bin/bash','--noprofile','--norc','-i','+m']:['--noprofile','--rcfile',join(temporary!,'bashrc'),'-i'];
   const process=this.spawn(command,args,{name:'xterm-256color',cols:80,rows:24,cwd:capability.workingRoot,env:{PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',HOME:this.homeDir,LANG:'en_US.UTF-8',TERM:'xterm-256color',HISTFILE:'/dev/null',BASH_SILENCE_DEPRECATION_WARNING:'1'}});
   let exited!:()=>void;const exit=new Promise<void>(resolve=>{exited=resolve;});
   const entry:Entry={temporary,generation,profileId:this.connection.state.profileId,id:randomUUID(),capability,process,buffer:'',truncated:false,exited:false,state:'running',exit,checking:false,deadline:setTimeout(()=>this.#invalidate(),Math.max(1,capability.expiresAt-Date.now())),heartbeat:setInterval(()=>void this.#verify(),700)};
   this.#entry=entry;capability=undefined;temporary=undefined;
   process.onData(data=>{if(entry.state!=='running')return;entry.buffer+=data;if(entry.buffer.length>65536){entry.buffer=entry.buffer.slice(-65536);entry.truncated=true;}});
   process.onExit(({exitCode,signal})=>{entry.exitCode=exitCode;entry.exitSignal=signal;entry.exited=true;exited();void this.#stop(entry).catch(()=>{});});
   try{entry.session=await terminalSession(process.pid);assert();}catch(error){await this.closeCurrent();throw error;}
   return{id:entry.id,backend:entry.capability.backend};
  }finally{
   this.#opening=false;
   if(temporary)await rm(temporary,{recursive:true,force:true});
   if(capability)await this.connection.inspectionRequest('terminal.release',{capabilityId:capability.capabilityId,settled:true}).catch(()=>{});
  }
 }
 async #verify():Promise<void>{
  const entry=this.#entry;if(!entry||entry.state!=='running'||entry.checking)return;entry.checking=true;
  try{
   const value=await this.connection.inspectionRequest('terminal.verify',{capabilityId:entry.capability.capabilityId});
   if(this.#entry!==entry||entry.state!=='running')return;
   clearTimeout(entry.deadline);entry.capability.expiresAt=value.expiresAt;entry.deadline=setTimeout(()=>this.#invalidate(),Math.max(1,value.expiresAt-Date.now()));
  }catch{await this.#stop(entry).catch(()=>{});}finally{entry.checking=false;}
 }
 #active(id:string):Entry{
  const entry=this.#entry;if(!entry||entry.id!==id||entry.generation!==this.connection.state.generation||entry.profileId!==this.connection.state.profileId||entry.state!=='running'||entry.capability.expiresAt<=Date.now()||this.connection.state.status!=='ready')throw new Error('Terminal unavailable.');return entry;
 }
 read(id:string):Awaited<ReturnType<DesktopTerminalApi['read']>>{
  const entry=this.#entry;if(!entry||entry.id!==id||entry.generation!==this.connection.state.generation||entry.profileId!==this.connection.state.profileId||this.connection.state.status!=='ready')throw new Error('Terminal unavailable.');
  const data=entry.buffer.slice(0,16384);entry.buffer=entry.buffer.slice(data.length);const truncated=entry.truncated;entry.truncated=false;return{data,truncated,more:entry.buffer.length>0,state:entry.state};
 }
 write(id:string,data:string):void{this.#active(id).process.write(data);}
 resize(id:string,cols:number,rows:number):void{this.#active(id).process.resize(cols,rows);}
 async #stop(entry:Entry):Promise<void>{
  if(entry.stop)return entry.stop;
  entry.state='stopping';clearTimeout(entry.deadline);clearInterval(entry.heartbeat);
  // Verify the controlling PTY, not only the shell's initial job-control group.
  entry.stop=(async()=>{
   if(entry.session){const stopped=await stopTerminalSession(entry.session);if(!stopped&&entry.capability.backend==='host'&&(entry.exitCode===undefined||entry.exitSignal))throw new Error('Abnormal terminal exit requires process recovery.');}
   else try{process.kill(-entry.process.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
   await Promise.race([entry.exit,pause(2000)]);if(!entry.exited)throw new Error('Terminal exit unconfirmed.');
   if(this.connection.state.status==='ready'&&entry.generation===this.connection.state.generation&&entry.profileId===this.connection.state.profileId)await this.connection.inspectionRequest('terminal.release',{capabilityId:entry.capability.capabilityId,settled:true});
   if(entry.temporary){await rm(entry.temporary,{recursive:true,force:true});entry.temporary=undefined;}
     // Lost transport leaves the core borrower retained for recovery, not released by inference.
  })();
  try{await entry.stop;entry.state='closed';}catch(error){entry.stop=undefined;throw error;}
 }
 async close(id:string):Promise<void>{if(this.#entry?.id!==id)throw new Error('Terminal unavailable.');await this.closeCurrent();}
 async closeCurrent():Promise<void>{const entry=this.#entry;if(!entry)return;await this.#stop(entry);if(this.#entry===entry){entry.buffer='';this.#entry=undefined;}}
 async dispose():Promise<void>{this.#disposed=true;this.#epoch++;this.connection.off('invalidate',this.#invalidate);await this.closeCurrent();}
}

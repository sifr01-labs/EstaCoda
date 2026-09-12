import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export type TerminalProcessOwner={pid:number;tty:string;started:string};
type Row=TerminalProcessOwner&{state:string};
/** macOS hides `ps sess` as zero. Use the live, independently verified PTY
 * leader and its controlling terminal; never group processes by that zero. */
async function rows():Promise<Row[]>{
 const result=await execute('/bin/ps',['-axo','pid=,tty=,stat=,lstart='],{timeout:1000,maxBuffer:2*1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
 return result.stdout.trim().split('\n').filter(Boolean).map(line=>{
  const match=/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);if(!match)throw new Error('Terminal process inspection failed.');return{pid:Number(match[1]),tty:match[2]!,state:match[3]!,started:match[4]!};
 });
}
export async function terminalSession(pid:number):Promise<TerminalProcessOwner>{
 for(let attempt=0;attempt<20;attempt++){
  const all=await rows(),row=all.find(row=>row.pid===pid),parent=all.find(row=>row.pid===process.pid);
  if(row&&parent&&row.tty!=='??'&&row.tty!=='?'&&row.tty!==parent.tty&&pid!==process.pid)return{pid,tty:row.tty,started:row.started};
  await new Promise<void>(resolve=>setTimeout(resolve,25));
 }
 throw new Error('Independent terminal ownership unavailable.');
}
function signal(pid:number,value:NodeJS.Signals):void{try{process.kill(pid,value);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
/** Returns false when the leader already exited; the caller must use the shell's
 * normal-exit cleanup contract or retain its target borrower on an abnormal exit. */
export async function stopTerminalSession(owner:TerminalProcessOwner):Promise<boolean>{
 const first=await rows(),leader=first.find(row=>row.pid===owner.pid);
 if(!leader)return false;
 if(leader.tty!==owner.tty||leader.started!==owner.started)throw new Error('Terminal owner identity changed.');
 signal(owner.pid,'SIGSTOP');const frozen=new Map<number,string>([[owner.pid,owner.started]]);
 for(let pass=0;pass<4;pass++){
  const fresh=(await rows()).filter(row=>row.tty===owner.tty&&!row.state.startsWith('Z')&&!frozen.has(row.pid));
  if(!fresh.length)break;
  for(const row of fresh){signal(row.pid,'SIGSTOP');frozen.set(row.pid,row.started);}
 }
 const active=(await rows()).filter(row=>row.tty===owner.tty&&!row.state.startsWith('Z'));
 if(active.some(row=>frozen.get(row.pid)!==row.started))throw new Error('Terminal process tree did not quiesce.');
 for(const row of active.filter(row=>row.pid!==owner.pid))signal(row.pid,'SIGKILL');
 signal(owner.pid,'SIGKILL');
 for(let pass=0;pass<30;pass++){
  if(!(await rows()).some(row=>frozen.get(row.pid)===row.started&&!row.state.startsWith('Z')))return true;
  await new Promise<void>(resolve=>setTimeout(resolve,50));
 }
 throw new Error('Terminal process settlement unconfirmed.');
}

import {resolve} from 'node:path';
import type {ExecutionLease} from '../execution/host-environment.js';
import type {MethodContracts} from '../contracts/desktop-control/index.js';
import {explainPathBlock,isLikelyBinary} from '../context/context-security.js';
import {withInspection} from './inspection-lease.js';
import {inspectionPath} from './workspace-files.js';
type ChangedFile=MethodContracts['diff.list']['result']['items'][number];
const base=['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false','-c','protocol.allow=never'];
/** Fixed commands only, bounded output and owned process-tree cancellation. */
async function git(lease:ExecutionLease,args:string[],signal:AbortSignal,limit=131072,allowTruncation=false):Promise<{text:string;truncated:boolean}>{
 signal.throwIfAborted();lease.assertActive();
 const child=lease.processes.spawn('git',[...base,...args],{env:{...lease.processes.environment(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_PAGER:'cat',GIT_TERMINAL_PROMPT:'0',GIT_EDITOR:'true',GIT_ASKPASS:'true',SSH_ASKPASS:'true',LC_ALL:'C'}});
 let size=0,truncated=false,failed=false;const chunks:Buffer[]=[];
 const stop=()=>{void lease.processes.terminate(child,'SIGKILL').catch(()=>{failed=true;});};
 const timer=setTimeout(()=>{failed=true;stop();},8000);signal.addEventListener('abort',stop,{once:true});
 try{
  const code=await new Promise<number|null>((done,reject)=>{
   child.once('error',reject);child.once('close',done);
   child.stderr.on('data',()=>{});
   child.stdout.on('data',(data:Buffer)=>{const remaining=limit-size;if(remaining>0)chunks.push(data.subarray(0,remaining));size+=data.length;if(size>limit){truncated=true;stop();}});
  });
  signal.throwIfAborted();if(failed||truncated&&!allowTruncation||code!==0&&!truncated)throw new Error('Git inspection unavailable or exceeded its limit.');
  return{text:Buffer.concat(chunks).toString('utf8'),truncated};
 }finally{clearTimeout(timer);signal.removeEventListener('abort',stop);await lease.processes.terminate(child,'SIGKILL');}
}
async function config(lease:ExecutionLease,signal:AbortSignal):Promise<string[]>{
 // `--get-regexp` returns 1 for no filters. `--list` is bounded and its values never leave core.
 const {text}=await git(lease,['config','--local','--name-only','--list','-z'],signal);
 const names=new Set(text.split('\0').map(key=>/^filter\.(.+)\.(?:process|smudge|clean|required)$/u.exec(key)?.[1]).filter((key):key is string=>!!key));
 if(names.size>64)throw new Error('Too many Git filters.');
 return [...names].flatMap(name=>['-c',`filter.${name}.process=`,'-c',`filter.${name}.smudge=`,'-c',`filter.${name}.clean=`,'-c',`filter.${name}.required=false`]);
}
function visible(root:string,path:string):boolean{try{inspectionPath(path);return path!=='.'&&!explainPathBlock(root,resolve(root,path));}catch{return false;}}
async function listing(lease:ExecutionLease,root:string,settings:string[],signal:AbortSignal):Promise<MethodContracts['diff.list']['result']>{
 const items:ChangedFile[]=[];let truncated=false;
 for(const stage of ['staged','unstaged'] as const){
  const {text}=await git(lease,[...settings,'diff',...(stage==='staged'?['--cached']:[]),'--raw','-z','--no-abbrev','--no-ext-diff','--no-textconv','--ignore-submodules=all','-M','--'],signal);
  const parts=text.split('\0');
  for(let i=0;i<parts.length-1;){
   const header=parts[i++]!,match=/^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMDRCTU])\d*$/u.exec(header);if(!match)throw new Error('Unsupported Git status.');
   const first=parts[i++]!,renamed=['R','C'].includes(match[3]!),path=renamed?parts[i++]!:first,previousPath=renamed?first:null;
   if(!visible(root,path)||previousPath&&!visible(root,previousPath))continue;
   if(items.length===32){truncated=true;continue;}
   items.push({path,previousPath,stage,status:({A:'added',M:'modified',D:'deleted',R:'renamed',C:'copied',T:'type_changed',U:'conflicted'} as const)[match[3] as 'A'|'M'|'D'|'R'|'C'|'T'|'U'],binary:null,previewable:![match[1],match[2]].some(mode=>mode==='120000'||mode==='160000')});
  }
 }
 const untracked=await git(lease,['ls-files','--others','--exclude-standard','-z','--'],signal);
 for(const path of untracked.text.split('\0').filter(Boolean)){if(!visible(root,path))continue;if(items.length===32){truncated=true;continue;}items.push({path,previousPath:null,stage:'untracked',status:'added',binary:null,previewable:true});}
 return{items,truncated};
}
export async function inspectDiff<M extends 'diff.list'|'diff.patch'>(input:{homeDir:string;profileId:string},method:M,params:MethodContracts[M]['params'],signal:AbortSignal):Promise<MethodContracts[M]['result']>{
 return withInspection(input,params.target,signal,async(lease,root)=>{
  const top=await git(lease,['rev-parse','--show-toplevel'],signal);if(top.text.trimEnd()!==root)throw new Error('Target is not a repository root.');
  const settings=await config(lease,signal),changes=await listing(lease,root,settings,signal);
  if(method==='diff.list')return changes as MethodContracts[M]['result'];
  const patch=params as MethodContracts['diff.patch']['params'],entry=changes.items.find(item=>item.path===patch.path&&item.stage===patch.stage);
  if(!entry?.previewable)throw new Error('Patch unavailable. Refresh changes.');
  for(const path of [entry.path,entry.previousPath].filter((value):value is string=>value!==null)){
   const checked=await lease.files.resolvePath(resolve(root,path),{allowMissingLeaf:true,forbidSymlinks:true});if(!checked.ok)throw new Error('Patch path unavailable.');
  }
  if(entry.stage==='untracked'){
   const {bytes,size}=await lease.files.preview(resolve(root,entry.path)),binary=isLikelyBinary(bytes);
   return {path:entry.path,stage:entry.stage,binary,text:binary?null:bytes.toString('utf8'),truncated:size>bytes.length} as MethodContracts[M]['result'];
  }
  const output=await git(lease,[...settings,'diff',...(entry.stage==='staged'?['--cached']:[]),'--no-ext-diff','--no-textconv','--ignore-submodules=all','--no-color','-M','--',entry.path,...(entry.previousPath?[entry.previousPath]:[])],signal,16384,true);
  const binary=/^Binary files .* differ$/mu.test(output.text);
  return{path:entry.path,stage:entry.stage,binary,text:binary?null:output.text,truncated:output.truncated} as MethodContracts[M]['result'];
 });
}

import {resolve} from 'node:path';
import {explainPathBlock,isLikelyBinary} from '../context/context-security.js';
import type {MethodContracts} from '../contracts/desktop-control/index.js';
import {withInspection} from './inspection-lease.js';
export function inspectionPath(path:string):void{
 if(path!=='.'&&(!path||path.length>1024||path.startsWith('/')||path.includes('\\')||/[\x00-\x1f\x7f]/u.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git'||part==='.estacoda'||part==='.estacoda-worktrees')))throw new Error('Invalid workspace-relative path.');
}
export async function inspectFiles<M extends 'files.list'|'files.preview'>(input:{homeDir:string;profileId:string},method:M,params:MethodContracts[M]['params'],signal:AbortSignal):Promise<MethodContracts[M]['result']>{
 inspectionPath(params.path);
 return withInspection(input,params.target,signal,async(lease,root)=>{
  const path=resolve(root,params.path),checked=await lease.files.resolvePath(path,{allowDirectory:method==='files.list',forbidSymlinks:true});
  if(!checked.ok)throw new Error('File unavailable.');
  if(method==='files.preview'){
   const {bytes,size}=await lease.files.preview(checked.path),binary=isLikelyBinary(bytes);
   return {path:params.path,size,binary,text:binary?null:bytes.toString('utf8'),truncated:size>bytes.length} as MethodContracts[M]['result'];
  }
  const cursor=(params as MethodContracts['files.list']['params']).cursor;
  if(cursor)inspectionPath(cursor);
  const entries=(await lease.files.readdir(checked.path,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),items=[];
  let truncated=false;
  for(const entry of entries){
   signal.throwIfAborted();const child=params.path==='.'?entry.name:params.path+'/'+entry.name;
   try{inspectionPath(child);}catch{continue;}
   if(explainPathBlock(root,resolve(root,child))||cursor&&child<=cursor)continue;
   if(items.length===32){truncated=true;break;}
   items.push({path:child,name:entry.name,kind:entry.isSymbolicLink()?'symlink' as const:entry.isDirectory()?'directory' as const:entry.isFile()?'file' as const:'special' as const});
  }
  const again=await lease.files.resolvePath(path,{allowDirectory:true,forbidSymlinks:true});if(!again.ok)throw new Error('Directory changed.');
  return {items,truncated,...(truncated?{nextCursor:items.at(-1)!.path}:{})} as MethodContracts[M]['result'];
 });
}

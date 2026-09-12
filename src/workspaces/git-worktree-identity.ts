import {execFile} from 'node:child_process';
import {realpathSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {ManagedGitWorktreeTarget} from '../contracts/workspace.js';
import {checkStamp, stamp} from './copy-files.js';

/** Bounded asynchronous Git keeps cancellation and approval traffic responsive.
 * No shell, inherited Git overrides, network, hooks, pager or fsmonitor programs. */
export async function targetGit(root:string,args:string[],signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  let closed=false,finished=false,failure:Error|null=null,output='';
  const settle=()=>{if(closed&&finished){if(failure)reject(new Error('Git target operation failed. Inspect repository state before retrying.'));else resolve(output);}};
  const child=execFile('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false','-c','protocol.allow=never','-C',root,...args],{
   shell:false,encoding:'utf8',timeout:30_000,maxBuffer:2*1024*1024,signal,killSignal:'SIGKILL',
   env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'},
  },(error,stdout)=>{failure=error;output=stdout;finished=true;settle();});
  child.once('close',()=>{closed=true;settle();});
  child.stdin?.end();
 });
}
export async function repositoryIdentity(root:string,signal?:AbortSignal){
 const directoryStamp=stamp(root);
 const top=realpathSync((await targetGit(root,['rev-parse','--show-toplevel'],signal)).trim());
 if(top!==root)throw new Error('Select a repository root, not a subdirectory.');
 const commonDirectory=realpathSync((await targetGit(root,['rev-parse','--path-format=absolute','--git-common-dir'],signal)).trim());
 checkStamp(root,directoryStamp);
 return {commonDirectory,commonDirectoryStamp:stamp(commonDirectory)};
}
export async function verifyWorktreeIdentity(target:ManagedGitWorktreeTarget,signal?:AbortSignal):Promise<void>{
 const checkDirectories=()=>{
  checkStamp(target.workspace.canonicalPath,target.directoryStamp);
  checkStamp(target.source.identity.canonicalPath,target.sourceDirectoryStamp);
  checkStamp(target.repository.commonDirectory,target.repository.commonDirectoryStamp);
 };
 checkDirectories();
 const source=await repositoryIdentity(target.source.identity.canonicalPath,signal);
 const working=await repositoryIdentity(target.workspace.canonicalPath,signal);
 if(source.commonDirectory!==target.repository.commonDirectory||working.commonDirectory!==source.commonDirectory)throw new Error('Worktree repository identity changed.');
 const dotgit=lstatSync(join(target.workspace.canonicalPath,'.git'));
 if(!dotgit.isFile()||dotgit.isSymbolicLink())throw new Error('Managed worktree metadata changed.');
 const gitDirectory=realpathSync((await targetGit(target.workspace.canonicalPath,['rev-parse','--absolute-git-dir'],signal)).trim());
 if(gitDirectory!==target.gitDirectory)throw new Error('Worktree registration changed.');
 checkStamp(gitDirectory,target.gitDirectoryStamp);
 const entries=(await targetGit(target.source.identity.canonicalPath,['worktree','list','--porcelain','-z'],signal)).split('\0');
 if(!entries.includes(`worktree ${target.workspace.canonicalPath}`))throw new Error('Worktree is no longer registered.');
 checkDirectories();checkStamp(gitDirectory,target.gitDirectoryStamp);
}

export async function disabledGitFilters(root:string,signal?:AbortSignal):Promise<string[]>{
 const names=(await targetGit(root,['config','--null','--name-only','--list'],signal)).split('\0');
 const filters=new Set(names.filter(name=>/^filter\..+\.(?:process|smudge|clean|required)$/u.test(name)).map(name=>name.replace(/\.[^.]+$/u,'')));
 return [...filters].flatMap(name=>['-c',`${name}.process=`,'-c',`${name}.smudge=`,'-c',`${name}.clean=`,'-c',`${name}.required=false`]);
}

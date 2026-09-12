import {execFileSync} from 'node:child_process';
import {realpathSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {ManagedGitWorktreeTarget} from '../contracts/workspace.js';
import {checkStamp, stamp} from './copy-files.js';

/** No shell, inherited Git overrides, network, hooks, pager or fsmonitor programs. */
export function targetGit(root:string,args:string[]):string{
 try{return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false','-c','protocol.allow=never','-C',root,...args],{
  shell:false,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000,maxBuffer:2*1024*1024,
  env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C'},
 });}catch{throw new Error('Git target operation failed. Inspect repository state before retrying.');}
}
export function repositoryIdentity(root:string){
 stamp(root);
 const top=realpathSync(targetGit(root,['rev-parse','--show-toplevel']).trim());
 if(top!==root)throw new Error('Select a repository root, not a subdirectory.');
 const commonDirectory=realpathSync(targetGit(root,['rev-parse','--path-format=absolute','--git-common-dir']).trim());
 return {commonDirectory,commonDirectoryStamp:stamp(commonDirectory)};
}
export function verifyWorktreeIdentity(target:ManagedGitWorktreeTarget):void{
 checkStamp(target.workspace.canonicalPath,target.directoryStamp);
 checkStamp(target.source.identity.canonicalPath,target.sourceDirectoryStamp);
 checkStamp(target.repository.commonDirectory,target.repository.commonDirectoryStamp);
 const source=repositoryIdentity(target.source.identity.canonicalPath);
 const working=repositoryIdentity(target.workspace.canonicalPath);
 if(source.commonDirectory!==target.repository.commonDirectory||working.commonDirectory!==source.commonDirectory)throw new Error('Worktree repository identity changed.');
 const dotgit=lstatSync(join(target.workspace.canonicalPath,'.git'));
 if(!dotgit.isFile()||dotgit.isSymbolicLink())throw new Error('Managed worktree metadata changed.');
 const gitDirectory=realpathSync(targetGit(target.workspace.canonicalPath,['rev-parse','--absolute-git-dir']).trim());
 if(gitDirectory!==target.gitDirectory)throw new Error('Worktree registration changed.');
 checkStamp(gitDirectory,target.gitDirectoryStamp);
 const entries=targetGit(target.source.identity.canonicalPath,['worktree','list','--porcelain','-z']).split('\0');
 if(!entries.includes(`worktree ${target.workspace.canonicalPath}`))throw new Error('Worktree is no longer registered.');
}

export function disabledGitFilters(root:string):string[]{
 const names=targetGit(root,['config','--null','--name-only','--list']).split('\0');
 const filters=new Set(names.filter(name=>/^filter\..+\.(?:process|smudge|clean|required)$/u.test(name)).map(name=>name.replace(/\.[^.]+$/u,'')));
 return [...filters].flatMap(name=>['-c',`${name}.process=`,'-c',`${name}.smudge=`,'-c',`${name}.clean=`,'-c',`${name}.required=false`]);
}

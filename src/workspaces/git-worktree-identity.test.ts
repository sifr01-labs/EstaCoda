import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {targetGit} from './git-worktree-identity.js';
it('keeps control timers responsive during slow Git and cancels without returning raw errors',async()=>{
 const directory=await mkdtemp('/tmp/ec-slow-git-');
 try{
  // A deterministic local Git stand-in; no repository hooks or network are used.
  await writeFile(join(directory,'git'),`#!${process.execPath}\nsetTimeout(()=>process.stdout.write('finished'),2000);`,{mode:0o700});
  vi.stubEnv('PATH',directory+':'+process.env.PATH);
  const abort=new AbortController();let timerFired=false;
  const operation=targetGit(directory,['status'],abort.signal);
  const rejection=expect(operation).rejects.toThrow('Git target operation failed');
  await new Promise<void>(resolve=>setTimeout(()=>{timerFired=true;abort.abort();resolve();},30));
  await rejection;expect(timerFired).toBe(true);
  await expect(targetGit(directory,['status'],abort.signal)).rejects.toThrow();
 }finally{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});}
});

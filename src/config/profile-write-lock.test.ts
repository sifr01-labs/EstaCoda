import {mkdtemp,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {expect,it} from 'vitest';
import {withProfileWriteLock} from './profile-write-lock.js';
it('serializes overlapping writers and permits awaited reentrant writes',async()=>{
  const root=await mkdtemp('/tmp/ec-profile-lock-');const events:string[]=[];
  try{
    let start!:()=>void;const ready=new Promise<void>(r=>start=r);
    const first=withProfileWriteLock(root,async()=>{events.push('first');start();await delay(30);await withProfileWriteLock(root,async()=>{events.push('nested');});});
    await ready;const second=withProfileWriteLock(root,async()=>{events.push('second');});
    await Promise.all([first,second]);expect(events).toEqual(['first','nested','second']);
  }finally{await rm(root,{recursive:true,force:true});}
});
it('releases cross-process ownership when a writer dies',async()=>{
  const root=await mkdtemp('/tmp/ec-profile-lock-');
  const code="import {withProfileWriteLock} from './src/config/profile-write-lock.ts'; await withProfileWriteLock(process.argv[1], async()=>{process.stdout.write('locked\\n');await new Promise(()=>{setInterval(()=>{},1000)});});";
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,root],{stdio:['ignore','pipe','pipe']});
  try{
    await once(child.stdout!,'data');child.kill('SIGKILL');await once(child,'exit');
    expect(await withProfileWriteLock(root,async()=>42)).toBe(42);
  }finally{child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});

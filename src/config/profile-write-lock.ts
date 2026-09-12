import {AsyncLocalStorage} from 'node:async_hooks';
import {constants} from 'node:fs';
import {mkdir, open, lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDefaultSQLiteDatabase} from '../storage/factory.js';

const held = new AsyncLocalStorage<Map<string,{active:boolean}>>();
/** SQLite provides OS-released cross-process locks, including after process death. No credentials enter this database. */
export async function withProfileWriteLock<T>(profileRoot: string, work: () => Promise<T>): Promise<T> {
  const root=resolve(profileRoot);
  if (held.getStore()?.get(root)?.active) return work();
  await mkdir(root,{recursive:true,mode:0o700});
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Linked profile directories are not writable');
  const path=join(root,'.profile-write.sqlite');
  const file=await open(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try {if (!(await file.stat()).isFile()) throw new Error('Invalid profile lock');} finally {await file.close();}
  const db=openDefaultSQLiteDatabase({path,timeoutMs:0});
  let acquired=false;
  try {
    const deadline=performance.now()+5000;
    while (!acquired) {
      try {db.exec('BEGIN EXCLUSIVE');acquired=true;}
      catch(error) {if (!['SQLITE_BUSY','SQLITE_LOCKED'].includes(String((error as {code?:string}).code)) || performance.now()>=deadline) throw new Error('Profile is busy; retry the reviewed change');await delay(10);}
    }
    const lease={active:true};
    try {return await held.run(new Map([...(held.getStore()??[]),[root,lease]]),work);}
    finally {lease.active=false;}
  } finally {if(acquired)db.exec('ROLLBACK');db.close();}
}

/** Reads fail closed while an authorized multi-file commit requires completion. */
export async function assertProfileApplySettled(profileRoot: string): Promise<void> {
  try {await lstat(join(profileRoot,'.profile-apply.json'));}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  throw new Error('Profile apply requires recovery before execution');
}

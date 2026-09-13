import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ScheduleQueries} from './schedule-queries.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {CronExecutionStore} from '../cron/cron-execution-store.js';
import {resolveGlobalStateHome} from '../config/profile-home.js';
it('projects profile schedules and attributes early failures without exposing another profile or legacy unowned history',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'desktop-schedules-')),q=new ScheduleQueries({homeDir,profileId:'one'});let db:SQLiteSessionDB|undefined;
 try{await mkdir(q.paths.profileRoot,{recursive:true});const store=await q.store(),job=await store.create({prompt:'Summarize workspace',schedule:'every 1h'});expect((await q.list()).items[0]).toMatchObject({id:job.id,kind:'interval',runRequested:false});expect((await new ScheduleQueries({homeDir,profileId:'two'}).list()).items).toEqual([]);
 db=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir}).sessionsSqlitePath});const ours=new CronExecutionStore({db:db.db,profileId:'one'}),foreign=new CronExecutionStore({db:db.db,profileId:'two'}),legacy=new CronExecutionStore({db:db.db});const run=await ours.create({jobId:job.id});await ours.complete(run.id,{status:'failed',failureClass:'runtime_error',failureMessage:'private output'});await foreign.create({jobId:job.id});await legacy.create({jobId:job.id});
 await store.pause(job.id);expect((await q.get(job.id)).nextRunAt).toBeNull();
 const page=await q.history(job.id);expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({id:run.id,status:'failed',failure:'runtime_error',workId:null});expect(JSON.stringify(page)).not.toContain('private output');
 }finally{db?.close();await rm(homeDir,{recursive:true,force:true});}
});
it('rejects linked profile schedule state without repairing it',async()=>{const homeDir=await mkdtemp(join(tmpdir(),'desktop-schedules-')),q=new ScheduleQueries({homeDir,profileId:'one'});try{await mkdir(q.paths.cronPath,{recursive:true});const outside=join(homeDir,'outside.json');await writeFile(outside,'{"jobs":[]}');await symlink(outside,join(q.paths.cronPath,'jobs.json'));await expect(q.list()).rejects.toThrow();}finally{await rm(homeDir,{recursive:true,force:true});}});

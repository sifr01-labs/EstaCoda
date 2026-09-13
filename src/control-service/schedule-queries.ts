import {join,dirname} from 'node:path';
import {lstat} from 'node:fs/promises';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {CronStore,type CronJob} from '../cron/cron-store.js';
import {CronExecutionStore} from '../cron/cron-execution-store.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ControlProtocolError,type ScheduleProjection,type ScheduleExecutionProjection} from '../contracts/desktop-control/index.js';
import {readProfileFile} from './profile-attention.js';
import {boundedLibraryPage} from './library-queries.js';
import {safeText} from './work-projections.js';
export class ScheduleQueries{
 readonly paths;constructor(readonly input:{homeDir:string;profileId:string}){this.paths=resolveProfileStateHome(input);}
 async store(){const path=join(this.paths.cronPath,'jobs.json');const raw=await readProfileFile(this.paths.profileRoot,path);if(raw!==undefined){const value=JSON.parse(raw);if(!Array.isArray(value.jobs)||value.jobs.length>1000)throw new ControlProtocolError('-32009');}return new CronStore({path,outputRoot:join(this.paths.cronPath,'output')});}
 project(job:CronJob):ScheduleProjection{return{id:job.id,name:safeText(job.name,240),objective:safeText(job.prompt,4096),schedule:job.schedule,kind:job.scheduleKind,status:job.status,delivery:safeText(job.delivery,240),workspace:job.workdir?safeText(job.workdir,4096):null,model:job.modelOverride?{provider:job.modelOverride.provider??null,model:job.modelOverride.model}:null,nextRunAt:job.nextRunAt??null,lastRunAt:job.lastRunAt??null,lastStatus:job.lastStatus??null,runCount:job.runCount,runRequested:job.runRequested===true,script:!!job.script,channelBound:!!job.executionOrigin};}
 async list(offset=0){return boundedLibraryPage((await(await this.store()).list()).map(j=>this.project(j)),offset);}
 async get(id:string){const job=await(await this.store()).get(id);if(!job)throw new ControlProtocolError('-32004');return this.project(job);}
 async history(id:string,offset=0){
  await this.get(id);const path=resolveGlobalStateHome(this.input).sessionsSqlitePath;let db:SQLiteSessionDB|undefined;
  try{
   const parent=await lstat(dirname(path)),stat=await lstat(path);if(parent.isSymbolicLink()||!parent.isDirectory()||stat.isSymbolicLink()||!stat.isFile())throw new ControlProtocolError('-32003');
   db=new SQLiteSessionDB({path,readonly:true});const store=new CronExecutionStore({db:db.db,readonly:true});const rows=await store.listForProfile(this.input.profileId,id,offset);
   const items:ScheduleExecutionProjection[]=await Promise.all(rows.slice(0,50).map(async r=>({id:r.id,workId:r.sessionId&&await db!.getSessionForProfile(r.sessionId,this.input.profileId)?`session:${r.sessionId}`:null,startedAt:r.startedAt,completedAt:r.completedAt??null,status:r.status,failure:r.failureClass?safeText(r.failureClass,120):null,delivery:[...r.deliveryResults].slice(0,16).map(([destination,result])=>({destination:safeText(destination,240),success:result.success}))})));
   return{items,nextOffset:rows.length>50?offset+50:null,available:true};
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return{items:[],nextOffset:null,available:false};throw e;}finally{db?.close();}
 }
}

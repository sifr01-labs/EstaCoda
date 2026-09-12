import {constants,closeSync,fstatSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {isControlId,type WorkProjection} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
/** Presentation references only; every read resolves current canonical Work. */
export class WorkPins {
 constructor(readonly directory:string,readonly connection:Pick<DesktopConnection,'state'|'getWork'>){}
 private file(profile:string){return join(this.directory,'pins-'+createHash('sha256').update(profile).digest('hex')+'.json');}
 private read(profile:string):string[]{
  let fd:number|undefined;
  try{fd=openSync(this.file(profile),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>32768)return[];const data:unknown=JSON.parse(readFileSync(fd,'utf8'));return Array.isArray(data)&&data.length<=100&&data.every(isControlId)?[...new Set(data)]:[];}catch{return[];}finally{if(fd!==undefined)closeSync(fd);}
 }
 private fence(profile:string,generation:number){if(this.connection.state.profileId!==profile||this.connection.state.generation!==generation||this.connection.state.status!=='ready')throw new Error('Desktop context changed.');}
 async list():Promise<WorkProjection[]>{
  const {profileId,generation}=this.connection.state;
  this.fence(profileId,generation);
  const results:WorkProjection[]=[];
  for(const id of this.read(profileId)){try{const work=await this.connection.getWork(id);if(work.profileId===profileId)results.push(work);}catch{/* Deleted references remain removable by canonical id. */}this.fence(profileId,generation);}
  return results;
 }
 async set(id:string,pinned:boolean):Promise<WorkProjection[]>{
  const {profileId,generation}=this.connection.state;this.fence(profileId,generation);
  if(!isControlId(id))throw new Error('Invalid Work reference.');
  if(pinned){const work=await this.connection.getWork(id);this.fence(profileId,generation);if(work.profileId!==profileId||work.id!==id)throw new Error('Invalid Work reference.');}
  const ids=this.read(profileId).filter(value=>value!==id);if(pinned)ids.push(id);if(ids.length>100)throw new Error('Pin limit reached.');
  mkdirSync(this.directory,{recursive:true,mode:0o700});
  const temporary=join(this.directory,'pins-'+randomUUID()+'.tmp');writeFileSync(temporary,JSON.stringify(ids),{flag:'wx',mode:0o600});renameSync(temporary,this.file(profileId));
  return this.list();
 }
}

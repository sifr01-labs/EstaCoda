import {randomUUID,createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {validateControlRequest,CONTROL_METHODS,CONTROL_EVENTS,type MethodContracts} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
type Inspection=MethodContracts['operations.inspect']['params'];
/** Bounded reference-only journal. Canonical receipts remain with the execution owner. */
export class WorkOperationReferences {
 constructor(readonly connection:DesktopConnection,readonly directory:string){}
 file(){return join(this.directory,'work-operations-'+createHash('sha256').update(this.connection.state.profileId).digest('hex')+'.json');}
 records():Record<string,Inspection>{let fd:number|undefined;try{fd=openSync(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);if(!fstatSync(fd).isFile()||fstatSync(fd).size>131072)throw new Error('Invalid recovery state');const records:unknown=JSON.parse(readFileSync(fd,'utf8'));if(!records||typeof records!=='object'||Array.isArray(records)||Object.keys(records).length>100)throw new Error('Invalid recovery state');for(const value of Object.values(records))validateControlRequest({jsonrpc:'2.0',id:'inspect',method:'operations.inspect',params:value},{profileId:this.connection.state.profileId,instanceId:'main',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return records as Record<string,Inspection>;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{};throw error;}finally{if(fd!==undefined)closeSync(fd);}}
 write(records:Record<string,Inspection>){mkdirSync(this.directory,{recursive:true,mode:0o700});const temporary=join(this.directory,'work-operation-'+randomUUID()+'.tmp');writeFileSync(temporary,JSON.stringify(records),{flag:'wx',mode:0o600});renameSync(temporary,this.file());}
 save(workId:string,record:Inspection){const records=this.records();if(!records[workId]&&Object.keys(records).length>=100)throw new Error('Too many unresolved Work operations.');records[workId]=record;this.write(records);}
 async makeRoom(check:()=>void){
  if(Object.keys(this.records()).length<90)return;
  for(const [key,record] of Object.entries(this.records())){
   // Preparation is not the submission: retain its reference until the draft continues.
   if(record.method==='sessions.start'||record.method==='sessions.setModel'&&!key.startsWith('model:'))continue;
   const receipt=await this.connection.workRequest('operations.inspect',record);check();
   if(receipt.state==='completed'){const current=this.records();for(const [id,value]of Object.entries(current))if(value.operationId===record.operationId)delete current[id];this.write(current);}
   if(Object.keys(this.records()).length<80)return;
  }
 }

}

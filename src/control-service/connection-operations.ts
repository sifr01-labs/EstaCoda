import {randomUUID} from 'node:crypto';
import {open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {readProfileFile} from './profile-attention.js';
import {ControlProtocolError,CONNECTION_OPERATION_ISSUES,type ConnectionOperation,type ConnectionOperationIssue} from '../contracts/desktop-control/index.js';
/** Durable, reference-only receipts. An uncertain operation is never automatically replayed. */
export class ConnectionOperations {
 readonly root:string;readonly path:string;
 constructor(input:{homeDir:string;profileId:string}){this.root=resolveProfileStateHome(input).profileRoot;this.path=join(this.root,'.connection-operations.json');}
 private async read():Promise<ConnectionOperation[]>{const rows=JSON.parse(await readProfileFile(this.root,this.path)??'[]');if(!Array.isArray(rows)||rows.length>1000||rows.some(row=>typeof row.operationId!=='string'||typeof row.action!=='string'||!['completed','failed','uncertain'].includes(row.state)||row.issue!==undefined&&!CONNECTION_OPERATION_ISSUES.includes(row.issue)||row.phase!==undefined&&!['preparing','installing','verifying'].includes(row.phase)))throw new ControlProtocolError('-32003');return rows;}
 private async write(rows:ConnectionOperation[]){const temp=this.path+'.'+randomUUID();const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(rows));await file.sync();}finally{await file.close();}try{await rename(temp,this.path);const dir=await open(this.root,'r');try{await dir.sync();}finally{await dir.close();}}finally{await rm(temp,{force:true});}}
 async inspect(operationId:string):Promise<ConnectionOperation>{return(await this.read()).find(row=>row.operationId===operationId)??{operationId,action:'unknown',state:'unknown'};}
 async progress(operationId:string,phase:NonNullable<ConnectionOperation['phase']>):Promise<void>{
  await withProfileWriteLock(this.root,async()=>{const rows=await this.read(),row=rows.find(item=>item.operationId===operationId);if(row?.state==='uncertain'){row.phase=phase;await this.write(rows);}});
 }
 async execute(operationId:string,action:string,run:()=>Promise<boolean|{ok:boolean;issue?:ConnectionOperationIssue}>,accepted?:()=>void):Promise<ConnectionOperation>{
  const reserved=await withProfileWriteLock(this.root,async()=>{const rows=await this.read(),old=rows.find(row=>row.operationId===operationId);if(old){if(old.action!==action)throw new ControlProtocolError('-32602');return false;}if(rows.length>=1000)throw new ControlProtocolError('-32009');rows.push({operationId,action,state:'uncertain'});await this.write(rows);return true;});
  if(!reserved)return this.inspect(operationId);
  accepted?.();
  let state:ConnectionOperation['state']='uncertain',issue:ConnectionOperationIssue|undefined;try{const result=await run();state=(typeof result==='boolean'?result:result.ok)?'completed':'failed';if(typeof result!=='boolean'&&state==='failed'&&result.issue&&CONNECTION_OPERATION_ISSUES.includes(result.issue))issue=result.issue;}catch{/* The external effect may have occurred. Reconcile; never infer failure or repeat. */}
  await withProfileWriteLock(this.root,async()=>{const rows=await this.read(),row=rows.find(item=>item.operationId===operationId);if(!row)throw new ControlProtocolError('-32003');row.state=state;if(state!=='uncertain')delete row.phase;if(issue)row.issue=issue;await this.write(rows);});return this.inspect(operationId);
 }
}

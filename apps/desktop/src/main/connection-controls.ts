import {randomUUID,createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import type {ConnectionOperation,GatewayAction} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
/** Main creates operation identities; only reference metadata survives app restart. */
export class DesktopConnectionControls {
 #busy=false;
 constructor(readonly connection:DesktopConnection,readonly directory:string){}
 private file(){return join(this.directory,'connection-operation-'+createHash('sha256').update(this.connection.state.profileId).digest('hex')+'.json');}
 private reference():{operationId:string;action:string}|null{let fd:number|undefined;try{fd=openSync(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);if(!fstatSync(fd).isFile()||fstatSync(fd).size>4096)throw new Error('Invalid operation reference');const value=JSON.parse(readFileSync(fd,'utf8'));if(typeof value.operationId!=='string'||!/^[a-f0-9-]{36}$/.test(value.operationId)||typeof value.action!=='string'||value.action.length>80)throw new Error('Invalid operation reference');return value;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)closeSync(fd);}}
 async inspect(){const value=this.reference();return value?this.connection.connectionRequest('connections.inspectOperation',{operationId:value.operationId}):null;}
 async perform(action:string,run:(operationId:string)=>Promise<ConnectionOperation>){if(this.#busy)throw new Error('Operation is settling');this.#busy=true;try{const profileId=this.connection.state.profileId,generation=this.connection.state.generation,previous=this.reference();if(previous?.action===action){const receipt=await this.inspect();if(receipt?.state==='uncertain'||receipt?.state==='unknown')throw new Error('Reconcile the previous operation first');}if(profileId!==this.connection.state.profileId||generation!==this.connection.state.generation)throw new Error('Profile changed');const operationId=randomUUID();mkdirSync(this.directory,{recursive:true,mode:0o700});const temp=join(this.directory,'connection-'+randomUUID()+'.tmp');writeFileSync(temp,JSON.stringify({operationId,action}),{flag:'wx',mode:0o600});renameSync(temp,this.file());try{return await run(operationId);}catch{return{operationId,action,state:'uncertain' as const};}}finally{this.#busy=false;}}
 gateway(action:GatewayAction){return this.perform('gateway.'+action,operationId=>this.connection.connectionRequest('gateway.execute',{operationId,action,acknowledgeSharedWork:true}));}
}

import {join} from 'node:path';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {validateSessionWorkspaceOwnership} from '../session/session-workspace-ownership.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {FileHandoffStore} from '../channels/handoff-store.js';
import {FileSurfacePointerStore} from '../channels/surface-pointer-store.js';
import {readProfileFile} from './profile-attention.js';
import {ConnectionOperations} from './connection-operations.js';
import {safeText} from './work-projections.js';
import {ControlProtocolError,type TelegramSession,type TelegramSessionDetails} from '../contracts/desktop-control/index.js';
export class ChannelSessions {
 readonly paths;readonly handoffs;readonly pointers;readonly operations;
 constructor(readonly input:{homeDir:string;profileId:string}){this.paths=resolveProfileStateHome(input);this.handoffs=new FileHandoffStore({path:join(this.paths.gatewayStatePath,'handoff-codes.json')});this.pointers=new FileSurfacePointerStore({path:join(this.paths.gatewayStatePath,'surface-pointers.json')});this.operations=new ConnectionOperations(input);}
 private db(){return new SQLiteSessionDB({path:resolveGlobalStateHome(this.input).sessionsSqlitePath});}
 private async bounded(){await readProfileFile(this.paths.profileRoot,this.handoffs.path);await readProfileFile(this.paths.profileRoot,this.pointers.path);}
 async list():Promise<{items:TelegramSession[];truncated:boolean}>{
  await this.bounded();const raw=JSON.parse(await readProfileFile(this.paths.profileRoot,join(this.paths.gatewayStatePath,'channel-sessions.json'))??'{"entries":[]}');
  if(raw.profileId&&raw.profileId!==this.input.profileId||!Array.isArray(raw.entries))throw new ControlProtocolError('-32003');
  const pointers=(await this.pointers.listPointers()).filter(row=>row.surfaceType==='telegram');
  const ids=[...new Set<string>([...raw.entries.filter((row:{platform:string})=>row.platform==='telegram').map((row:{sessionId:string})=>row.sessionId),...pointers.map(row=>row.record.sessionId)])];
  const db=this.db(),items:TelegramSession[]=[];try{for(const id of ids.slice(0,100)){const session=await db.getSessionForProfile(id,this.input.profileId);if(session)items.push({sessionId:id,workId:'session:'+id,title:safeText(session.title??'Telegram conversation',240),attached:pointers.some(row=>row.record.sessionId===id)});}}finally{db.close();}
  return{items,truncated:ids.length>100};
 }
 async details(sessionId:string):Promise<TelegramSessionDetails>{await this.bounded();const db=this.db();try{if(!await db.getSessionForProfile(sessionId,this.input.profileId))throw new ControlProtocolError('-32003');}finally{db.close();}
  return{codes:(await this.handoffs.list()).filter(row=>row.sessionId===sessionId&&row.surfaceType==='telegram'&&!row.redeemed&&Date.parse(row.expiresAt)>Date.now()).slice(-10).map(row=>({code:row.code,expiresAt:Date.parse(row.expiresAt)})),attachments:(await this.pointers.listPointers()).filter(row=>row.surfaceType==='telegram'&&row.record.sessionId===sessionId).slice(0,100).map(row=>({id:row.surfaceId,attachedAt:Date.parse(row.record.attachedAt)||0}))};
 }
 async execute(params:{operationId:string;sessionId:string;action:'create'|'revoke'|'detach';attachmentId?:string}){
  await this.details(params.sessionId);const db=this.db();try{const session=await db.getSessionForProfile(params.sessionId,this.input.profileId);if(!session)throw new ControlProtocolError('-32003');if(params.action==='create'){
   const workspaceRoot=session.executionTarget?.workspace.canonicalPath;if(!workspaceRoot||session.endedAt||!await new WorkspaceTrustStore(this.input).isTrusted(workspaceRoot))throw new ControlProtocolError('-32003');
   await validateSessionWorkspaceOwnership({...this.input,session,workspaceRoot});
  }}finally{db.close();}
  return this.operations.execute(params.operationId,'handoff.'+params.action,async()=>{
   if(params.action==='create'){await this.handoffs.purgeExpired();if((await this.details(params.sessionId)).codes.length>=10)throw new ControlProtocolError('-32009');await this.handoffs.create({sessionId:params.sessionId,surfaceType:'telegram',ttlMinutes:10});}
   else if(params.action==='revoke')await this.handoffs.revokeSession(params.sessionId,'telegram');
   else{if(!params.attachmentId)throw new ControlProtocolError('-32602');return this.pointers.removePointerForSession('telegram',params.attachmentId,params.sessionId);}
   return true;
  });
 }
}

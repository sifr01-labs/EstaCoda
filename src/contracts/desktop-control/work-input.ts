/** Private credential-channel messages. Values must never use ordinary renderer RPC. */
export type WorkInputCommand = {action:'pending';holder:string}|{action:'claim'|'cancel';holder:string;requestId:string}|{action:'deliver';holder:string;requestId:string;value:string};
export type WorkInputRequest = {id:string;kind:string;origin:string;position:number;total:number;expiresAt:string};
export type WorkInputResult = {request:WorkInputRequest|null};
export function validateWorkInputCommand(value:unknown):asserts value is WorkInputCommand{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid protected request.');
 const v=value as Record<string,unknown>,keys=v.action==='pending'?['action','holder']:v.action==='deliver'?['action','holder','requestId','value']:['action','holder','requestId'];
 if(!['pending','claim','cancel','deliver'].includes(String(v.action))||Object.keys(v).sort().join()!==keys.sort().join()||!safe(v.holder)||(v.action!=='pending'&&!safe(v.requestId))||v.action==='deliver'&&(typeof v.value!=='string'||!v.value.length||v.value.length>16384))throw new Error('Invalid protected request.');
}
export function validateWorkInputResult(value:unknown):asserts value is WorkInputResult{
 if(!value||typeof value!=='object'||Object.keys(value).join()!=='request')throw new Error('Invalid protected response.');
 const r=(value as WorkInputResult).request;if(r===null)return;
 if(!r||Object.keys(r).sort().join()!=='expiresAt,id,kind,origin,position,total'||!safe(r.id)||!['account-identifier','password','one-time-code','api-key','client-secret','access-token','private-key','recovery-code','generic-secret'].includes(r.kind)||typeof r.origin!=='string'||r.origin.length>2048||!Number.isInteger(r.position)||!Number.isInteger(r.total)||r.position<1||r.total>8||r.position>r.total||!Number.isFinite(Date.parse(r.expiresAt)))throw new Error('Invalid protected response.');
 if(!/^https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::[0-9]+)?$/i.test(r.origin))throw new Error('Invalid protected origin.');
}
function safe(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value);}

import type {ActivityProjection} from '@estacoda/control-protocol';
import type {Draft} from './app.js';

/** Reconcile only new user records; history is redacted and may be truncated. */
export function pendingMessageRecorded(pending:Draft['pending'],items:ActivityProjection[]):boolean{
 if(!pending)return false;
 return items.some(item=>{
  if(item.kind!=='message'||item.role!=='user'||pending.knownIds.includes(item.id)||item.timestamp<pending.startedAt-1000)return false;
  if(!pending.text&&pending.attachments.some(file=>item.text.includes(file.name)))return true;
  if(item.text.includes(pending.matchText.slice(0,512)))return true;
  if(!item.text.includes('[REDACTED]'))return false;
  const projected=item.text.split('\n\nUser-selected attachments')[0]!.slice(0,512);
  const parts=projected.split('[REDACTED]');let offset=0;
  for(let index=0;index<parts.length;index++){
   const part=parts[index]!;if(!part)continue;
   const at=pending.matchText.indexOf(part,offset);
   if(at<0||index===0&&at!==0)return false;
   offset=at+part.length;
  }
  return true;
 });
}

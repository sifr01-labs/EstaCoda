import {constants,closeSync,fstatSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {emptyChatPresentation,validChatPresentation,type ChatPresentation} from '../shared/chat-presentation.js';
/** Profile-local desktop presentation. Saved targets never grant execution or trust. */
export class ChatPresentationStore{
 constructor(readonly directory:string,readonly profile:()=>string){}
 private file(id:string){return join(this.directory,'chats-'+createHash('sha256').update(id).digest('hex')+'.json');}
 private fence(id:string){if(id!==this.profile())throw new Error('Desktop profile changed.');}
 read(id:string):ChatPresentation{
  this.fence(id);let fd:number|undefined;
  try{fd=openSync(this.file(id),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>4_000_000)throw new Error('Invalid chat presentation');const value:unknown=JSON.parse(readFileSync(fd,'utf8'));if(!validChatPresentation(value))throw new Error('Invalid chat presentation');return value;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return emptyChatPresentation();throw new Error('Saved chats could not be read.');}finally{if(fd!==undefined)closeSync(fd);}
 }
 write(id:string,value:unknown){this.fence(id);if(!validChatPresentation(value))throw new Error('Invalid chat presentation');mkdirSync(this.directory,{recursive:true,mode:0o700});const temporary=join(this.directory,'chats-'+randomUUID()+'.tmp');try{writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});renameSync(temporary,this.file(id));}finally{try{unlinkSync(temporary);}catch{}}}
}

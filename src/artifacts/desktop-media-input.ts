import {constants} from 'node:fs';
import {open,mkdir,writeFile,readFile,readdir,rm,lstat} from 'node:fs/promises';
import {join,basename,extname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {resolveProfileStateHome,resolveGlobalStateHome} from '../config/profile-home.js';
import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {resolveVisionImageSource} from '../vision/image-source-resolver.js';
import type {ChannelAttachment} from '../contracts/channel.js';
import type {TargetReference} from '../contracts/desktop-control/index.js';
type Binding={sessionId:string;operationId:string;targetId:string;targetGeneration?:number};
type Row={id:string;name:string;size:number;type:string;hash:string;target:TargetReference;expiresAt:number;binding?:Binding};
/** Core-owned, bounded user media snapshots. References never authorize another profile or target. */
export class DesktopMediaInput {
 readonly root:string;
 constructor(readonly input:{homeDir:string;profileId:string}){this.root=join(resolveProfileStateHome(input).channelMediaPath,'desktop-input');}
 private path(id:string,suffix:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid media reference');return join(this.root,id+suffix);}
 private async ensureRoot(create=false){const global=resolveGlobalStateHome(this.input),profile=resolveProfileStateHome(this.input);for(const path of [global.stateRoot,global.profilesRoot,profile.profileRoot,profile.channelMediaPath,this.root]){if(create)await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid media directory');}}
 private async row(id:string):Promise<Row>{await this.ensureRoot();const file=await open(this.path(id,'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await file.stat();if(!st.isFile()||st.size>4096)throw new Error('Invalid media record');const row=JSON.parse((await boundedRead(file,4096)).toString('utf8'));if(row.id!==id||!Number.isSafeInteger(row.size)||row.size<1||row.size>8*1024*1024||row.expiresAt<Date.now())throw new Error('Media expired');return row;}finally{await file.close();}}
 async stage(path:string,target:TargetReference){
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes:Buffer;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>8*1024*1024)throw new Error('Media must be a regular file up to 8 MB');bytes=Buffer.alloc(stat.size+1);let size=0;while(size<bytes.length){const r=await handle.read(bytes,size,bytes.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}if(size!==stat.size)throw new Error('Media changed');bytes=bytes.subarray(0,size);}finally{await handle.close();}
  await this.ensureRoot(true);
  return withProfileWriteLock(this.root,async()=>{
   const files=await readdir(this.root);let count=0;for(const name of files.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const id=name.slice(0,-5);try{await this.row(id);count++;}catch{await rm(this.path(id,'.json'),{force:true});await rm(this.path(id,'.bin'),{force:true});await rm(this.path(id,'.wav'),{force:true});}}
   if(count>=64)throw new Error('Media staging is full');const audio=extname(path).toLowerCase()==='.wav'&&bytes.length>=44&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE'&&bytes.subarray(12,16).toString()==='fmt '&&bytes.readUInt16LE(20)===1&&bytes.readUInt16LE(22)===1&&bytes.readUInt32LE(24)===16000&&bytes.readUInt16LE(34)===16&&bytes.subarray(36,40).toString()==='data'&&bytes.readUInt32LE(40)===bytes.length-44;const id=randomUUID(),dest=this.path(id,audio?'.wav':'.bin');await writeFile(dest,bytes,{flag:'wx',mode:0o600});
   try{const image=audio?{ok:true as const,mimeType:'audio/wav'}:await resolveVisionImageSource({workspaceRoot:this.root,path:dest,maxBytes:8*1024*1024});if(!image.ok)throw new Error('Choose a supported PNG JPEG GIF or WebP image');
    const row:Row={id,name:basename(path).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200),size:bytes.length,type:image.mimeType,hash:createHash('sha256').update(bytes).digest('hex'),target,expiresAt:Date.now()+15*60_000};await writeFile(this.path(id,'.json'),JSON.stringify(row),{flag:'wx',mode:0o600});return {id,name:row.name,size:row.size,type:row.type};
   }catch(error){await rm(dest,{force:true});throw error;}
  });
 }
 async claim(ids:string[],binding:Binding){await this.ensureRoot();return withProfileWriteLock(this.root,async()=>{const rows=await Promise.all(ids.map(id=>this.row(id)));for(const row of rows){if(row.target.targetId!==binding.targetId||row.target.targetGeneration!==binding.targetGeneration||row.binding&&JSON.stringify(row.binding)!==JSON.stringify(binding))throw new Error('Media belongs to another submission');}for(const row of rows){row.binding=binding;row.expiresAt=Date.now()+24*60*60_000;const file=await open(this.path(row.id,'.json'),constants.O_WRONLY|constants.O_NOFOLLOW);try{await file.truncate(0);await file.writeFile(JSON.stringify(row));}finally{await file.close();}}});}
 async resolve(ids:string[],binding:Binding):Promise<ChannelAttachment[]>{const items=[];for(const id of ids){const row=await this.row(id);if(JSON.stringify(row.binding)!==JSON.stringify(binding))throw new Error('Media binding changed');const path=this.path(id,row.type==='audio/wav'?'.wav':'.bin'),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let data:Buffer;try{if((await file.stat()).size!==row.size)throw new Error('Media changed');data=await boundedRead(file,row.size);}finally{await file.close();}if(data.length!==row.size||createHash('sha256').update(data).digest('hex')!==row.hash)throw new Error('Media integrity failed');items.push({id,kind:row.type==='audio/wav'?'audio' as const:'image' as const,status:'ready' as const,mimeType:row.type,localPath:path,name:row.name,bytes:row.size});}return items;}
}

async function boundedRead(file:import('node:fs/promises').FileHandle,max:number){const bytes=Buffer.alloc(max+1);let size=0;while(size<bytes.length){const r=await file.read(bytes,size,bytes.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}if(size>max)throw new Error('Media size limit');return bytes.subarray(0,size);}

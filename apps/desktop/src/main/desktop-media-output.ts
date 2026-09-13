import {createHash,randomUUID} from 'node:crypto';import {writeFile,rename,rm} from 'node:fs/promises';
import type {ArtifactReference} from '@estacoda/control-protocol';import type {DesktopConnection} from './connection.js';
export async function readDesktopMedia(connection:DesktopConnection,reference:ArtifactReference){
 const generation=connection.state.generation,profile=connection.state.profileId;const check=()=>{if(generation!==connection.state.generation||profile!==connection.state.profileId||connection.state.status!=='ready')throw new Error('Media context changed');};
 const meta=await connection.inspectionRequest('artifacts.mediaBegin',{reference});
 try{check();const parts:Buffer[]=[];let offset=0;while(offset<meta.bytes){const part=await connection.inspectionRequest('artifacts.mediaChunk',{transferId:meta.transferId,offset});check();const bytes=Buffer.from(part.data,'base64');if(!bytes.length||bytes.length>24576||offset+bytes.length>meta.bytes)throw new Error('Invalid media frame');parts.push(bytes);offset+=bytes.length;}
 const content=Buffer.concat(parts);if(createHash('sha256').update(content).digest('hex')!==meta.sha256)throw new Error('Media integrity failed');return{meta,content,check};
 }finally{await connection.inspectionRequest('artifacts.mediaClose',{transferId:meta.transferId}).catch(()=>{});}
}
export async function saveDesktopMedia(path:string,content:Buffer){const temporary=path+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,content,{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}}

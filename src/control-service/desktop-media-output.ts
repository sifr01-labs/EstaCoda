import {randomUUID} from 'node:crypto';
import {captureArtifactMedia} from './artifacts.js';
import type {ArtifactReference} from '../contracts/desktop-control/index.js';
/** One bridge owns short-lived immutable transfer snapshots. Frames stay below protocol limits. */
export class DesktopMediaOutput {
 readonly transfers=new Map<string,{content:Buffer;expires:number}>();
 constructor(readonly input:{homeDir:string;profileId:string}){}
 async begin(reference:ArtifactReference){for(const [id,row] of this.transfers)if(row.expires<Date.now())this.transfers.delete(id);if(this.transfers.size>=4)throw new Error('Media transfers full');const {artifact,content}=await captureArtifactMedia(this.input,reference);if(this.transfers.size>=4)throw new Error('Media transfers full');const transferId=randomUUID();this.transfers.set(transferId,{content,expires:Date.now()+60000});return{transferId,bytes:content.length,mimeType:artifact.mimeType,sha256:artifact.sha256,name:artifact.displayName};}
 chunk(transferId:string,offset:number){const row=this.transfers.get(transferId);if(!row||row.expires<Date.now()||!Number.isSafeInteger(offset)||offset<0||offset>row.content.length)throw new Error('Media transfer expired');return{data:row.content.subarray(offset,offset+24576).toString('base64')};}
 close(transferId:string){return{closed:this.transfers.delete(transferId)};}
 dispose(){this.transfers.clear();}
}

import {useEffect,useState} from 'react';
import type {ArtifactProjection} from '@estacoda/control-protocol';
import type {DesktopApi} from '../../shared/desktop-api.js';
import {imageKey,sameReference,type ImageOutput} from '../image-activity.js';

type ImageState={key:string;url:string;artifact?:ArtifactProjection;state:'loading'|'ready'|'unavailable'};
/** Decode only verified retained raster bytes. Each effect owns and revokes its own URL. */
export function useRetainedImage(api:DesktopApi|undefined,item:ImageOutput|undefined,enabled:boolean,retry:number,scopeVersion:number){
 const mime=item?.mimeType,key=item?JSON.stringify([imageKey(item),mime,retry,scopeVersion]):'';
 const [result,setResult]=useState<ImageState>();
 useEffect(()=>{
  if(!enabled||!item||!api?.artifacts?.media)return;
  let current=true,url='';
  setResult({key,url:'',state:'loading'});
  void(async()=>{
   try{
    const preview=await api.artifacts!.open(item.reference);
    if(!current)return;
    if(preview.integrity!=='verified'||preview.artifact.retention!=='retained'||!sameReference(preview.artifact.reference,item.reference)||preview.artifact.mimeType!==mime)throw new Error('Image unavailable');
    const media=await api.artifacts!.media!(item.reference);
    if(!current)return;
    if(media.mimeType!==mime)throw new Error('Image type changed');
    const bytes=Uint8Array.from(atob(media.data),char=>char.charCodeAt(0));
    url=URL.createObjectURL(new Blob([bytes],{type:media.mimeType}));
    setResult({key,url,artifact:preview.artifact,state:'ready'});
   }catch{if(current)setResult({key,url:'',state:'unavailable'});}
  })();
  return()=>{current=false;if(url)URL.revokeObjectURL(url);};
 },[api,key,mime,enabled,retry]);
 return enabled&&result?.key===key?result:undefined;
}

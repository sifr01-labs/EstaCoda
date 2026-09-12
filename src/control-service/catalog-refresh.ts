import {refreshModelsDevSnapshot} from '../model-catalog/models-dev-registry.js';
/** Explicit public metadata refresh: no provider credential, prompt, or model execution. */
export async function refreshDesktopCatalog(homeDir:string,signal:AbortSignal):Promise<{refreshed:boolean}>{
 const snapshot=await refreshModelsDevSnapshot({homeDir,allowNetwork:true,fetchTimeoutMs:8000,fetchImpl:async(url,init)=>{
  if(url!=='https://models.dev/api.json')throw new Error('Invalid catalog source');
  const response=await fetch(url,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
  return {ok:response.ok,status:response.status,statusText:'',text:async()=>'',json:async()=>{
   if(!response.body)throw new Error('Empty catalog');const reader=response.body.getReader();let total=0;const chunks:Uint8Array[]=[];
   try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>16*1024*1024)throw new Error('Catalog limit');chunks.push(part.value);}}finally{await reader.cancel();}
   signal.throwIfAborted();return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }};
 }});return {refreshed:Boolean(snapshot)};
}

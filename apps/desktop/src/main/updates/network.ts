const hosts=new Set(['github.com','release-assets.githubusercontent.com']);
export function allowedReleaseUrl(value:string):URL{
 const url=new URL(value);if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!hosts.has(url.hostname))throw Error('Untrusted release destination');return url;
}
/** Main-owned transport: no cookies, credentials or profile/work metadata. */
export async function releaseResponse(url:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<Response>{
 let next=allowedReleaseUrl(url);
 for(let redirect=0;redirect<=4;redirect++){
  const response=await fetcher(next,{method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'application/octet-stream'},signal});
  if([301,302,303,307,308].includes(response.status)){
   await response.body?.cancel();const location=response.headers.get('location');if(!location)throw Error('Invalid release redirect');next=allowedReleaseUrl(new URL(location,next).href);continue;
  }
  if(response.status!==200){await response.body?.cancel();throw Error('Release download unavailable');}
  return response;
 }
 throw Error('Too many release redirects');
}
export async function readBounded(response:Response,limit:number):Promise<Uint8Array>{
 if(!response.body)throw Error('Missing release body');
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){await response.body.cancel();throw Error('Release exceeds limit');}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit)throw Error('Release exceeds limit');chunks.push(value);}}catch(error){await reader.cancel();throw error;}
 return Buffer.concat(chunks,total);
}

import {open,mkdir,lstat,rename,rm,statfs} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {releaseResponse} from './network.js';
import type {DesktopRelease} from './release-feed.js';
export type ArchiveVerifier=(path:string,release:DesktopRelease,signal:AbortSignal)=>Promise<void>;
export async function verifyArchiveBytes(path:string,release:DesktopRelease,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==release.updater.bytes)throw Error('verification_failed');
 const hash=createHash('sha256');let bytes=0;
 for await(const chunk of createReadStream(path,{signal})){bytes+=chunk.length;if(bytes>release.updater.bytes)throw Error('verification_failed');hash.update(chunk);}
 if(bytes!==release.updater.bytes||hash.digest('hex')!==release.updater.sha256)throw Error('verification_failed');
}
/** No extraction/execution. Platform authentication is mandatory and supplied by the
 * accepted updater adapter, never by a renderer flag or release metadata alone. */
export async function stageDownload(input:{directory:string;release:DesktopRelease;signal:AbortSignal;verify:ArchiveVerifier;progress:(percent:number)=>void;fetcher?:typeof fetch}):Promise<string>{
 const {directory,release,signal}=input;
 await mkdir(directory,{recursive:true,mode:0o700});const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('verification_failed');
 const space=await statfs(directory,{bigint:true});if(space.bavail*space.bsize<BigInt(release.updater.bytes)*3n+128n*1024n*1024n)throw Error('insufficient_space');
 const temporary=join(directory,randomUUID()+'.partial'),target=join(directory,release.updater.sha256+'.zip');
 let handle:Awaited<ReturnType<typeof open>>|undefined;
 try{
  signal.throwIfAborted();const response=await releaseResponse(release.updater.url,signal,input.fetcher);
  const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)!==release.updater.bytes)){await response.body?.cancel();throw Error('verification_failed');}
  if(!response.body)throw Error('download_failed');
  const reader=response.body.getReader();let total=0;
  try{
   handle=await open(temporary,'wx',0o600);
   for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>release.updater.bytes)throw Error('verification_failed');let offset=0;while(offset<value.length){const result=await handle.write(value,offset,value.length-offset);if(!result.bytesWritten)throw Error('download_failed');offset+=result.bytesWritten;}input.progress(Math.floor(total/release.updater.bytes*100));}
   await handle.sync();await handle.close();handle=undefined;
  }finally{await reader.cancel().catch(()=>{});}
  await verifyArchiveBytes(temporary,release,signal);await input.verify(temporary,release,signal);
  // Verify again after the native verifier returns and immediately before promotion.
  await verifyArchiveBytes(temporary,release,signal);signal.throwIfAborted();await rename(temporary,target);return target;
 }finally{await handle?.close();await rm(temporary,{force:true});}
}

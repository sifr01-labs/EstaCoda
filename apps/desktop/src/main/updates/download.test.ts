import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stageDownload,verifyArchiveBytes} from './download.js';
import type {DesktopRelease} from './release-feed.js';
it('stages only complete authenticated bytes, rejects later tampering and cleans failures',async()=>{
 const directory=mkdtempSync('/tmp/ec-download-'),body='synthetic package';const release={updater:{url:'https://github.com/sifr01-labs/EstaCoda/releases/download/desktop-v1.0.0/EstaCoda-1.0.0-darwin-arm64.zip',bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}} as DesktopRelease;
 let verified=0;const base={directory,release,signal:new AbortController().signal,progress:()=>{},fetcher:(async()=>new Response(body)) as typeof fetch,verify:async(path:string)=>{expect(readFileSync(path,'utf8')).toBe(body);verified++;}};
 try{
 const path=await stageDownload(base);expect(verified).toBe(1);await verifyArchiveBytes(path,release,base.signal);writeFileSync(path,'tampered');await expect(verifyArchiveBytes(path,release,base.signal)).rejects.toThrow();
 await expect(stageDownload({...base,fetcher:(async()=>new Response('truncated')) as typeof fetch})).rejects.toThrow('verification_failed');expect(verified).toBe(1);
 await expect(stageDownload({...base,verify:async()=>{throw Error('wrong publisher');}})).rejects.toThrow('wrong publisher');
 await expect(stageDownload({...base,signal:AbortSignal.abort()})).rejects.toThrow();expect(readdirSync(directory).filter(name=>name.endsWith('.partial'))).toEqual([]);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

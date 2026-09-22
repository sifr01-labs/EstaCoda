import {it,expect,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifiedRelease,type DesktopRelease} from './release-feed.js';
import {UpdateDiscovery} from './discovery.js';
export const signing=generateKeyPairSync('ed25519'),publicKey=signing.publicKey.export({type:'spki',format:'pem'}).toString(),now=1800000000000;
export function fixture(version='1.2.0'):DesktopRelease {const asset=(extension:string)=>({url:`https://github.com/sifr01-labs/EstaCoda/releases/download/desktop-v${version}/EstaCoda-${version}-darwin-arm64.${extension}`,bytes:100,sha256:'a'.repeat(64)});return{format:1,version,coreVersion:'1.0.0',channel:'stable',sourceRevision:'a'.repeat(40),platform:'darwin',arch:'arm64',minimumOs:'14.0.0',protocol:{min:1,max:1},schema:{min:36,max:36},issuedAt:now-1000,expiresAt:now+60000,teamId:'ABCDEFGHIJ',notesUrl:`https://github.com/sifr01-labs/EstaCoda/releases/tag/desktop-v${version}`,installer:asset('dmg'),updater:asset('zip')};}
export function envelope(record:unknown):Uint8Array {const bytes=Buffer.from(JSON.stringify(record));return Buffer.from(JSON.stringify({payload:bytes.toString('base64'),signature:sign(null,bytes,signing.privateKey).toString('base64')}));}
it('requires authenticated fresh metadata and exact immutable asset destinations',()=>{
 const input={publicKey,teamId:'ABCDEFGHIJ',now};expect(verifiedRelease(envelope(fixture()),input).version).toBe('1.2.0');
 for(const change of [{expiresAt:now},{teamId:'OTHERTEAM0'},{channel:'preview'},{updater:{...fixture().updater,url:'https://evil.test/app.zip'}},{schema:{min:37,max:36}}])expect(()=>verifiedRelease(envelope({...fixture(),...change}),input)).toThrow();
 const changed=JSON.parse(Buffer.from(envelope(fixture())).toString());changed.payload=Buffer.from(JSON.stringify(fixture('9.0.0'))).toString('base64');expect(()=>verifiedRelease(Buffer.from(JSON.stringify(changed)),input)).toThrow();
});
it('deduplicates and bounds checks, never downloads implicitly, and preserves check failures',async()=>{
 let calls=0,clock=now;const options={version:'1.0.0',platform:'darwin',arch:'arm64',os:'15.0.0',protocol:1,schema:36,publicKey,teamId:'ABCDEFGHIJ',installation:()=>({ownership:'unverified' as const,canReplace:false}),now:()=>clock,fetcher:(async()=>{calls++;return new Response(Buffer.from(envelope(fixture())).toString());}) as typeof fetch};
 const discovery=new UpdateDiscovery(options);expect(calls).toBe(0);await Promise.all([discovery.check(),discovery.check()]);expect(calls).toBe(1);expect(discovery.status().phase).toBe('available');await discovery.check();expect(calls).toBe(1);
 clock+=31000;await discovery.check();expect(calls).toBe(2);
 const disabled=new UpdateDiscovery({...options,publicKey:null});await disabled.check();expect(calls).toBe(2);expect(disabled.status().phase).toBe('disabled');
 const failure=new UpdateDiscovery({...options,fetcher:(async()=>new Response('',{status:503})) as typeof fetch});expect((await failure.check()).problem).toBe('check_failed');
});

it('runs automatic checks only after opt-in and stops them when disabled',async()=>{
 vi.useFakeTimers();try{let calls=0;const d=new UpdateDiscovery({version:'1.0.0',platform:'darwin',arch:'arm64',os:'15.0.0',protocol:1,schema:36,publicKey,teamId:'ABCDEFGHIJ',now:()=>now,installation:()=>({ownership:'unverified',canReplace:false}),fetcher:(async()=>{calls++;return new Response('',{status:503});}) as typeof fetch});
 await vi.advanceTimersByTimeAsync(60000);expect(calls).toBe(0);d.preferences(true);await vi.advanceTimersByTimeAsync(60000);expect(calls).toBe(1);d.preferences(false);await vi.advanceTimersByTimeAsync(24*3600000);expect(calls).toBe(1);d.dispose();}finally{vi.useRealTimers();}
});

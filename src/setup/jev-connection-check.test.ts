import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveProfileStateHome,resolveGlobalStateHome} from '../config/profile-home.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {checkJevConnection} from './jev-connection-check.js';
import {PublicSettings} from '../control-service/public-settings.js';
import {CredentialCandidates} from '../control-service/credential-candidates.js';
let homeDir:string;
const profileId='p';
let fetcher:ReturnType<typeof vi.fn<typeof fetch>>;
const reply=()=>new Response(JSON.stringify({model:'jev-1.13.0',answers:{connection:{type:'noul',noul:.95}},usage:{input_tokens:20,output_tokens:0}}));
const paths=()=>resolveProfileStateHome({homeDir,profileId});
const save=async(mode='jev-assisted')=>writeFile(paths().configPath,JSON.stringify({routing:{mode}}));
const check=(signal?:AbortSignal)=>checkJevConnection({homeDir,profileId,spendApproved:true,signal,fetch:fetcher});
beforeEach(async()=>{homeDir=await mkdtemp(join(tmpdir(),'jev-check-'));await mkdir(paths().profileRoot,{recursive:true});await save();await writeFile(paths().envPath,'TYPESAFE_API_KEY=fixture-secret\n');fetcher=vi.fn(async()=>reply());});
afterEach(async()=>{vi.unstubAllGlobals();await rm(homeDir,{recursive:true,force:true});});
it('checks only fixed synthetic context and accounts selected-profile usage without changing configuration',async()=>{
 const before=await readFile(paths().configPath,'utf8');expect(await check()).toEqual({state:'ready',model:'jev-1.13.0'});
 expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone');
 const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body));expect(body.state.userRequest).toBe('Say hello.');expect(JSON.stringify(body)).not.toContain('fixture-secret');
 expect(await readFile(paths().configPath,'utf8')).toBe(before);
 const db=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir}).sessionsSqlitePath});try{const entries=await db.listProviderUsageEntries(profileId);expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({profileId,sourceKind:'auxiliary',auxiliaryKind:'routing'});expect(await db.listProviderUsageEntries('other')).toEqual([]);}finally{db.close();}
});
it('does not send checks in Standard mode or without explicit spend consent',async()=>{
 await save('standard');expect(await check()).toEqual({state:'disabled'});expect(fetcher).not.toHaveBeenCalled();
 await expect(checkJevConnection({homeDir,profileId,spendApproved:false as never,fetch:fetcher})).rejects.toThrow('explicit approval');expect(fetcher).not.toHaveBeenCalled();
});
it.each([[401,'authentication'],[429,'rate-limited'],[503,'service-error']] as const)('reports safe failure %i',async(status,reason)=>{fetcher.mockResolvedValue(new Response('private secret user content',{status}));expect(await check()).toEqual({state:'failed',reason});});
it('requires selected-profile credentials and accepts repaired saved credentials',async()=>{
 await writeFile(paths().envPath,'');const other=resolveProfileStateHome({homeDir,profileId:'other'});await mkdir(other.profileRoot,{recursive:true});await writeFile(other.envPath,'TYPESAFE_API_KEY=other-secret\n');
 expect(await check()).toEqual({state:'failed',reason:'credentials-unavailable'});expect(fetcher).not.toHaveBeenCalled();
 await writeFile(paths().envPath,'TYPESAFE_API_KEY=repaired-fixture\n');expect(await check()).toMatchObject({state:'ready'});expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({Authorization:'Bearer repaired-fixture'});
});
it('rejects stale success when saved mode changes during the check',async()=>{fetcher.mockImplementation(async()=>{await save('standard');return reply();});expect(await check()).toEqual({state:'failed',reason:'stale'});expect(await check()).toEqual({state:'disabled'});expect(fetcher).toHaveBeenCalledTimes(1);});
it('rejects stale success when credentials change during the check',async()=>{fetcher.mockImplementation(async()=>{await writeFile(paths().envPath,'TYPESAFE_API_KEY=new-fixture\n');return reply();});expect(await check()).toEqual({state:'failed',reason:'stale'});});
it('does not dispatch cancelled checks and rejects malformed responses',async()=>{const abort=new AbortController();abort.abort();expect(await check(abort.signal)).toEqual({state:'failed',reason:'cancelled'});expect(fetcher).not.toHaveBeenCalled();fetcher.mockResolvedValue(new Response('{}'));expect(await check()).toEqual({state:'failed',reason:'invalid-response'});});
it('keeps default settings verification offline, requires consent, aborts on disposal and prevents parallel checks',async()=>{
 const candidates=new CredentialCandidates(profileId,'instance'),owner=new PublicSettings({homeDir,profileId},candidates);
 let started!:()=>void;const dispatch=new Promise<void>(r=>started=r);
 fetcher.mockImplementation(async(_url,init)=>{started();return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true}));});vi.stubGlobal('fetch',fetcher);
 try{await owner.verify();expect(fetcher).not.toHaveBeenCalled();await expect(owner.verify({routing:true})).rejects.toThrow();
 const pending=owner.verify({routing:true,spendApproved:true});await dispatch;await expect(owner.verify({routing:true,spendApproved:true})).rejects.toThrow();owner.dispose();expect((await pending).routing).toEqual({state:'failed',reason:'cancelled'});
 }finally{owner.dispose();candidates.dispose();}
});

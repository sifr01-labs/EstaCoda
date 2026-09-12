import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {it,expect} from 'vitest';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import type {ProviderUsageEntry} from '../contracts/provider-usage.js';
import {workUsage} from './work-usage.js';
import {workCounts} from './work-counts.js';
import {sessionWork} from './work-projections.js';
it('reads canonical reported cost and context, preserves unknown values and isolates profiles',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-work-usage-'),path=resolveGlobalStateHome({homeDir}).sessionsSqlitePath;await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path});
 try{const session=await db.createSession({id:'s',profileId:'p'}),work=sessionWork(session,[],false);const input={homeDir,profileId:'p'},signal=new AbortController().signal;
 expect(await workUsage(input,work,signal)).toMatchObject({reportedTokens:null,cost:null,context:null});
 await db.appendMessage({id:'turn',sessionId:'s',role:'user',content:'Work'});
 const entry:ProviderUsageEntry={id:'usage',profileId:'p',sessionId:'s',visibleTurnId:'turn',requestKey:'request',provider:'local',model:'model',routeRole:'primary',routeIndex:0,providerAttemptIndex:0,sourceKind:'main',pricing:{currency:'USD',fingerprint:'pricing'},pricingFingerprint:'pricing',inputTokens:100,outputTokens:20,totalTokens:120,reasoningTokens:0,cacheReadTokens:0,cacheWriteTokens:0,estimatedCostUsd:0.25,usageComplete:true,pricingComplete:true,incompleteReasons:[],dispatchedAt:new Date().toISOString()};
 await db.recordProviderUsageEntries([entry]);await db.appendEvent('s',{kind:'context-window-usage',usedTokens:400,totalTokens:8000,provider:'local',model:'model'});
 expect(await workUsage(input,work,signal)).toMatchObject({reportedTokens:120,cost:{amount:0.25,currency:'USD'},providerCalls:1,context:{usedTokens:400,totalTokens:8000},usageComplete:true,pricingComplete:true});
 await expect(workUsage({homeDir,profileId:'other'},work,signal)).rejects.toThrow('unavailable');
 await db.appendEvent('s',{kind:'context-window-usage-invalidated'} as any);expect((await workUsage(input,work,signal)).context).toBeNull();
 // Missing provider usage produces an explicit partial total.
 await db.recordProviderUsageEntries([{...entry,id:'partial',requestKey:'partial',inputTokens:0,outputTokens:0,totalTokens:0,estimatedCostUsd:0,usageComplete:false,pricingComplete:false,incompleteReasons:['provider-usage-unavailable']}]);expect(await workUsage(input,work,signal)).toMatchObject({reportedTokens:120,usageComplete:false,pricingComplete:false});
 await db.recordProviderUsageEntries(Array.from({length:4096},(_,i)=>({...entry,id:'bulk-'+i,requestKey:'bulk-'+i})));expect(await workUsage(input,work,signal)).toMatchObject({providerCalls:4096,truncated:true,usageComplete:false,pricingComplete:false});
 }finally{db.close();await rm(homeDir,{recursive:true,force:true});}
});
it('counts canonical sessions and Tasks without counting attempts or approvals as running Work',()=>{
 const base={canonicalId:'s',profileId:'p',title:'Work',target:null,updatedAt:0};
 expect(workCounts({work:[{...base,id:'s',kind:'session',status:'needs_attention'},{...base,id:'t',kind:'task',status:'running'},{...base,id:'a',parentWorkId:'t',kind:'task_attempt',status:'running'},{...base,id:'child',parentWorkId:'a',kind:'session',status:'running'}],inbox:[{id:'approval',workId:'s',profileId:'p',kind:'approval',title:'Review',summary:'',createdAt:0,approval:null}],activity:{},activeSchedules:null})).toMatchObject({runningSessions:0,runningTasks:1,approvals:1,scheduled:null});
});

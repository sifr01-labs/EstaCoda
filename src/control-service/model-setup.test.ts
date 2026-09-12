import {join} from 'node:path';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {ModelSetup} from './model-setup.js';
import {CredentialCandidates,type CandidateScope} from './credential-candidates.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import type {CandidateRoute} from '../contracts/desktop-control/index.js';
import {AUXILIARY_SLOTS} from '../contracts/desktop-control/index.js';
it('reviews and applies only the bound candidate, preserves the profile and reconciles duplicate Apply',async()=>{
  const homeDir=await mkdtemp('/tmp/ec-model-setup-');const input={homeDir,profileId:'p'};
  const candidates=new CredentialCandidates('p','b');let changes=0;const setup=new ModelSetup(input,candidates,()=>{changes++;});
  const route:CandidateRoute={providerId:'kimi',modelId:'kimi-k2',endpoint:'https://api.moonshot.ai/v1',authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false};
  const scope:CandidateScope={windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:route.endpoint};
  const candidateId=candidates.stage(scope,'synthetic-key-canary');
  try{
    const draft=await setup.review({windowId:'w',generation:1,route,candidateId});const binding={draftId:draft.draftId,windowId:'w',generation:1};
    await expect(readFile(resolveProfileStateHome(input).configPath)).rejects.toThrow();
    await expect(setup.apply({...binding,generation:2},new AbortController().signal)).rejects.toThrow();
    expect(await setup.apply(binding,new AbortController().signal)).toMatchObject({state:'applied',verification:'configured'});
    expect(await setup.apply(binding,new AbortController().signal)).toMatchObject({state:'applied'});expect(changes).toBe(1);
    expect(()=>candidates.read(candidateId,scope)).toThrow();
    expect(await readFile(resolveProfileStateHome(input).envPath,'utf8')).toContain('synthetic-key-canary');
    expect(JSON.stringify(draft)).not.toContain('canary');
  }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('cancels a no-auth draft without creating profile configuration',async()=>{
  const homeDir=await mkdtemp('/tmp/ec-model-setup-');const input={homeDir,profileId:'p'};const candidates=new CredentialCandidates('p','b');const setup=new ModelSetup(input,candidates,()=>{});
  try{
    const draft=await setup.review({windowId:'w',generation:1,route:{providerId:'local',modelId:'local-model',endpoint:'http://127.0.0.1:8080/v1',authMethod:'none',apiMode:'custom_openai_compatible',allowPrivateEndpoint:true}});
    const binding={draftId:draft.draftId,windowId:'w',generation:1};expect(setup.cancel(binding)).toEqual({cancelled:true});
    await expect(setup.apply(binding,new AbortController().signal)).rejects.toThrow();
    await expect(readFile(resolveProfileStateHome(input).configPath)).rejects.toThrow();
  }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});

it('adds, reorders and removes fallbacks without redirecting the primary or accepting stale indices',async()=>{
  const homeDir=await mkdtemp('/tmp/ec-fallbacks-');const input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input);
  const candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
  await mkdir(paths.profileRoot,{recursive:true});
  await writeFile(paths.configPath,JSON.stringify({model:{provider:'kimi',id:'primary'},providers:{kimi:{baseUrl:'https://api.moonshot.ai/v1',apiKeyEnv:'ORIGINAL_KEY',authMethod:'api_key',enableNetwork:true,models:['primary']}}}));
  await writeFile(paths.envPath,'ORIGINAL_KEY=synthetic-original\n');
  const apply=async(draftId:string)=>setup.apply({draftId,windowId:'w',generation:1},new AbortController().signal);
  try{
    for(const modelId of ['fallback-one','fallback-two']){
      const route:CandidateRoute={providerId:'kimi',modelId,endpoint:'https://alternative.example/v1',authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false};
      const candidateId=candidates.stage({windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:route.endpoint},'synthetic-fallback-key');
      const draft=await setup.review({windowId:'w',generation:1,candidateId,route},'fallback');expect(await apply(draft.draftId)).toMatchObject({state:'applied'});
    }
    let config=JSON.parse(await readFile(paths.configPath,'utf8'));
    expect(config.providers.kimi.baseUrl).toBe('https://api.moonshot.ai/v1');expect(config.providers.kimi.apiKeyEnv).toBe('ORIGINAL_KEY');expect(config.model.id).toBe('primary');
    expect(config.model.fallbacks.every((route:{apiKeyEnv:string})=>route.apiKeyEnv!=='ORIGINAL_KEY')).toBe(true);
    const list=await setup.fallbacks();
    await expect(setup.reviewFallbackOrder({windowId:'w',generation:1,revision:list.revision,order:[0,0]})).rejects.toThrow();
    const ordered=await setup.reviewFallbackOrder({windowId:'w',generation:1,revision:list.revision,order:[1,0]});await apply(ordered.draftId);
    config=JSON.parse(await readFile(paths.configPath,'utf8'));expect(config.model.fallbacks.map((r:{id:string})=>r.id)).toEqual(['fallback-two','fallback-one']);
    await expect(setup.reviewFallbackOrder({windowId:'w',generation:1,revision:list.revision,order:[0]})).rejects.toThrow();
    const current=await setup.fallbacks();const removed=await setup.reviewFallbackOrder({windowId:'w',generation:1,revision:current.revision,order:[0]});await apply(removed.draftId);
    expect((await setup.fallbacks()).items.map(r=>r.modelId)).toEqual(['fallback-two']);
    const route:CandidateRoute={providerId:'kimi',modelId:'primary',endpoint:'https://api.moonshot.ai/v1',authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false};
    const candidateId=candidates.stage({windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:route.endpoint},'synthetic-duplicate');
    await expect(setup.review({windowId:'w',generation:1,candidateId,route},'fallback')).rejects.toThrow();
  }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});

it('manages only the five exposed specialist slots and preserves primary, fallback and Vision settings',async()=>{
  const homeDir=await mkdtemp('/tmp/ec-specialists-');const input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input);
  const candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
  await mkdir(paths.profileRoot,{recursive:true});
  await writeFile(paths.configPath,JSON.stringify({model:{provider:'local',id:'primary',fallbacks:[]},providers:{local:{baseUrl:'http://127.0.0.1:8080/v1',authMethod:'none',enableNetwork:true,models:['primary']}},auxiliaryModels:{vision:{provider:'main',enabled:true}}}));
  const apply=async(draftId:string)=>setup.apply({draftId,windowId:'w',generation:1},new AbortController().signal);
  try{
    expect((await setup.auxiliary()).items.map(row=>row.slot)).toEqual([...AUXILIARY_SLOTS]);
    for(const slot of AUXILIARY_SLOTS){
      const draft=await setup.reviewAuxiliaryMode({windowId:'w',generation:1,slot,mode:'disabled',fallbackToMain:false});expect(await apply(draft.draftId)).toMatchObject({state:'applied'});
    }
    expect((await setup.auxiliary()).items.every(row=>row.mode==='disabled')).toBe(true);
    const dedicated=await setup.review({windowId:'w',generation:1,route:{providerId:'local-specialist',modelId:'specialist',endpoint:'http://127.0.0.1:8081/v1',authMethod:'none',apiMode:'custom_openai_compatible',allowPrivateEndpoint:true}},'auxiliary',{slot:'assessor',fallbackToMain:true});
    await apply(dedicated.draftId);
    expect((await setup.auxiliary()).items.find(row=>row.slot==='assessor')).toMatchObject({mode:'dedicated',modelId:'specialist',fallbackToMain:true});
    const main=await setup.reviewAuxiliaryMode({windowId:'w',generation:1,slot:'assessor',mode:'main',fallbackToMain:false});await apply(main.draftId);
    expect((await setup.auxiliary()).items.find(row=>row.slot==='assessor')).toMatchObject({mode:'main',modelId:'primary'});
    const config=JSON.parse(await readFile(paths.configPath,'utf8'));expect(config.model.id).toBe('primary');expect(config.model.fallbacks).toEqual([]);expect(config.auxiliaryModels.vision).toMatchObject({provider:'main',enabled:true});
    await expect(setup.reviewAuxiliaryMode({windowId:'w',generation:1,slot:'vision' as never,mode:'disabled',fallbackToMain:false})).rejects.toThrow();
  }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('reviews custom transport, network and limits without a key',async()=>{
 const home=await mkdtemp('/tmp/ec-custom-limits-');const candidates=new CredentialCandidates('p','b'),setup=new ModelSetup({homeDir:home,profileId:'p'},candidates,()=>{});
 try{
  const route={providerId:'custom-office',modelId:'office-model',endpoint:'http://127.0.0.1:11434/v1',authMethod:'none' as const,apiMode:'openai_responses' as const,allowPrivateEndpoint:true,enableNetwork:false,contextWindowTokens:32000,maxTokens:512};
  const draft=await setup.review({windowId:'w',generation:1,route});expect(draft.route).toEqual(route);
  expect(await setup.apply({windowId:'w',generation:1,draftId:draft.draftId},new AbortController().signal)).toMatchObject({state:'applied'});
  const config=JSON.parse(await readFile(join(home,'.estacoda/profiles/p/config.json'),'utf8'));
  expect(config.providers['custom-office']).toMatchObject({authMethod:'none',apiMode:'openai_responses',enableNetwork:false});expect(config.model).toMatchObject({provider:'custom-office',id:'office-model',maxTokens:512});
  expect(config.model.contextWindowTokens).toBe(32000);
  const {contextWindowTokens:_context,maxTokens:_output,...defaults}=route;const reset=await setup.review({windowId:'w',generation:1,route:defaults});await setup.apply({windowId:'w',generation:1,draftId:reset.draftId},new AbortController().signal);const resetConfig=JSON.parse(await readFile(join(home,'.estacoda/profiles/p/config.json'),'utf8'));expect(resetConfig.model.contextWindowTokens).toBeUndefined();expect(resetConfig.model.maxTokens).toBeUndefined();
  expect(await readFile(join(home,'.estacoda/profiles/p/.env'),'utf8').catch(()=>null)).toBeNull();
 }finally{setup.dispose();candidates.dispose();await rm(home,{recursive:true,force:true});}
});

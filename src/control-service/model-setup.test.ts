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
    const duplicateRoute:CandidateRoute={providerId:'kimi',modelId:'fallback-one',endpoint:'https://alternative.example/v1/',authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false};
    const duplicateCandidate=candidates.stage({windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:duplicateRoute.endpoint},'synthetic-duplicate-primary');
    await expect(setup.review({windowId:'w',generation:1,candidateId:duplicateCandidate,route:duplicateRoute},'primary')).rejects.toThrow();
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
  expect(await setup.apply({windowId:'w',generation:1,draftId:draft.draftId},new AbortController().signal)).toMatchObject({state:'applied',verification:'configured'});
  const config=JSON.parse(await readFile(join(home,'.estacoda/profiles/p/config.json'),'utf8'));
  expect(config.providers['custom-office']).toMatchObject({authMethod:'none',apiMode:'openai_responses',enableNetwork:false});expect(config.model).toMatchObject({provider:'custom-office',id:'office-model',maxTokens:512});
  expect(config.model.contextWindowTokens).toBe(32000);
  const {contextWindowTokens:_context,maxTokens:_output,...defaults}=route;const reset=await setup.review({windowId:'w',generation:1,route:defaults});await setup.apply({windowId:'w',generation:1,draftId:reset.draftId},new AbortController().signal);const resetConfig=JSON.parse(await readFile(join(home,'.estacoda/profiles/p/config.json'),'utf8'));expect(resetConfig.model.contextWindowTokens).toBeUndefined();expect(resetConfig.model.maxTokens).toBeUndefined();
  expect(await readFile(join(home,'.estacoda/profiles/p/.env'),'utf8').catch(()=>null)).toBeNull();
 }finally{setup.dispose();candidates.dispose();await rm(home,{recursive:true,force:true});}
});
it('reuses and verifies a configured key without replacing it or importing it into process environment',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-existing-route-'),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input);const candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
 const {CandidateVerifier}=await import('./candidate-verification.js');let calls=0;
 const verifier=new CandidateVerifier(candidates,()=>async(_url,init)=>{calls++;expect(init.headers.Authorization??init.headers.authorization).toBe('Bearer existing-key-canary');return {ok:false,status:401,statusText:'',json:async()=>({}),text:async()=>''};});
 try{
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.envPath,'EC_EXISTING_ROUTE_KEY=existing-key-canary\n');await writeFile(paths.configPath,JSON.stringify({model:{provider:'kimi',id:'primary'},providers:{kimi:{baseUrl:'https://api.moonshot.ai/v1',apiKeyEnv:'EC_EXISTING_ROUTE_KEY',authMethod:'api_key',enableNetwork:true,models:['primary','second']}}}));
  const before=await readFile(paths.envPath,'utf8');const draft=await setup.reviewConfigured({windowId:'w',generation:1,providerId:'kimi',modelId:'second',role:'primary'});expect(draft.credentialState).toBe('existing');
  const binding={windowId:'w',generation:1,draftId:draft.draftId};expect(await setup.verifyDraft({...binding,spendApproved:true,allowPrivateEndpoint:false},new AbortController().signal,verifier)).toMatchObject({reason:'invalid_credential'});expect(calls).toBe(1);
  expect(await readFile(paths.envPath,'utf8')).toBe(before);expect(process.env.EC_EXISTING_ROUTE_KEY).toBeUndefined();expect(await setup.apply(binding,new AbortController().signal)).toMatchObject({state:'applied'});
  expect(await readFile(paths.envPath,'utf8')).toBe(before);expect(JSON.parse(await readFile(paths.configPath,'utf8')).model.id).toBe('second');
 }finally{verifier.dispose();setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('invalidates reviewed no-auth configuration when its owning window closes',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-window-draft-'),candidates=new CredentialCandidates('p','b'),setup=new ModelSetup({homeDir,profileId:'p'},candidates,()=>{});
 try{const draft=await setup.review({windowId:'w',generation:1,route:{providerId:'local',modelId:'m',endpoint:'http://127.0.0.1:8080/v1',authMethod:'none',apiMode:'custom_openai_compatible',allowPrivateEndpoint:true}});candidates.closeWindow('w',1);await expect(setup.apply({windowId:'w',generation:1,draftId:draft.draftId},new AbortController().signal)).rejects.toThrow();await expect(readFile(resolveProfileStateHome({homeDir,profileId:'p'}).configPath)).rejects.toThrow();}finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('rejects another profile or bridge candidate and never changes the other profile',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-profile-candidate-'),a=new CredentialCandidates('a','bridge-a'),b=new CredentialCandidates('b','bridge-b'),setup=new ModelSetup({homeDir,profileId:'b'},b,()=>{});
 try{const route:CandidateRoute={providerId:'kimi',modelId:'m',endpoint:'https://api.moonshot.ai/v1',authMethod:'api_key',apiMode:'openai_chat_completions',allowPrivateEndpoint:false};const candidateId=a.stage({windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:route.endpoint},'synthetic-other-profile');await expect(setup.review({windowId:'w',generation:1,route,candidateId})).rejects.toThrow();for(const profileId of ['a','b'])await expect(readFile(resolveProfileStateHome({homeDir,profileId}).envPath)).rejects.toThrow();}finally{setup.dispose();a.dispose();b.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('preserves current primary limits when selecting its configured route again',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-primary-limits-'),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({model:{provider:'local',id:'m',contextWindowTokens:32000,maxTokens:512},providers:{local:{baseUrl:'http://localhost:11434/v1',authMethod:'none',apiMode:'custom_openai_compatible',enableNetwork:true,models:['m']}}}));const draft=await setup.reviewConfigured({windowId:'w',generation:1,providerId:'local',modelId:'m',role:'primary'});expect(draft.route).toMatchObject({contextWindowTokens:32000,maxTokens:512});expect(await setup.apply({windowId:'w',generation:1,draftId:draft.draftId},new AbortController().signal)).toMatchObject({state:'applied',verification:'configured'});}finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('reconciles the latest saved Apply after service restart without crossing profiles',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-restart-receipt-'),input={homeDir,profileId:'p'},candidates=new CredentialCandidates('p','b');let setup=new ModelSetup(input,candidates,()=>{});
 try{const draft=await setup.review({windowId:'w',generation:1,route:{providerId:'local',modelId:'test-chat',endpoint:'http://localhost:11434/v1',authMethod:'none',apiMode:'custom_openai_compatible',allowPrivateEndpoint:true}});await setup.apply({windowId:'w',generation:1,draftId:draft.draftId},new AbortController().signal);setup.dispose();setup=new ModelSetup(input,candidates,()=>{});expect(await setup.inspect()).toMatchObject({operationId:draft.draftId,state:'applied'});const otherCandidates=new CredentialCandidates('other','c'),other=new ModelSetup({homeDir,profileId:'other'},otherCandidates,()=>{});try{expect(await other.inspect()).toMatchObject({state:'unknown',operationId:'none'});}finally{other.dispose();otherCandidates.dispose();}}finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});

it('adds a provider through reviewed apply without replacing any model selections or credentials',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-provider-only-'),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input);
 const candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
 const original={model:{provider:'local',id:'primary',fallbacks:[{provider:'local',id:'backup'}]},providers:{local:{baseUrl:'http://127.0.0.1:8080/v1',authMethod:'none',enableNetwork:true,models:['primary','backup']}},auxiliaryModels:{assessor:{provider:'main',enabled:true},vision:{provider:'main',enabled:true}}};
 try{
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify(original));
  const route:CandidateRoute={providerId:'kimi',modelId:'kimi-k2',endpoint:'https://api.moonshot.ai/v1',apiMode:'openai_chat_completions',authMethod:'api_key',allowPrivateEndpoint:false};
  const scope:CandidateScope={windowId:'w',generation:1,purpose:'provider',providerId:'kimi',authMethod:'api_key',endpoint:route.endpoint};
  await expect(setup.review({windowId:'w',generation:1,route:{...route,maxTokens:512},candidateId:candidates.stage(scope,'synthetic-unused-limits')},'provider')).rejects.toThrow();
  const cancelled=await setup.review({windowId:'w',generation:1,route,candidateId:candidates.stage(scope,'synthetic-cancelled-key')},'provider');
  expect(cancelled.role).toBe('provider');expect(setup.cancel({draftId:cancelled.draftId,windowId:'w',generation:1})).toEqual({cancelled:true});
  expect(JSON.parse(await readFile(paths.configPath,'utf8'))).toEqual(original);await expect(readFile(paths.envPath)).rejects.toThrow();
  const draft=await setup.review({windowId:'w',generation:1,route,candidateId:candidates.stage(scope,'synthetic-provider-key')},'provider');
  await setup.apply({draftId:draft.draftId,windowId:'w',generation:1},new AbortController().signal);
  const saved=JSON.parse(await readFile(paths.configPath,'utf8'));expect(saved.model).toEqual(original.model);expect(saved.auxiliaryModels).toEqual(original.auxiliaryModels);expect(saved.providers.local).toEqual(original.providers.local);expect(saved.providers.kimi.models).toContain('kimi-k2');
  expect(await readFile(paths.envPath,'utf8')).toContain('synthetic-provider-key');expect(JSON.stringify(draft)).not.toContain('synthetic-provider-key');
  await expect(setup.review({windowId:'w',generation:1,route,candidateId:candidates.stage(scope,'synthetic-overwrite-key')},'provider')).rejects.toThrow();
  expect(JSON.parse(await readFile(paths.configPath,'utf8'))).toEqual(saved);
 }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});

it('reviews another catalog model with the configured provider credential without making it runnable before Apply',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-catalog-selection-'),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input);
 const candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
 try{
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({model:{provider:'kimi',id:'kimi-k2'},providers:{kimi:{baseUrl:'https://api.moonshot.ai/v1',authMethod:'api_key',apiKeyEnv:'ORIGINAL_KEY',enableNetwork:true,models:['kimi-k2']}}}));await writeFile(paths.envPath,'ORIGINAL_KEY=synthetic-catalog-key\n');
  const {captureModelCatalog}=await import('./model-catalog.js');
  const before=await captureModelCatalog(input),other=before.models.find(m=>m.providerId==='kimi'&&!m.catalog?.configured&&m.catalog?.lifecycle!=='retired');expect(other).toBeDefined();expect(other!.runnable).toBe(false);
  const draft=await setup.reviewConfigured({windowId:'w',generation:1,providerId:'kimi',modelId:other!.id,role:'auxiliary',slot:'compression',fallbackToMain:true});
  expect(draft.credentialState).toBe('existing');expect(JSON.parse(await readFile(paths.configPath,'utf8')).model.id).toBe('kimi-k2');
  expect(await setup.apply({draftId:draft.draftId,windowId:'w',generation:1},new AbortController().signal)).toMatchObject({state:'applied'});
  const saved=JSON.parse(await readFile(paths.configPath,'utf8'));expect(saved.model.id).toBe('kimi-k2');expect(saved.providers.kimi.apiKeyEnv).toBe('ORIGINAL_KEY');expect(saved.auxiliaryModels.compression).toMatchObject({provider:'kimi',id:other!.id});expect((await captureModelCatalog(input)).models.find(m=>m.providerId==='kimi'&&m.id===other!.id)?.runnable).toBe(true);expect(await readFile(paths.envPath,'utf8')).toBe('ORIGINAL_KEY=synthetic-catalog-key\n');
 }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});

it('provider registration preserves primary limits and never adopts a fallback credential',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-provider-registration-'),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('p','b'),setup=new ModelSetup(input,candidates,()=>{});
 const original={model:{provider:'kimi',id:'primary',contextWindowTokens:32000,maxTokens:512,fallbacks:[{provider:'kimi',id:'backup',baseUrl:'https://api.moonshot.ai/v1',apiKeyEnv:'BACKUP_KEY',contextWindowTokens:16000,maxTokens:256}]},providers:{kimi:{baseUrl:'https://api.moonshot.ai/v1',authMethod:'api_key',apiKeyEnv:'PRIMARY_KEY',enableNetwork:true,models:['primary','backup']}}};
 try{
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify(original));const env='PRIMARY_KEY=synthetic-primary\nBACKUP_KEY=synthetic-backup\n';await writeFile(paths.envPath,env);
  const draft=await setup.reviewConfigured({windowId:'w',generation:1,providerId:'kimi',modelId:'primary',role:'provider'});expect(draft.route?.contextWindowTokens).toBeUndefined();expect(draft.route?.maxTokens).toBeUndefined();
   expect(await setup.apply({windowId:'w',generation:1,draftId:draft.draftId},new AbortController().signal)).toMatchObject({state:'applied'});
   const saved=JSON.parse(await readFile(paths.configPath,'utf8'));expect(saved.model).toEqual(original.model);expect(saved.providers.kimi.apiKeyEnv).toBe('PRIMARY_KEY');expect(await readFile(paths.envPath,'utf8')).toBe(env);
  // Two credential identities for the same model remain ambiguous; do not choose one implicitly.
  const beforeRejected=await readFile(paths.configPath,'utf8');await expect(setup.reviewConfigured({windowId:'w',generation:1,providerId:'kimi',modelId:'backup',role:'provider'})).rejects.toThrow();expect(await readFile(paths.configPath,'utf8')).toBe(beforeRejected);expect(await readFile(paths.envPath,'utf8')).toBe(env);
 }finally{setup.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});

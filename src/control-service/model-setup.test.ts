import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {ModelSetup} from './model-setup.js';
import {CredentialCandidates,type CandidateScope} from './credential-candidates.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import type {CandidateRoute} from '../contracts/desktop-control/index.js';
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

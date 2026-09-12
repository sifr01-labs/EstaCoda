import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {resolveProfileStateHome} from '../../config/profile-home.js';
import {loadRuntimeConfig,setupUiConfig} from '../../config/runtime-config.js';
import {captureProfileApplySnapshot,applyProfilePlan,recoverProfileApply,inspectProfileApply} from './profile-apply.js';
import {primaryRoutePlan} from './model-route-plan.js';

async function fixture(){const homeDir=await mkdtemp('/tmp/ec-profile-apply-');const input={homeDir,profileId:'p'};const paths=resolveProfileStateHome(input);await mkdir(paths.profileRoot,{recursive:true});
  await writeFile(paths.configPath,JSON.stringify({ui:{language:'ar'},model:{provider:'local',id:'old'}}));
  const plan=primaryRoutePlan({provider:'kimi',model:'kimi-k2',baseUrl:'https://api.moonshot.ai/v1',authMethod:'api_key'},'EC_APPLY_TEST_KEY');
  return {...input,paths,plan,snapshot:await captureProfileApplySnapshot(input),operationId:randomUUID(),secrets:[{envVarName:'EC_APPLY_TEST_KEY',value:'synthetic-apply-canary'}],signal:new AbortController().signal};}
it('rejects stale review and pre-commit cancellation without writing credentials',async()=>{
  const f=await fixture();try{
    const controller=new AbortController();controller.abort();await expect(applyProfilePlan({...f,signal:controller.signal})).rejects.toThrow();
    await writeFile(f.paths.configPath,JSON.stringify({ui:{language:'en'}}));
    await expect(applyProfilePlan(f)).rejects.toThrow('review again');
    await expect(readFile(f.paths.envPath)).rejects.toThrow();
  }finally{await rm(f.homeDir,{recursive:true,force:true});}
});
it.each(['.env','auth.json','config.json'])('blocks activation and recovers interruption after %s',async interruption=>{
  const f=await fixture();try{
    expect(await applyProfilePlan({...f,afterWrite:async name=>{if(name===interruption)throw new Error('simulated interruption');}})).toMatchObject({state:'uncertain'});
    await expect(loadRuntimeConfig({...f,workspaceRoot:f.homeDir,configurationInspection:true})).rejects.toThrow('recovery');
    expect((await stat(join(f.paths.profileRoot,'.profile-apply.json'))).mode & 0o777).toBe(0o600);
    expect(await recoverProfileApply(f)).toMatchObject({state:'applied'});
    const config=JSON.parse(await readFile(f.paths.configPath,'utf8'));expect(config.ui.language).toBe('ar');expect(config.model.id).toBe('kimi-k2');
    expect(await readFile(f.paths.envPath,'utf8')).toContain('synthetic-apply-canary');
    expect(process.env.EC_APPLY_TEST_KEY).toBeUndefined();
    expect(await inspectProfileApply(f,f.operationId)).toMatchObject({state:'applied'});
    expect(await applyProfilePlan(f)).toMatchObject({state:'applied'});
  }finally{await rm(f.homeDir,{recursive:true,force:true});}
});

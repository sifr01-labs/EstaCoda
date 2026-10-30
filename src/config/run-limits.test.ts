import {expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeRunLimits,providerBudgetsForRun} from './run-limits.js';
import {readRunLimits} from './run-limits-store.js';
import {resolveProfileStateHome} from './profile-home.js';

it('defaults interactive work to unlimited and unattended work to finite ceilings',()=>{
 const limits=normalizeRunLimits(undefined);
 expect(providerBudgetsForRun(limits.interactive)).toEqual({maxProviderIterations:Infinity,maxProviderToolCalls:Infinity,maxProviderWallClockMs:Infinity});
 expect(providerBudgetsForRun(limits.unattended)).toEqual({maxProviderIterations:45,maxProviderToolCalls:100,maxProviderWallClockMs:1800000});
 expect(normalizeRunLimits({interactive:{maxIterations:12}}).interactive).toEqual({maxIterations:12,maxToolCalls:0,maxDurationMinutes:0});
});
it.each([null,[],{unknown:{}},{interactive:{typo:0}},{unattended:{maxIterations:0}},{interactive:{maxIterations:-1}},{interactive:{maxIterations:1.5}},{interactive:{maxIterations:'0'}},{interactive:{maxDurationMinutes:Infinity}},{interactive:{maxDurationMinutes:10081}}])('rejects malformed or unbounded unattended policy: %j',value=>{
 expect(()=>normalizeRunLimits(value)).toThrow();
});
it('reads only the selected profile and observes later saved edits',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-run-limits-'));
 try{
  for(const [profileId,n] of [['one',60],['two',80]] as const){const paths=resolveProfileStateHome({homeDir,profileId});await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({runLimits:{interactive:{maxIterations:n}}}));}
  expect((await readRunLimits({homeDir,profileId:'one'})).interactive.maxIterations).toBe(60);
  const paths=resolveProfileStateHome({homeDir,profileId:'one'});await writeFile(paths.configPath,JSON.stringify({runLimits:{interactive:{maxIterations:90}}}));
  expect((await readRunLimits({homeDir,profileId:'one'})).interactive.maxIterations).toBe(90);
  expect((await readRunLimits({homeDir,profileId:'two'})).interactive.maxIterations).toBe(80);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});

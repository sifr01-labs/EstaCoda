import {it, expect, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod} from 'node:fs/promises';
import {resolveProfileStateHome, resolveGlobalStateHome} from '../config/profile-home.js';
import {startPrivateControl} from '../gateway/private-control.js';
import {OnboardingWorkspace} from './onboarding-workspace.js';
import {inspectLocalSetup} from './local-setup.js';

it('inspects missing state without creating a profile or starting a runtime', async () => {
 const homeDir=await mkdtemp('/tmp/ec-local-');
 try {
  expect(await inspectLocalSetup({homeDir,profileId:'default',version:'test'},AbortSignal.timeout(5000))).toMatchObject({configuration:{mode:'first-run'},runtime:'stopped',compatibility:'compatible',canConnect:false});
  expect(await readdir(homeDir)).toEqual([]);
 } finally {await rm(homeDir,{recursive:true,force:true});}
});

it('preserves selected setup bytes and distinguishes authenticated runtime compatibility', async () => {
 const homeDir=await mkdtemp('/tmp/ec-local-'),input={homeDir,profileId:'existing',version:'test'},paths=resolveProfileStateHome(input),global=resolveGlobalStateHome(input);
 const workspace=new OnboardingWorkspace(input);let host:Awaited<ReturnType<typeof startPrivateControl>>|undefined;
 try {
  await mkdir(paths.profileRoot,{recursive:true});await mkdir(homeDir+'/work');
  await writeFile(paths.configPath,JSON.stringify({model:{provider:'local',id:'test'},providers:{local:{kind:'openai-compatible',baseUrl:'http://127.0.0.1:8080/v1',apiMode:'custom_openai_compatible',authMethod:'none',enableNetwork:true}}}));
  await writeFile(paths.profileRoot+'/.env','SYNTHETIC_KEY=never-display\n');
  await writeFile(global.stateRoot+'/active-profile.json','{"profileId":"other"}\n');
  const files=[paths.configPath,paths.profileRoot+'/.env',global.stateRoot+'/active-profile.json'];const before=await Promise.all(files.map(file=>readFile(file)));
  const review=await workspace.review({path:homeDir+'/work',alias:'work',trust:true});await workspace.apply({reviewId:review.reviewId,operationId:'register',confirmed:true});
  expect(await inspectLocalSetup(input,AbortSignal.timeout(5000))).toMatchObject({canConnect:true,runtime:'stopped'});
  await mkdir(paths.gatewayStatePath,{recursive:true,mode:0o700});await chmod(paths.gatewayStatePath,0o700);
  const handle=vi.fn(async()=>({}));host=await startPrivateControl({directory:paths.gatewayStatePath,profileId:input.profileId,version:'test',instanceId:'host',handle});
  expect(await inspectLocalSetup(input,AbortSignal.timeout(5000))).toMatchObject({canConnect:true,runtime:'ready',compatibility:'compatible'});
  const mismatch=await inspectLocalSetup({...input,version:'new'},AbortSignal.timeout(5000));
  expect(mismatch).toMatchObject({canConnect:false,runtime:'incompatible',compatibility:'incompatible'});
  expect(JSON.stringify(mismatch)).not.toContain('never-display');expect(handle).not.toHaveBeenCalled();
  expect(await Promise.all(files.map(file=>readFile(file)))).toEqual(before);
  await expect(inspectLocalSetup(input,AbortSignal.abort())).rejects.toThrow();
 } finally {await host?.close();workspace.dispose();await rm(homeDir,{recursive:true,force:true});}
});

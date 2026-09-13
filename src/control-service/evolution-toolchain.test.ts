import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {HostEnvironment} from '../execution/host-environment.js';
import {evolutionGates} from './evolution-gates.js';

it('runs an installed pnpm with the packaged PATH and owned Node without passing profile credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gate-toolchain-'));
 const environment=await HostEnvironment.create({profileId:'p',workspaceRoot:root,policy:{backend:'host'}}),lease=environment.acquire({profileId:'p',sessionId:'test',surface:'test'});
 try{
  vi.stubEnv('HOME',process.env.ESTACODA_TEST_ORIGINAL_HOME!);vi.stubEnv('PATH','/usr/bin:/bin:/usr/sbin:/sbin');vi.stubEnv('KIMI_API_KEY','test-credential-must-not-leak');
  await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node gate.cjs'},packageManager:'pnpm@99.0.0'}));
  await writeFile(join(root,'gate.cjs'),"require('node:fs').writeFileSync('result.json',JSON.stringify({node:process.execPath,credential:process.env.KIMI_API_KEY??null,download:process.env.COREPACK_ENABLE_NETWORK}))");
  expect(await evolutionGates(lease,['pnpm run test'],new AbortController().signal)).toBe(true);
  expect(JSON.parse(await readFile(join(root,'result.json'),'utf8'))).toEqual({node:process.execPath,credential:null,download:'0'});
 }finally{vi.unstubAllEnvs();await lease.release();await environment.destroy();await rm(root,{recursive:true,force:true});}
},15000);

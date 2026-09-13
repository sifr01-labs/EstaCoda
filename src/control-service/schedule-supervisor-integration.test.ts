import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scheduleFixture} from './schedule-test-fixture.js';
import {launchDesktopBridge} from '../test/desktop-bridge-client.js';

it.skipIf(process.platform==='win32')('executes a reviewed schedule in the real supervisor after bridge exit and reconnects without replay',async()=>{
 const f=await scheduleFixture('/tmp/ec-sc-');const bridges:ReturnType<typeof launchDesktopBridge>[]=[];
 const start=async()=>{const bridge=launchDesktopBridge(f.input.homeDir,'one');bridges.push(bridge);expect((await bridge.initialize()).error).toBeUndefined();return bridge;};
 try{
  await writeFile(join(f.root,'audit.sh'),"printf 'executed\\n' >> schedule-runs.txt\nprintf '[ALERT] schedule integration complete\\n'\n");
  const bridge=await start();const reviewed=await bridge.rpc('schedules.review',{action:'save',draft:{...f.draft,script:'audit.sh',repeat:null}});expect(reviewed.error).toBeUndefined();const created=await bridge.rpc('schedules.execute',{reviewId:reviewed.result.reviewId,operationId:'create',confirmed:true});expect(created.result.state).toBe('completed');
  const id=(await bridge.rpc('schedules.list',{})).result.items[0].id;
  const request=await bridge.rpc('schedules.review',{action:'run-now',id});expect(request.error).toBeUndefined();expect((await bridge.rpc('schedules.execute',{reviewId:request.result.reviewId,operationId:'run',confirmed:true})).result.state).toBe('completed');expect(await bridge.stop()).toBe(0);
  const module=fileURLToPath(new URL('../gateway/supervisor.ts',import.meta.url));
  await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',"const {runGatewaySupervisor}=await import(process.argv[1]);const result=await runGatewaySupervisor({homeDir:process.argv[2],workspaceRoot:process.argv[3],profileId:'one',once:true});if(!result.ok)throw new Error(result.output);",module,f.input.homeDir,f.root],{timeout:30000,maxBuffer:1_048_576});
  expect(await readFile(join(f.root,'schedule-runs.txt'),'utf8')).toBe('executed\n');
  const reconnected=await start();expect((await reconnected.rpc('schedules.inspect',{operationId:'run'})).result.state).toBe('completed');
  const history=await reconnected.rpc('schedules.history',{id});expect(history.error).toBeUndefined();expect(history.result.items).toHaveLength(1);expect(history.result.items[0].status).toBe('success');expect((await reconnected.rpc('schedules.get',{id})).result).toMatchObject({runRequested:false,runCount:1});
  // The operation identity survives reconnect; replay does not requeue a run.
  expect((await reconnected.rpc('schedules.execute',{reviewId:request.result.reviewId,operationId:'run',confirmed:true})).result.state).toBe('completed');expect((await reconnected.rpc('schedules.get',{id})).result.runRequested).toBe(false);
 }finally{await Promise.all(bridges.map(b=>b.stop()));await f.dispose();}
},60000);

/** Real Desktop -> bridge -> supervisor -> runtime/Task worker; only HTTP provider output is scripted. */
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {_electron,expect} from '@playwright/test';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../../../src/config/profile-home.ts';
import {SQLiteSessionDB} from '../../../src/session/sqlite-session-db.ts';
import {ensureRuntimeSession} from '../../../src/session/session-workspace-ownership.ts';
import {WorkspaceTrustStore} from '../../../src/security/workspace-trust-store.ts';
import {probePrivateControl} from '../../../src/gateway/private-control.ts';
const home=mkdtempSync('/tmp/ec-real-desktop-'),desktop=resolve('apps/desktop');
const repository=join(home,'repo');mkdirSync(repository);execFileSync('git',['init','-q',repository]);execFileSync('git',['-C',repository,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Initial']);
const paths=resolveProfileStateHome({homeDir:home,profileId:'default'});
let held=false,release:undefined|(()=>void),requests=0;
const provider=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body);expect(req.headers.authorization).toBeUndefined();
 if(++requests>12){res.writeHead(429).end();return;}
 if(held)await new Promise<void>(resolve=>{release=resolve;});
 const text='The requested review is complete. No workspace changes were required.';
 res.writeHead(200,{'Content-Type':input.stream?'text/event-stream':'application/json'});
 if(input.stream)res.end('data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:12,total_tokens:42}})+'\n\ndata: [DONE]\n\n');
 else res.end(JSON.stringify({id:'controlled',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:30,completion_tokens:12,total_tokens:42}}));
});
await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
const port=(provider.address() as {port:number}).port;
mkdirSync(paths.profileRoot,{recursive:true});
writeFileSync(paths.configPath,JSON.stringify({model:{provider:'local',id:'desktop-acceptance',contextWindowTokens:131072,maxTokens:256},providers:{local:{enabled:true,enableNetwork:true,authMethod:'none',baseUrl:`http://127.0.0.1:${port}/v1`,apiMode:'custom_openai_compatible',models:['desktop-acceptance']}},security:{approvalMode:'strict'},skills:{autonomy:'none'}}));
const db=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir:home}).sessionsSqlitePath});
await ensureRuntimeSession({sessionDb:db,sessionId:'target-registration',profileId:'default',workspaceRoot:repository,homeDir:home,durable:true});
const binding=(await db.getSession('target-registration'))!.executionTarget!;
await new WorkspaceTrustStore({homeDir:home}).grant(repository);
const supervisorEntry=join(home,'supervisor.mjs');
writeFileSync(supervisorEntry,`import {runGatewaySupervisor} from ${JSON.stringify(resolve('src/gateway/supervisor.ts'))}; await runGatewaySupervisor(${JSON.stringify({homeDir:home,workspaceRoot:repository,profileId:'default'})});`);
const supervisor=spawn(process.execPath,['--import','tsx',supervisorEntry],{stdio:['ignore','pipe','pipe']});let diagnostics='';
for(const stream of [supervisor.stdout,supervisor.stderr])stream!.on('data',data=>{diagnostics=(diagnostics+data).slice(-16000);});
const ended=new Promise(resolve=>supervisor.once('exit',resolve));
const harness=join(home,'entry.cjs');writeFileSync(harness,`const {app}=require('electron');app.setPath('home',${JSON.stringify(home)});app.setPath('userData',${JSON.stringify(join(home,'desktop-data'))});app.setAppPath(${JSON.stringify(desktop)});require(${JSON.stringify(join(desktop,'.vite/build/main.cjs'))});`);
const launch=()=>_electron.launch({args:[harness],executablePath:join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),env:{HOME:home,PATH:process.env.PATH!}});
let app:Awaited<ReturnType<typeof launch>>|undefined;
try{
 const version=JSON.parse(readFileSync('package.json','utf8')).version;
 await expect.poll(async()=>{try{return(await probePrivateControl({directory:paths.gatewayStatePath,profileId:'default',version})).instanceId;}catch{return null;}},{timeout:30000}).not.toBeNull();
 app=await launch();let page=await app.firstWindow();
 const ready=async()=>expect.poll(()=>page.evaluate(async()=>(await window.desktop.snapshot()).status),{timeout:30000}).toBe('ready');await ready();
 const source={targetId:binding.targetId,targetGeneration:binding.targetGeneration};
 const review=await page.evaluate(source=>window.desktop.targets!.review(source),source);
 const created=await page.evaluate(id=>window.desktop.targets!.create(id,true),review.reviewId);
 expect(created.state).toBe('completed');expect(created.target).not.toBeNull();const target=created.target!;
 const inspection=await page.evaluate(target=>window.desktop.targets!.inspect(target),target);
 const selected=await page.evaluate(target=>window.desktop.work!.targets({target}),target);
 expect(selected.items).toHaveLength(1);expect(selected.items[0]).toMatchObject(target);
 expect((await page.evaluate(()=>window.desktop.work!.targets())).items.some(item=>item.targetId===target.targetId)).toBe(true);
 expect(inspection.kind).toBe('git-worktree');expect(inspection.readiness).toBe('ready');expect(inspection.workingRoot).not.toBe(inspection.sourceRoot);
 const submit=async(input:any)=>{
  let result:any;
  await expect.poll(async()=>{try{result=await page.evaluate(input=>window.desktop.work!.submit(input),input);return ['sessions.send','tasks.create'].includes(result.receipt.method);}catch{return false;}},{timeout:30000}).toBe(true);return result;
 };
 const session=await submit({draftId:'real-session',target,text:'Reply with a brief review summary. No tools or changes are needed.',attachmentIds:[]});
 await expect.poll(()=>page.evaluate(id=>window.desktop.getWork(id).then(work=>work.status).catch(()=>'unavailable'),session.workId),{timeout:30000}).toBe('completed');
 held=true;
 const task=await submit({draftId:'real-task',target,kind:'task',text:'Provide a brief review summary. No tools or changes are needed.',attachmentIds:[],limits:{maxProviderCalls:3,maxTotalTokens:30000,maxWallClockMs:120000}});
 await expect.poll(()=>Boolean(release),{timeout:60000}).toBe(true);
 await expect.poll(()=>page.evaluate(id=>window.desktop.getWork(id).then(work=>work.status).catch(()=>'unavailable'),task.workId),{timeout:30000}).toBe('running');
 const requestsBeforeRestart=requests;await app.close();app=undefined;
 app=await launch();page=await app.firstWindow();await ready();
 await expect.poll(()=>page.evaluate(id=>window.desktop.getWork(id).then(work=>work.status).catch(()=>'unavailable'),task.workId),{timeout:30000}).toBe('running');
 expect(requests).toBe(requestsBeforeRestart);held=false;release!();
 await expect.poll(()=>page.evaluate(id=>window.desktop.getWork(id).then(work=>work.status).catch(()=>'unavailable'),task.workId),{timeout:30000}).toBe('completed');
 const activity=await page.evaluate(id=>window.desktop.activity(id),task.workId);
 expect(activity.items.some(item=>item.kind==='result')).toBe(true);
 await app.close();app=undefined;app=await launch();page=await app.firstWindow();await ready();
 expect(await page.evaluate(id=>window.desktop.getWork(id).then(work=>work.status).catch(()=>'unavailable'),task.workId)).toBe('completed');
 expect(requests).toBe(requestsBeforeRestart);
 const persistedSession=await db.getSession(session.workId.replace(/^session:/,''));expect(persistedSession?.executionTarget?.targetId).toBe(target.targetId);expect(persistedSession?.metadata?.workspaceRoot).toBe(inspection.workingRoot);
 console.log('Real Desktop execution passed: reviewed managed worktree creation and immutable working-root binding; canonical Session completion; running Task survives app restart; worker result persists; no request replay.');
}catch(error){console.error(diagnostics);console.error('Synthetic provider requests:',requests);throw error;}
finally{
 held=false;release?.();await app?.close();supervisor.kill('SIGTERM');const kill=setTimeout(()=>supervisor.kill('SIGKILL'),10000);await ended;clearTimeout(kill);db.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(home,{recursive:true,force:true});
}

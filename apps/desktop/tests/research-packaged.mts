/** Actual signed app -> owned bridge -> packaged supervisor/runtime. Only model/web responses are fixtures. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,expect,type Browser,type Page} from '@playwright/test';
import {verifyRuntimeInventory} from '../src/main/runtime-integrity.ts';
import type {} from '../src/shared/desktop-api.ts';

const appRoot=resolve(process.argv[2]??'apps/desktop/out/EstaCoda-darwin-arm64/EstaCoda.app');
const output=resolve(process.argv[3]??'evals/results/research-reliability-packaged-v1.json');
const runtimeRoot=join(appRoot,'Contents/Resources/.runtime'), core=join(runtimeRoot,'core/dist');
const manifest=JSON.parse(readFileSync(join(runtimeRoot,'manifest.json'),'utf8'));
verifyRuntimeInventory(runtimeRoot,manifest);
for(const file of manifest.files.filter((f:any)=>f.path.startsWith('core/dist/'))){
 assert.equal(createHash('sha256').update(readFileSync(resolve(file.path.slice(5)))).digest('hex'),file.sha256,'Packaged core differs from the current build: '+file.path);
}
execFileSync('codesign',['--verify','--deep','--strict',appRoot]);
const coreImport=async(path:string)=>import(pathToFileURL(join(core,path)).href);
const {SQLiteSessionDB}=await coreImport('session/sqlite-session-db.js');
const {SQLiteTaskStore}=await coreImport('tasks/sqlite-task-store.js');
const {TaskResultService}=await coreImport('tasks/task-result-service.js');
const {ensureRuntimeSession}=await coreImport('session/session-workspace-ownership.js');
const {WorkspaceTrustStore}=await coreImport('security/workspace-trust-store.js');
const {resolveGlobalStateHome,resolveProfileStateHome}=await coreImport('config/profile-home.js');
const {probePrivateControl}=await coreImport('gateway/private-control.js');
const home=mkdtempSync('/tmp/ec-research-release-'),workspace=join(home,'workspace');
const profileId='pr6-'+randomBytes(5).toString('hex'),paths=resolveProfileStateHome({homeDir:home,profileId});
mkdirSync(workspace);mkdirSync(paths.profileRoot,{recursive:true});
const source='https://93.184.216.34/fixture/battery-recycling';
const table=`| Source URL | Supported claim | Limitation |\n| --- | --- | --- |\n| ${source} | Synthetic research fixture | Illustrative snippet; not scientific evidence |`;
const report=`# Battery recycling\n\nSynthetic research fixture. [Source](${source})\n${table}`;
let requests=0,phase='research',saveIndex=0,recoveryIndex=0,diagnostics='',providerErrors:string[]=[];
let sessionId='',reportContent='',bridgeVerified=false;
const db=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir:home}).sessionsSqlitePath});
const store=new SQLiteTaskStore({db:db.db,profileId});
const resultService=new TaskResultService({store,profileId,sessionDb:db,contentRoot:paths.taskResultsPath});
const calls:any[]=[];
const tool=(name:string,args:unknown)=>({name,args});
const provider=createServer(async(req,res)=>{
 try{
  assert.equal(req.headers.authorization,undefined);
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4_194_304)throw new Error('Oversized model fixture request');}
  const input=JSON.parse(raw);assert(++requests<=60,'Provider fixture call limit exceeded');
  const text=JSON.stringify(input.messages), tools=input.tools?.map((x:any)=>x.function.name)??[];
  const priorCalls=input.messages.flatMap((m:any)=>m.tool_calls??[]).map((c:any)=>c.function.name);
  // Custom-compatible routes may serialize tool feedback as text instead of native history.
  const hasFeedback=priorCalls.length>0||input.messages.some((m:any)=>m.role==='tool'||typeof m.content==='string'&&m.content.startsWith('EstaCoda executed the requested tools.'));
  let content='',next:ReturnType<typeof tool>[]=[];
  if(phase==='save'){
   const task=store.listTasks()[0],synthesis=store.listSteps(task.id,task.activePlanRevisionId).find((s:any)=>s.executor.role==='synthesis');
   const result=store.listResults(task.id).find((r:any)=>r.stepId===synthesis.id&&r.disposition==='accepted');assert(result);
   if(saveIndex===0)next=[tool('task_result_read',{task_id:task.id,result_id:result.id})];
   else if(saveIndex===1){reportContent=(await resultService.readText({taskId:task.id,resultId:result.id,sessionId})).content;next=[tool('file_write',{path:'report.md',content:reportContent})];}
   else if(saveIndex===2)next=[tool('file_read',{path:'report.md'})];
   else content='Saved report.md.';
   saveIndex++;
  }else if(phase==='recovery'){
   if(recoveryIndex===0)next=[tool('capability_discover',{ids:['skill:researcher']})];
   else if(recoveryIndex===1)next=[tool('capability_request',{ids:['skill:researcher'],reason:'Use the research workflow'})];
   else if(recoveryIndex===2)next=[tool('skill_read',{name:'researcher'})];
   else content='Research instructions loaded.';
   recoveryIndex++;
  }else if(phase==='false-save')content='Saved the report to nonexistent.md.';
  else if(phase==='missing-search'){
   if(!hasFeedback)next=[tool('delegate_task',{task:'Research battery recycling',allowedTools:['web.search'],research:{scope:'methods',requireLiveSources:true,requireRepositoryEvidence:false}})];
   else content='Research is blocked because search is unavailable.';
  }else if(text.includes('Assigned research scopes:')){
   const task=store.listTasks()[0];const accepted=store.listResults(task.id).filter((r:any)=>r.disposition==='accepted');
   if(!hasFeedback)next=accepted.map((r:any)=>tool('task_result_read',{task_id:task.id,result_id:r.id}));
   else content=report;
  }else if(text.includes('Work only on this assigned Step')){
   if(!hasFeedback)next=[tool('web_search',{query:'battery recycling '+requests})];
   else content=`Synthetic evidence: ${source}\n${table}`;
  }else if(!hasFeedback)next=[tool('delegate_task',{tasks:['collection','processing','reuse'].map(scope=>({task:`Research battery recycling: ${scope}.`,allowedTools:['web.search'],research:{scope,requireLiveSources:true,requireRepositoryEvidence:false}}))})];
  else content='Research workers are running; report delivery remains pending.';
  for(const call of next)assert(tools.includes(call.name),'Fixture attempted unexposed tool: '+call.name);
  calls.push({phase,tools:next.map(x=>x.name)});
  const tool_calls=next.map((call,index)=>({index,id:`fixture-${requests}-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}));
  const payload={...(content?{content}:{}),...(next.length?{tool_calls}:{})};
  const result={id:'fixture-'+requests,object:'chat.completion',choices:[{index:0,...(input.stream?{delta:payload}:{message:{role:'assistant',...payload}}),finish_reason:next.length?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:12,total_tokens:42}};
  res.writeHead(200,{'content-type':input.stream?'text/event-stream':'application/json'});
  res.end(input.stream?'data: '+JSON.stringify(result)+'\n\ndata: [DONE]\n\n':JSON.stringify(result));
 }catch(error){providerErrors.push(String(error));res.writeHead(500).end('Fixture failure');}
});
await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`;
writeFileSync(paths.configPath,JSON.stringify({model:{provider:'local',id:'research-release-tools',contextWindowTokens:131072,maxTokens:2048},providers:{local:{enabled:true,enableNetwork:true,authMethod:'none',baseUrl:endpoint,apiMode:'custom_openai_compatible',models:['research-release-tools']}},security:{approvalMode:'open'},skills:{autonomy:'none'},web:{enableNetwork:true,searchBackend:'pr6-fixture',extractBackend:'pr6-fixture'}}));
writeFileSync(join(home,'.estacoda/active-profile.json'),JSON.stringify({profileId}));
await ensureRuntimeSession({sessionDb:db,sessionId:'target-registration',profileId,workspaceRoot:workspace,homeDir:home,durable:true});
const binding=(await db.getSession('target-registration')).executionTarget;
const target={targetId:binding.targetId,targetGeneration:binding.targetGeneration};
await new WorkspaceTrustStore({homeDir:home}).grant(workspace);
const bootstrap=join(home,'supervisor.mjs'),searchLog=join(home,'searches.jsonl'),missingFlag=join(home,'missing-search');
writeFileSync(bootstrap,`import {appendFileSync,existsSync} from 'node:fs';
import {registerWebResearchProvider} from ${JSON.stringify(pathToFileURL(join(core,'tools/web-research-registry.js')).href)};
import {runGatewaySupervisor} from ${JSON.stringify(pathToFileURL(join(core,'gateway/supervisor.js')).href)};
registerWebResearchProvider({name:'pr6-fixture',displayName:'Synthetic release evidence',capabilities:{search:true,extract:true},getAvailability:()=>({available:!existsSync(${JSON.stringify(missingFlag)}),reason:'Fixture search disabled'}),search:async query=>{appendFileSync(${JSON.stringify(searchLog)},JSON.stringify({query})+'\\n');return [{title:'Synthetic study',url:${JSON.stringify(source)},snippet:'Illustrative fixture; not scientific evidence.'}];},extract:async url=>({url,content:'Illustrative research fixture',status:200})});
await runGatewaySupervisor(${JSON.stringify({homeDir:home,workspaceRoot:workspace,profileId})});`);
const supervisor=spawn(join(runtimeRoot,'node'),[bootstrap],{cwd:runtimeRoot,env:{HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore','pipe','pipe']});
for(const stream of [supervisor.stdout,supervisor.stderr])stream!.on('data',data=>{diagnostics=(diagnostics+data).slice(-16000);});
let app:ChildProcess|undefined,browser:Browser|undefined,page:Page|undefined;
async function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),10000);await ended;clearTimeout(kill);}
async function stopApp(){await browser?.close();browser=undefined;await stop(app);app=undefined;}
async function launch(){
 const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
 app=spawn(join(appRoot,'Contents/MacOS/EstaCoda'),[`--remote-debugging-port=${port}`,`--user-data-dir=${join(home,'desktop-data')}`],{env:{HOME:home,CFFIXED_USER_HOME:home,USERPROFILE:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'},stdio:['ignore','ignore','pipe']});
 app.stderr!.on('data',data=>{diagnostics=(diagnostics+data).slice(-16000);});
 await expect.poll(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},{timeout:30000}).toBe(true);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 await expect.poll(()=>{page=browser!.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('estacoda://app/'));return !!page;},{timeout:30000}).toBe(true);
 await expect.poll(()=>page!.evaluate(async()=>(await window.desktop.snapshot()).status),{timeout:30000}).toBe('ready');
 // Verify the app spawned its retained packaged Node/core, not a CLI from PATH.
 const pids=execFileSync('pgrep',['-P',String(app.pid)],{encoding:'utf8'}).trim().split(/\s+/);
 const commands=pids.map(pid=>execFileSync('ps',['-p',pid,'-o','command='],{encoding:'utf8'}));
 assert(commands.some(command=>command.includes(`/runtime-versions/${manifest.runtimeSha256}/node`)&&command.includes('desktop-service')),'App did not launch its verified owned bridge');
 const retained=join(home,'desktop-data/runtime-versions',manifest.runtimeSha256);verifyRuntimeInventory(retained,manifest);bridgeVerified=true;
}
const submittedText=new Map<string,string>();
async function submit(text:string,workId?:string){
 const result=await page!.evaluate(input=>window.desktop.work!.submit(input),{draftId:randomBytes(8).toString('hex'),target,text,attachmentIds:[],...(workId?{workId}:{})});
 submittedText.set(result.workId,text);return result;
}
async function idle(workId:string){
 // Operation admission and cached UI status can precede actual turn settlement.
 // Fence on the exact submitted user message's persisted outcome before changing fixture phases.
 const id=workId.replace(/^session:/,'');
 await expect.poll(async()=>{
  const user=(await db.listMessages(id)).filter((m:any)=>m.role==='user'&&m.content===submittedText.get(workId)).at(-1);
  return !!user&&(await db.listEvents(id)).some((e:any)=>e.kind==='execution-final-outcome-recorded'&&e.turnMessageId===user.id);
 },{timeout:60000}).toBe(true);
 await expect.poll(()=>page!.evaluate(id=>window.desktop.work!.inspect(id).then(x=>x?.state).catch(()=>'unavailable'),workId),{timeout:60000}).toBe('completed');
}
const searches=()=>existsSync(searchLog)?readFileSync(searchLog,'utf8').trim().split('\n').length:0;
try{
 await expect.poll(async()=>{try{return(await probePrivateControl({directory:paths.gatewayStatePath,profileId,version:manifest.coreVersion})).instanceId;}catch{return null;}},{timeout:30000}).not.toBeNull();
 await launch();console.log('Verified packaged app and owned bridge.');
 const initial=await submit('Use the researcher skill and use 3 subagents to research current battery recycling. Save report.md');sessionId=initial.workId.replace(/^session:/,'');
 await expect.poll(()=>{assert.deepEqual(providerErrors,[]);return store.listTasks().length;},{timeout:60000}).toBe(1);
 await expect.poll(()=>store.listTasks()[0]?.status,{timeout:120000}).toBe('partial');
 const task=store.listTasks()[0],steps=store.listSteps(task.id,task.activePlanRevisionId),workers=steps.filter((s:any)=>s.executor.role==='worker'),synthesis=steps.find((s:any)=>s.executor.role==='synthesis');
 assert.equal(workers.length,3);assert.deepEqual(new Set(synthesis.dependsOn),new Set(workers.map((s:any)=>s.id)));assert.equal(store.listResults(task.id).filter((r:any)=>r.disposition==='accepted').length,4);assert.equal(searches(),3);assert(!existsSync(join(workspace,'report.md')));
 const workerSessions=new Set(store.listAttempts(task.id).map((a:any)=>a.workerSessionId));assert.equal(workerSessions.size,4);assert(!workerSessions.has(sessionId));
 await idle(initial.workId);const beforeRestart=requests;await stopApp();await launch();assert.equal(requests,beforeRestart);
 phase='save';await submit('Save this report to report.md',initial.workId);await idle(initial.workId);
 await expect.poll(()=>existsSync(join(workspace,'report.md')),{timeout:60000}).toBe(true);
 await expect.poll(()=>page!.evaluate(id=>window.desktop.getWork(id).then(x=>x.status).catch(()=>'unavailable'),initial.workId),{timeout:60000}).toBe('completed');
 assert.equal(readFileSync(join(workspace,'report.md'),'utf8'),reportContent);assert(reportContent.includes('| Retrieved |'));assert.equal(store.listTasks().length,1);assert.equal(searches(),3);
 const events=await db.listEvents(sessionId);assert(events.some((e:any)=>e.kind==='tool-result'&&e.tool==='file.read'&&e.result.ok));
 console.log('Three workers, synthesis, app restart and verified save passed.');
 phase='recovery';const recovered=await submit('Find recent battery research.');await expect.poll(()=>recoveryIndex,{timeout:60000}).toBe(4);await idle(recovered.workId);
 const recoveryEvents=await db.listEvents(recovered.workId.replace(/^session:/,''));assert(recoveryEvents.some((e:any)=>e.kind==='tool-result'&&e.tool==='skill.read'&&e.result.ok));
 phase='false-save';const falseSave=await submit('Save this report as nonexistent.md');await idle(falseSave.workId);await expect.poll(()=>page!.evaluate(id=>window.desktop.getWork(id).then(x=>x.status).catch(()=>'unavailable'),falseSave.workId),{timeout:60000}).toBe('needs_attention');assert(!existsSync(join(workspace,'nonexistent.md')));
 const falseSaveEvents=await db.listEvents(falseSave.workId.replace(/^session:/,''));assert(falseSaveEvents.some((e:any)=>e.kind==='execution-final-outcome-recorded'&&e.status==='blocked'));
 phase='missing-search';writeFileSync(missingFlag,'disabled');const missing=await submit('Use the researcher skill to research battery recycling.');await expect.poll(()=>calls.some(x=>x.phase==='missing-search'&&x.tools.length===0),{timeout:60000}).toBe(true);await idle(missing.workId);assert.equal(store.listTasks().length,1);
 const missingEvents=await db.listEvents(missing.workId.replace(/^session:/,''));assert(missingEvents.some((e:any)=>e.kind==='tool-result'&&e.tool==='delegate_task'&&e.result.ok===false));
 assert.deepEqual(providerErrors,[]);
 const allSessionIds=new Set([sessionId,...workerSessions,recovered.workId.replace(/^session:/,''),falseSave.workId.replace(/^session:/,''),missing.workId.replace(/^session:/,'')]);
 const allEvents=(await Promise.all([...allSessionIds].map(id=>db.listEvents(id)))).flat();
 const toolResults=allEvents.filter((e:any)=>e.kind==='tool-result');
 assert.equal(toolResults.length,calls.reduce((n,x)=>n+x.tools.length,0));
 const sourceOverlay=['package.json','src/eval/fixtures/research-workflow-harness.ts','src/eval/fixtures/research-workflow-release.ts','src/runtime/research-surfaces.acceptance.test.ts','scripts/validate-research-reliability.ts','apps/desktop/tests/research-packaged.mts'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
 const measurements={
  version:1,passed:true,measuredAt:new Date().toISOString(),sourceBaseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceOverlay,
  platform:process.platform,arch:process.arch,
  runtime:{sha256:manifest.runtimeSha256,nodeVersion:manifest.nodeVersion,coreVersion:manifest.coreVersion,entrySha256:manifest.entrySha256,signature:'ad-hoc verified',ownedBridgeVerified:bridgeVerified,inventoryVerified:true,matchesCurrentDist:true},
  fixtures:{model:'scripted loopback HTTP',web:'in-process registered synthetic provider in packaged supervisor',liveModelCalls:0,transport:'actual signed app + preload/Main + owned bridge + private control'},
  workflow:{workers:workers.length,acceptedResults:store.listResults(task.id).filter((r:any)=>r.disposition==='accepted').length,distinctChildSessions:workerSessions.size,tasks:store.listTasks().length,searches:searches(),providerCalls:calls.filter(c=>['research','save'].includes(c.phase)).length,appRestartNoReplay:true,fileBytes:Buffer.byteLength(reportContent),fileSha256:createHash('sha256').update(reportContent).digest('hex'),readbackVerified:true,historicalTaskStatus:store.getTask(task.id).status},
  allScenarios:{providerCalls:requests,actualToolResults:toolResults.length,failedToolResults:toolResults.filter((e:any)=>!e.result.ok).length},
  scenarios:{research:true,saveOnlyAfterRestart:true,skillRecovery:true,missingSearch:true,falseSaveBlocked:true},
  liveAssessment:'pending approved model, sources and spend ceiling'
 };
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(measurements,null,2)+'\n');
 console.log('Packaged research release checks passed: '+output);
}catch(error){console.error('Fixture errors:',providerErrors);console.error('Provider phases:',calls);console.error('Task state:',JSON.stringify(store.listTasks().map((t:any)=>({status:t.status,steps:store.listSteps(t.id,t.activePlanRevisionId).map((s:any)=>({role:s.executor.role,status:s.status})),attempts:store.listAttempts(t.id).map((a:any)=>({status:a.status,failure:a.failure}))})),null,2));console.error(diagnostics);throw error;}
finally{await stopApp();await stop(supervisor);db.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});}

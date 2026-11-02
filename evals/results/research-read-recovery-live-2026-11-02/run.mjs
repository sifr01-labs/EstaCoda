// Explicitly authorized live Codex research through the production durable Task scheduler.
// Run from the repository: node --import tsx <this-file> <existing-prepared-tmp-root> prepare|before|after
import {mkdir,readFile,writeFile,rm,symlink,cp,readdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=process.cwd(),root=resolve(process.argv[2]??''),arm=process.argv[3],out=dirname(fileURLToPath(import.meta.url));
if(!root.startsWith('/private/tmp/')||!['prepare','before','after'].includes(arm))throw Error('Expected prepared /private/tmp root and prepare|before|after');
const hash=s=>createHash('sha256').update(s).digest('hex');
const hermesRevision='5e7c2b254d414e4e25105231f818f385fee67469';
const budgets={maxProviderIterations:18,maxProviderToolCalls:42,maxProviderWallClockMs:300000,maxRepeatedToolFailures:5,finalizationReserveMs:20000};
const objective='Compare how EstaCoda and Hermes accept delegated research after local read errors. Inspect the supplied pinned source snapshots, trace implementation rather than relying on comments, and recommend a small defensible acceptance policy. Distinguish execution authorization, available report text, evidence coverage, and verified task completion. Cite exact repository paths and symbols. Return a substantial readable report (about 800 words) with concrete findings from BOTH codebases, limitations, and a regression-test plan. No performance winner or claims of executed tests: this is a source investigation.';
const probes='Reproduce these two harmless read-input failures once each before your source investigation: terminal.inspect with argv ["git","log","-1"] and file.grep with pattern "hasUnrecoveredToolFailure", path "estacoda/src/tasks", max_filesize "". Then recover using supported arguments (for example git log -n 1 and a valid grep size) or another authorized read. Do not repeat a rejected formulation or bypass permissions. These are deliberately seeded regression probes, not evidence about the code. Read MANIFEST.json for actual source revisions; the workspace Git HEAD identifies only the fixture.';
const tasks=[{task:`Inspect EstaCoda. ${probes} Trace hasUnrecoveredToolFailure, researchCompletionFailure, researchReadLimitations, researchEvidenceFailure and settlement in estacoda/src/tasks/agent-step-executor.ts. Use successful discovery and file.read observations, cite paths and symbols, and report what remains unverified. Inspect only the relevant sections; do not dump whole large files.`,research:{scope:'estacoda-source',requireLiveSources:false,requireRepositoryEvidence:true}},
{task:'Inspect Hermes in hermes/tools/delegate_tool_child_run.py (_build_result_entry, _validate_child_output_schema), hermes/agent/turn_tool_round.py and hermes/agent/turn_stop_gates.py. Use discovery and file.read. Explain how tool errors, real run failures, partial output and schema failures affect delegated results. Cite paths and symbols; distinguish observed code from inference. Read MANIFEST.json for source revision. Inspect relevant sections, not whole large files.',research:{scope:'hermes-source',requireLiveSources:false,requireRepositoryEvidence:true}}];
async function fingerprints(dir){const values={};async function walk(path,rel=''){for(const e of await readdir(path,{withFileTypes:true})){if(e.name==='.git')continue;const r=join(rel,e.name);if(e.isDirectory())await walk(join(path,e.name),r);else if(e.isFile())values[r]=hash(await readFile(join(path,e.name)));}}await walk(dir);return values;}
if(arm==='prepare'){
  const before='c7d656c614d9acf5b9649148fa2d6d6e8c5b3c4b';
  const beforeSource=join(root,'before-source');await mkdir(beforeSource,{recursive:true});
  execFileSync('tar',['-xf','-','-C',beforeSource],{input:execFileSync('git',['archive',before],{maxBuffer:256*1024*1024})});
  await symlink(join(repo,'node_modules'),join(beforeSource,'node_modules'));
  const fixture=join(root,'fixture');await mkdir(join(fixture,'estacoda/src/tasks'),{recursive:true});
  for(const p of ['agent-step-executor.ts','research-result-evidence.ts','agent-step-executor.test.ts'])await cp(join(repo,'src/tasks',p),join(fixture,'estacoda/src/tasks',p));
  for(const p of ['tools/delegate_tool_child_run.py','agent/tool_executor.py','agent/turn_tool_round.py','agent/turn_stop_gates.py']) {
    const target=join(root,'hermes',p);try{await readFile(target);}catch{
      const response=await fetch(`https://raw.githubusercontent.com/NousResearch/hermes-agent/${hermesRevision}/${p}`);
      if(!response.ok)throw Error(`Source fetch failed: ${p} ${response.status}`);
      await mkdir(dirname(target),{recursive:true});await writeFile(target,await response.text());
    }
  }
  await cp(join(root,'hermes'),join(fixture,'hermes'),{recursive:true});
  const inputHashes=await fingerprints(fixture);
  const manifest={before,hermesRevision,afterSourceHashes:{'src/tasks/agent-step-executor.ts':hash(await readFile(join(repo,'src/tasks/agent-step-executor.ts')))},inputHashes,objective,tasks,budgets,model:'codex/gpt-6.1-sol',scope:'Two real model research workers plus live synthesis per arm; deliberately seeded real read failures. Same curated source snapshots in both arms. No Telegram or upstream test execution. Runtime before is pinned c7d656c61; after is the working tree.'};
  await writeFile(join(fixture,'MANIFEST.json'),JSON.stringify(manifest,null,2));await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  for(const a of ['before','after']){const w=join(root,a,'workspace');await cp(fixture,w,{recursive:true});execFileSync('git',['init','-q',w]);execFileSync('git',['-C',w,'add','.']);execFileSync('git',['-C',w,'-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','commit','-qm','Pinned research source fixture']);}
  console.log('Prepared isolated source snapshots.');process.exit(0);
}
const source=arm==='before'?join(root,'before-source'):repo;
const imp=p=>import(join(source,'src',p));
const {loadRuntimeConfig}=await imp('config/runtime-config.ts');
const {resolveProfileStateHome}=await imp('config/profile-home.ts');
const {redactBenchmarkArtifact}=await imp('benchmark/redaction.ts');
const {createRuntime}=await imp('runtime/create-runtime.ts');
const {createSQLiteSessionDB}=await imp('session/session-setup.ts');
const {SQLiteTaskStore}=await imp('tasks/sqlite-task-store.ts');
const {TaskResultService}=await imp('tasks/task-result-service.ts');
const {TaskScheduler}=await imp('tasks/task-scheduler.ts');
const {DurableDelegationService}=await imp('delegation/durable-delegation-service.ts');
const {DEFAULT_DELEGATION_CONFIG}=await imp('config/delegation-defaults.ts');
const {resolveTaskWorkspaceBinding}=await imp('tasks/task-workspace.ts');
const {WorkspaceTrustStore}=await imp('security/workspace-trust-store.ts');
const {resolveTokens}=await imp('theme/token-resolver.ts');
const base=join(root,arm),homeDir=join(base,'home'),workspaceRoot=join(base,'workspace'),profile=join(homeDir,'.estacoda/profiles/default');
await mkdir(profile,{recursive:true});await mkdir(join(out,arm),{recursive:true});
const selected=await loadRuntimeConfig({workspaceRoot:repo,configurationInspection:true});
const auth=JSON.parse(await readFile(resolveProfileStateHome({profileId:selected.profileId}).authJsonPath,'utf8'));
const {refreshToken,...token}=auth.providers.codex;if(!token.accessToken)throw Error('Selected Codex credential unavailable');
const authPath=join(profile,'auth.json');
const config={model:{provider:'codex',id:'gpt-6.1-sol',fallbacks:[]},providers:{codex:{kind:'openai-compatible',apiMode:'openai_responses',authMethod:'oauth_device_pkce',enableNetwork:true,models:['gpt-6.1-sol']}},web:{enableNetwork:false},skills:{autonomy:'none'}};
await writeFile(join(profile,'config.json'),JSON.stringify(config),{mode:0o600});
const safe=v=>JSON.parse(JSON.stringify(redactBenchmarkArtifact(v)).replaceAll(root,'<BENCHMARK_ROOT>').replaceAll(repo,'<REPOSITORY>'));
const save=(p,v)=>writeFile(join(out,arm,p),JSON.stringify(safe(v),null,2));
const initial=await fingerprints(workspaceRoot);const started=Date.now();let runtime,db,store,taskId,error;
try{
 await writeFile(authPath,JSON.stringify({version:auth.version,providers:{codex:token}}),{mode:0o600});
 if(process.argv[4]==='export-only'){db=await createSQLiteSessionDB({path:join(base,'sessions.sqlite')});store=new SQLiteTaskStore({db:db.db,profileId:'default'});taskId=store.listTasks()[0]?.id;} else {
 const cfg=await loadRuntimeConfig({workspaceRoot,homeDir,profileId:'default'});
 const trust=new WorkspaceTrustStore({homeDir});await trust.grant(workspaceRoot);
 db=await createSQLiteSessionDB({path:join(base,'sessions.sqlite')});store=new SQLiteTaskStore({db:db.db,profileId:'default'});
 runtime=await createRuntime({homeDir,workspaceRoot,profileId:'default',sessionDb:db,trustStore:trust,workspaceTrusted:true,tokens:resolveTokens('standard','dark','kemetBlue'),
 model:cfg.model,primaryModelRoute:cfg.primaryModelRoute,modelFallbackRoutes:[],providerRegistry:cfg.providerRegistry,providerConfigs:cfg.config.providers,
 localSkillsRoot:join(profile,'skills'),skillAutonomy:'none',enableWebNetwork:false,disableCronTools:true,enabledToolsets:['core','files','shell-readonly','research'],securityMode:'adaptive',
 executionControls:{providerBudgets:budgets,providerRequestDefaults:{temperature:0,maxTokens:5000},childProcessEnv:{mode:'isolated',homeDir}}});
 const service=new DurableDelegationService({store,creatorSessionId:()=>runtime.sessionId,workspace:await resolveTaskWorkspaceBinding(workspaceRoot),config:DEFAULT_DELEGATION_CONFIG,visibleTools:()=>runtime.tools()});
 const allowedTools=['file.read','file.grep','file.glob','terminal.inspect'];
 const handle=service.create({toolCallId:`live-${arm}`,trustedWorkspace:true,tasks:tasks.map(t=>({...t,allowedTools})),synthesis:{objective},requestContract:{version:1,objective,requirements:{skillReferences:[],issues:[],research:{fresh:false,domain:'general'}}}});
 taskId=handle.taskId;const task=store.getTask(taskId),ownerId=`live-${arm}`;
 if(!store.acquireTaskHostLease({taskId,workspaceIdentityHash:task.workspace.identityHash,ownerId,kind:'foreground',acquiredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString()}))throw Error('No host lease');
 const resultService=new TaskResultService({store,profileId:'default',sessionDb:db,contentRoot:resolveProfileStateHome({homeDir,profileId:'default'}).taskResultsPath});
 const scheduler=new TaskScheduler({store,resultService,ownerId,limits:{maxProfileConcurrentAttempts:1},resolveExecutor:()=>runtime.taskAgentExecutor});
 for(let i=0;i<5;i++){console.log(JSON.stringify({arm,phase:'scheduler',round:i,status:store.getTask(taskId).status}));const result=await scheduler.runOnce();await save(`round-${i}.json`,result);if(['completed','partial','failed','cancelled'].includes(store.getTask(taskId).status)||result.claimed===0)break;}
 for(const r of store.listResults(taskId)){let offset=0,content='';while(true){const page=await resultService.readText({taskId,resultId:r.id,sessionId:runtime.sessionId,offset,maxChars:20000});content+=page.content;if(page.nextOffset===undefined)break;offset=page.nextOffset;}
   await writeFile(join(out,arm,`${r.disposition}-${r.stepId}.md`),safe(content));}
 }
}catch(e){error=String(e);console.error(error);}
finally{
 try {
 const sessions=[];if(db)for(const s of await db.listSessions())sessions.push({session:s,messages:await db.listMessages(s.id),events:await db.listEvents(s.id)});
 const usage=db?await db.listProviderUsageEntries('default'):[];
 const final=await fingerprints(workspaceRoot);
 await save('transcript.json',sessions);await save('usage.json',usage);
 const summary={arm,error,exportOnly:process.argv[4]==='export-only',elapsedMs:Date.now()-started,inputsUnchanged:JSON.stringify(initial)===JSON.stringify(final),task:taskId?store.getTask(taskId):null,steps:taskId?store.listSteps(taskId,store.getTask(taskId).activePlanRevisionId):[],attempts:taskId?store.listAttempts(taskId):[],results:taskId?store.listResults(taskId):[],events:taskId?store.listEvents(taskId):[],providerCalls:usage.length};
 await save('summary.json',summary);console.log(JSON.stringify({arm,error,status:summary.task?.status,steps:summary.steps.map(s=>({title:s.title,status:s.status})),providerCalls:usage.length,elapsedMs:summary.elapsedMs}));
 } finally {try{if(runtime)await runtime.dispose();else if(db)await db.close();}finally{await rm(authPath,{force:true});}}
}

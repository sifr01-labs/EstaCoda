// Run against an immutable baseline build and the candidate build with identical isolated profile settings.
import fs from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
const repo=process.cwd();
const root=process.env.RUN_ROOT;
if(!root)throw Error('RUN_ROOT required: use a fresh isolated output directory');
const core=process.env.RUNTIME_CORE;
if(!core)throw Error('RUNTIME_CORE required');
const imp=p=>import(pathToFileURL(join(core,'dist',p)).href);
const {createRuntime}=await imp('runtime/create-runtime.js');
const {loadRuntimeConfig}=await imp('config/runtime-config.js');
const {createSQLiteSessionDB}=await imp('session/session-setup.js');
const {SQLiteTaskStore}=await imp('tasks/sqlite-task-store.js');
const {TaskScheduler}=await imp('tasks/task-scheduler.js');
const {TaskResultService}=await imp('tasks/task-result-service.js');
const {resolveProfileStateHome}=await imp('config/profile-home.js');
const {WorkspaceTrustStore}=await imp('security/workspace-trust-store.js');
const {createSecurityPolicyForMode}=await imp('security/security-policy-factory.js');
const {resolveTokens}=await imp('theme/token-resolver.js');
const manifest=JSON.parse(await fs.readFile(join(repo,'evals/fixtures/live-workflows-120-2026-10-18.json'),'utf8')).filter(c=>['early-03-local-search','early-04-code-fix-tests'].includes(c.id));
// Controlled long workload: individual case decisions require progressing tool turns.
// This stresses completion ceilings; it is not a representative speed benchmark.
const long={id:'long-refund-review',fixtureSource:'controlled long live workload',files:{},mutable:[],checks:[],additionalOutputs:[]};
for(let i=1;i<=52;i++){
 const caseId=`R${String(i).padStart(3,'0')}`,daysSinceDelivery=i*7%43,used=i%5===0,customMade=i%7===0,paidCents=1234+137*i;
 const eligible=daysSinceDelivery<=30&&!used&&!customMade,path=`decisions/${caseId}.json`;
 long.files[`cases/${caseId}.json`]=JSON.stringify({caseId,daysSinceDelivery,used,customMade,paidCents})+'\n';
 long.checks.push({kind:'json',path,value:{caseId,eligible,refundCents:eligible?paidCents:0}});long.additionalOutputs.push(path);
}
long.prompt="Review the 52 refund requests in cases/R001.json through cases/R052.json. A refund is eligible only if delivery was at most 30 days ago, the product is unused, and it is not custom made. Eligible requests receive exactly paidCents; others receive 0. Save each decision in the decisions directory, preserving its input filename, with exactly caseId, eligible (boolean), refundCents (integer). After all 52 decisions are saved, write summary.json containing exactly {\"reviewed\":52}. This is a sequential case-review workflow: finish and save each individual case before reading the next case. Use individual file read/write tools, not shell commands, scripts, bulk reads, batching, or delegation. Preserve all input files. Process all 52 cases, then give a brief completion summary. No questions or approval needed beyond normal policy.";
long.checks.push({kind:"json",path:"summary.json",value:{reviewed:52}});long.additionalOutputs.push("summary.json");
manifest.push(long);
const taskCases=Object.values(long.files).map(JSON.parse),eligibleCases=taskCases.filter(c=>c.daysSinceDelivery<=30&&!c.used&&!c.customMade);
manifest.push({id:'task-refund-audit',task:true,fixtureSource:'live durable Task audit',files:long.files,mutable:[],checks:[],
 expectedTaskResult:{reviewed:52,eligibleCount:eligibleCases.length,totalRefundCents:eligibleCases.reduce((sum,c)=>sum+c.paidCents,0)},
 prompt:'Read and audit the 52 refund requests in cases, one file at a time in numerical order. Use individual file reads, no batching, scripts, or delegation. A refund is eligible only when delivery was at most 30 days ago, the item is unused, and it was not custom made. Eligible refunds equal paidCents. Do not change any files. Review all 52 records and return a final JSON object with exactly reviewed, eligibleCount, totalRefundCents. Do not claim completion until all records have been read.'});
const resume={...long,id:'resume-short-review',resume:true,files:Object.fromEntries(Object.entries(long.files).slice(0,4)),checks:long.checks.slice(0,4),additionalOutputs:long.additionalOutputs.slice(0,4),prompt:long.prompt.replaceAll('R052','R004').replaceAll('52','4')};
resume.checks=[...resume.checks,{kind:'json',path:'summary.json',value:{reviewed:4}}];resume.additionalOutputs=[...resume.additionalOutputs,'summary.json'];manifest.push(resume);
await fs.mkdir(root,{recursive:true});
const homeDir=process.env.EVAL_HOME,profileId=process.env.EVAL_PROFILE||'default';
if(!homeDir)throw Error('EVAL_HOME required: use an isolated profile home with test provider credentials');
const wanted=new Set((process.env.CASES||'').split(',').filter(Boolean));
const cases=manifest.filter(c=>!wanted.size||wanted.has(c.id));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function exists(p){try{await fs.access(p);return true}catch{return false}}
async function walk(p,base=p){let out={};for(const e of await fs.readdir(p,{withFileTypes:true})){if(e.name==='.estacoda'||e.name==='.git')continue;const f=join(p,e.name);if(e.isDirectory())Object.assign(out,await walk(f,base));else if(e.isFile())out[f.slice(base.length+1)]=await fs.readFile(f,'utf8')}return out}
function approve(c,r){const command=r.input.command; if(c.testCommand&&typeof command==='string'&&command.trim()===c.testCommand.join(' '))return 'approved';return 'denied'}
async function check(c,r,workspace){
 const faults=[];const files=await walk(workspace);r.files=Object.fromEntries(Object.entries(files).map(([p,v])=>[p,{bytes:Buffer.byteLength(v),sha256:hash(v)}]));
 for(const [p,v]of Object.entries(c.files||{}))if(!(c.mutable||[]).includes(p)&&files[p]!==v)faults.push('input-changed:'+p);
 for(const p of c.absent||[])if(p in files)faults.push('forbidden-file:'+p);
 let body=c.output?files[c.output]:r.turns.at(-1)?.text||'';
 if(c.output&&body===undefined)faults.push('missing-output:'+c.output);
 if(c.exact!==undefined&&body!==c.exact)faults.push('exact-content');
 for(const k of c.contains||[])if(!body?.toLowerCase().includes(k.toLowerCase()))faults.push('review-missing-text:'+k);
 for(const x of c.checks||[]){try{if(x.kind==='json'&&!isDeepStrictEqual(JSON.parse(files[x.path]),x.value))faults.push('json-value:'+x.path);if(x.kind==='copy'&&files[x.path]!==files[x.source])faults.push('copy-content:'+x.path)}catch{faults.push('invalid-json:'+x.path)}}
 for(const p of c.additionalOutputs||[])if(!(p in files))faults.push('missing-output:'+p);
 if(c.jsonKeys)try{const j=JSON.parse(body);if(!isDeepStrictEqual(Object.keys(j).sort(),[...c.jsonKeys].sort()))faults.push('json-keys')}catch{faults.push('invalid-json')}
 if(c.jsonFields)try{const j=JSON.parse(body);if(!Array.isArray(j)||j.some(x=>!isDeepStrictEqual(Object.keys(x).sort(),[...c.jsonFields].sort())))faults.push('json-fields')}catch{faults.push('invalid-json')}
 for(const p of c.placeholders||[])if(!body?.includes(p))faults.push('placeholder:'+p);
 if(c.arabic&&!/[\u0600-\u06ff]/u.test(body||''))faults.push('arabic-missing');
 if(c.cited&&!/https?:\/\//.test(body||''))faults.push('citations-missing');
 if(c.testCommand){const t=spawnSync(process.execPath,c.testCommand.slice(1),{cwd:workspace,encoding:'utf8',timeout:30000});r.codeTest={status:t.status,output:(t.stdout+t.stderr).slice(-8000)};if(t.status!==0)faults.push('code-test');}
 if(c.resume){
  if(r.turns.length<2||!r.turns[0].text.includes('configured run limit'))faults.push('missing-explicit-budget-stop');
  if(r.turns.some(t=>(t.turnUsage?.mainAgent?.providerCalls??Infinity)>4))faults.push('per-turn-budget-exceeded');
  const writes=r.turns.flatMap(t=>t.toolExecutions).filter(t=>t.tool.name==='file.write').map(t=>t.input.path);
  if(new Set(writes).size!==writes.length)faults.push('repeated-completed-write');
 }
 if(c.expectedTaskResult){try{const text=r.resultText??'',match=text.match(/\{[^{}]*\}/s);if(!match||!isDeepStrictEqual(JSON.parse(match[0]),c.expectedTaskResult))faults.push('task-result-value');}catch{faults.push('task-result-json');}}
 const status=r.tasks.length?r.tasks.at(-1).status:r.turns.at(-1)?.finalOutcome?.status;r.status=status;
 if(!c.expectedBlocked&&!['completed','completed_with_recovered_errors'].includes(status))faults.push('outcome:'+status);
 r.checkFaults=faults;r.automatedVerdict=faults.length?'review':'pass';
}
async function run(c){
 const dir=join(root,c.id),resultPath=join(dir,'result.json');if(await exists(resultPath)){console.log('SKIP',c.id);return}
 await fs.mkdir(dir,{recursive:true});const workspace=join(dir,'workspace');await fs.mkdir(workspace,{recursive:true});
 for(const[p,v]of Object.entries(c.files||{})){const dest=resolve(workspace,p);if(!dest.startsWith(workspace+'/'))throw Error('unsafe fixture');await fs.mkdir(dirname(dest),{recursive:true});await fs.writeFile(dest,v)}
 const r={id:c.id,fixtureSource:c.fixtureSource,startedAt:new Date().toISOString(),turns:[],tasks:[],approvals:[],build:core};
 console.log('START',c.id);let runtime,db;const sessionId=randomUUID();
 const trustStore=new WorkspaceTrustStore({path:join(dir,'trust.json')});await trustStore.grant(workspace);
 const loaded=await loadRuntimeConfig({homeDir,profileId,workspaceRoot:workspace});
 r.model={provider:loaded.model.provider,id:loaded.model.id};r.routingMode=loaded.routing.mode;
 const basePolicy=createSecurityPolicyForMode('adaptive');
 const denied=q=>c.denyWrites&&['workspace-write','destructive-local'].includes(q.riskClass);
 const securityPolicy={decide:q=>denied(q)?'deny':basePolicy.decide(q),assess:async q=>denied(q)?{decision:'deny',mode:'adaptive',reason:'Test scenario: operator denied file mutation',risk:'high',deterministicRule:'fixture-denied-write'}:basePolicy.assess(q)};
 async function build(){db=await createSQLiteSessionDB({path:join(dir,'sessions.sqlite')});runtime=await createRuntime({homeDir,profileId,sessionId,workspaceRoot:workspace,sessionDb:db,closeSessionDbOnDispose:false,tokens:resolveTokens('standard','dark','kemetBlue'),model:loaded.model,primaryModelRoute:loaded.primaryModelRoute,modelFallbackRoutes:[],providerRegistry:loaded.providerRegistry,providerConfigs:loaded.config.providers,auxiliaryModels:loaded.auxiliaryModels,trustStore,workspaceTrusted:true,userMemoryRoot:join(dir,'memory'),projectMemoryRoot:join(dir,'project-memory'),localSkillsRoot:join(dir,'local-skills'),memory:{...loaded.memory,retrieval:{...loaded.memory.retrieval,enabled:false},index:{...loaded.memory.index,enabled:false},curation:{...loaded.memory.curation,mode:'manual',auditOnRuntimeDispose:false}},browser:{backend:'unconfigured',autoLaunch:false},enableWebNetwork:true,webConfig:loaded.web,securityPolicy,securityMode:'adaptive',enabledToolsets:['core','files','web','research','coding','shell-readonly','shell-write'],disableCronTools:true,enableTaskSessionCompletion:true});}
 async function turn(text,kind){const events=[];const res=await runtime.handle({text,channel:'cli',signal:AbortSignal.timeout(2400000),onEvent:e=>events.push(e),onApprovalRequest:async q=>{const decision=approve(c,q);r.approvals.push({tool:q.tool.name,input:q.input,decision});return decision}});await fs.writeFile(join(dir,`events-${r.turns.length}.json`),JSON.stringify(events,null,2));const out={kind,text:res.text,finalOutcome:res.finalOutcome,completionValidationFailure:res.completionValidationFailure,toolExecutions:res.toolExecutions,matchedSkills:res.matchedSkills,intent:res.intent,turnUsage:res.turnUsage};r.turns.push(out);await fs.writeFile(join(dir,'progress.json'),JSON.stringify(r,null,2));}
 try{
 await build();
 if(c.setupPrompt){await turn(c.setupPrompt,'setup');await runtime.dispose();await db.close();await build()}
 if(c.task)await runtime.beginTask(c.prompt);else await turn(c.prompt,'initial');
 if(c.resume){for(let i=0;i<7&&!['completed','completed_with_recovered_errors'].includes(r.turns.at(-1)?.finalOutcome?.status);i++){await runtime.dispose();await db.close();await build();await turn('Continue','explicit-user-continuation');}}
 if(c.followup){await runtime.dispose();await db.close();await build();await turn(c.followup,'followup')}
 const store=new SQLiteTaskStore({db:db.db,profileId});const tasks=store.listTasks();
 if(tasks.length){const ownerId='live120-'+sessionId;const results=new TaskResultService({store,profileId,sessionDb:db,contentRoot:resolveProfileStateHome({homeDir,profileId}).taskResultsPath});const scheduler=new TaskScheduler({store,resultService:results,ownerId,limits:{maxProfileConcurrentAttempts:1},resolveExecutor:()=>runtime.taskAgentExecutor});for(let i=0;i<15;i++){const active=store.listTasks().filter(t=>['queued','running'].includes(t.status));if(!active.length)break;for(const t of active)store.acquireTaskHostLease({taskId:t.id,workspaceIdentityHash:t.workspace.identityHash,ownerId,kind:'foreground',acquiredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString()});const iteration=await scheduler.runOnce();await fs.appendFile(join(dir,'scheduler.jsonl'),JSON.stringify(iteration)+'\n');if(!iteration.completed&&!iteration.failed&&!iteration.started)break;}
 for(const task of store.listTasks())for(const result of store.listResults(task.id)){if(result.status==='available')try{r.resultText=(await results.readText({taskId:task.id,resultId:result.id,sessionId})).content;}catch{}}
 r.providerUsage=store.listProviderUsageEntries();
 r.tasks=store.listTasks().map(t=>({...t,steps:store.listSteps(t.id,t.activePlanRevisionId),attempts:store.listAttempts(t.id),results:store.listResults(t.id)}));}
 const ids=[sessionId,...r.tasks.flatMap(t=>t.attempts.map(a=>a.workerSessionId).filter(Boolean))];r.events=[];for(const id of new Set(ids))r.events.push(...await db.listEvents(id));
 await check(c,r,workspace);
 }catch(e){r.error=String(e?.stack||e);r.automatedVerdict='harness-or-runtime-error'}finally{try{await runtime?.dispose();await db?.close()}catch(e){r.disposeError=String(e)}}
 r.finishedAt=new Date().toISOString();r.durationMs=Date.parse(r.finishedAt)-Date.parse(r.startedAt);await fs.writeFile(resultPath,JSON.stringify(r,null,2));console.log('DONE',c.id,r.automatedVerdict,r.status,JSON.stringify(r.checkFaults||[]));
}
let next=0;await Promise.all(Array.from({length:Number(process.env.LANES||2)},async()=>{while(next<cases.length){const c=cases[next++];try{await run(c)}catch(e){console.error('HARNESS',c.id,String(e?.stack||e))}}}));
console.log('FINISHED');

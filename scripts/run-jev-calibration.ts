import {readFileSync} from 'node:fs';
import {experimentQuestions} from '../src/eval/jev-question-experiments.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {JevDecisionClient} from '../src/runtime/jev/decision-client.js';
import {normalizeRoutingConfig} from '../src/config/routing-config.js';
import {readActiveProfile,resolveProfileStateHome} from '../src/config/profile-home.js';
import {createSQLiteSessionDB} from '../src/session/session-setup.js';
import {createResearchWorkflowHarness} from '../src/eval/fixtures/research-workflow-harness.js';
import {loadSkillsFromDirectory} from '../src/skills/skill-loader.js';
import {SkillRegistry} from '../src/skills/skill-registry.js';
import {IntentRouter} from '../src/runtime/intent-router.js';
import {RuntimeRouter} from '../src/runtime/runtime-router.js';
import {jevRoutingContext,JEV_ROUTING_THRESHOLDS} from '../src/runtime/jev/live-routing.js';
import {selectJevCapabilities} from '../src/runtime/jev/capability-selection.js';
import {evaluateCapabilities} from '../src/runtime/jev/capability-decisions.js';
import {selectProviderToolsForTurn} from '../src/runtime/provider-tool-narrowing.js';
import {buildProviderToolSchemaCatalog} from '../src/tools/tool-schema.js';
import {scoreSelection,summarizeSelections,validateCalibrationCorpus,probabilityCalibration,type JevCalibrationCase,type Selection} from '../src/eval/jev-calibration.js';
import type {JevEvaluation,JevDecisionResult} from '../src/runtime/jev/types.js';
const args=process.argv.slice(2),arg=(name:string)=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
const live=args.includes('--live'),replay=arg('replay');
if(live===!!replay)throw Error('Choose --live (billable provider requests) or --replay <directory>.');
const variant=arg('variant')??'baseline';if(!['baseline','explicit-subject','direct-question','scoped-question','scoped-work','workflow-fit'].includes(variant))throw Error('Unknown question variant');
const split=arg('split')??'development';if(!['development','calibration','acceptance'].includes(split))throw Error('Invalid split');
const output=resolve(arg('output')??'');if(!arg('output'))throw Error('--output is required');
const accept=Number(arg('accept')??JEV_ROUTING_THRESHOLDS.acceptAt),reject=Number(arg('reject')??JEV_ROUTING_THRESHOLDS.rejectAt),toolAccept=Number(arg('tool-accept')??accept),toolReject=Number(arg('tool-reject')??reject),repeat=Number(arg('repeat')??1);
const policy={acceptAt:accept,rejectAt:reject,toolAcceptAt:toolAccept,toolRejectAt:toolReject};
if(!(toolReject>=0&&toolAccept<=1&&toolReject<toolAccept&&reject>=0&&accept<=1&&reject<accept&&Number.isInteger(repeat)&&repeat>=1&&repeat<=5))throw Error('Invalid experiment parameters');
const corpusRaw=await readFile(arg('corpus') ? resolve(arg('corpus')!) : new URL('../assets/evals/jev-routing-v1.json',import.meta.url),'utf8');
const corpus=JSON.parse(corpusRaw) as {cases:JevCalibrationCase[]};validateCalibrationCorpus(corpus.cases);
const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const corpusHash=hash(corpusRaw);
const rows=corpus.cases.filter(row=>row.split===split&&(!arg('case')||row.id===arg('case')));
if(!rows.length)throw Error('No matching cases');
await mkdir(output,{recursive:true});
const homeDir=homedir(),profileId=readActiveProfile({homeDir}).profileId;
const configPath=resolveProfileStateHome({homeDir,profileId}).configPath;
const config=normalizeRoutingConfig(JSON.parse(await readFile(configPath,'utf8')).routing);
if(config.mode!=='jev-assisted')throw Error('Selected profile must enable Jev explicitly');
if(!/^jev-\d+\.\d+\.\d+$/.test(config.jev.id))throw Error('Calibration requires a pinned Jev version');
const db=await createSQLiteSessionDB({path:join(output,'usage.sqlite')});
let fixture:Awaited<ReturnType<typeof createResearchWorkflowHarness>>|undefined;
try{
 fixture=await createResearchWorkflowHarness();
 const loaded=await loadSkillsFromDirectory(new URL('../skills/official',import.meta.url).pathname,{sourceKind:'bundled'});
 if(loaded.errors.length)throw Error('Skill catalog failed to load');
 const registry=new SkillRegistry();for(const skill of loaded.skills)registry.register(skill);
 const intentRouter=new IntentRouter({skillRegistry:registry});
 const catalog=buildProviderToolSchemaCatalog({tools:fixture.runtime.tools()});
 const skillNames=intentRouter.listSkills().map(s=>s.name),toolNames=catalog.inventory.map(t=>t.name);
 const experimentHash=hash(await Promise.all(['scripts/run-jev-calibration.ts','src/eval/jev-calibration.ts','src/runtime/request-requirements.ts','src/runtime/request-interpretation.ts','src/runtime/request-action-segments.ts','src/runtime/jev/live-routing.ts','src/runtime/jev/capability-selection.ts','src/runtime/jev/capability-decisions.ts','src/runtime/jev/selection-evidence.ts','src/runtime/provider-tool-narrowing.ts','src/runtime/runtime-router.ts','src/eval/jev-question-experiments.ts'].map(path=>readFile(new URL('../'+path,import.meta.url),'utf8'))));
 const catalogHash=hash({skills:intentRouter.listSkills().map(s=>({name:s.name,description:s.description,requiredToolsets:s.requiredToolsets,optionalToolsets:s.optionalToolsets,routing:s.routing,instructionsHash:'instructions' in s?hash(s.instructions):undefined})),tools:catalog.entries.map(e=>({name:e.tool.name,description:e.tool.description,toolsets:e.tool.toolsets,riskClass:e.tool.riskClass,schema:e.schema}))});
 const snapshot=()=>{const current=normalizeRoutingConfig(JSON.parse(readFileSync(configPath,'utf8')).routing);return {config:current,configurationRevision:hash(current),catalogRevision:catalogHash};};
 const client=new JevDecisionClient({homeDir,profileId,snapshot,recordUsage:entries=>db.recordProviderUsageEntries(entries)});
 const measurements:any[]=[];
 for(let trial=0;trial<repeat;trial++)for(const row of rows){
  if(hash(config)!==snapshot().configurationRevision)throw Error('Profile routing configuration changed during evaluation');
  const path=join(output,`${row.id}.${trial}.json`);
  // Never accidentally repeat paid requests when resuming an interrupted run.
  try{const existing=JSON.parse(await readFile(path,'utf8'));if(existing.experimentHash!==experimentHash||existing.live!==live||existing.model!==config.jev.id||(existing.variant??'baseline')!==variant||existing.corpusHash!==corpusHash||existing.catalogHash!==catalogHash||existing.policy.acceptAt!==accept||existing.policy.rejectAt!==reject||(existing.policy.toolAcceptAt??existing.policy.acceptAt)!==toolAccept||(existing.policy.toolRejectAt??existing.policy.rejectAt)!==toolReject)throw Error('Existing result belongs to another experiment');measurements.push(existing);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const prior=replay?JSON.parse(await readFile(join(resolve(replay),`${row.id}.${trial}.json`),'utf8')):undefined;
  if(prior&&prior.catalogHash!==catalogHash)throw Error('Replay provenance mismatch');
  let cursor=0,replayError:Error|undefined;const traces:Array<{questionHash:string;questions:JevEvaluation['questions'];result:JevDecisionResult;elapsedMs:number}>=[];
  const routing={snapshot,client:{evaluate:async(input:JevEvaluation)=>{
   input={...input,questions:experimentQuestions(input.questions,variant)};
   const questionHash=hash({context:input.context,questions:input.questions});const start=performance.now(),isTools=input.questions[0]?.id.startsWith('capability.'),yes=isTools?toolAccept:accept,no=isTools?toolReject:reject;
   let result:JevDecisionResult;
   if(prior){const record=prior.traces[cursor++];if(record?.questionHash!==questionHash){replayError=Error('Replay request differs');throw replayError;}result=structuredClone(record.result);result.answers=result.answers.map(answer=>'probability'in answer?{...answer,status:answer.probability>=yes?'accepted':answer.probability<=no?'rejected':'uncertain'}:answer);}
   else result=await client.evaluate({...input,thresholds:{acceptAt:yes,rejectAt:no,minConfidence:.8}});
   traces.push({questionHash,questions:input.questions,result,elapsedMs:prior?prior.traces[cursor-1].elapsedMs:Math.round(performance.now()-start)});return result;
  }}};
  const runtimeRouter=new RuntimeRouter({intentRouter,skillConfig:{},jev:routing});
  const context=jevRoutingContext({userRequest:row.prompt,continuity:row.continuity,material:row.material});
  const evaluation={context,usage:{requestKey:`jev-eval:${split}:${row.id}:${trial}`}};
  const routeInput={text:row.prompt,requestText:row.prompt,channel:'cli' as const,trustedWorkspace:true};
  const base=runtimeRouter.route({...routeInput,skipShadow:true});
  const standard=selectProviderToolsForTurn({catalog,intent:base.intent,userText:row.prompt,selectedSkill:base.selectedSkill});
  const route=await runtimeRouter.routeAsync({...routeInput,evaluation,saveOnly:row.saveOnly});
  const narrowed=selectProviderToolsForTurn({catalog,intent:route.intent,userText:row.prompt,selectedSkill:route.selectedSkill});
  const selection=await selectJevCapabilities({routing,catalog,intent:route.intent,standard:narrowed,evaluation,validateTool:async id=>catalog.entries.some(e=>`tool:${e.tool.name}`===id)});
  let discovery;
  if(row.discovery)discovery=await evaluateCapabilities(routing,catalog.inventory.map(t=>({id:`tool:${t.name}`,description:`${t.name}: ${t.description}`})),evaluation,'discovery',new Set());
  if(prior&&(replayError||cursor!==prior.traces.length))throw replayError??Error('Replay did not consume the recorded requests');
  const canonical=(schemas:typeof standard.initialTools)=>schemas.map(s=>catalog.aliases.get(s.function.name)!);
  const standardSelection:Selection={intents:[...new Set([...base.intent.labels,base.intent.taskClass??'general'])].filter(id=>id!=='general'),skills:base.intent.suggestedSkills.map(s=>s.name),tools:canonical(standard.initialTools)};
  const exposed:Selection={intents:[...new Set([...route.intent.labels,route.intent.taskClass??'general'])].filter(id=>id!=='general'),skills:route.intent.suggestedSkills.map(s=>s.name),tools:canonical(selection.initialTools)};
  const raw:Selection={intents:[],skills:[],tools:[]};const rejected:Selection={intents:[],skills:[],tools:[]};
  traces.slice(0,2).forEach(trace=>trace.result.answers.forEach(answer=>{
   if(answer.status!=='accepted'&&answer.status!=='rejected')return;
   const target=answer.status==='accepted'?raw:rejected;
   if(answer.id.startsWith('intent.'))target.intents.push(answer.id.slice(7));
   else if(answer.id.startsWith('skill.'))target.skills.push(skillNames[Number(answer.id.slice(6))]);
   else if(answer.id.startsWith('capability.'))target.tools.push(toolNames[Number(answer.id.slice(11))]);
  }));
  const probabilities=traces.slice(0,2).flatMap(t=>t.result.answers.map(a=>({stage:a.id.startsWith('intent.')?'intents':a.id.startsWith('skill.')?'skills':'tools',id:a.id.startsWith('intent.')?a.id.slice(7):a.id.startsWith('skill.')?skillNames[Number(a.id.slice(6))]:toolNames[Number(a.id.slice(11))],probability:'probability'in a?a.probability:undefined,status:a.status})));
  const result={version:1,experimentHash,variant,probabilities,replayedFromCorpusHash:prior?.corpusHash,corpusHash,catalogHash,id:row.id,trial,split,row,model:config.jev.id,timeoutMs:config.jev.timeoutMs,policy,live:!replay,
   scope:'Production routing functions and bundled skills; 109 registered runtime tool definitions under the research fixture. Tool execution/readiness and external MCP catalogs are separate checks.',
   standard:standardSelection,raw,rejected,exposed,scores:{standard:scoreSelection(row,standardSelection),raw:scoreSelection(row,raw),exposed:scoreSelection(row,exposed)},
   route:route.intent.routingDecision,capabilities:selection.capabilityRouting,discovery,
   loadedSkills:[...(route.selectedSkillPromptContent?[route.selectedSkill!.name]:[]),...(route.supportingSkillPromptContents??[]).map(s=>s.name)],
   traces};
  await writeFile(path,JSON.stringify(result,null,2)+'\n');measurements.push(result);
  console.log(JSON.stringify({case:row.id,trial,failures:traces.flatMap(t=>t.result.failure?[t.result.failure.code]:[]),ms:traces.reduce((n,t)=>n+t.elapsedMs,0),missingTools:result.scores.exposed.tools.missing.length}));
  if(traces.some(t=>['authentication','billing-rejected','credentials-unavailable'].includes(t.result.failure?.code??'')))throw Error('Provider unavailable; stopped without retrying');
 }
 const summarize=(key:'raw'|'exposed'|'standard')=>summarizeSelections(measurements.map(m=>({row:m.row,selected:m[key]})));
 const latencies=measurements.map(m=>m.traces.slice(0,2).reduce((n:number,t:any)=>n+t.elapsedMs,0)).sort((a,b)=>a-b);
 const summary={version:1,experimentHash,variant,probabilityCalibration:probabilityCalibration(measurements.map(m=>({row:m.row,candidates:m.probabilities??[]}))),recordedLiveProviderCalls:live?measurements.reduce((n,m)=>n+m.traces.reduce((k:number,t:any)=>k+t.result.usage.providerCalls,0),0):0,split,cases:measurements.length,corpusHash,catalogHash,model:config.jev.id,policy,live,standard:summarize('standard'),raw:summarize('raw'),exposed:summarize('exposed'),
  latencyMs:{median:latencies[Math.floor(latencies.length/2)],p95:latencies[Math.ceil(latencies.length*.95)-1]},
  failures:measurements.flatMap(m=>m.traces.flatMap((t:any)=>t.result.failure?[{id:m.id,...t.result.failure}]:[])),
  usage:measurements.reduce((sum,m)=>{for(const t of m.traces){sum.calls+=t.result.usage.providerCalls;sum.tokens+=t.result.usage.totalTokens;sum.estimatedUsd+=t.result.usage.estimatedCostUsd??0;}return sum;},{calls:0,tokens:0,estimatedUsd:0}),
  perLanguage:Object.fromEntries([...new Set(rows.map(r=>r.language))].map(language=>[language,summarizeSelections(measurements.filter(m=>m.row.language===language).map(m=>({row:m.row,selected:m.exposed})))]))};
 await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
}finally{try{await fixture?.dispose()}finally{await db.close()}}

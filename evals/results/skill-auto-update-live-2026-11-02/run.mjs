// User-authorized live test of automatic activation, approval, pinning, fresh-session reuse and undo. Isolated profiles only.
import {mkdir,readFile,writeFile,rm,symlink,cp} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const repo=process.cwd(),root=resolve(process.argv[2]??''),out=dirname(fileURLToPath(import.meta.url));
if(!process.argv[2]||!root.startsWith('/private/tmp/'))throw Error('Pass a new /private/tmp directory');
await mkdir(root,{mode:0o700});
const before='f68f2490a',sourceBefore=join(root,'before-source'),sourceAfter=join(root,'after-source');
await mkdir(sourceBefore);
execFileSync('tar',['-xf','-','-C',sourceBefore],{input:execFileSync('git',['archive',before],{maxBuffer:256*1024*1024})});
await cp(sourceBefore,sourceAfter,{recursive:true});
for(const source of [sourceBefore,sourceAfter])await symlink(join(repo,'node_modules'),join(source,'node_modules'));
const changed=execFileSync('git',['diff','--name-only',before,'--','src'],{encoding:'utf8'}).trim().split('\n').filter(p=>p.endsWith('.ts')&&!p.endsWith('.test.ts'));
const hash=text=>createHash('sha256').update(text).digest('hex'),sourceHashes={};
for(const path of changed){const text=await readFile(join(repo,path),'utf8');sourceHashes[path]=hash(text);await writeFile(join(sourceAfter,path),text);}
const header={name:'stock-snapshot',description:'Build an inventory snapshot from an event export.',requiredToolsets:['files'],optionalToolsets:['shell-readonly'],routing:{labels:['coding'],triggerPatterns:[{type:'contains',value:'stock-snapshot'}],confirmation:'policy'},playbook:[],evaluations:[]};
const body='Read the requested CSV inventory events (sku, revision, quantity, deleted). Keep the last row for each sku because exports arrive in chronological order. After selecting the last row, omit entries whose deleted value is true. Preserve zero and negative integer quantities. Write the requested JSON as {"stock":{<sku>:<quantity>}} with sku keys sorted alphabetically. Read back and verify the saved file before reporting completion.';
const baseline=`---\n${JSON.stringify(header)}\n---\n${body}\n`;
const contract='Inventory exporter replay contract: file order is not chronological. For each sku select the greatest numeric revision; if two rows have that revision, the last occurrence wins. Select first, then remove winners marked deleted=true. A lower-revision row must never resurrect a newer tombstone. Quantities are integers, including zero and negative values. Output {"stock":{sku:quantity}} with keys sorted.';
const make=(id,rows)=>{const chosen=new Map();for(const [sku,revision,quantity,deleted]of rows){const old=chosen.get(sku);if(!old||revision>=old.revision)chosen.set(sku,{revision,quantity,deleted});}const stock=Object.fromEntries([...chosen].filter(([,r])=>!r.deleted).sort(([a],[b])=>a.localeCompare(b)).map(([sku,r])=>[sku,r.quantity]));return {id,csv:['sku,revision,quantity,deleted',...rows.map(r=>r.join(','))].join('\n')+'\n',expected:{stock}};};
const train=make('correction',[['A',8,12,false],['B',9,0,true],['A',2,100,false],['C',3,0,false],['B',4,9,false],['D',5,-2,false],['D',5,-3,false]]);
const held=[make('out-of-order',[['K',13,8,false],['L',12,0,true],['K',2,99,false],['L',1,17,false],['M',5,-4,false]]),
  make('ties-and-tombstones',[['P',7,2,false],['Q',11,0,true],['P',7,0,false],['R',3,-5,false],['P',4,77,false],['Q',8,44,false],['R',3,-6,false]]),
  make('chronological-regression',[['S',1,2,false],['S',2,7,false],['T',3,-3,false],['U',4,1,false],['U',5,0,true],['V',2,0,false]])];
const fixture={baseline,contract,train,held};
const budgets={maxProviderIterations:16,maxProviderToolCalls:24,maxProviderWallClockMs:180000,maxRepeatedToolFailures:3};
const manifest={before,sourceHashes,createdAt:new Date().toISOString(),model:'codex/gpt-6.1-sol',budgets,fixtureHash:hash(JSON.stringify(fixture)),
  protocol:'Four isolated training profiles: previous runtime, updated automatic mode, updated approval-required mode, and updated pinned skill. Continue with fresh sessions/workspaces reading the actual persisted skill; never manually install a candidate. Compare three unseen tasks on previous/automatic profiles. Exercise pending approval, explicit approval, pinning, snapshots and undo. Expected answers remain outside held-out workspaces.',
  limitation:'Controlled file-processing tasks with a seeded stale procedure and explicit correction. This establishes automatic activation/reuse and controls, not general spontaneous improvement or a Hermes head-to-head.'};
await writeFile(join(out,'fixtures.json'),JSON.stringify(fixture,null,2));await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const {loadRuntimeConfig}=await import(join(sourceAfter,'src/config/runtime-config.ts'));
const {resolveProfileStateHome}=await import(join(sourceAfter,'src/config/profile-home.ts'));
const {redactBenchmarkArtifact}=await import(join(sourceAfter,'src/benchmark/redaction.ts'));
const {SkillProposalService}=await import(join(sourceAfter,'src/skills/skill-proposal-service.ts'));
const {SkillRegistry}=await import(join(sourceAfter,'src/skills/skill-registry.ts'));
const {SkillEvolutionStore}=await import(join(sourceAfter,'src/skills/skill-evolution.ts'));
const {parseSkillFile}=await import(join(sourceAfter,'src/skills/skill-loader.ts'));
const selected=await loadRuntimeConfig({workspaceRoot:repo,configurationInspection:true});
const auth=JSON.parse(await readFile(resolveProfileStateHome({profileId:selected.profileId}).authJsonPath,'utf8'));
const {refreshToken,...token}=auth.providers.codex;if(!token.accessToken)throw Error('No selected Codex credential');
const safe=value=>JSON.parse(JSON.stringify(redactBenchmarkArtifact(value)).replaceAll(root,'<BENCHMARK_ROOT>').replaceAll(repo,'<REPOSITORY>'));
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(safe(value),null,2));};
const json=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return undefined;}};
const jsonl=async path=>{try{return (await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
const config=JSON.stringify({model:{provider:'codex',id:'gpt-6.1-sol',fallbacks:[]},providers:{codex:{kind:'openai-compatible',apiMode:'openai_responses',authMethod:'oauth_device_pkce',enableNetwork:true,models:['gpt-6.1-sol']}},web:{enableNetwork:false}});
const summary={manifest,runs:[],reviews:{},pairs:[]},authPaths=new Set();
async function run({id,group=id,source,test,learning=false,initialize=false,pinned=false,writeApproval=false}){
  const base=join(root,group),home=join(base,'home'),workspace=join(root,id,'workspace'),profile=join(home,'.estacoda/profiles/default');
  const skills=join(profile,'skills'),path=join(skills,'stock-snapshot/SKILL.md'),authPath=join(profile,'auth.json');
  await mkdir(dirname(path),{recursive:true});await mkdir(workspace,{recursive:true});
  if(initialize)await writeFile(path,baseline);const skillBefore=await readFile(path,'utf8');await writeFile(join(workspace,'events.csv'),test.csv);
  if(initialize)await writeFile(join(profile,'config.json'),JSON.stringify({...JSON.parse(config),skills:{autonomy:'proactive',writeApproval}}),{mode:0o600});authPaths.add(authPath);
  if(pinned)await new SkillEvolutionStore({usagePath:join(skills,'.usage.json'),evolutionRoot:join(skills,'.evolution')}).pinSkill('stock-snapshot','local');
  await writeFile(authPath,JSON.stringify({version:auth.version,providers:{codex:token}}),{mode:0o600});
  let verifier;
  if(learning){
    await writeFile(join(workspace,'CONTRACT.txt'),contract);
    verifier=`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.deepEqual(JSON.parse(readFileSync('stock.json','utf8')),${JSON.stringify(test.expected)});console.log('PASS: stock.json matches the source replay contract, including out-of-order rows, tombstones and tied revisions.');\n`;
    await writeFile(join(workspace,'verify.mjs'),verifier);
  }
  const {createRuntime}=await import(join(source,'src/runtime/create-runtime.ts'));
  const {InMemorySessionDB}=await import(join(source,'src/session/in-memory-session-db.ts'));
  const {WorkspaceTrustStore}=await import(join(source,'src/security/workspace-trust-store.ts'));
  const {resolveTokens}=await import(join(source,'src/theme/token-resolver.ts'));
  const {loadRuntimeConfig:load}=await import(join(source,'src/config/runtime-config.ts'));
  const cfg=await load({workspaceRoot:workspace,homeDir:home,profileId:'default'});
  const trust=new WorkspaceTrustStore({path:join(base,'trust.json')});await trust.grant(workspace);
  const db=new InMemorySessionDB();let runtime,response,error;const events=[],started=Date.now();
  const prompt=learning?'Use stock-snapshot to reconcile events.csv into stock.json. Correction: the exporter does not deliver chronological rows; its replay contract in CONTRACT.txt overrides the stale skill procedure. Read the contract, reconcile the file, and run node verify.mjs to verify the saved output. Do not change the contract or verifier. Do not use skill-management tools during this foreground task; leave skill learning to the configured background reviewer. Work locally without network or delegation.'
    :'Use stock-snapshot to reconcile events.csv into stock.json according to the skill procedure. Read back and verify the saved output. Work locally without network, delegation or skill edits.';
  console.log(JSON.stringify({phase:'start',id}));
  try{
    runtime=await createRuntime({homeDir:home,profileId:'default',workspaceRoot:workspace,sessionDb:db,trustStore:trust,tokens:resolveTokens('standard','dark','kemetBlue'),
      model:cfg.model,primaryModelRoute:cfg.primaryModelRoute,modelFallbackRoutes:[],providerRegistry:cfg.providerRegistry,providerConfigs:cfg.config.providers,
      skillAutonomy:learning?'proactive':'none',skillWriteApproval:cfg.skills.writeApproval,enableWebNetwork:false,securityMode:'open',enabledToolsets:['core','files','shell-readonly'],disableCronTools:true,
      executionControls:{providerBudgets:budgets,providerRequestDefaults:{temperature:0,maxTokens:4000},childProcessEnv:{mode:'isolated',homeDir:home}}});
    response=await runtime.handle({text:prompt,requirementText:prompt,channel:'cli',trustedWorkspace:true,signal:AbortSignal.timeout(210000),onEvent:e=>{if(!/token|delta/i.test(e.kind??''))events.push(e);}});
    if(learning)for(let i=0;i<120;i++){
      const state=await json(join(skills,'.evolution/learning.json'));
      if(state?.records?.some(r=>['promoted','proposed','abstained'].includes(r.draftStatus)))break;
      await new Promise(r=>setTimeout(r,250));
    }
  }catch(e){error=String(e);}
  finally{
    if(runtime)await runtime.dispose();
    const output=await json(join(workspace,'stock.json'));
    const fixedInputsUnchanged=await readFile(join(workspace,'events.csv'),'utf8')===test.csv&&(!learning||(await readFile(join(workspace,'CONTRACT.txt'),'utf8')===contract&&await readFile(join(workspace,'verify.mjs'),'utf8')===verifier));
    const usage=await db.listProviderUsageEntries('default');const sessions=[];
    for(const session of await db.listSessions())sessions.push({session,messages:await db.listMessages(session.id)});
    const result={id,artifactPassed:isDeepStrictEqual(output,test.expected)&&fixedInputsUnchanged,passed:isDeepStrictEqual(output,test.expected)&&fixedInputsUnchanged&&response?.finalOutcome?.terminationCause==='normal',output,expected:test.expected,fixedInputsUnchanged,liveSkillUnchanged:await readFile(path,'utf8')===skillBefore,skillBeforeHash:hash(skillBefore),skillAfterHash:hash(await readFile(path,'utf8')),
      elapsedMs:Date.now()-started,error,outcome:response?.finalOutcome,text:response?.text,providerCalls:usage.length,reviewCalls:usage.filter(u=>u.auxiliaryKind==='skill-draft').length};
    summary.runs.push(result);
    await save(join(out,id,'result.json'),result);await save(join(out,id,'transcript.json'),{prompt,events,sessions});await save(join(out,id,'usage.json'),usage);
    if(learning){
      const state=await json(join(skills,'.evolution/learning.json'));const proposals=await jsonl(join(skills,'.evolution/proposed-patches.jsonl'));
      const observations=await jsonl(join(skills,'.evolution/observations.jsonl'));
      summary.reviews[id]={state,proposals,observations,promotions:await jsonl(join(skills,'.evolution/promotions.jsonl')),reviewCalls:result.reviewCalls};
      await writeFile(join(out,id,'skill-after.md'),await readFile(path,'utf8'));
      await save(join(out,id,'learning.json'),summary.reviews[id]);
    }
    await save(join(out,'summary.json'),summary);await rm(authPath,{force:true});authPaths.delete(authPath);
    console.log(JSON.stringify({phase:'done',id,passed:result.passed,calls:result.providerCalls,reviewCalls:result.reviewCalls,elapsedMs:result.elapsedMs}));
  }
  return summary.runs.at(-1);
}
async function serviceFor(group){
  const skills=join(root,group,'home/.estacoda/profiles/default/skills'),path=join(skills,'stock-snapshot/SKILL.md');
  const content=await readFile(path,'utf8');const registry=new SkillRegistry();registry.register(parseSkillFile(path,content,{sourceRoot:skills,sourceKind:'local'}));
  const store=new SkillEvolutionStore({usagePath:join(skills,'.usage.json'),evolutionRoot:join(skills,'.evolution')});
  const {ChangeManifestStore}=await import(join(sourceAfter,'src/skills/change-manifest-store.ts'));
  const service=new SkillProposalService({registry,localSkillsRoot:skills,skillEvolutionStore:store,changeManifestStore:new ChangeManifestStore({root:join(skills,'.evolution/manifests')})});
  return {service,store,path};
}
try{
  for(const group of ['previous','automatic','approval','pinned'])await run({id:group+'-learning',group,source:group==='previous'?sourceBefore:sourceAfter,test:train,learning:true,initialize:true,writeApproval:group==='approval',pinned:group==='pinned'});
  for(const [i,test] of held.entries()){
    const pair={id:test.id};
    for(const group of i%2?['automatic','previous']:['previous','automatic'])pair[group]=await run({id:group+'-'+test.id,group,source:group==='previous'?sourceBefore:sourceAfter,test});
    summary.pairs.push(pair);await save(join(out,'summary.json'),summary);
  }
  await run({id:'approval-before-approve',group:'approval',source:sourceAfter,test:held[0]});
  const approval=await serviceFor('approval'),pending=(await approval.service.listProposals()).find(p=>p.status==='proposed');
  if(pending){
    summary.unapprovedPromotion=await approval.service.promoteProposal(pending.id);
    if(summary.unapprovedPromotion.ok)throw Error('Approval-enabled change activated without approval');
    await approval.service.approveProposal(pending.id);
    summary.approvedPromotion=await approval.service.promoteProposal(pending.id);
    await run({id:'approval-after-approve',group:'approval',source:sourceAfter,test:held[0]});
  }
  const automatic=await serviceFor('automatic'),promoted=(await automatic.service.listProposals()).find(p=>p.status==='promoted');
  summary.automaticPatch=promoted?.patch;
  if(promoted){
    const promotions=await automatic.store.listPromotions({skillName:'stock-snapshot'});
    summary.snapshotMatchesOriginal=await readFile(join(promotions.at(-1).snapshotPath,'SKILL.md'),'utf8')===baseline;
    await writeFile(join(out,'automatically-active-skill.md'),await readFile(automatic.path,'utf8'));
    summary.undoSucceeded=await automatic.service.rollbackProposal(promoted.id);
    summary.undoRestoredOriginal=await readFile(automatic.path,'utf8')===baseline;
    await run({id:'automatic-after-undo',group:'automatic',source:sourceAfter,test:held[0]});
  }
  summary.completedAt=new Date().toISOString();
  summary.result={previous:summary.pairs.filter(p=>p.previous.passed).length,automatic:summary.pairs.filter(p=>p.automatic.passed).length,total:summary.pairs.length,
    automaticPromoted:!!promoted,approvalBlocked:summary.unapprovedPromotion?.ok===false,explicitApprovalApplied:summary.approvedPromotion?.ok===true,pinnedUnchanged:summary.runs.find(r=>r.id==='pinned-learning')?.liveSkillUnchanged,undoRestoredOriginal:summary.undoRestoredOriginal};
  await save(join(out,'summary.json'),summary);console.log(JSON.stringify({phase:'complete',result:summary.result}));
}finally{for(const path of authPaths)await rm(path,{force:true});}

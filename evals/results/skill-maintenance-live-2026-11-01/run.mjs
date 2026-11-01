import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const root=process.argv[3],arm=process.argv[2];if(!['before','after'].includes(arm))throw Error('before or after');
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const source=arm==='before'?join(root,'source-before'):manifest.afterSource;
const base=join(root,arm),home=join(base,'home'),workspace=join(base,'workspace');
const fixture=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'));
const {loadRuntimeConfig}=await import(join(source,'src/config/runtime-config.ts'));
const {createRuntime}=await import(join(source,'src/runtime/create-runtime.ts'));
const {InMemorySessionDB}=await import(join(source,'src/session/in-memory-session-db.ts'));
const {WorkspaceTrustStore}=await import(join(source,'src/security/workspace-trust-store.ts'));
const {resolveTokens}=await import(join(source,'src/theme/token-resolver.ts'));
const {redactBenchmarkArtifact}=await import(join(source,'src/benchmark/redaction.ts'));
const config=await loadRuntimeConfig({workspaceRoot:workspace,homeDir:home,profileId:'default'});
const trust=new WorkspaceTrustStore({path:join(base,'trust.json')});await trust.grant(workspace);
const loaded=await (await import(join(source,'src/skills/skill-loader.ts'))).loadSkillsFromDirectory(join(home,'.estacoda/profiles/default/skills')); if(loaded.errors.length||loaded.skills.length!==1)throw Error(JSON.stringify(loaded.errors));
const db=new InMemorySessionDB();let runtime;const results=[];const started=Date.now();
try{
runtime=await createRuntime({homeDir:home,profileId:'default',workspaceRoot:workspace,sessionDb:db,trustStore:trust,
 tokens:resolveTokens('standard','dark','kemetBlue'),model:config.model,primaryModelRoute:config.primaryModelRoute,modelFallbackRoutes:[],providerRegistry:config.providerRegistry,providerConfigs:config.config.providers,
 skillAutonomy:'none',enableWebNetwork:false,securityMode:'open',enabledToolsets:['core','files','shell-readonly'],disableCronTools:true,
 executionControls:{providerBudgets:{maxProviderIterations:16,maxProviderToolCalls:24,maxProviderWallClockMs:180000,maxRepeatedToolFailures:3},providerRequestDefaults:{temperature:0,maxTokens:4000},childProcessEnv:{mode:'isolated',homeDir:home}}});
for(const n of [1,2]){
 if(n===2)await writeFile(join(home,'.estacoda/profiles/default/skills/ledger-close/SKILL.md'),fixture.skillV2);
 const events=[];const begin=Date.now();
 const text=`Use the ledger-close skill to reconcile batch${n}.csv and save close${n}.json according to its current procedure. Read the input and verify the saved output. Work independently with local tools; no network, delegation or skill edits are needed.`;
 const response=await runtime.handle({text,requirementText:text,channel:'cli',trustedWorkspace:true,signal:AbortSignal.timeout(210000),onEvent:e=>events.push(e)});
 let output;try{output=JSON.parse(await readFile(join(workspace,`close${n}.json`),'utf8'));}catch{}
 results.push({turn:n,elapsedMs:Date.now()-begin,passed:isDeepStrictEqual(output,fixture[`expected${n}`]),output,expected:fixture[`expected${n}`],outcome:response.finalOutcome,text:response.text,events});
 await writeFile(join(base,'results.json'),JSON.stringify(redactBenchmarkArtifact({arm,elapsedMs:Date.now()-started,results}),null,2));
 console.log(JSON.stringify({arm,turn:n,passed:results.at(-1).passed,outcome:response.finalOutcome?.status,elapsedMs:Date.now()-begin}));
}
}finally{
 if(runtime)await runtime.dispose();
 const sessions=[];for(const session of await db.listSessions())sessions.push({session,messages:await db.listMessages(session.id),events:await db.listEvents(session.id),providerUsage:await db.listProviderUsageEntries('default',{sessionId:session.id})});
 await writeFile(join(base,'sessions.json'),JSON.stringify(redactBenchmarkArtifact(sessions),null,2));
 await rm(join(home,'.estacoda/profiles/default/auth.json'),{force:true});
}

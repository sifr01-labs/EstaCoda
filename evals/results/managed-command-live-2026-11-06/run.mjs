// Authorized live A/B: production foreground planner, durable workers, real repository tests.
// node --import tsx <this-file> /private/tmp/<fresh-root> prepare|before|after
import { mkdir, readFile, writeFile, rm, symlink, cp, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo = process.cwd(), root = resolve(process.argv[2] ?? ''), arm = process.argv[3];
const out = join(root, 'evidence');
if (!root.startsWith('/private/tmp/') || !['prepare', 'before', 'after'].includes(arm)) throw Error('Expected fresh /private/tmp root and prepare|before|after');
const hash = value => createHash('sha256').update(value).digest('hex');
const budgets = { maxProviderIterations: 45, maxProviderToolCalls: 65, maxProviderWallClockMs: 600000, maxRepeatedToolFailures: 5, finalizationReserveMs: 20000 };
const cases = {
  comparison: `deepseek reportedly launched a new open source thing called super-agent. I want you to find it and benchmark it against EstaCoda's codebase and capabilities`,
  continuation: `Review EstaCoda's real command completion and task-result summary implementations. Delegate a repository research worker with file.read, terminal.run and process.logs access. The paths are already known: src/runtime/command-completion-checks.ts, src/utils/task-result-summary.ts and their corresponding .test.ts files. Read those files directly; no discovery search is needed. Have the worker execute both existing test files with vitest.node.config.ts. Keep the initial command observation wait short (around one second) while allowing the tests to finish; collect the final exit status without restarting the same test command. Return a substantial source-cited assessment and actual test results. Do not edit source or tests. Then synthesize the worker's findings, explicitly disclosing any missing coverage.`
};

async function fingerprints(dir) {
  const values = {};
  async function walk(path, rel = '') {
    for (const e of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const r = join(rel, e.name);
      if (e.isDirectory()) await walk(join(path,e.name),r);
      else if (e.isFile()) values[r] = hash(await readFile(join(path,e.name)));
    }
  }
  await walk(dir); return values;
}
if (arm === 'prepare') {
  const baseline = execFileSync('git', ['rev-parse', '62246ec5afb60cde7d1a9cb4d57b0bcfb421f1b2'], { encoding: 'utf8' }).trim();
  await mkdir(root, { recursive: false }); await mkdir(out);
  const archive = join(root, 'baseline.tar');
  execFileSync('git', ['archive', baseline, '--output', archive, 'src', 'skills', 'registries', 'assets', 'workers', 'docs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.node.config.ts']);
  await mkdir(join(root, 'before-source'));
  execFileSync('tar', ['-xf', archive, '-C', join(root,'before-source')]);
  await rm(archive);
  await cp(join(root,'before-source'),join(root,'after-source'),{recursive:true});
  const changed = execFileSync('git',['diff','--name-only',baseline,'--','src','skills'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for (const p of changed) await cp(join(repo,p),join(root,'after-source',p));
  for (const a of ['before','after']) await symlink(join(repo,'node_modules'),join(root,`${a}-source/node_modules`));
  const fixture = join(root,'fixture'); await mkdir(fixture);
  for (const p of ['src','registries','assets','workers','skills','docs','package.json','tsconfig.json','vitest.node.config.ts']) {
    await cp(join(root,'before-source',p),join(fixture,p),{recursive:true});
  }
  await writeFile(join(fixture,'AGENTS.md'),`Benchmark environment: EstaCoda source is at this workspace root. Public pinned upstream checkouts are in upstream/superagent and upstream/harness when present. Their original revisions are in UPSTREAM.json. Dependencies are prepared without lifecycle scripts; do not assume all upstream tests work. Use their implementation and relevant existing tests, and disclose unavailable test prerequisites. These are source research fixtures, not deployed services. Never claim comparative live-model coding performance from native test counts.`);
  const inputHashes = await fingerprints(fixture);
  const manifest = { baseline, model:'codex/gpt-6.1-sol', budgets, cases,
    securityMode:'open; hardline policy and durable task authority remain enforced',
    updatedSourceHashes: Object.fromEntries(await Promise.all(changed.map(async p=>[p,hash(await readFile(join(repo,p)))]))),
    inputHashes, scope:'Identical pinned 62246ec5a subject source in both arms. Public upstream sources and dependencies prepared equally; no web or Telegram transport. Comparison uses the original broad request. Continuation explicitly tests a delegated source audit with known paths and a short initial observation wait. Real Codex model and production planner/workers/scheduler; real processes and existing test files. Not Telegram transport or a comparative agent-performance ranking.' };
  await writeFile(join(fixture,'MANIFEST.json'),JSON.stringify({subjectRevision:baseline,subjectSourceHashes:inputHashes,scope:'These are the pinned comparison subject files, identical in both arms. The executing harness snapshot is recorded separately in the external benchmark evidence manifest. The fixture Git commit also includes this description and is not the upstream EstaCoda revision.'},null,2));
  execFileSync('git',['init','-q',fixture]);
  execFileSync('git',['-C',fixture,'add','.']);
  execFileSync('git',['-C',fixture,'-c','core.hooksPath=/dev/null','-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','commit','-qm','Pinned benchmark subject snapshot']);
  manifest.fixtureRevision = execFileSync('git',['-C',fixture,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  for (const a of ['before','after']) for (const test of Object.keys(cases)) {
    const workspace = join(root,a,test,'workspace');
    await cp(fixture,workspace,{recursive:true});
    await symlink(join(repo,'node_modules'),join(workspace,'node_modules'));
    if(test==='comparison') {
      const revisions={}; await mkdir(join(workspace,'upstream'));
      for(const [name,origin] of [['superagent','/private/tmp/lifecycle-superagent'],['harness','/private/tmp/lifecycle-deepseek-harness']]) {
        const dest=join(workspace,'upstream',name);
        await cp(origin,dest,{recursive:true,filter:src=>!src.split('/').includes('node_modules') && !src.split('/').includes('.git')});
        async function linkDeps(src,target) { for(const ent of await readdir(src,{withFileTypes:true})) {
          if(ent.name==='.git')continue;
          if(ent.name==='node_modules') {await symlink(join(src,ent.name),join(target,ent.name));continue;}
          if(ent.isDirectory()) await linkDeps(join(src,ent.name),join(target,ent.name));
        }}
        await linkDeps(origin,dest);
        revisions[name]=execFileSync('git',['-C',origin,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
      }
      await writeFile(join(workspace,'UPSTREAM.json'),JSON.stringify(revisions,null,2));
    }

  }
  console.log('Prepared immutable runtime snapshots and identical real-work inputs.'); process.exit(0);
}
const source = join(root,`${arm}-source`), imp = p => import(join(source,'src',p));
const { loadRuntimeConfig } = await imp('config/runtime-config.ts');
const { resolveProfileStateHome } = await imp('config/profile-home.ts');
const { redactBenchmarkArtifact } = await imp('benchmark/redaction.ts');
const { createRuntime } = await imp('runtime/create-runtime.ts');
const { createSQLiteSessionDB } = await imp('session/session-setup.ts');
const { SQLiteTaskStore } = await imp('tasks/sqlite-task-store.ts');
const { TaskResultService } = await imp('tasks/task-result-service.ts');
const { TaskScheduler } = await imp('tasks/task-scheduler.ts');
const { WorkspaceTrustStore } = await imp('security/workspace-trust-store.ts');
const { resolveTokens } = await imp('theme/token-resolver.ts');
const selected = await loadRuntimeConfig({workspaceRoot:repo,configurationInspection:true});
const auth = JSON.parse(await readFile(resolveProfileStateHome({profileId:selected.profileId}).authJsonPath,'utf8'));
const {refreshToken,...token} = auth.providers.codex;
if (!token.accessToken) throw Error('Configured Codex credential unavailable');
const safe = v => JSON.parse(JSON.stringify(redactBenchmarkArtifact(v)).replaceAll(root,'<BENCHMARK_ROOT>').replaceAll(repo,'<REPOSITORY>'));
// Keep source observations, calls, answers and validation; omit duplicate prompt/accounting projections.
function compactSessions(sessions) {
  const keep = new Set(['skill-learned', 'step-completion-validation', 'execution-final-outcome-recorded', 'provider-budget-exhausted', 'structured-tool-history-selected', 'tool-gated', 'security-assessed']);
  return sessions.map(s => ({session:s.session,
    messages:s.messages.filter(m => m.role !== 'tool' && m.content).map(({metadata,...m}) => m),
    events:s.events.filter(e => keep.has(e.kind) || e.kind === 'tool-plan' && e.plan?.status === 'executed')
      .map(e => e.kind === 'tool-plan' ? {...e,plan:Object.fromEntries(Object.entries(e.plan).filter(([key])=>key!=='raw'))} : e)
  }));
}

for (const test of (process.env.BENCHMARK_CASE ? [process.env.BENCHMARK_CASE] : Object.keys(cases))) {
  if (!Object.hasOwn(cases,test)) throw Error('Invalid benchmark case');
  const base = join(root,arm,test), homeDir = join(base,'home'), workspaceRoot = join(base,'workspace');
  const profile = join(homeDir,'.estacoda/profiles/default'), evidence = join(out,arm,test);
  await mkdir(profile,{recursive:true}); await mkdir(evidence,{recursive:true});
  const save = (p,v) => writeFile(join(evidence,p),JSON.stringify(safe(v),null,2));
  const authPath = join(profile,'auth.json');
  const config = { model:{provider:'codex',id:'gpt-6.1-sol',fallbacks:[]},providers:{codex:{kind:'openai-compatible',apiMode:'openai_responses',authMethod:'oauth_device_pkce',enableNetwork:true,models:['gpt-6.1-sol']}},web:{enableNetwork:false},skills:{autonomy:'proactive'}};
  await writeFile(join(profile,'config.json'),JSON.stringify(config),{mode:0o600});
  const initial = await fingerprints(workspaceRoot), started = Date.now();
  let runtime, db, store, response, error;
  console.log(JSON.stringify({arm,test,phase:'starting'}));
  try {
    await writeFile(authPath,JSON.stringify({version:auth.version,providers:{codex:token}}),{mode:0o600});
    const cfg = await loadRuntimeConfig({workspaceRoot,homeDir,profileId:'default'});
    const trust = new WorkspaceTrustStore({homeDir}); await trust.grant(workspaceRoot);
    db = await createSQLiteSessionDB({path:join(base,'sessions.sqlite')}); store = new SQLiteTaskStore({db:db.db,profileId:'default'});
    runtime = await createRuntime({homeDir,workspaceRoot,profileId:'default',sessionDb:db,trustStore:trust,workspaceTrusted:true,tokens:resolveTokens('standard','dark','kemetBlue'),
      model:cfg.model,primaryModelRoute:cfg.primaryModelRoute,modelFallbackRoutes:[],providerRegistry:cfg.providerRegistry,providerConfigs:cfg.config.providers,
      localSkillsRoot:join(profile,'skills'),skillAutonomy:'proactive',enableWebNetwork:false,disableCronTools:true,
      enabledToolsets:['core','files','shell-readonly','shell-write','research','coding'],securityMode:'open',
      executionControls:{providerBudgets:budgets,providerRequestDefaults:{temperature:0,maxTokens:5000},childProcessEnv:{mode:'isolated',homeDir}}});
    const prompt = cases[test];
    response = await runtime.handle({text:prompt,requirementText:prompt,channel:'cli',trustedWorkspace:true,signal:AbortSignal.timeout(650000)});
    await save('foreground.json',{text:response.text,finalOutcome:response.finalOutcome,completionValidationFailure:response.completionValidationFailure});
    await save('learning-at-handoff.json',await readFile(join(profile,'skills/.evolution/learning.json'),'utf8').then(JSON.parse).catch(()=>null));
    const resultService = new TaskResultService({store,profileId:'default',sessionDb:db,contentRoot:resolveProfileStateHome({homeDir,profileId:'default'}).taskResultsPath});
    for (const task of store.listTasks()) {
      const ownerId = `live-${arm}-${test}`;
      if (!store.acquireTaskHostLease({taskId:task.id,workspaceIdentityHash:task.workspace.identityHash,ownerId,kind:'foreground',acquiredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString()})) throw Error('No host lease');
      const scheduler = new TaskScheduler({store,resultService,ownerId,limits:{maxProfileConcurrentAttempts:2},resolveExecutor:()=>runtime.taskAgentExecutor});
      for (let i=0;i<8;i++) {
        const result = await scheduler.runOnce(); await save(`scheduler-${i}.json`,result);
        console.log(JSON.stringify({arm,test,phase:'scheduled',round:i,status:store.getTask(task.id).status}));
        if (['completed','partial','failed','cancelled'].includes(store.getTask(task.id).status) || result.dispatched===0) break;
      }
      for (const r of store.listResults(task.id)) {
        const { content } = await resultService.readText({taskId:task.id,resultId:r.id,sessionId:runtime.sessionId});
        await writeFile(join(evidence,`${r.disposition}-${r.stepId}.md`),safe(content));
      }
    }
    for(let i=0;i<70;i++) {
      const state=await readFile(join(profile,'skills/.evolution/learning.json'),'utf8').then(JSON.parse).catch(()=>({records:[]}));
      if(i>1 && !state.records.some(r=>!r.draftStatus || ['pending','attempted'].includes(r.draftStatus))) break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    for(const file of ['learning.json','observations.jsonl','learning-candidates.jsonl','patch-proposals.jsonl']) {
      const text=await readFile(join(profile,'skills/.evolution',file),'utf8').catch(()=>null);
      if(text!==null) await save('learning-'+file+'.json',text);
    }
  } catch(e) {error=String(e); console.error(JSON.stringify({arm,test,error}));}
  finally {
    try {
      const sessions=[];
      if(db) for(const s of await db.listSessions()) sessions.push({session:s,messages:await db.listMessages(s.id),events:await db.listEvents(s.id)});
      const usage=db?await db.listProviderUsageEntries('default'):[];
      await save('transcript.json',compactSessions(sessions));await save('usage.json',usage);
      const summary={arm,test,error,exports:store?.listTasks().flatMap(t=>store.listSteps(t.id,t.activePlanRevisionId).filter(s=>s.executor.role==='report-delivery').map(s=>({stepId:s.id,executor:s.executor,status:s.status})))??[],elapsedMs:Date.now()-started,inputsUnchanged:JSON.stringify(initial)===JSON.stringify(await fingerprints(workspaceRoot)),outcome:response?.finalOutcome,providerCalls:usage.length,
        tasks:store?.listTasks().map(t=>({task:t,steps:store.listSteps(t.id,t.activePlanRevisionId),attempts:store.listAttempts(t.id),results:store.listResults(t.id),events:store.listEvents(t.id)}))??[]};
      await save('summary.json',summary);
      console.log(JSON.stringify({arm,test,phase:'done',providerCalls:usage.length,elapsedMs:summary.elapsedMs,tasks:summary.tasks.map(t=>t.task.status),error}));
    } finally {try{if(runtime)await runtime.dispose();else if(db)await db.close();}finally{await rm(authPath,{force:true});}}
  }
}

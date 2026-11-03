// Authorized live A/B: production foreground planner, durable workers, real repository tests.
// node --import tsx <this-file> /private/tmp/<fresh-root> prepare|before|after
import { mkdir, readFile, writeFile, rm, symlink, cp, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo = process.cwd(), root = resolve(process.argv[2] ?? ''), arm = process.argv[3];
const out = dirname(fileURLToPath(import.meta.url));
if (!root.startsWith('/private/tmp/') || !['prepare', 'before', 'after'].includes(arm)) throw Error('Expected fresh /private/tmp root and prepare|before|after');
const hash = value => createHash('sha256').update(value).digest('hex');
const budgets = { maxProviderIterations: 24, maxProviderToolCalls: 55, maxProviderWallClockMs: 420000, maxRepeatedToolFailures: 5, finalizationReserveMs: 20000 };
const workPrompt = `Review the release readiness of the EstaCoda delegation and skill-discovery changes in this workspace. These are real source files and tests, not a mock application. Read MANIFEST.json for the source boundary. Use two delegated workers with non-overlapping scopes, followed by one combined report. Each worker should inspect relevant implementation and execute its own focused tests. The delegation worker should inspect src/config/delegation-defaults.ts, src/delegation/toolset-security.ts and the Task approval boundary, and run: pnpm exec vitest run --config vitest.node.config.ts src/delegation/toolset-security.test.ts src/tasks/task-approval-service.test.ts . The skill worker should inspect src/tools/skill-tools.ts and run: pnpm exec vitest run --config vitest.node.config.ts src/tools/skill-tools.test.ts . Give workers the eligible read/search and execution tools needed. Use available capability discovery if needed. Preserve source and tests unchanged. Do not run installation, network research or personal-state inspection. Workers must return concrete source references and actual command/exit/test-count receipts, including any failed checks or missing capability. Synthesis must read both worker reports, explain whether the tests establish the claimed boundaries and identify remaining limits. Do not treat suite counts as comparative performance scores. If a requested delegation capability is unavailable, adapt within policy and disclose which requested work remains incomplete. Return a useful report of about 600 words.`;
const skillsPrompt = `Audit the skills currently visible to this session. First call skill.list with category set to the empty string, then call it with no category, then with category __missing_catalog_probe__. These deliberately supplied inputs exercise discovery, not skill execution. Explain whether the first two return the same names/count and whether the last means an empty catalog or an unmatched category. Use tool results rather than guessing from the prompt index; do not edit skills or inspect personal state. Return the observed counts and a brief interpretation.`;
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
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await mkdir(root, { recursive: false });
  const archive = join(root, 'baseline.tar');
  execFileSync('git', ['archive', baseline, '--output', archive]);
  await mkdir(join(root, 'before-source'));
  execFileSync('tar', ['-xf', archive, '-C', join(root,'before-source')]);
  await rm(archive);
  await cp(join(root,'before-source'),join(root,'after-source'),{recursive:true});
  const changed = execFileSync('git',['diff','--name-only','HEAD','--','src','skills'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for (const p of changed) await cp(join(repo,p),join(root,'after-source',p));
  for (const a of ['before','after']) await symlink(join(repo,'node_modules'),join(root,`${a}-source/node_modules`));
  const fixture = join(root,'fixture'); await mkdir(fixture);
  for (const p of ['src','registries','assets','workers','skills','package.json','tsconfig.json','vitest.node.config.ts']) {
    await cp(join(root,'after-source',p),join(fixture,p),{recursive:true});
  }
  const inputHashes = await fingerprints(fixture);
  const manifest = { baseline, model:'codex/gpt-6.1-sol', budgets, workPrompt, skillsPrompt,
    updatedSourceHashes: Object.fromEntries(await Promise.all(changed.map(async p=>[p,hash(await readFile(join(repo,p)))]))),
    inputHashes, scope:'Identical updated subject source in both arms. Foreground model creates the graph; production workers execute real source tests. Separate fresh skill-discovery sessions use deliberately supplied filter inputs. No Telegram delivery or general performance ranking.' };
  await writeFile(join(fixture,'MANIFEST.json'),JSON.stringify({baseline,updatedSourceHashes:manifest.updatedSourceHashes,scope:manifest.scope},null,2));
  execFileSync('git',['init','-q',fixture]);
  execFileSync('git',['-C',fixture,'add','.']);
  execFileSync('git',['-C',fixture,'-c','core.hooksPath=/dev/null','-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','commit','-qm','Pinned benchmark subject snapshot']);
  manifest.fixtureRevision = execFileSync('git',['-C',fixture,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  for (const a of ['before','after']) for (const test of ['work','skills']) {
    const workspace = join(root,a,test,'workspace');
    await cp(fixture,workspace,{recursive:true});
    await symlink(join(repo,'node_modules'),join(workspace,'node_modules'));
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
  const keep = new Set(['step-completion-validation', 'execution-final-outcome-recorded', 'provider-budget-exhausted', 'structured-tool-history-selected', 'tool-gated', 'security-assessed']);
  return sessions.map(s => ({session:s.session,
    messages:s.messages.filter(m => m.role !== 'tool' && m.content).map(({metadata,...m}) => m),
    events:s.events.filter(e => keep.has(e.kind) || e.kind === 'tool-plan' && e.plan?.status === 'executed')
      .map(e => e.kind === 'tool-plan' ? {...e,plan:Object.fromEntries(Object.entries(e.plan).filter(([key])=>key!=='raw'))} : e)
  }));
}

for (const test of ['work','skills']) {
  const base = join(root,arm,test), homeDir = join(base,'home'), workspaceRoot = join(base,'workspace');
  const profile = join(homeDir,'.estacoda/profiles/default'), evidence = join(out,arm,test);
  await mkdir(profile,{recursive:true}); await mkdir(evidence,{recursive:true});
  const save = (p,v) => writeFile(join(evidence,p),JSON.stringify(safe(v),null,2));
  const authPath = join(profile,'auth.json');
  const config = { model:{provider:'codex',id:'gpt-6.1-sol',fallbacks:[]},providers:{codex:{kind:'openai-compatible',apiMode:'openai_responses',authMethod:'oauth_device_pkce',enableNetwork:true,models:['gpt-6.1-sol']}},web:{enableNetwork:false},skills:{autonomy:'none'}};
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
      localSkillsRoot:join(profile,'skills'),skillAutonomy:'none',enableWebNetwork:false,disableCronTools:true,
      enabledToolsets:['core','files','shell-readonly','shell-write','research','coding'],securityMode:'adaptive',
      executionControls:{providerBudgets:budgets,providerRequestDefaults:{temperature:0,maxTokens:5000},childProcessEnv:{mode:'isolated',homeDir}}});
    const prompt = test === 'work' ? workPrompt : skillsPrompt;
    response = await runtime.handle({text:prompt,requirementText:prompt,channel:'cli',trustedWorkspace:true,signal:AbortSignal.timeout(450000)});
    await save('foreground.json',{text:response.text,finalOutcome:response.finalOutcome,completionValidationFailure:response.completionValidationFailure});
    const resultService = new TaskResultService({store,profileId:'default',sessionDb:db,contentRoot:resolveProfileStateHome({homeDir,profileId:'default'}).taskResultsPath});
    for (const task of store.listTasks()) {
      const ownerId = `live-${arm}-${test}`;
      if (!store.acquireTaskHostLease({taskId:task.id,workspaceIdentityHash:task.workspace.identityHash,ownerId,kind:'foreground',acquiredAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString()})) throw Error('No host lease');
      const scheduler = new TaskScheduler({store,resultService,ownerId,limits:{maxProfileConcurrentAttempts:2},resolveExecutor:()=>runtime.taskAgentExecutor});
      for (let i=0;i<8;i++) {
        const result = await scheduler.runOnce(); await save(`scheduler-${i}.json`,result);
        console.log(JSON.stringify({arm,test,phase:'scheduled',round:i,status:store.getTask(task.id).status}));
        if (['completed','partial','failed','cancelled'].includes(store.getTask(task.id).status) || result.claimed===0) break;
      }
      for (const r of store.listResults(task.id)) {
        let offset=0, content='';
        while(true) {const page=await resultService.readText({taskId:task.id,resultId:r.id,sessionId:runtime.sessionId,offset,maxChars:20000}); content+=page.content;if(page.nextOffset===undefined)break;offset=page.nextOffset;}
        await writeFile(join(evidence,`${r.disposition}-${r.stepId}.md`),safe(content));
      }
    }
  } catch(e) {error=String(e); console.error(JSON.stringify({arm,test,error}));}
  finally {
    try {
      const sessions=[];
      if(db) for(const s of await db.listSessions()) sessions.push({session:s,messages:await db.listMessages(s.id),events:await db.listEvents(s.id)});
      const usage=db?await db.listProviderUsageEntries('default'):[];
      await save('transcript.json',compactSessions(sessions));await save('usage.json',usage);
      const summary={arm,test,error,elapsedMs:Date.now()-started,inputsUnchanged:JSON.stringify(initial)===JSON.stringify(await fingerprints(workspaceRoot)),outcome:response?.finalOutcome,providerCalls:usage.length,
        tasks:store?.listTasks().map(t=>({task:t,steps:store.listSteps(t.id,t.activePlanRevisionId),attempts:store.listAttempts(t.id),results:store.listResults(t.id),events:store.listEvents(t.id)}))??[]};
      await save('summary.json',summary);
      console.log(JSON.stringify({arm,test,phase:'done',providerCalls:usage.length,elapsedMs:summary.elapsedMs,tasks:summary.tasks.map(t=>t.task.status),error}));
    } finally {try{if(runtime)await runtime.dispose();else if(db)await db.close();}finally{await rm(authPath,{force:true});}}
  }
}

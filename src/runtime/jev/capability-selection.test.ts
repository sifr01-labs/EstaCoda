import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RegisteredTool } from '../../contracts/tool.js';
import { resolveProfileStateHome } from '../../config/profile-home.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { loadSkillsFromDirectory } from '../../skills/skill-loader.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { createCapabilityTools, SessionCapabilityRecovery } from '../../tools/capability-tools.js';
import { buildProviderToolSchemaCatalog, MAX_PROVIDER_TOOLS, MAX_PROVIDER_SCHEMA_TOKENS } from '../../tools/tool-schema.js';
import { InMemorySessionDB } from '../../session/in-memory-session-db.js';
import { IntentRouter } from '../intent-router.js';
import { selectProviderToolsForTurn } from '../provider-tool-narrowing.js';
import { JevDecisionClient } from './decision-client.js';
import { routingSnapshotReader } from './routing-snapshot.js';
import { selectJevCapabilities } from './capability-selection.js';

function tool(name: string, extra: Partial<RegisteredTool> = {}): RegisteredTool {
 return { name, description: `Registered capability ${name}`, toolsets: ['test'], inputSchema: { type: 'object' }, riskClass: 'read-only-local', progressLabel: 'test', maxResultSizeChars: 1000, isAvailable: () => true, run: async () => ({ ok: true, content: 'done' }), ...extra };
}
const scope = { sessionId: 'session', profileId: 'p', visibleTurnId: 'turn', toolCallId: 'call' };
let home: string, registry: ToolRegistry, skills: SkillRegistry, recovery: SessionCapabilityRecovery, db: InMemorySessionDB;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>, chosen: string[], hook: (() => void) | undefined;
beforeEach(async () => {
 home = await mkdtemp(join(tmpdir(), 'jev-capability-')); registry = new ToolRegistry(); skills = new SkillRegistry(); db = new InMemorySessionDB();
 await db.createSession({ id: 'session', profileId: 'p' }); await db.appendMessage({ id: 'turn', sessionId: 'session', role: 'user', content: 'request' });
 const paths = resolveProfileStateHome({ homeDir: home, profileId: 'p' }); await mkdir(paths.profileRoot, { recursive: true });
 await writeFile(paths.configPath, JSON.stringify({ routing: { mode: 'jev-assisted' } })); await writeFile(paths.envPath, 'TYPESAFE_API_KEY=fixture-only-secret\n');
 recovery = new SessionCapabilityRecovery({ registry, skills }); for (const t of createCapabilityTools(recovery)) registry.register(t);
 chosen = []; hook = undefined;
 fetcher = vi.fn(async (_url, init) => {
  const body = JSON.parse(String(init?.body)); hook?.();
  return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 30, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { type: 'noul', noul: chosen.some(name => (q as any).instructions.subjectDescription.startsWith(name + ':')) ? .95 : .05 }])) }));
 });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function harness(request = 'Investigate and prepare a briefing.', requiredTools: readonly string[] = []) {
 const available = await registry.snapshot(); const catalog = buildProviderToolSchemaCatalog({ tools: available.available, unavailableTools: available.unavailable }); recovery.bindCatalog(catalog);
 const router = new IntentRouter({ skillRegistry: skills });
 const snapshot = routingSnapshotReader({ homeDir: home, profileId: 'p', router, capabilityRevision: () => recovery.catalogRevision() });
 const client = new JevDecisionClient({ homeDir: home, profileId: 'p', snapshot, fetch: fetcher, recordUsage: entries => db.recordProviderUsageEntries([...entries]) });
 const routing = { client, snapshot }; recovery.bindRouting(routing);
 const intent = router.route(request); const standard = selectProviderToolsForTurn({ catalog, intent, userText: request, requiredTools });
 const select = () => selectJevCapabilities({ routing, catalog, intent, standard, requiredTools, validateTool: id => recovery.toolSchema(id), evaluation: { context: { userRequest: request }, usage: { requestKey: 'initial', executionSessionId: 'session', visibleTurnId: 'turn' } } });
 recovery.beginTurn({ ...scope, tools: [], objective: request });
 return { catalog, intent, standard, select };
}
const names = (result: Awaited<ReturnType<typeof selectJevCapabilities>>) => result.initialTools.map(t => t.function.name);

describe('live Jev capability selection and recovery', () => {
 it.each([true, false])('keeps host-required dependency reading only when available (available=%s)', async available => {
  registry.register(tool('task.result.read', { toolsets: ['core'], isAvailable: () => available }));
  const h = await harness('Combine the accepted worker findings into a report.', ['task.result.read', 'unregistered.tool']);
  const selected = names(await h.select());
  expect(selected.includes('task_result_read')).toBe(available);
  expect(h.standard.initialTools.some(tool => tool.function.name === 'task_result_read')).toBe(available);
  expect(selected).not.toContain('unregistered_tool');
 });
 it('does not let host prerequisites override an explicit tool prohibition', async () => {
  registry.register(tool('task.result.read', { toolsets: ['core'] }));
  const h = await harness('Combine findings. Do not use task.result.read.', ['task.result.read']);
  expect(names(await h.select())).not.toContain('task_result_read');
 });

 it('preserves explicit URL extraction despite a negative Jev decision without enabling prohibited search', async () => {
  registry.register(tool('web.extract', { toolsets: ['web'], riskClass: 'read-only-network' }));
  registry.register(tool('web.search', { toolsets: ['web'], riskClass: 'read-only-network' }));
  const h = await harness('Read https://example.com/spec and explain its status definitions. Do not use web search.');
  const selected = names(await h.select());
  expect(selected).toContain('web_extract');
  expect(selected).not.toContain('web_search');
 });

 it('keeps local delivery readers when new research is prohibited, even with negative Jev scores', async () => {
  for (const name of ['file.read', 'task.result.read', 'task.status']) registry.register(tool(name, { toolsets: ['core', 'research'], riskClass: 'read-only-local' }));
  registry.register(tool('file.write', { toolsets: ['files'], riskClass: 'workspace-write' }));
  registry.register(tool('web.search', { toolsets: ['web', 'research'], riskClass: 'read-only-network' }));
  registry.register(tool('research.lookup', { toolsets: ['research'], riskClass: 'read-only-network' }));
  chosen = ['web.search', 'research.lookup'];
  const h = await harness('Save the existing report to report.md. Do not repeat research.');
  h.intent.requestRequirements!.sourceTaskId = 'task_existing';
  const selected = names(await h.select());
  expect(selected).toEqual(expect.arrayContaining(['file_read', 'task_result_read', 'task_status', 'file_write']));
  expect(selected).not.toContain('web_search');
  expect(selected).not.toContain('research_lookup');
 });
 it.each(['Save report.md. Do not use file.read. No web research is needed.', 'No web research is needed, but save report.md. Do not use file.read.'])('preserves exact tool prohibitions and negative need scope: %s', async request => {
  registry.register(tool('file.read', { toolsets: ['files', 'research'], riskClass: 'read-only-local' }));
  registry.register(tool('web.search', { toolsets: ['web'], riskClass: 'read-only-network' }));
  chosen = ['file.read', 'web.search'];
  const h = await harness(request);
  const selected = names(await h.select());
  expect(selected).not.toContain('file_read');
  expect(selected).not.toContain('web_search');
 });
 it('does not treat the name researcher as permission to override a no-research clause', async () => {
  registry.register(tool('web.search', { toolsets: ['web'], riskClass: 'read-only-network' }));
  chosen = ['web.search'];
  const h = await harness('Use the researcher skill to explain this supplied text. No web research is needed.');
  expect(names(await h.select())).not.toContain('web_search');
 });
 it('routes discovery with an empty optional ID filter through Jev', async () => {
  registry.register(tool('wanted')); chosen = ['wanted']; await harness('Inspect available tools');
  const result = await recovery.discoverAsync({ ids: [], query: 'find a tool' }, scope);
  expect(result.ok).toBe(true);
  expect(result.metadata?.matches).toEqual([expect.objectContaining({ id: 'tool:wanted' })]);
  expect(fetcher).toHaveBeenCalledOnce();
 });
 it('assesses the complete crowded catalog in bounded batches and selects complementary capabilities', async () => {
  for (let i = 0; i < 140; i++) registry.register(tool(`candidate.${i}`));
  chosen = ['candidate.0', 'candidate.139']; const h = await harness(); const result = await h.select();
  expect(names(result)).toEqual(expect.arrayContaining(['candidate_0', 'candidate_139', 'capability_request', 'capability_discover']));
  expect(names(result)).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.flatMap(([, init]) => Object.keys(JSON.parse(String(init?.body)).questions))).toHaveLength(142);
  expect(await db.listProviderUsageEntries('p')).toHaveLength(3);
 });
 it('adds explicit request tools but only relevant dependencies from complementary skills', async () => {
  for (const name of ['file.write', 'file.read', 'delegate_task', 'a', 'b', 'optional']) registry.register(tool(name, { toolsets: [name] }));
  const h = await harness('Use 3 subagents and save a report to report.md.');
  h.intent.suggestedSkills = [{ name: 'one', requiredToolsets: ['a'], optionalToolsets: ['optional'] }, { name: 'two', requiredToolsets: ['b'] }] as typeof h.intent.suggestedSkills;
  chosen = ['a'];
  const result = await h.select(); expect(names(result)).toEqual(expect.arrayContaining(['file_write', 'file_read', 'delegate_task', 'a'])); expect(names(result)).not.toContain('optional'); expect(names(result)).not.toContain('b');
  expect(result.capabilityRouting?.requiredConflicts).not.toContain('b');
  recovery.beginTurn({ ...scope, tools: result.initialTools });
  expect((await recovery.discoverAsync({ ids: ['tool:b'] }, scope)).metadata?.matches).toEqual([expect.objectContaining({ id: 'tool:b', state: 'not_selected' })]);
  expect(recovery.request({ ids: ['tool:b'], reason: 'needed for the next step' }, scope).ok).toBe(true);
  const expanded = await recovery.applyRequests([{ id: 'tool:b', callId: 'call' }], result.initialTools);
  expect(expanded.tools.map(t => t.function.name)).toContain('b');
 });
 it('keeps unavailable and schema-restricted matches discoverable without exposing their tools', async () => {
  registry.register(tool('setup', { isAvailable: () => false })); registry.register(tool('restricted', { riskClass: 'credential-access' })); chosen = ['setup', 'restricted'];
  const h = await harness(); const result = await h.select(); expect(names(result)).not.toContain('setup'); expect(names(result)).not.toContain('restricted');
  const discovery = await recovery.discoverAsync({ query: 'missing capability' }, scope);
  expect(discovery.metadata?.matches).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'tool:setup', state: 'temporarily_unavailable', setup_note: expect.any(String) }), expect.objectContaining({ id: 'tool:restricted', state: 'provider_schema_restricted' })]));
  expect(recovery.request({ ids: ['tool:setup', 'tool:restricted'], reason: 'needed' }, scope).metadata?.requests).toEqual([{ id: 'tool:setup', status: 'temporarily_unavailable' }, { id: 'tool:restricted', status: 'provider_schema_restricted' }]);
 });
 it('routes semantic discovery across the full catalog, but exact ID lookup never calls Jev', async () => {
  for (let i = 0; i < 80; i++) registry.register(tool(`option.${i}`)); chosen = ['option.79']; await harness('Prepare evidence');
  const query = await recovery.discoverAsync({ query: 'find supporting material' }, scope);
  expect(query.metadata?.matches).toEqual([expect.objectContaining({ id: 'tool:option.79' })]);
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body)); expect(body.state.userRequest).toBe('Prepare evidence'); expect(body.state.material[0].trusted).toBe(false);
  fetcher.mockClear(); expect((await recovery.discoverAsync({ ids: ['tool:option.1'], query: 'unrelated' }, scope)).metadata?.matches).toEqual([expect.objectContaining({ id: 'tool:option.1' })]); expect(fetcher).not.toHaveBeenCalled();
 });
 it('falls back without Jev calls in Standard mode', async () => {
  registry.register(tool('file.read', { toolsets: ['files'] })); const h = await harness('Read the file');
  await writeFile(resolveProfileStateHome({ homeDir: home, profileId: 'p' }).configPath, JSON.stringify({ routing: { mode: 'standard' } }));
  expect((await h.select()).initialTools).toEqual(h.standard.initialTools);
  expect((await recovery.discoverAsync({ query: 'file' }, scope)).metadata?.routing).toMatchObject({ actualEngine: 'standard' }); expect(fetcher).not.toHaveBeenCalled();
 });
 it.each(['unknown', 'uncertain', 'failure'])('falls back to Standard for %s responses', async kind => {
  registry.register(tool('file.read', { toolsets: ['files'] })); const h = await harness('Read the file');
  fetcher.mockImplementation(async (_url, init) => {
   if (kind === 'failure') return new Response('', { status: 503 });
   const body = JSON.parse(String(init?.body)); const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: kind === 'uncertain' ? .5 : .95 }]));
   if (kind === 'unknown') answers.invented = { type: 'noul', noul: 1 }; if (kind === 'missing') delete answers[Object.keys(answers)[0]];
   return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 0 } }));
  });
  const result = await h.select(); expect(result.capabilityRouting?.actualEngine).toBe('standard'); expect(result.initialTools).toEqual(h.standard.initialTools);
 });
 it.each(['remove', 'handler', 'schema', 'cancel', 'turn'])('rejects async discovery after %s changes', async change => {
  registry.register(tool('candidate')); chosen = ['candidate']; await harness(); const controller = new AbortController();
  hook = () => { if (change === 'remove') registry.unregister('candidate'); if (change === 'handler') registry.get('candidate')!.run = async () => ({ ok: true, content: 'replacement' }); if (change === 'schema') registry.get('candidate')!.inputSchema = { type: 'string' }; if (change === 'cancel') controller.abort(); if (change === 'turn') recovery.beginTurn({ ...scope, visibleTurnId: 'next', tools: [] }); };
  const result = await recovery.discoverAsync({ query: 'candidate' }, { ...scope, signal: controller.signal }); expect(result.ok).toBe(false);
 });
 it('revalidates before initial exposure and never resurrects a removed Standard tool on fallback', async () => {
  registry.register(tool('file.read', { toolsets: ['files'] })); chosen = ['file.read']; const h = await harness('Read file'); hook = () => { registry.unregister('file.read'); };
  const result = await h.select(); expect(names(result)).not.toContain('file_read'); expect(result.capabilityRouting?.actualEngine).toBe('standard');
 });
 it('preserves aliases and stages required overflow through authenticated next-iteration requests', async () => {
  for (let i = 0; i < 110; i++) registry.register(tool(`required.${i}`)); registry.register(tool('required_0')); const h = await harness();
  chosen = Array.from({ length: 110 }, (_, i) => `required.${i}`);
  h.intent.suggestedSkills = [{ name: 'large', requiredToolsets: ['test'] }] as typeof h.intent.suggestedSkills;
  const result = await h.select(); expect(names(result)).toHaveLength(MAX_PROVIDER_TOOLS); expect(result.stagedTools!.length).toBeGreaterThan(0);
  const staged = result.stagedTools![0]; const alias = h.catalog.entries.find(t => t.tool.name === staged)!.schema.function.name;
  recovery.beginTurn({ ...scope, tools: result.initialTools, stagedTools: result.stagedTools });
  const request = recovery.request({ ids: [`tool:${staged}`], reason: 'Next required stage' }, scope);
  expect((await recovery.discoverAsync({ ids: [`tool:${staged}`] }, scope)).metadata?.matches).toEqual([expect.objectContaining({ state: 'not_selected' })]);
  expect(recovery.takeRequests([{ tool: registry.get('capability.request')!, input: {}, decision: 'allow', riskClass: 'read-only-local', toolCallId: 'call', result: { ...request } }])).toEqual([]);
  const proposals = recovery.takeRequests([{ tool: registry.get('capability.request')!, input: {}, decision: 'allow', riskClass: 'read-only-local', toolCallId: 'call', result: request }]);
  const expanded = await recovery.applyRequests(proposals, result.initialTools);
  expect(expanded.tools.map(t => t.function.name)).toContain(alias); expect(expanded.tools).toHaveLength(MAX_PROVIDER_TOOLS); expect(expanded.deferred).toHaveLength(1);
  expect(expanded.tools.map(t => t.function.name)).toEqual(expect.arrayContaining(['capability_request', 'capability_discover']));
 });
 it('records unexposable oversized required schemas without exceeding byte limits', async () => {
  registry.register(tool('file.write', { inputSchema: { description: 'x'.repeat(MAX_PROVIDER_SCHEMA_TOKENS * 8) } })); const h = await harness('Save report.md.');
  const result = await h.select(); expect(result.capabilityRouting?.requiredConflicts).toContain('file.write'); expect(result.stagedTools).toContain('file.write');
  recovery.beginTurn({ ...scope, tools: result.initialTools, stagedTools: result.stagedTools });
  const expanded = await recovery.applyRequests([{ id: 'tool:file.write', callId: 'call' }], result.initialTools);
  expect(expanded.rejected).toContainEqual({ id: 'tool:file.write', reason: 'schema_budget' }); expect(expanded.tools).toEqual(result.initialTools);
 });
});

it.each(['Do not research. Read the notes.', 'لا تبحث. اقرأ الملاحظات.'])('keeps explicit prohibitions binding despite positive relevance: %s', async request => {
 registry.register(tool('web.search', { toolsets: ['web'] })); registry.register(tool('file.read', { toolsets: ['files'] })); chosen = ['web.search', 'file.read'];
 const h = await harness(request); expect(names(await h.select())).toContain('file_read'); expect(names(await h.select())).not.toContain('web_search');
});
it('rechecks availability after the network decision and retains evidence-gated expansion', async () => {
 let available = true; registry.register(tool('live', { isAvailable: () => available })); registry.register(tool('browser.vision')); chosen = ['live', 'browser.vision']; const h = await harness();
 h.standard.expansionCandidates = [{ toolName: 'browser.vision', source: 'active-browser', schema: h.catalog.entries.find(e => e.tool.name === 'browser.vision')!.schema }];
 hook = () => { available = false; };
 const result = await h.select(); expect(names(result)).not.toContain('live'); expect(names(result)).not.toContain('browser_vision'); expect(result.expansionCandidates).toHaveLength(1);
});
it('selects no capabilities when none are relevant', async () => {
 registry.register(tool('irrelevant')); const h = await harness('Hello'); const result = await h.select(); expect(result.initialTools).toEqual([]); expect(result.capabilityRouting?.actualEngine).toBe('jev');
});
it('discards a response after the mode changes and performs current Standard selection', async () => {
 registry.register(tool('unrelated')); chosen = ['unrelated']; const h = await harness('Hello');
 const original = fetcher.getMockImplementation()!;
 fetcher.mockImplementation(async (...args) => { const response = await original(...args); await writeFile(resolveProfileStateHome({ homeDir: home, profileId: 'p' }).configPath, JSON.stringify({ routing: { mode: 'standard' } })); return response; });
 const result = await h.select(); expect(result.initialTools).toEqual(h.standard.initialTools); expect(result.capabilityRouting?.actualEngine).toBe('standard');
});
it('rejects a pending expansion when execution/catalog identity changes during availability checks', async () => {
 registry.register(tool('target')); registry.register(tool('another')); const h = await harness();
 registry.get('target')!.isAvailable = async () => { registry.get('another')!.description = 'changed'; return true; };
 const result = await recovery.applyRequests([{ id: 'tool:target', callId: 'call' }], h.standard.initialTools);
 expect(result.applied).toEqual([]); expect(result.rejected).toEqual([{ id: 'tool:target', reason: 'inactive_scope' }]);
});
it('keeps discovery reachable when semantic selection misses every initial capability for an actionable request', async () => {
 registry.register(tool('missed')); const h = await harness('Investigate this issue.'); const result = await h.select();
 expect(names(result)).toEqual(expect.arrayContaining(['capability_discover', 'capability_request'])); expect(names(result)).not.toContain('missed');
});
it('respects the schema token budget before the count limit and prioritizes explicit file obligations', async () => {
 for (let i = 0; i < 15; i++) registry.register(tool(`large.${i}`, { inputSchema: { description: 'x'.repeat(15_000) } }));
 registry.register(tool('file.write')); registry.register(tool('file.read')); const h = await harness('Save to report.md.');
 h.intent.suggestedSkills = [{ name: 'bulk', requiredToolsets: ['test'] }] as typeof h.intent.suggestedSkills;
 const result = await h.select(); expect(names(result).length).toBeLessThan(15); expect(names(result)).toEqual(expect.arrayContaining(['file_write', 'file_read', 'capability_request'])); expect(JSON.stringify(result.initialTools).length / 4).toBeLessThanOrEqual(MAX_PROVIDER_SCHEMA_TOKENS);
});

it.each([[401,'authentication'],[429,'rate-limited']] as const)('retains actionable initial and discovery fallback for HTTP %i',async(status,reason)=>{
 registry.register(tool('file.read',{toolsets:['files']}));const h=await harness('Read the file');fetcher.mockResolvedValue(new Response('private provider diagnostic',{status}));
 expect((await h.select()).capabilityRouting).toMatchObject({configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:reason});
 expect((await recovery.discoverAsync({query:'file'},scope)).metadata?.routing).toMatchObject({configuredMode:'jev-assisted',actualEngine:'standard',fallbackReason:reason});
});

it('merges missing candidates with Standard without discarding confident selections or rejections',async()=>{
 registry.register(tool('file.read',{toolsets:['files']}));registry.register(tool('special'));registry.register(tool('file.grep',{toolsets:['files']}));
 const h=await harness('Read the file');
 fetcher.mockImplementation(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({model:'jev-1.13.0',usage:{input_tokens:10,output_tokens:1},answers:Object.fromEntries(Object.entries(body.questions).flatMap(([id,q])=>{
   const name=(q as any).instructions.subjectDescription.split(':')[0];
   return name==='file.read'?[]:[[id,{type:'noul',noul:name==='special'?.95:.05}]];
  }))}));
 });
 const result=await h.select();expect(names(result)).toEqual(expect.arrayContaining(['special','file_read']));expect(names(result)).not.toContain('file_grep');
 expect(result.capabilityRouting).toMatchObject({actualEngine:'jev',partialFallback:true,fallbackReason:'invalid-response'});
 expect(result.capabilityRouting?.diagnostics?.candidates).toContainEqual(expect.objectContaining({id:'tool:file.read',outcome:'missing',source:'standard'}));
});


it.each(['rejected', 'uncertain'])("preserves explicit inspection prerequisites when Jev is %s", async kind => {
 for (const name of ['task.status', 'task.result.read', 'config.provider.status', 'config.web.setup', 'terminal.inspect', 'terminal.run']) registry.register(tool(name, {toolsets: ['core']}));
 const h = await harness('Check task_demo status and show its saved result. Check web search settings. Inspect git diff. Do not change settings or start workers.');
 fetcher.mockImplementation(async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({model:'jev-1.13.0',usage:{input_tokens:1,output_tokens:0},answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'noul',noul:kind==='uncertain'?.5:.05}]))}));
 });
 const result = await h.select();
 expect(names(result)).toEqual(expect.arrayContaining(['task_status','task_result_read','config_provider_status','terminal_inspect']));
 expect(names(result)).not.toContain('config_web_setup'); expect(names(result)).not.toContain('terminal_run');
});
it('does not expose an unavailable explicit inspection prerequisite', async () => {
 registry.register(tool('task.status', {isAvailable:()=>false}));
 const h = await harness('Check task_demo status.');
 expect(names(await h.select())).not.toContain('task_status');
});

it.each(['researcher','wiki-builder'])('does not require unrelated core tools for %s', async name => {
 const loaded=await loadSkillsFromDirectory(new URL(`../../../skills/official/${name}`,import.meta.url).pathname,{sourceKind:'bundled'});
 expect(loaded.errors).toEqual([]);expect(loaded.skills).toHaveLength(1);
 skills.register(loaded.skills[0]);
 registry.register(tool('file.read',{toolsets:['files']}));
 registry.register(tool('unrelated.mutate',{toolsets:['core'],riskClass:'shared-state-mutation'}));
 chosen = ['file.read'];
 const h=await harness(`Use the ${name} skill.`);
 expect(h.intent.suggestedSkills.map(s=>s.name)).toContain(name);
 const result=names(await h.select());expect(result).toContain('file_read');expect(result).not.toContain('unrelated_mutate');
});

// Reading a known source and discovering new sources are separate activities.
it.each([
 'Read https://www.python.org/about/. Do not search for other pages.',
 'Read https://www.python.org/about/. No additional searches are needed.',
])('retains source extraction while prohibiting search: %s', async request => {
 registry.register(tool('web.search', { toolsets: ['web', 'research'], riskClass: 'read-only-network' }));
 registry.register(tool('web.extract', { toolsets: ['web', 'research'], riskClass: 'read-only-network' }));
 chosen = ['web.search', 'web.extract'];
 const h = await harness(request);
 const selected = names(await h.select());
 expect(selected).toContain('web_extract');
 expect(selected).not.toContain('web_search');
});
it.each([
 'Save the finished text to notes.md. No additional research.',
 'Use the researcher skill to explain supplied facts. No web research is needed and do not save any files.',
 'Read the supplied notes. Do not research.',
])('does not expose network research from negative scope: %s', async request => {
 registry.register(tool('web.search', { toolsets: ['web', 'research'], riskClass: 'read-only-network' }));
 registry.register(tool('web.extract', { toolsets: ['web', 'research'], riskClass: 'read-only-network' }));
 chosen = ['web.search', 'web.extract'];
 const h = await harness(request);
 const selected = names(await h.select());
 expect(selected).not.toContain('web_search'); expect(selected).not.toContain('web_extract');
});

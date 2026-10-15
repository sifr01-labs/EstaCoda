import type { IntentRoute } from '../../contracts/intent.js';
import { CAPABILITY_RECOVERY_TOOLS } from '../../tools/capability-tools.js';
import { budgetProviderTools, type ProviderToolSchemaCatalog } from '../../tools/tool-schema.js';
import type { ProviderToolSelection } from '../provider-tool-narrowing.js';
import { explicitInspectionTools, requiredRequestTools } from '../request-requirements.js';
import { explicitlyProhibited, type LiveJevRouting } from './live-routing.js';
import { evaluateCapabilities, type CapabilityEvaluation } from './capability-decisions.js';
export type { CapabilityEvaluation } from './capability-decisions.js';

export async function selectJevCapabilities(input: {
  routing: LiveJevRouting; catalog: ProviderToolSchemaCatalog; intent: IntentRoute;
  requiredTools?: readonly string[];
  standard: ProviderToolSelection; evaluation: CapabilityEvaluation;
  validateTool(id: string): Promise<unknown>;
}): Promise<ProviderToolSelection> {
  const decision = await evaluateCapabilities(input.routing, input.catalog.inventory.map(tool => ({ id: `tool:${tool.name}`, description: `${tool.name}: ${tool.description}` })), input.evaluation, 'initial', new Set(input.standard.initialTools.map(schema => `tool:${input.catalog.aliases.get(schema.function.name) ?? schema.function.name}`)));
  const fallback = async (): Promise<ProviderToolSelection> => {
    if (decision.configuredMode === 'standard') return { ...input.standard, capabilityRouting: decision };
    // A failed or stale semantic request cannot resurrect schemas removed while it was pending.
    const initialTools = [];
    for (const schema of input.standard.initialTools) {
      try { if (await input.validateTool(`tool:${input.catalog.aliases.get(schema.function.name) ?? schema.function.name}`)) initialTools.push(schema); } catch { /* unavailable */ }
    }
    const exposed = new Set(initialTools.map(schema => input.catalog.aliases.get(schema.function.name) ?? schema.function.name));
    return { ...input.standard, initialTools, capabilityRouting: { ...decision, partialFallback: undefined,
      ...(decision.fallbackReason === 'engine-unavailable' && decision.diagnostics ? { diagnostics: { ...decision.diagnostics, failure: decision.diagnostics.failure ?? { code: 'stale' }, candidates: decision.diagnostics.candidates.map(candidate => ({ ...candidate, source: 'standard' as const, outcome: 'discarded' as const })) } } : {}), selections: input.catalog.inventory.map(tool => ({ id: `tool:${tool.name}`, selected: exposed.has(tool.name) })) } };
  };
  if (decision.actualEngine !== 'jev') return fallback();
  const explicit = new Set([...(input.requiredTools ?? []), ...requiredRequestTools(input.intent.requestRequirements), ...explicitInspectionTools(input.evaluation.context.userRequest)]);
  const required = new Set(explicit);
  if (input.catalog.entries.some(entry => entry.tool.name === "config.provider.execution_status")) required.add("config.provider.execution_status");
  // Skill toolsets describe dependency availability, not a requirement to expose
  // every member. Prioritize relevant dependencies without undoing Jev's
  // candidate-level rejections. Omitted tools remain recoverable from the catalog.
  const requiredToolsets = new Set(input.intent.suggestedSkills.flatMap(skill => skill.requiredToolsets));
  const dependencies = new Set(input.catalog.inventory.filter(tool => tool.toolsets.some(set => requiredToolsets.has(set))).map(tool => tool.name));
  const selected = new Set(decision.selections.filter(item => item.selected).map(item => item.id.slice(5)));
  for (const name of required) selected.add(name);
  const riskClasses = new Map(input.catalog.entries.map(entry => [entry.tool.name, entry.tool.riskClass]));
  for (const tool of input.catalog.inventory) {
    // Research is an activity, not a ban on shared local readers. A save-only
    // request still needs task results and file readback. Exact tool prohibitions
    // remain binding, as do the session catalog and execution authorization.
    const categories = tool.toolsets.flatMap(set => set === 'web' || (set === 'research' && riskClasses.get(tool.name) === 'read-only-network') ? ['research'] : set === 'browser' ? ['browser-operation'] : []);
    // Reading a supplied page is distinct from searching for more pages.
    if (tool.name === 'web.search') categories.push('web-search');
    if ([tool.name, ...categories].some(category => explicitlyProhibited(input.evaluation.context.userRequest, category))) selected.delete(tool.name);
  }
  const needsRecovery = selected.size > 0 || input.standard.initialTools.some(schema => CAPABILITY_RECOVERY_TOOLS.some(name => name === (input.catalog.aliases.get(schema.function.name) ?? schema.function.name)));
  if (needsRecovery) for (const name of CAPABILITY_RECOVERY_TOOLS) selected.add(name);
  const evidenceGated = new Set(input.standard.expansionCandidates.map(candidate => candidate.toolName));
  const candidates = input.catalog.entries.filter(entry => selected.has(entry.tool.name) && !evidenceGated.has(entry.tool.name));
  const valid = [];
  for (const entry of candidates) {
    try { if (await input.validateTool(`tool:${entry.tool.name}`)) valid.push(entry); } catch { /* unavailable */ }
  }
  let now;
  try { now = input.routing.snapshot(); } catch { decision.actualEngine = "standard"; decision.fallbackReason = "engine-unavailable"; return fallback(); }
  if (input.evaluation.signal?.aborted || now.configurationRevision !== decision.configurationRevision || now.catalogRevision !== decision.catalogRevision || now.config.mode !== 'jev-assisted') {
    decision.actualEngine = 'standard'; decision.fallbackReason = 'engine-unavailable';
    return fallback();
  }
  const recovery = new Set<string>([...CAPABILITY_RECOVERY_TOOLS, "config.provider.execution_status"]);
  // Keep recovery reachable even when required dependencies exceed the schema budget.
  valid.sort((a, b) => Number(recovery.has(b.tool.name)) - Number(recovery.has(a.tool.name)) || Number(explicit.has(b.tool.name)) - Number(explicit.has(a.tool.name)) || Number(required.has(b.tool.name)) - Number(required.has(a.tool.name)) || Number(dependencies.has(b.tool.name)) - Number(dependencies.has(a.tool.name)) ||
    (decision.selections.find(s => s.id === `tool:${b.tool.name}`)?.probability ?? 0) - (decision.selections.find(s => s.id === `tool:${a.tool.name}`)?.probability ?? 0));
  const budget = budgetProviderTools({ tools: valid.map(entry => entry.schema) });
  const exposed = new Set(budget.tools.map(schema => input.catalog.aliases.get(schema.function.name) ?? schema.function.name));
  const requiredConflicts = [...required].filter(name => !exposed.has(name));
  const stagedTools = valid.filter(entry => (required.has(entry.tool.name) || dependencies.has(entry.tool.name)) && !exposed.has(entry.tool.name)).map(entry => entry.tool.name);
  return { initialTools: budget.tools, expansionCandidates: input.standard.expansionCandidates, namedConnectorIds: input.standard.namedConnectorIds,
    policy: 'jev-assisted', budgetOmittedTools: budget.omitted, stagedTools,
    capabilityRouting: { ...decision, requiredConflicts, selections: decision.selections.map(item => ({ ...item, selected: selected.has(item.id.slice(5)) })) } };
}

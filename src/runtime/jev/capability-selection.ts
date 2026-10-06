import type { IntentRoute } from '../../contracts/intent.js';
import { CAPABILITY_RECOVERY_TOOLS } from '../../tools/capability-tools.js';
import { budgetProviderTools, type ProviderToolSchemaCatalog } from '../../tools/tool-schema.js';
import type { ProviderToolSelection } from '../provider-tool-narrowing.js';
import { requiredRequestTools } from '../request-requirements.js';
import { explicitlyProhibited, type LiveJevRouting } from './live-routing.js';
import { evaluateCapabilities, type CapabilityEvaluation } from './capability-decisions.js';
export type { CapabilityEvaluation } from './capability-decisions.js';

export async function selectJevCapabilities(input: {
  routing: LiveJevRouting; catalog: ProviderToolSchemaCatalog; intent: IntentRoute;
  standard: ProviderToolSelection; evaluation: CapabilityEvaluation;
  validateTool(id: string): Promise<unknown>;
}): Promise<ProviderToolSelection> {
  const decision = await evaluateCapabilities(input.routing, input.catalog.inventory.map(tool => ({ id: `tool:${tool.name}`, description: `${tool.name}: ${tool.description}` })), input.evaluation);
  const fallback = async (): Promise<ProviderToolSelection> => {
    if (decision.configuredMode === 'standard') return { ...input.standard, capabilityRouting: decision };
    // A failed or stale semantic request cannot resurrect schemas removed while it was pending.
    const initialTools = [];
    for (const schema of input.standard.initialTools) {
      try { if (await input.validateTool(`tool:${input.catalog.aliases.get(schema.function.name) ?? schema.function.name}`)) initialTools.push(schema); } catch { /* unavailable */ }
    }
    const exposed = new Set(initialTools.map(schema => input.catalog.aliases.get(schema.function.name) ?? schema.function.name));
    return { ...input.standard, initialTools, capabilityRouting: { ...decision, selections: input.catalog.inventory.map(tool => ({ id: `tool:${tool.name}`, selected: exposed.has(tool.name) })) } };
  };
  if (decision.actualEngine !== 'jev') return fallback();
  const explicit = new Set(requiredRequestTools(input.intent.requestRequirements));
  const required = new Set(explicit);
  // Registered skill dependencies, including every complementary skill. Optional toolsets are not obligations.
  const requiredToolsets = new Set(input.intent.suggestedSkills.flatMap(skill => skill.requiredToolsets));
  for (const tool of input.catalog.inventory) if (tool.toolsets.some(set => requiredToolsets.has(set))) required.add(tool.name);
  const selected = new Set(decision.selections.filter(item => item.selected).map(item => item.id.slice(5)));
  for (const name of required) selected.add(name);
  for (const tool of input.catalog.inventory) {
    const categories = tool.toolsets.flatMap(set => set === 'web' || set === 'research' ? ['research'] : set === 'browser' ? ['browser-operation'] : []);
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
  const recovery = new Set<string>(CAPABILITY_RECOVERY_TOOLS);
  // Keep recovery reachable even when required dependencies exceed the schema budget.
  valid.sort((a, b) => Number(recovery.has(b.tool.name)) - Number(recovery.has(a.tool.name)) || Number(explicit.has(b.tool.name)) - Number(explicit.has(a.tool.name)) || Number(required.has(b.tool.name)) - Number(required.has(a.tool.name)) ||
    (decision.selections.find(s => s.id === `tool:${b.tool.name}`)?.probability ?? 0) - (decision.selections.find(s => s.id === `tool:${a.tool.name}`)?.probability ?? 0));
  const budget = budgetProviderTools({ tools: valid.map(entry => entry.schema) });
  const exposed = new Set(budget.tools.map(schema => input.catalog.aliases.get(schema.function.name) ?? schema.function.name));
  const requiredConflicts = [...required].filter(name => !exposed.has(name));
  const stagedTools = valid.filter(entry => required.has(entry.tool.name) && !exposed.has(entry.tool.name)).map(entry => entry.tool.name);
  return { initialTools: budget.tools, expansionCandidates: input.standard.expansionCandidates, namedConnectorIds: input.standard.namedConnectorIds,
    policy: 'jev-assisted', budgetOmittedTools: budget.omitted, stagedTools,
    capabilityRouting: { ...decision, requiredConflicts, selections: decision.selections.map(item => ({ ...item, selected: selected.has(item.id.slice(5)) })) } };
}

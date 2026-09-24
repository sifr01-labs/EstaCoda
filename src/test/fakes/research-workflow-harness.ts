import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProfile, ProviderRequest, ProviderStructuredToolCall } from "../../contracts/provider.js";
import type { RuntimeEvent } from "../../contracts/runtime-event.js";
import { ProviderRegistry } from "../../providers/provider-registry.js";
import { createRuntime, type Runtime } from "../../runtime/create-runtime.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import { createSQLiteSessionDB } from "../../session/session-setup.js";
import { SQLiteTaskStore } from "../../tasks/sqlite-task-store.js";
import { resolveTokens } from "../../theme/token-resolver.js";
import { registerWebResearchProvider, resetWebResearchProvidersForTest } from "../../tools/web-research-registry.js";

export const RESEARCH_PROMPT = "Do deep research on the latest battery recycling methods and prepare a report. Use 3 subagents";
// A literal public IP avoids DNS even when the real URL guard executes. No
// request reaches it: both web backends are in-memory fixtures.
export const SOURCE_URL = "https://93.184.216.34/baseline/battery-recycling";
export const REPORT = `# Battery recycling\n\nSynthetic research fixture. [Source](${SOURCE_URL})\n`;

const model: ModelProfile = {
  id: "research-baseline-model", provider: "research-baseline", contextWindowTokens: 128_000,
  supportsTools: true, supportsVision: false, supportsStructuredOutput: true
};

type ScriptStep = (request: ProviderRequest) => { content: string; toolCalls?: ProviderStructuredToolCall[] };

export function nativeCall(name: string, args: Record<string, unknown>): ScriptStep {
  return (request) => {
    const schemas = request.tools as Array<{ function: { name: string } }> | undefined;
    if (!schemas?.some((schema) => schema.function.name === name)) {
      throw new Error(`Fixture attempted unexposed native tool: ${name}`);
    }
    return { content: "", toolCalls: [{ id: "fixture-call", name, argumentsText: JSON.stringify(args) }] };
  };
}

export function answer(content: string): ScriptStep {
  return () => ({ content });
}

export async function createResearchWorkflowHarness(options: { searchAvailable?: boolean; denyWrites?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "estacoda-research-baseline-"));
  const homeDir = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const sessionDb = await createSQLiteSessionDB({ path: join(homeDir, "sessions.sqlite") });
  const store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "baseline" });
  const requests: ProviderRequest[] = [];
  const events: RuntimeEvent[] = [];
  const searches: string[] = [];
  const extracts: string[] = [];
  const script: ScriptStep[] = [];
  const scriptErrors: string[] = [];
  const providers = new ProviderRegistry();
  providers.register({
    id: model.provider, name: "Scripted research baseline", executable: true,
    health: () => ({ available: true }), listModels: () => [model],
    complete: async (request) => {
      requests.push(structuredClone(request));
      const step = script.shift();
      try {
        if (step === undefined) throw new Error("Unexpected provider call after script exhausted");
        const result = step(request);
        const toolCalls: ProviderStructuredToolCall[] | undefined = result.toolCalls?.map((call, index) => ({
          ...call, id: `fixture-call-${requests.length}-${index}`
        }));
        return {
          ok: true, provider: model.provider, model: model.id, content: result.content,
          finishReason: toolCalls?.length ? "tool_calls" : "stop",
          raw: { choices: [{ message: { tool_calls: toolCalls?.map((call) => ({ id: call.id, function: { name: call.name, arguments: call.argumentsText } })) } }] }
        };
      } catch (error) {
        scriptErrors.push(String(error));
        throw error;
      }
    }
  });
  registerWebResearchProvider({
    name: "research-baseline-web", displayName: "In-memory research fixtures",
    capabilities: { search: true, extract: true }, getAvailability: () => ({ available: true }),
    search: async (query) => {
      searches.push(query);
      return [{ title: "Synthetic battery study", url: SOURCE_URL, snippet: "A fixture, not a real scientific claim." }];
    },
    extract: async (url) => {
      if (url !== SOURCE_URL) throw new Error("Unexpected fixture URL");
      extracts.push(url);
      return { url, title: "Synthetic battery study", content: "Fixture abstract: compare recycling methods; evidence is illustrative.", status: 200 };
    }
  });
  let runtime: Runtime;
  try {
    const trustStore = new WorkspaceTrustStore({ homeDir });
    await trustStore.grant(workspaceRoot);
    runtime = await createRuntime({
      homeDir, workspaceRoot, profileId: "baseline", sessionId: "research-baseline-session", sessionDb,
      tokens: resolveTokens("standard", "dark", "kemetBlue"), model,
      primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
      providerRegistry: providers, trustStore, workspaceTrusted: true,
      localSkillsRoot: join(homeDir, "local-skills"), browser: { backend: "unconfigured", autoLaunch: false },
      enableWebNetwork: true,
      webConfig: { searchBackend: options.searchAvailable === false ? "unconfigured-baseline-web" : "research-baseline-web", extractBackend: "research-baseline-web" },
      webFetch: async () => { throw new Error("Fixture must never perform network fetches"); },
      // Constrain unrelated capabilities using the real session filter.
      // Catalog truncation is independently characterized at the function seam.
      enabledToolsets: ["core", "files", "web", "research"],
      securityPolicy: { decide: (request) => options.denyWrites && request.riskClass === "workspace-write" ? "deny" : "allow" },
      executionControls: { providerBudgets: { maxProviderIterations: 8, maxProviderToolCalls: 8, maxProviderWallClockMs: 15_000, finalizationReserveMs: 0 } }
    });
  } catch (error) {
    await sessionDb.close();
    resetWebResearchProvidersForTest();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    runtime, root, homeDir, workspaceRoot, sessionDb, store, requests, events, searches, extracts, scriptErrors,
    enqueue(...steps: ScriptStep[]) { script.push(...steps); },
    remainingSteps: () => script.length,
    turn: (text: string) => runtime.handle({ text, channel: "cli", onEvent: (event) => { events.push(event); } }),
    async dispose() {
      try { await runtime.dispose(); }
      finally {
        await sessionDb.close();
        resetWebResearchProvidersForTest();
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}

import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyFixture } from "../test/copy-fixture.js";
import { prepareTemporaryCopy } from "./temporary-copy.js";
import { ChangeApplicationStore } from "./change-application.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { resolveTokens } from "../theme/token-resolver.js";
import type { ModelProfile, ProviderResponse } from "../contracts/provider.js";

it.each(["apply", "review", "conflict", "remote", "attached", "busy"])("real runtime copy workflow: %s", async (outcome) => {
  const f = await copyFixture(), changes = new ChangeApplicationStore(f), db = new SQLiteSessionDB({ path: join(f.homeDir, "sessions.sqlite") });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    await writeFile(join(f.source, "counter.cjs"), "module.exports = n => n + 1;\n");
    await writeFile(join(f.source, "verify.cjs"), "require('node:assert/strict').equal(require('./counter.cjs')(3), 5); console.log('verified');");
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: { version: 1, files: [{ path: "counter.cjs", origin: "untracked" }, { path: "verify.cjs", origin: "dependency" }] } });
    await changes.authorize(target.id, { version: 1, outcome: outcome === "review" ? "review" : "apply", paths: [{ path: "counter.cjs", operations: ["update"] }] });
    await changes.trust.grant(f.destination);
    if (outcome === "conflict") await writeFile(join(f.source, "counter.cjs"), "user edits\n");
    const model: ModelProfile = { provider: "copy-fixture", id: "copy-fixture", contextWindowTokens: 131072, supportsTools: true, supportsVision: false, supportsStructuredOutput: true };
    const registry = new ProviderRegistry(); let step = 0, approvalRequests = 0;
    const calls = [["file.read", { path: "counter.cjs" }], ["file.patch", { mode: "replace", path: "counter.cjs", old_string: "n + 1", new_string: "n + 2" }], ["terminal.run", { command: "node verify.cjs", timeoutMs: 5000 }]] as const;
    registry.register({ id: model.provider, name: "Copy fixture", executable: true, health: () => ({ available: true }), listModels: () => [model],
      complete: async (): Promise<ProviderResponse> => {
        const call = calls[step++];
        return { ok: true, provider: model.provider, model: model.id, content: call ? "" : "Edit verified.", finishReason: call ? "tool_calls" : "stop",
          ...(call ? { raw: { choices: [{ message: { tool_calls: [{ id: `call-${step}`, function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } }] } } : {}) };
      } });
    runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"), model, providerRegistry: registry,
      primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
      homeDir: f.homeDir, profileId: f.profileId, workspaceRoot: f.destination, localSkillsRoot: join(f.homeDir, "skills"),
      sessionId: "copy-session", sessionMetadata: { originSurface: outcome === "remote" ? "telegram" : "cli" }, sessionDb: db,
      closeSessionDbOnDispose: false, securityMode: "open", workspaceTrusted: true, trustStore: changes.trust,
      executionControls: { providerBudgets: { maxProviderIterations: 8, maxProviderToolCalls: 6, maxProviderWallClockMs: 15000, finalizationReserveMs: 0 } } });
    if (outcome === "busy") expect((await runtime.executeTool!({ tool: "process.start", toolInput: { command: "sleep 30" } }))?.result?.ok).toBe(true);
    const response = await runtime.handle({ channel: ["remote", "attached"].includes(outcome) ? "telegram" : "cli", text: "Read counter.cjs, fix its increment to add two instead of one using file.patch, then run node verify.cjs to test it.",
      onApprovalRequest: async () => { approvalRequests++; return "denied"; } });
    expect(response.toolExecutions.filter((tool) => tool.result?.ok)).toHaveLength(3);
    expect(approvalRequests).toBe(0);
    expect((await db.getSession("copy-session"))!.executionTarget!.targetId).toBe(target.id);
    expect(await readFile(join(f.source, "counter.cjs"), "utf8")).toBe(outcome === "apply" ? "module.exports = n => n + 2;\n" : outcome === "conflict" ? "user edits\n" : "module.exports = n => n + 1;\n");
    if (!["remote", "attached", "busy"].includes(outcome)) {
      expect(response.text).toContain(outcome === "conflict" ? "Source files conflict" : outcome === "apply" ? "Changes applied" : "Changes saved for review");
      expect((await db.listEvents("copy-session")).some((event) => event.kind === "session-artifact-registered")).toBe(true);
    }
    if (outcome === "busy") expect(response.text).toContain("await settlement");
    if (outcome === "conflict" || outcome === "busy") expect(response.finalOutcome?.status).toBe("partially_completed");
  } finally { await runtime?.dispose(); db.close(); changes.close(); await f.cleanup(); }
}, 30000);

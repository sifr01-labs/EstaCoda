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
import type { ModelProfile, ProviderRequest, ProviderResponse } from "../contracts/provider.js";

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
      complete: async (request: ProviderRequest): Promise<ProviderResponse> => {
        const call = step === 4 ? (step++, ["file.read", { path: "counter.cjs" }] as const) : calls[step++];
        if (call) expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: call[0].replaceAll(".", "_") }) })]));
        if (step === 5) {
          for (const name of ["file_patch", "terminal_run"]) {
            expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name }) })]));
          }
        }
        return { ok: true, provider: model.provider, model: model.id, content: call ? "" : "Edit verified.", finishReason: call ? "tool_calls" : "stop",
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          ...(call ? { raw: { choices: [{ message: { tool_calls: [{ id: `call-${step}`, function: { name: call[0].replaceAll(".", "_"), arguments: JSON.stringify(call[1]) } }] } }] } } : {}) };
      } });
    runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"), model, providerRegistry: registry,
      primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
      homeDir: f.homeDir, profileId: f.profileId, workspaceRoot: f.destination, localSkillsRoot: join(f.homeDir, "skills"),
      sessionId: "copy-session", sessionMetadata: { originSurface: outcome === "remote" ? "telegram" : "cli" }, sessionDb: db,
      closeSessionDbOnDispose: false, securityMode: "open", workspaceTrusted: true, trustStore: changes.trust,
      executionControls: { providerBudgets: { maxProviderIterations: 8, maxProviderToolCalls: 6, maxProviderWallClockMs: 15000, finalizationReserveMs: 0 } } });
    if (outcome === "busy") expect((await runtime.executeTool!({ tool: "process.start", toolInput: { command: "sleep 30" } }))?.result?.ok).toBe(true);
    const response = await runtime.handle({ channel: ["remote", "attached"].includes(outcome) ? "telegram" : "cli", text: "Read counter.cjs with file.read. Change n + 1 to n + 2 using file.patch. Run exactly node verify.cjs using terminal.run. Do not modify verify.cjs or create other files. Report the test result.",
      onApprovalRequest: async () => { approvalRequests++; return "denied"; } });
    expect(response.toolExecutions.filter((tool) => tool.result?.ok)).toHaveLength(3);
    expect(approvalRequests).toBe(0);
    expect((await db.getSession("copy-session"))!.executionTarget!.targetId).toBe(target.id);
    expect(await readFile(join(f.source, "counter.cjs"), "utf8")).toBe(outcome === "apply" ? "module.exports = n => n + 2;\n" : outcome === "conflict" ? "user edits\n" : "module.exports = n => n + 1;\n");
    if (!["remote", "attached", "busy"].includes(outcome)) {
      expect(response.text).toContain(outcome === "conflict" ? "Source files conflict" : outcome === "apply" ? "Changes applied" : "Changes saved for review");
      expect((await db.listEvents("copy-session")).some((event) => event.kind === "session-artifact-registered")).toBe(true);
    }
    const events = await db.listEvents("copy-session");
    expect(events.filter((event) => event.kind === "execution-final-outcome-recorded").at(-1)).toMatchObject({ status: response.finalOutcome!.status });
    const trajectory = (await db.listTrajectoriesForSession("copy-session"))[0]!;
    expect(trajectory.outcome?.status).toBe(response.finalOutcome!.status);
    expect(trajectory.executionReferences?.definitionRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(trajectory.executionReferences?.authorityRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(trajectory.executionMetrics).toMatchObject({ providerDispatches: 4, usageReports: 4, reportedTokens: 440 });
    const message = (await db.listMessages("copy-session")).filter((entry) => entry.role === "agent").at(-1)!;
    expect(message.content).toBe(response.text);
    for (const artifact of response.artifacts) expect(JSON.stringify(message.metadata)).toContain(artifact.id);
    if (outcome === "busy") expect(response.text).toContain("await settlement");
    if (outcome === "conflict" || outcome === "busy") expect(response.finalOutcome?.status).toBe("partially_completed");
    if (outcome === "apply") {
      await writeFile(join(f.destination, "counter.cjs"), "later edit\n");
      const later = await runtime.handle({ channel: "cli", text: "Read counter.cjs and summarize its contents. Do not modify the code and add tests." });
      expect(later.finalOutcome?.completionFloor).toBe("read");
      expect(later.finalOutcome?.status).toBe("partially_completed");
      expect(later.text).toContain("No new changes were applied");
      expect(await readFile(join(f.source, "counter.cjs"), "utf8")).toBe("module.exports = n => n + 2;\n");
      expect((await db.listTrajectoriesForSession("copy-session"))[0]!.outcome?.status).toBe("partially_completed");
      expect((await db.listMessages("copy-session")).filter((entry) => entry.role === "agent").at(-1)!.content).toBe(later.text);
    }
  } finally { await runtime?.dispose(); db.close(); changes.close(); await f.cleanup(); }
}, 30000);

it.each([
  { progress: "none", status: "blocked", count: 0 },
  { progress: "read", status: "partially_completed", count: 1 },
  { progress: "edit-and-test", status: "completed", count: 3 }
])("persists the actual progress of comma-separated edit requests: $progress", async ({ progress, status, count }) => {
  const f = await copyFixture(), changes = new ChangeApplicationStore(f), db = new SQLiteSessionDB({ path: join(f.homeDir, "sessions.sqlite") });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    await writeFile(join(f.source, "counter.cjs"), "module.exports = 0;\n");
    await writeFile(join(f.source, "test.cjs"), "require('node:assert/strict').equal(require('./counter.cjs'), 1);\n");
    const model: ModelProfile = { provider: "copy-fixture", id: "comma-fixture", contextWindowTokens: 131072, supportsTools: true, supportsVision: false, supportsStructuredOutput: true };
    const registry = new ProviderRegistry(); let step = 0;
    const calls = [["file.read", { path: "counter.cjs" }],
      ["file.patch", { mode: "replace", path: "counter.cjs", old_string: "module.exports = 0;", new_string: "module.exports = 1;" }],
      ["terminal.run", { command: "node test.cjs", timeoutMs: 5000 }]] as const;
    registry.register({ id: model.provider, name: "Comma fixture", executable: true, health: () => ({ available: true }), listModels: () => [model],
      complete: async (request: ProviderRequest): Promise<ProviderResponse> => {
        expect(step).toBeLessThanOrEqual(count);
        for (const name of ["file_read", "file_patch", "terminal_run"]) {
          expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name }) })]));
        }
        const call = step < count ? calls[step] : undefined; step++;
        // A provider's claim cannot stand in for the omitted mutation receipt.
        return { ok: true, provider: model.provider, model: model.id, content: call ? "" : "The update passed node test.cjs.", finishReason: call ? "tool_calls" : "stop",
          ...(call ? { raw: { choices: [{ message: { tool_calls: [{ id: `comma-${step}`, function: { name: call[0].replaceAll(".", "_"), arguments: JSON.stringify(call[1]) } }] } }] } } : {}) };
      } });
    runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"), model, providerRegistry: registry,
      primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
      homeDir: f.homeDir, profileId: f.profileId, workspaceRoot: f.source, localSkillsRoot: join(f.homeDir, "skills"),
      sessionId: "comma-session", sessionMetadata: { originSurface: "cli" }, sessionDb: db,
      closeSessionDbOnDispose: false, securityMode: "open", workspaceTrusted: true, trustStore: changes.trust });
    const response = await runtime.handle({ channel: "cli", text: "Read counter.cjs, update its exported number from 0 to 1 using file.patch, then run node test.cjs to test it." });
    expect(response.finalOutcome).toMatchObject({ status, completionFloor: "mutation" });
    expect(response.toolExecutions.map((entry) => [entry.tool.name, entry.result?.ok])).toEqual(calls.slice(0, count).map(([name]) => [name, true]));
    expect(await readFile(join(f.source, "counter.cjs"), "utf8")).toBe(`module.exports = ${progress === "edit-and-test" ? 1 : 0};\n`);
    expect((await db.listTrajectoriesForSession("comma-session"))[0]!.outcome).toMatchObject({ status, completionFloor: "mutation" });
    expect((await db.listEvents("comma-session")).filter((event) => event.kind === "execution-final-outcome-recorded").at(-1)).toMatchObject({ status });
    expect((await db.listMessages("comma-session")).filter((message) => message.role === "agent").at(-1)!.content).toBe(response.text);
  } finally { await runtime?.dispose(); db.close(); changes.close(); await f.cleanup(); }
}, 30000);

it.each([
  { read: true, text: "Read counter.cjs and summarize its contents. Do not modify the code and add tests." },
  { read: false, text: "Read counter.cjs and summarize its contents. Do not modify the code and add tests." },
  { read: true, text: "Read counter.cjs and summarize its contents. Do not modify the code and add tests.", ending: "If you actually meant 'do add tests', just say the word and I'll add a test file (e.g., counter.test.cjs) without changing the module." },
  { read: true, text: "Read counter.cjs and summarize its contents. Do not modify the code and add tests.", ending: "I'll add a test file next.", open: true },
  { read: true, text: "Read counter.cjs and summarize its contents. Do not modify the code and add tests.", ending: "I will not modify the code or add tests." },
  { read: true, text: "اقرأ الملف counter.cjs. لا تعدّل الكود ثم أضف الاختبارات." }
])("persists an evidence-based read outcome for negated edits: $read / $text", async ({ read, text, ending, open }) => {
  const f = await copyFixture(), changes = new ChangeApplicationStore(f), db = new SQLiteSessionDB({ path: join(f.homeDir, "sessions.sqlite") });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    const content = "module.exports = n => n + 1;\n";
    await writeFile(join(f.source, "counter.cjs"), content);
    const model: ModelProfile = { provider: "copy-fixture", id: "read-fixture", contextWindowTokens: 131072, supportsTools: true, supportsVision: false, supportsStructuredOutput: true };
    const registry = new ProviderRegistry(); let step = 0;
    registry.register({ id: model.provider, name: "Read fixture", executable: true, health: () => ({ available: true }), listModels: () => [model],
      complete: async (request: ProviderRequest): Promise<ProviderResponse> => {
        const names = (request.tools ?? []).map((schema) => (schema as { function: { name: string } }).function.name);
        expect(names).toContain("file_read");
        expect(names).toContain("file_patch"); expect(names).toContain("terminal_run");
        const call = read && step++ === 0;
        return { ok: true, provider: model.provider, model: model.id, content: call ? "" : `The function increments its argument. ${ending ?? ""}`, finishReason: call ? "tool_calls" : "stop",
          ...(call ? { raw: { choices: [{ message: { tool_calls: [{ id: "read-counter", function: { name: "file_read", arguments: JSON.stringify({ path: "counter.cjs" }) } }] } }] } } : {}) };
      } });
    runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"), model, providerRegistry: registry,
      primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
      homeDir: f.homeDir, profileId: f.profileId, workspaceRoot: f.source, localSkillsRoot: join(f.homeDir, "skills"),
      sessionId: "read-session", sessionMetadata: { originSurface: "cli" }, sessionDb: db,
      closeSessionDbOnDispose: false, securityMode: "open", workspaceTrusted: true, trustStore: changes.trust });
    const response = await runtime.handle({ channel: "cli", text });
    const status = !read ? "blocked" : open ? "partially_completed" : "completed";
    expect(response.finalOutcome).toMatchObject({ status, completionFloor: "read" });
    expect(response.toolExecutions.filter((entry) => entry.result?.ok)).toHaveLength(read ? 1 : 0);
    expect(await readFile(join(f.source, "counter.cjs"), "utf8")).toBe(content);
    expect((await db.listTrajectoriesForSession("read-session"))[0]!.outcome).toMatchObject({ status, completionFloor: "read" });
    expect((await db.listEvents("read-session")).filter((event) => event.kind === "execution-final-outcome-recorded").at(-1)).toMatchObject({ status });
    expect((await db.listMessages("read-session")).filter((message) => message.role === "agent").at(-1)!.content).toBe(response.text);
  } finally { await runtime?.dispose(); db.close(); changes.close(); await f.cleanup(); }
}, 30000);

import { verifyHostExecution } from "../execution/host-authority.js";
import { localApprovalScope } from "../security/approval-scope.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateBenchmarkMetrics } from "../benchmark/metrics.js";
import { ChannelGateway, InMemoryChannelSessionStore } from "../channels/channel-gateway.js";
import type { ModelProfile, ProviderRequest, ProviderResponse } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SecurityPolicy } from "../contracts/security.js";
import { createRuntimeCronRunner } from "../cron/cron-runner.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { createRuntime, type Runtime } from "../runtime/create-runtime.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { resolveSessionForResume } from "../session/session-resume.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { createFakeChannelAdapter } from "./fakes/fake-channel-adapter.js";

export const hostBaselineScenarios = ["code-edit", "authorized-channel", "scheduled-work", "interrupted-resume"] as const;
export type HostBaselineScenario = typeof hostBaselineScenarios[number];
const prompt = "Read counter.cjs, fix its increment to add two instead of one using file.patch, then run node verify.cjs to test it.";
const model: ModelProfile = {
  provider: "host-baseline", id: "scripted-fixture", contextWindowTokens: 131_072,
  supportsTools: true, supportsVision: false, supportsStructuredOutput: true,
};

// Only the provider and outbound channel delivery are scripted. The runtime,
// policy, file/command tools, SQLite, gateway authorization and cron runner are real.
// All usage numbers are synthetic accounting fixtures, never model-cost evidence.
export async function runHostBaselineSample(scenario: HostBaselineScenario) {
  const setupStart = performance.now();
  const root = await mkdtemp(join(tmpdir(), "estacoda-host-baseline-"));
  const workspaceRoot = join(root, "workspace");
  const homeDir = join(root, "home");
  const events: RuntimeEvent[] = [];
  const runtimes = new Set<Runtime>();
  const runtimeStartupMs: number[] = [];
  const commandMs: number[] = [];
  let commandStarted: number | undefined;
  let db: SQLiteSessionDB | undefined;
  let providerInvocations = 0;
  let approvalRequests = 0;
  let deliveryCount = 0;
  let finalDelivered = false;
  let recoveryMs: number | null = null;
  let persistedMessagesBeforeResume = 0;
  let step = 0;
  let expectedTool: string | undefined;
  let resume = false;
  const cancellation = new AbortController();
  try {
    await mkdir(workspaceRoot);
    await mkdir(homeDir);
    await writeFile(join(workspaceRoot, "counter.cjs"), "module.exports = n => n + 1;\n");
    await writeFile(join(workspaceRoot, "verify.cjs"), "require('node:assert/strict').equal(require('./counter.cjs')(3), 5); console.log('fixture verified');\n");
    const dbPath = join(homeDir, "sessions.sqlite");
    db = new SQLiteSessionDB({ path: dbPath });
    const trustStore = new WorkspaceTrustStore({ path: join(homeDir, "trust.json") });
    await trustStore.grant(workspaceRoot);
    const registry = new ProviderRegistry();
    registry.register({
      id: model.provider, name: "Host baseline fixture", executable: true,
      health: () => ({ available: true }), listModels: () => [model],
      complete: async (request: ProviderRequest): Promise<ProviderResponse> => {
        providerInvocations += 1;
        assert(providerInvocations <= 12, "Unexpected auxiliary call or provider loop");
        if (expectedTool !== undefined) {
          assert(events.some((event) => event.kind === "tool-result" && event.tool === expectedTool && event.ok),
            "The next fixture step requires the previous real tool to succeed");
          assert(request.messages.some((message) => message.role !== "system" && JSON.stringify(message.content).includes(expectedTool!)),
            "The provider must receive tool evidence (native or flattened history)");
        }
        const calls = resume
          ? [["file.read", { path: "counter.cjs" }], ["terminal.run", { command: "node verify.cjs", timeoutMs: 5_000 }]] as const
          : [["file.read", { path: "counter.cjs" }], ["file.patch", { mode: "replace", path: "counter.cjs", old_string: "n + 1", new_string: "n + 2" }],
            ["terminal.run", { command: "node verify.cjs", timeoutMs: 5_000 }]] as const;
        const call = calls[step++];
        if (call) assert(request.tools?.some((schema) => (schema as { function?: { name?: string } }).function?.name === call[0].replaceAll(".", "_")), `Fixture requested unavailable tool: ${call[0]}`);
        const response: ProviderResponse = {
          ok: true, content: call ? "" : "Fixture edit verified.", model: model.id, provider: model.provider,
          finishReason: call ? "tool_calls" : "stop",
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        };
        if (call) {
          expectedTool = call[0];
          const toolCallId = `${resume ? "resume" : "initial"}-${step}`;
          response.raw = { choices: [{ message: { tool_calls: [{ id: toolCallId,
            function: { name: call[0].replaceAll(".", "_"), arguments: JSON.stringify(call[1]) } }] } }] };
        }
        return response;
      },
    });
    const makeRuntime = async (sessionId: string, securityPolicy?: SecurityPolicy) => {
      const started = performance.now();
      const runtime = await createRuntime({
        tokens: resolveTokens("standard", "dark", "kemetBlue"), model,
        primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
        providerRegistry: registry, workspaceRoot, homeDir, localSkillsRoot: join(root, "skills"),
        sessionId, profileId: "default", sessionDb: db!, closeSessionDbOnDispose: false,
        workspaceTrusted: true, trustStore, securityMode: "adaptive", securityPolicy,
        executionControls: { providerBudgets: { maxProviderIterations: 8, maxProviderToolCalls: 6,
          maxProviderWallClockMs: 15_000, finalizationReserveMs: 0 } },
      });
      runtimeStartupMs.push(performance.now() - started);
      runtimes.add(runtime);
      const handle = runtime.handle.bind(runtime);
      runtime.handle = (input) => handle({
        ...input,
        onApprovalRequest: async (request) => {
          approvalRequests += 1;
          // Never auto-approve a channel/scheduled action or an unexpected tool.
          if (input.onApprovalRequest) return input.onApprovalRequest(request);
          assert(scenario === "code-edit" || scenario === "interrupted-resume", "Unexpected unattended approval");
          assert(["file.read", "file.patch", "terminal.run"].includes(request.tool.name));
          if (request.tool.name === "terminal.run") assert.equal(request.input.command, "node verify.cjs");
          return "approved";
        },
        onEvent: async (event) => {
          events.push(event);
          if (event.kind === "tool-start" && event.tool === "terminal.run") commandStarted = performance.now();
          if (event.kind === "tool-result" && event.tool === "terminal.run" && commandStarted !== undefined) {
            commandMs.push(performance.now() - commandStarted);
            commandStarted = undefined;
          }
          await input.onEvent?.(event);
          if (scenario === "interrupted-resume" && !resume && event.kind === "tool-result" && event.tool === "file.patch" && event.ok) {
            cancellation.abort();
          }
        },
      });
      return runtime;
    };
    const setupMs = performance.now() - setupStart;
    const executionStart = performance.now();
    if (scenario === "authorized-channel") {
      const adapter = createFakeChannelAdapter({ kind: "telegram" });
      const sendText = adapter.delivery!.sendText.bind(adapter.delivery);
      adapter.delivery!.sendText = async (...args) => {
        deliveryCount += 1;
        finalDelivered ||= args[1].includes("Fixture edit verified.");
        await sendText(...args);
      };
      const gateway = new ChannelGateway({
        adapters: [adapter], homeDir, profileId: "default", securityMode: "adaptive",
        sessionStore: new InMemoryChannelSessionStore(),
        authPolicy: { telegram: { allowedUserIds: ["fixture-user"] } },
        trustedWorkspace: () => trustStore.isTrusted(workspaceRoot),
        approvalScopeForSession: async (sessionId) => localApprovalScope("default", sessionId, await verifyHostExecution(workspaceRoot)),
        runtimeForSession: ({ sessionId, securityPolicy }) => makeRuntime(sessionId, securityPolicy),
      });
      await gateway.receive({ id: "fixture-message", channel: "telegram",
        sessionKey: { platform: "telegram", chatId: "fixture-chat", userId: "fixture-user" },
        sender: { id: "fixture-user", displayName: "Fixture" }, text: prompt, receivedAt: new Date().toISOString() });
      assert(deliveryCount > 0 && finalDelivered, "Gateway must deliver the verified final response");
    } else if (scenario === "scheduled-work") {
      const runner = createRuntimeCronRunner({
        workspaceRoot, allowedWorkdirRoots: [workspaceRoot], isWorkspaceTrusted: (path) => trustStore.isTrusted(path),
        runtimeFactory: (_job, context) => makeRuntime(context.sessionId),
        deliver: async (_job, content) => {
          assert(content.includes("Fixture edit verified."));
          deliveryCount += 1;
          return { success: true, perTarget: new Map() };
        },
        disposeRuntime: false, // Common finally owns disposal for every scenario.
      });
      const result = await runner.runJob({ id: "fixture-cron", name: "Fixture", prompt, schedule: "* * * * *",
        scheduleKind: "cron", skills: [], delivery: "local", status: "active", runCount: 0,
        createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" });
      assert(result.ok && result.delivered, "Real scheduled runner must complete and deliver");
    } else {
      const runtime = await makeRuntime("fixture-session");
      const response = await runtime.handle({ text: prompt, channel: "cli", trustedWorkspace: true,
        signal: scenario === "interrupted-resume" ? cancellation.signal : undefined });
      if (scenario === "code-edit") assert(response.text.includes("Fixture edit verified."));
      if (scenario === "interrupted-resume") {
        assert(cancellation.signal.aborted, "Cancellation must follow the completed mutation");
        assert(!events.some((event) => event.kind === "tool-start" && event.tool === "terminal.run"), "No command should run after cancellation");
        const recoveryStart = performance.now();
        await runtime.dispose?.();
        runtimes.delete(runtime);
        db.close();
        db = new SQLiteSessionDB({ path: dbPath });
        assert.deepEqual(await resolveSessionForResume({ homeDir, sessionDb: db, sessionId: "fixture-session", profileId: "default", workspaceRoot }),
          { ok: true, sessionId: "fixture-session" });
        const persistedMessages = await db.listMessages("fixture-session");
        persistedMessagesBeforeResume = persistedMessages.length;
        assert(persistedMessages.some((message) => message.role === "user" && message.content === prompt));
        resume = true;
        step = 0;
        expectedTool = undefined;
        const resumed = await makeRuntime("fixture-session");
        const resumedResponse = await resumed.handle({ text: "Read counter.cjs and run node verify.cjs to verify the existing edit. Do not apply the patch again.", channel: "cli", trustedWorkspace: true });
        assert(resumedResponse.text.includes("Fixture edit verified."));
        recoveryMs = performance.now() - recoveryStart;
      }
    }
    const executionMs = performance.now() - executionStart;
    assert.equal(await readFile(join(workspaceRoot, "counter.cjs"), "utf8"), "module.exports = n => n + 2;\n");
    const results = events.filter((event) => event.kind === "tool-result");
    assert.equal(results.filter((event) => event.tool === "file.patch" && event.ok).length, 1);
    assert.equal(results.filter((event) => event.tool === "terminal.run" && event.ok).length, 1);
    assert(results.every((event) => event.ok === true), "All fixture tools must succeed");
    const metrics = aggregateBenchmarkMetrics(events);
    assert.equal(metrics.providerCalls, providerInvocations, "Runtime accounting must cover every provider invocation");
    return { scenario, success: true, setupMs, executionMs, runtimeStartupMs, commandMs, recoveryMs,
      providerInvocations, approvalRequests, deliveryCount, persistedMessagesBeforeResume, metrics };
  } finally {
    try { for (const runtime of runtimes) await runtime.dispose?.(); }
    finally { db?.close(); await rm(root, { recursive: true, force: true }); }
  }
}

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProfile, ProviderRequest, ProviderResponse } from "../src/contracts/provider.js";
import type { Runtime } from "../src/runtime/create-runtime.js";
import type { SecurityPolicy } from "../src/contracts/security.js";
import type { DockerClient } from "../src/execution/docker-client.js";

/** Both source and compiled gates load the actual production entry points.
 * Only provider responses and outbound delivery are fixtures. */
export async function validateDockerRuntimeWorkflows(input: {
  runtimeRoot: string; workspaceRoot: string; homeDir: string; profileId: string; imageId: string; client: DockerClient;
}) {
  const load = (path: string) => import(new URL(`${input.runtimeRoot}/${path}.js`, import.meta.url).href);
  const { createRuntime } = await load("runtime/create-runtime");
  const { ProviderRegistry } = await load("providers/provider-registry");
  const { SQLiteSessionDB } = await load("session/sqlite-session-db");
  const { WorkspaceTrustStore } = await load("security/workspace-trust-store");
  const { resolveProfileStateHome } = await load("config/profile-home");
  const { resolveTokens } = await load("theme/token-resolver");
  const { ChannelGateway, InMemoryChannelSessionStore } = await load("channels/channel-gateway");
  const { localApprovalScope } = await load("security/approval-scope");
  const { createRuntimeCronRunner } = await load("cron/cron-runner");
  const { executionAuthorityFingerprint } = await load("execution/execution-authority");
  const { workspaceRoot, homeDir, profileId } = input;
  const paths = resolveProfileStateHome({ homeDir, profileId });
  await mkdir(paths.profileRoot, { recursive: true });
  const configure = (imageId: string) => writeFile(paths.configPath, JSON.stringify({ execution: { backend: "docker", imageId } }));
  await configure(input.imageId);
  const trustStore = new WorkspaceTrustStore({ homeDir });
  await trustStore.grant(workspaceRoot);
  const db = new SQLiteSessionDB({ path: join(homeDir, "runtime-workflows.sqlite") });
  const runtimes = new Map<string, Runtime>();
  const containerIds: string[] = [];
  const model: ModelProfile = { provider: "docker-fixture", id: "scripted", contextWindowTokens: 131072,
    supportsTools: true, supportsVision: false, supportsStructuredOutput: true };
  let invocations = 0;
  const prompt = "Read counter.cjs, fix its increment to add two instead of one using file.patch, then run node test.cjs to test it.";
  const makeRuntime = async (sessionId: string, securityPolicy?: SecurityPolicy, originSurface = "cli") => {
    let step = 0;
    const registry = new ProviderRegistry();
    registry.register({ id: model.provider, name: "Docker fixture", executable: true, health: () => ({ available: true }), listModels: () => [model],
      complete: async (request: ProviderRequest): Promise<ProviderResponse> => {
        invocations++;
        const calls = [["file.read", { path: "counter.cjs" }], ["file.patch", { mode: "replace", path: "counter.cjs", old_string: "n + 1", new_string: "n + 2" }],
          ["terminal.run", { command: "node test.cjs", timeoutMs: 10000 }]] as const;
        assert(step <= calls.length, "Unexpected provider continuation");
        const call = calls[step++];
        if (call) assert(request.tools?.some((schema) => (schema as { function?: { name?: string } }).function?.name === call[0].replaceAll(".", "_")), `Fixture requested unavailable tool: ${call[0]}`);
        return { ok: true, provider: model.provider, model: model.id, content: call ? "" : "Docker fixture verified.",
          finishReason: call ? "tool_calls" : "stop", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          ...(call ? { raw: { choices: [{ message: { tool_calls: [{ id: `call-${step}`, function: { name: call[0].replaceAll(".", "_"), arguments: JSON.stringify(call[1]) } }] } }] } } : {}) };
      } });
    const runtime: Runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"), model, providerRegistry: registry,
      primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
      homeDir, profileId, workspaceRoot, localSkillsRoot: join(homeDir, "skills"), sessionId, sessionMetadata: { originSurface },
      sessionDb: db, closeSessionDbOnDispose: false, workspaceTrusted: true, trustStore, securityMode: "adaptive", securityPolicy,
      executionControls: { providerBudgets: { maxProviderIterations: 8, maxProviderToolCalls: 6, maxProviderWallClockMs: 60000, finalizationReserveMs: 0 } } });
    runtimes.set(sessionId, runtime);
    assert.equal(runtime.executionFacts!().backend, "docker", "Configured runtime must acquire Docker, never host");
    assert.equal(runtime.executionFacts!().networkContainment, true);
    const receipts = await readdir(join(paths.profileRoot, "execution", "docker"));
    const owned = await Promise.all(receipts.filter((name: string) => name.endsWith(".json")).map(async (name: string) => JSON.parse(await readFile(join(paths.profileRoot, "execution", "docker", name), "utf8"))));
    assert(owned.some((receipt) => receipt.id === runtime.executionFacts!().environmentInstanceId), "Runtime authority must match its durable container receipt");
    // The bounded file service owns a separate sidecar under the same lease.
    for (const receipt of owned) {
      assert.equal(receipt.profileId, profileId);
      assert.equal(receipt.workspaceHash, runtime.executionFacts!().workspace.identityHash);
      containerIds.push(receipt.id);
    }
    return runtime;
  };
  const verifyAndDispose = async () => {
    for (const [sessionId, runtime] of runtimes) {
      const trajectory = (await db.listTrajectoriesForSession(sessionId))[0];
      assert.equal(trajectory.outcome.status, "completed", JSON.stringify({ outcome: trajectory.outcome, failures: trajectory.events.filter((event: any) => event.kind === "tool-gated" || event.kind === "tool-result" && !event.data.result?.ok) }));
      assert.equal(trajectory.executionMetrics.providerDispatches, 4);
      assert.equal(trajectory.executionMetrics.reportedTokens, 440);
      assert.equal(trajectory.executionReferences.authorityRevision, executionAuthorityFingerprint(runtime.executionFacts!()));
      assert.equal(trajectory.events.filter((event: any) => event.kind === "tool-result" && event.data.result?.ok).length, 3);
      assert.equal(await readFile(join(workspaceRoot, "counter.cjs"), "utf8"), "module.exports = n => n + 2;\n");
      await runtime.dispose();
      runtimes.delete(sessionId);
    }
    assert.equal((await readdir(join(paths.profileRoot, "execution", "docker"))).filter((name: string) => name.endsWith(".json")).length, 0);
    const liveIds = (await input.client.run(["ps", "-aq", "--no-trunc"])).split(/\s+/u);
    for (const id of containerIds) assert(!liveIds.includes(id), "Disposed runtime container must be removed");
  };
  try {
    // A host fallback fails these in-command assertions even if the edit succeeds.
    await writeFile(join(workspaceRoot, "test.cjs"), `const a=require('node:assert/strict'); a.equal(process.platform,'linux'); a.notEqual(process.getuid(),0); a.equal(require('./counter.cjs')(3),5); a.equal(require('node:fs').existsSync(${JSON.stringify(homeDir)}),false); console.log('verified');\n`);
    for (const scenario of ["cli", "channel", "recurring"] as const) {
      await writeFile(join(workspaceRoot, "counter.cjs"), "module.exports = n => n + 1;\n");
      if (scenario === "cli") {
        const runtime = await makeRuntime("docker-cli");
        const result = await runtime.handle({ text: prompt, channel: "cli" });
        assert(result.text.includes("Docker fixture verified."));
      } else if (scenario === "channel") {
        const delivered: string[] = [];
        const gateway = new ChannelGateway({ adapters: [{ kind: "telegram", delivery: { sendText: async (_key: unknown, text: string) => { delivered.push(text); } } }],
          homeDir, profileId, securityMode: "adaptive", sessionStore: new InMemoryChannelSessionStore(),
          authPolicy: { telegram: { allowedUserIds: ["fixture-user"] } }, trustedWorkspace: () => trustStore.isTrusted(workspaceRoot),
          approvalScopeForSession: async (sessionId: string) => localApprovalScope(profileId, sessionId, runtimes.get(sessionId)!.executionFacts!()),
          runtimeForSession: ({ sessionId, securityPolicy }: { sessionId: string; securityPolicy: SecurityPolicy }) => makeRuntime(sessionId, securityPolicy, "telegram") });
        const receive = (user: string) => gateway.receive({ id: `message-${user}`, channel: "telegram", sessionKey: { platform: "telegram", chatId: "fixture-chat", userId: user },
          sender: { id: user, displayName: "Fixture" }, text: prompt, receivedAt: new Date().toISOString() });
        const before = invocations;
        await receive("unauthorized");
        assert.equal(invocations, before); assert.equal(runtimes.size, 0, "Unauthorized channel cannot acquire a runtime");
        await receive("fixture-user");
        assert(delivered.some((text) => text.includes("Docker fixture verified.")));
      } else {
        let delivered = 0;
        const runner = createRuntimeCronRunner({ workspaceRoot, allowedWorkdirRoots: [workspaceRoot], isWorkspaceTrusted: (path: string) => trustStore.isTrusted(path),
          runtimeFactory: (_job: unknown, context: { sessionId: string }) => makeRuntime(context.sessionId, undefined, "cron"), disposeRuntime: false,
          deliver: async (_job: unknown, content: string) => { assert(content.includes("Docker fixture verified.")); delivered++; return { success: true, perTarget: new Map() }; } });
        const job = { id: "docker-recurring", name: "Docker recurring fixture", prompt, schedule: "* * * * *", scheduleKind: "cron", skills: [], delivery: "local", status: "active", runCount: 0,
          createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };
        for (let firing = 0; firing < 2; firing++) {
          await writeFile(join(workspaceRoot, "counter.cjs"), "module.exports = n => n + 1;\n");
          const result = await runner.runJob(job);
          assert(result.ok && result.delivered, result.output);
          await verifyAndDispose();
        }
        assert.equal(delivered, 2);
      }
      await verifyAndDispose();
      console.log(`PASS: configured Docker ${scenario} runtime, real edit/command, durable authority/metrics and disposal`);
    }
    await configure(`sha256:${"0".repeat(64)}`);
    const before = invocations;
    await assert.rejects(makeRuntime("missing-image"));
    assert.equal(invocations, before, "Missing configured image must block before provider dispatch");
    assert.equal(runtimes.size, 0);
    console.log("PASS: configured missing-image acquisition fails closed without host fallback");
  } finally {
    try { for (const runtime of runtimes.values()) await runtime.dispose(); }
    finally { db.close(); await configure(input.imageId); }
  }
}

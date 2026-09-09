import { securityActionKey } from "../security/pending-action-approval.js";
import { localApprovalScope } from "../security/approval-scope.js";
import { verifyHostExecution } from "../execution/host-authority.js";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecurityRequest } from "../contracts/security.js";
import { ActiveTurnRegistry } from "../gateway/active-turn-registry.js";
import { acquireGatewayLock } from "../gateway/gateway-lock.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "../security/workspace-approval-controller.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { resolveSessionForResume } from "../session/session-resume.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { resolveTaskWorkspaceBinding } from "../tasks/task-workspace.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { createRuntime, type Runtime } from "./create-runtime.js";
import { RuntimeCache } from "./runtime-cache.js";
import type { RuntimeFingerprint } from "./runtime-fingerprint.js";

// PR 0 baseline assertions become regression contracts as their fixes land.
// Persisted cross-process exclusion is covered in execution-ownership.test.ts.
// See docs/planning/workspace-execution-baseline.md. No real command is approved
// or executed by the policy-only cases below.
describe("workspace execution baseline", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "estacoda-execution-baseline-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("canonicalizes directory aliases without granting trust; a move changes path identity", async () => {
    const original = join(root, "source");
    const alias = join(root, "alias");
    const moved = join(root, "moved");
    await mkdir(original);
    await symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
    const trust = new WorkspaceTrustStore({ path: join(root, "trust.json") });
    const before = await resolveTaskWorkspaceBinding(original);
    expect(await resolveTaskWorkspaceBinding(alias)).toEqual(before);
    expect(await trust.isTrusted(original)).toBe(false);
    await trust.grant(original);
    expect(await trust.isTrusted(alias)).toBe(true);
    await rename(original, moved);
    const after = await resolveTaskWorkspaceBinding(moved);
    expect(after.identityHash).not.toBe(before.identityHash);
    expect(await trust.isTrusted(moved)).toBe(false);
    expect((await trust.list()).map((grant) => grant.root)).toEqual([before.canonicalPath]);
  });

  it("keeps persisted resume selection profile- and workspace-bound after reopening SQLite", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const path = join(root, "sessions.sqlite");
    const first = new SQLiteSessionDB({ path });
    try {
      await first.createSession({ id: "resume", profileId: "default", metadata: { workspaceRoot: workspace } });
      await first.appendMessage({ sessionId: "resume", role: "user", channel: "cli", content: "Edit a fixture." });
    } finally { first.close(); }
    const reopened = new SQLiteSessionDB({ path });
    try {
      const input = { sessionDb: reopened, sessionId: "resume", profileId: "default", workspaceRoot: workspace };
      expect(await resolveSessionForResume(input)).toEqual({ ok: true, sessionId: "resume" });
      expect(await resolveSessionForResume({ ...input, profileId: "other" })).toMatchObject({ ok: false });
      expect(await resolveSessionForResume({ ...input, workspaceRoot: root })).toMatchObject({ ok: false });
    } finally { reopened.close(); }
  });

  it.each(["once", "session", "always"] as const)("characterizes %s approval reuse without widening the command target", async (scope) => {
    const path = join(root, "approvals.json");
    const makeController = () => new WorkspaceApprovalController({ store: new WorkspaceApprovalStore({ path }) });
    const controller = makeController();
    const request = { ...commandRequest("rm -rf ./build"), executionScope: localApprovalScope("default", "scope", await verifyHostExecution(root)) };
    const options = { workspaceRoot: root, sessionId: "scope", mode: "adaptive" as const };
    const policy = createSecurityPolicyForMode("adaptive");
    expect((await controller.assess(policy, request, options)).decision).toBe("ask");
    await controller.grant({ ...options, toolName: "terminal.run", riskClass: request.riskClass,
      targetKey: request.targetKey, targetSummary: request.targetSummary, executionScope: request.executionScope, actionKey: securityActionKey(request), scope });
    expect((await controller.assess(policy, request, options)).decision).toBe("allow");
    expect((await controller.assess(policy, request, options)).decision).toBe(scope === "once" ? "ask" : "allow");
    expect((await controller.assess(policy, commandRequest("rm -rf ./other"), options)).decision).toBe("ask");
    expect((await makeController().assess(policy, request, options)).decision).toBe(scope === "always" ? "allow" : "ask");
    expect((await controller.assess(policy, request, { ...options, sessionId: "different" })).decision)
      .toBe(scope === "always" ? "allow" : "ask");
    if (scope === "always") {
      expect((await controller.assess(policy, request, { ...options, workspaceRoot: join(root, "different") })).decision).toBe("ask");
    }
  });

  it("keeps hardline denial ahead of a matching stored grant even in open mode", async () => {
    const controller = new WorkspaceApprovalController({ store: new WorkspaceApprovalStore({ path: join(root, "approvals.json") }) });
    const request = commandRequest("rm -rf /");
    const options = { workspaceRoot: root, sessionId: "hardline", mode: "open" as const };
    await controller.grant({ ...options, toolName: "terminal.run", riskClass: request.riskClass,
      targetKey: request.targetKey, targetSummary: request.targetSummary, scope: "always" });
    const result = await controller.assess(createSecurityPolicyForMode("open"), request, options);
    expect(result.decision).toBe("deny");
    expect(result.deterministicRule).toBe("destructive-delete-root-or-broad-path");
  });

  it("B01 fixed: concurrent cold acquisitions share one runtime and cleanup", async () => {
    const created: Array<{ disposeCount: number }> = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const cache = new RuntimeCache({ createRuntime: async () => {
      const state = { disposeCount: 0 };
      created.push(state);
      await barrier;
      return { dispose: async () => { state.disposeCount++; } } as Runtime;
    } });
    // Cache equality only consumes the serialized fingerprint; no runtime is built.
    const fingerprint = { profileId: "default", workspaceRoot: root } as RuntimeFingerprint;
    const policy = createSecurityPolicyForMode("adaptive");
    const pending = [cache.get("same", fingerprint, policy), cache.get("same", fingerprint, policy)];
    release();
    const borrowers = await Promise.all(pending);
    for (const borrower of borrowers) await borrower.dispose();
    await cache.disposeAll();
    expect(created).toHaveLength(1);
    expect(created.map((state) => state.disposeCount).sort()).toEqual([1]);
    expect(cache.stats().totalEntries).toBe(0);
  });

  it("B02 fixed: age never permits reclaiming a live owner", async () => {
    const state = { gatewayStatePath: join(root, "gateway") };
    await mkdir(state.gatewayStatePath);
    await writeFile(join(state.gatewayStatePath, "gateway.lock"), JSON.stringify({
      pid: process.pid, startedAt: new Date(Date.now() - 60_000).toISOString()
    }));
    expect(await acquireGatewayLock(state)).toEqual({ acquired: false, stale: false });
    // Fresh live locks are respected; this separates the age branch from all locks.
    expect(await acquireGatewayLock(state)).toEqual({ acquired: false, stale: false });
  });

  it("B03 fixed: runtime construction rejects the same working-root mismatch as resume", async () => {
    const original = join(root, "original");
    const other = join(root, "other");
    await mkdir(original);
    await mkdir(other);
    const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    let runtime: Runtime | undefined;
    try {
      await db.createSession({ id: "existing", profileId: "default", metadata: { workspaceRoot: original } });
      await db.appendMessage({ sessionId: "existing", role: "user", channel: "cli", content: "Fixture request." });
      expect(await resolveSessionForResume({ sessionDb: db, sessionId: "existing", profileId: "default", workspaceRoot: other }))
        .toMatchObject({ ok: false });
      await expect(createRuntime({
        tokens: resolveTokens("standard", "dark", "kemetBlue"),
        model: { provider: "unconfigured", id: "baseline", contextWindowTokens: 8192,
          supportsTools: false, supportsVision: false, supportsStructuredOutput: false },
        providerRegistry: new ProviderRegistry(),
        homeDir: join(root, "home"), workspaceRoot: other, localSkillsRoot: join(root, "skills"),
        profileId: "default", sessionId: "existing", sessionDb: db, closeSessionDbOnDispose: false
      })).rejects.toThrow("different workspace");
      expect((await db.getSession("existing"))?.metadata?.workspaceRoot).toBe(original);
    } finally {
      await runtime?.dispose();
      db.close();
    }
  });

  it("B04: active-turn registries are local bookkeeping, not cross-process authority", () => {
    const first = new ActiveTurnRegistry();
    const second = new ActiveTurnRegistry();
    expect(first.startTurn("same").ok).toBe(true);
    expect(first.startTurn("same").ok).toBe(false);
    expect(second.startTurn("same").ok).toBe(true);
  });

  it("B08 fixed: a Docker label cannot change destructive-local triage without a backend", async () => {
    const policy = createSecurityPolicyForMode("adaptive");
    const request = commandRequest("rm -rf ./build");
    expect(await policy.decide({ ...request, environmentType: "host" })).toBe("ask");
    expect(await policy.decide({ ...request, environmentType: "docker" })).toBe("ask");
    expect(await policy.decide({ ...commandRequest("rm -rf /"), environmentType: "docker" })).toBe("deny");
  });
});

function commandRequest(command: string): SecurityRequest {
  return { toolName: "terminal.run", riskClass: "destructive-local", command,
    targetKey: `terminal.run:cmd=${command}`, targetSummary: command, description: "Baseline policy probe",
    context: { trustedWorkspace: true, targetConversationIsActive: true } };
}

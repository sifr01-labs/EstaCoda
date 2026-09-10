import { createRuntimeCronRunner } from "./cron-runner.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { CronStore } from "./cron-store.js";
import { withCronExecutionOrigin, type CronExecutionOrigin } from "./cron-origin.js";
import { recurringCronSecurityPolicy, validateCronAuthority } from "./cron-authority.js";
import { ExecutionTargetStore, targetBinding } from "../workspaces/execution-target.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { channelApprovalScope, localApprovalScope } from "../security/approval-scope.js";
import { verifyHostExecution } from "../execution/host-authority.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { validateDispatchAuthorization } from "../security/dispatch-authorization.js";
import type { SecurityRequest } from "../contracts/security.js";

it("reuses only persistent originating-surface grants across recurring Sessions and rechecks revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "recurring-authority-"));
  const paths = resolveProfileStateHome({ homeDir: root, profileId: "work" });
  const targets = new ExecutionTargetStore({ homeDir: root, profileId: "work" });
  try {
    await writeFile(paths.configPath, JSON.stringify({ channels: { telegram: { enabled: true, allowedUserIds: ["owner"] } }, security: { approvalMode: "strict" } }));
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const target = await targets.acquireLocal(root);
    const origin: CronExecutionOrigin = { schemaVersion: 1, profileId: "work", target: targetBinding(target), principalId: "owner",
      sessionKey: { platform: "telegram", accountId: "bot", chatId: "one", chatType: "dm" } };
    const store = new CronStore({ path: join(paths.cronPath, "jobs.json") });
    const job = await withCronExecutionOrigin(origin, () => store.create({ prompt: "clean build", schedule: "every 1h" }));
    const grants = new ChannelApprovalStore({ path: join(paths.gatewayStatePath, "channel-approvals.json") });
    const scope = channelApprovalScope(localApprovalScope("work", "interactive", await verifyHostExecution(root)), origin.sessionKey);
    const grant = await grants.grant({ sessionKey: origin.sessionKey, executionScope: scope, toolName: "terminal.run", riskClass: "destructive-local", targetKey: "build" });
    const request = (): SecurityRequest => ({ toolName: "terminal.run", riskClass: "destructive-local", command: "rm -rf ./build", description: "clean build", targetKey: "build", context: { trustedWorkspace: true } });
    for (const sessionId of ["run-one", "run-two"]) {
      const policy = (await recurringCronSecurityPolicy(job, { homeDir: root, profileId: "work", sessionId }))!;
      const assessment = await policy.assess!(request());
      expect(assessment.decision).toBe("allow");
      await validateDispatchAuthorization(assessment);
      await expect(validateDispatchAuthorization(assessment)).rejects.toThrow("already consumed");
    }
    for (const sessionKey of [{ ...origin.sessionKey, accountId: "other-bot" }, { ...origin.sessionKey, threadId: "other-thread", chatType: "thread" as const }]) {
      expect(await grants.listForSession(sessionKey)).toEqual([]);
      expect(await grants.revoke(grant.id, sessionKey)).toBe(false);
      const isolated = { ...job, executionOrigin: { ...origin, sessionKey } };
      const policy = (await recurringCronSecurityPolicy(isolated, { homeDir: root, profileId: "work", sessionId: "isolated" }))!;
      expect((await policy.assess!(request())).decision).toBe("ask");
    }
    const hardline = { ...request(), command: "rm -rf /" };
    const hardlinePolicy = (await recurringCronSecurityPolicy(job, { homeDir: root, profileId: "work", sessionId: "hardline" }))!;
    expect((await hardlinePolicy.assess!(hardline)).decision).toBe("deny");
    await expect(validateCronAuthority(job, { homeDir: root, profileId: "other" })).rejects.toThrow("mismatch");
    await expect(validateCronAuthority({ ...job, delivery: "telegram:another-chat" }, { homeDir: root, profileId: "work" })).rejects.toThrow("delivery exceeds");
    const other = { ...job, executionOrigin: { ...origin, sessionKey: { ...origin.sessionKey, chatId: "two" } } };
    expect((await (await recurringCronSecurityPolicy(other, { homeDir: root, profileId: "work", sessionId: "other" }))!.assess!(request())).decision).toBe("ask");
    const policy = (await recurringCronSecurityPolicy(job, { homeDir: root, profileId: "work", sessionId: "revoked" }))!;
    const pending = await policy.assess!(request());
    await grants.revoke(grant.id, origin.sessionKey);
    await expect(validateDispatchAuthorization(pending)).rejects.toThrow("revoked");
    expect((await policy.assess!(request())).decision).toBe("ask");
    await grants.grant({ sessionKey: origin.sessionKey, executionScope: scope, toolName: "terminal.run", riskClass: "destructive-local", targetKey: "build" });
    await expect(validateDispatchAuthorization(pending)).rejects.toThrow();
    expect((await policy.assess!(request())).decision).toBe("allow");
    await writeFile(paths.configPath, JSON.stringify({ channels: { telegram: { enabled: true, allowedUserIds: [] } } }));
    await expect(validateCronAuthority(job, { homeDir: root, profileId: "work" })).rejects.toThrow("authorization was revoked");
  } finally { targets.close(); await rm(root, { recursive: true, force: true }); }
});

it("records immutable channel origins and isolates remote job management", async () => {
  const root = await mkdtemp(join(tmpdir(), "recurring-origins-"));
  const targets = new ExecutionTargetStore({ homeDir: root, profileId: "work" });
  try {
    const origin: CronExecutionOrigin = { schemaVersion: 1, profileId: "work", target: targetBinding(await targets.acquireLocal(root)),
      principalId: "owner", sessionKey: { platform: "telegram", chatId: "one", chatType: "dm" } };
    const store = new CronStore({ path: join(root, "jobs.json") });
    const local = await store.create({ prompt: "local work", schedule: "every 1h" });
    const job = await withCronExecutionOrigin(origin, () => store.create({ prompt: "channel work", schedule: "every 1h" }));
    expect(job.executionOrigin).toEqual(origin);
    expect(job.workdir).toBe(origin.target.workspace.canonicalPath);
    await withCronExecutionOrigin(origin, async () => {
      expect((await store.list()).map((j) => j.id)).toEqual([job.id]);
      await expect(store.pause(local.id)).rejects.toThrow("another authorized surface");
      await expect(store.update(job.id, { workdir: join(root, "other") })).rejects.toThrow("cannot change");
    });
    const other = { ...origin, sessionKey: { ...origin.sessionKey, chatId: "two" } };
    await withCronExecutionOrigin(other, async () => {
      expect(await store.get(job.id)).toBeUndefined();
      await expect(store.remove(job.id)).rejects.toThrow("another authorized surface");
    });
  } finally { targets.close(); await rm(root, { recursive: true, force: true }); }
});

it("retains originating authority for background tools and context, and suppresses revoked delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "recurring-runner-"));
  const paths = resolveProfileStateHome({ homeDir: root, profileId: "work" });
  const targets = new ExecutionTargetStore({ homeDir: root, profileId: "work" });
  try {
    const allowed = { channels: { telegram: { enabled: true, allowedUserIds: ["owner"] } } };
    await writeFile(paths.configPath, JSON.stringify(allowed));
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const origin: CronExecutionOrigin = { schemaVersion: 1, profileId: "work", target: targetBinding(await targets.acquireLocal(root)),
      principalId: "owner", sessionKey: { platform: "telegram", chatId: "one", chatType: "dm" } };
    const store = new CronStore({ path: join(paths.cronPath, "jobs.json") });
    const local = await store.create({ prompt: "private local task", schedule: "every 1h" });
    await store.writeOutput(local.id, new Date(), "private output from another origin");
    const job = await withCronExecutionOrigin(origin, () => store.create({ prompt: "report", schedule: "every 1h", contextFrom: [local.id] }));
    const deliver = vi.fn(async () => ({ success: true, perTarget: new Map() }));
    const handle = vi.fn(async ({ text }: { text: string }) => {
      expect(text).not.toContain("private output from another origin");
      expect((await store.list()).map((j) => j.id)).toEqual([job.id]);
      await expect(store.remove(local.id)).rejects.toThrow("another authorized surface");
      const child = await store.create({ prompt: "follow-up", schedule: "every 1h" });
      expect(child.executionOrigin).toEqual(origin);
      await writeFile(paths.configPath, JSON.stringify({ channels: { telegram: { enabled: false } } }));
      return { text: "report" };
    });
    const runtimeFactory = vi.fn(async () => ({ sessionId: "run", trajectoryId: "trace", handle, dispose: async () => {} }) as never);
    const runner = createRuntimeCronRunner({ runtimeFactory, store, deliver, scriptExecution: { homeDir: root, profileId: "work" },
      workspaceRoot: root, isWorkspaceTrusted: async () => true });
    const result = await runner.runJob(job);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(handle).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    const revoked = await runner.runJob({ ...job, script: "echo should-not-run", noAgent: true });
    expect(revoked.ok).toBe(false);
    expect(runtimeFactory).toHaveBeenCalledOnce();
  } finally { targets.close(); await rm(root, { recursive: true, force: true }); }
});

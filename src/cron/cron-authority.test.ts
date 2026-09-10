import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
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
    }
    const other = { ...job, executionOrigin: { ...origin, sessionKey: { ...origin.sessionKey, chatId: "two" } } };
    expect((await (await recurringCronSecurityPolicy(other, { homeDir: root, profileId: "work", sessionId: "other" }))!.assess!(request())).decision).toBe("ask");
    const policy = (await recurringCronSecurityPolicy(job, { homeDir: root, profileId: "work", sessionId: "revoked" }))!;
    const pending = await policy.assess!(request());
    await grants.revoke(grant.id, origin.sessionKey);
    await expect(validateDispatchAuthorization(pending)).rejects.toThrow("revoked");
    expect((await policy.assess!(request())).decision).toBe("ask");
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

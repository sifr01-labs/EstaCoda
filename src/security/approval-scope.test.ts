import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { localApprovalScope, channelApprovalScope, sameReusableAuthority, samePendingAuthority } from "./approval-scope.js";
import { verifyHostExecution } from "../execution/host-authority.js";
import { WorkspaceApprovalStore, WorkspaceApprovalController } from "./workspace-approval-controller.js";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";

it("separates reusable scope from exact process/session ownership and rejects unknown scopes", async () => {
  const first = localApprovalScope("work", "one", await verifyHostExecution(process.cwd()));
  expect(sameReusableAuthority(first, { ...first, sessionId: "two", environmentInstanceId: "another" })).toBe(true);
  expect(samePendingAuthority(first, { ...first, sessionId: "two" })).toBe(false);
  for (const changed of [{ profileId: "other" }, { workspaceIdentityHash: "0".repeat(64) }, { authorityFingerprint: "0".repeat(64) }, { schemaVersion: 99 }]) {
    expect(sameReusableAuthority(first, { ...first, ...changed })).toBe(false);
  }
  const channel = channelApprovalScope(first, { platform: "telegram", accountId: "one", chatId: "chat", threadId: "a" });
  const other = channelApprovalScope(first, { platform: "telegram", accountId: "two", chatId: "chat", threadId: "a" });
  expect(sameReusableAuthority(channel, other)).toBe(false);
  expect(sameReusableAuthority(undefined, undefined)).toBe(false);
});

it("retains legacy grants for inspection without authorizing them and preserves equivalent scoped grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "scoped-grants-"));
  try {
    const path = join(root, "approvals.json");
    const legacy = { id: "old", workspaceRoot: root, toolName: "terminal.run", riskClass: "destructive-local" as const, targetKey: "rm-build", grantedAt: new Date().toISOString() };
    await writeFile(path, JSON.stringify({ version: 1, grants: [legacy] }));
    const store = new WorkspaceApprovalStore({ path });
    const controller = new WorkspaceApprovalController({ store });
    const executionScope = localApprovalScope("work", "session", await verifyHostExecution(root));
    const request = { ...legacy, executionScope, command: "rm -rf ./build", description: "fixture", context: { trustedWorkspace: true } };
    const options = { workspaceRoot: root, sessionId: "session", mode: "adaptive" as const };
    expect((await controller.assess(createSecurityPolicyForMode("adaptive"), request, options)).decision).toBe("ask");
    expect(await store.listForWorkspace(root)).toHaveLength(1);
    const first = await store.grant({ ...legacy, executionScope });
    expect((await controller.assess(createSecurityPolicyForMode("adaptive"), request, options)).decision).toBe("allow");
    expect((await controller.assess({ decide: () => "deny" }, request, options)).decision).toBe("deny");
    expect((await controller.assess(createSecurityPolicyForMode("adaptive"), { ...request, context: { trustedWorkspace: false } }, options)).decision).not.toBe("allow");
    const second = await store.grant({ ...legacy, executionScope: { ...executionScope, sessionId: "another" }, targetSummary: "new label" });
    expect(second.id).toBe(first.id);
    expect(second.authorizationGeneration).toBe(first.authorizationGeneration);
    await store.revoke(first.id, root);
    const replacement = await store.grant({ ...legacy, executionScope });
    expect(replacement.authorizationGeneration).toBeGreaterThan(first.authorizationGeneration!);
  } finally { await rm(root, { recursive: true, force: true }); }
});

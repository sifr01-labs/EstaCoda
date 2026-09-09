import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyHostExecution } from "../execution/host-authority.js";
import { localApprovalScope, sameReusableAuthority } from "./approval-scope.js";
import { assertPendingAction, createPendingAction, exactActionKey } from "./pending-action-approval.js";

describe("pending action ownership", () => {
  it("binds the action, process, session, authority generation, and expiry separately from reusable scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "pending-action-"));
    try {
      const executionScope = localApprovalScope("profile-a", "session-a", await verifyHostExecution(root));
      const actionKey = exactActionKey(["file.write", { path: "a.txt", content: "reviewed" }]);
      const pending = createPendingAction({ executionScope, actionKey, description: "write", riskClass: "workspace-write", context: { trustedWorkspace: true } }, 7, 1000)!;
      expect(() => assertPendingAction(pending, executionScope, 7, actionKey, 1001)).not.toThrow();
      for (const changed of [
        { sessionId: "session-b" }, { environmentInstanceId: "new-process" }, { profileId: "profile-b" },
        { workspaceIdentityHash: "f".repeat(64) }, { authorityFingerprint: "e".repeat(64) },
        { surfaceKey: "channel:" + "d".repeat(64) }
      ]) expect(() => assertPendingAction(pending, { ...executionScope, ...changed }, 7, actionKey, 1001)).toThrow(/renew/);
      expect(sameReusableAuthority(executionScope, { ...executionScope, sessionId: "session-b", environmentInstanceId: "new-process" })).toBe(true);
      expect(() => assertPendingAction(pending, executionScope, 8, actionKey, 1001)).toThrow(/renew/);
      expect(() => assertPendingAction(pending, executionScope, 7, exactActionKey(["file.write", { path: "a.txt", content: "changed" }]), 1001)).toThrow(/renew/);
      expect(() => assertPendingAction(pending, executionScope, 7, actionKey, pending.expiresAt)).toThrow(/renew/);
      expect(() => assertPendingAction(undefined, executionScope, 7)).toThrow(/renew/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("canonicalizes object order without discarding arguments or array order", () => {
    expect(exactActionKey({ a: 1, b: [2, 3] })).toBe(exactActionKey({ b: [2, 3], a: 1 }));
    expect(exactActionKey({ a: 1, b: [3, 2] })).not.toBe(exactActionKey({ a: 1, b: [2, 3] }));
  });
});

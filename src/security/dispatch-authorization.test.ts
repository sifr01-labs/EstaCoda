import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { localApprovalScope } from "./approval-scope.js";
import { verifyHostExecution } from "../execution/host-authority.js";
import { WorkspaceApprovalStore, WorkspaceApprovalController } from "./workspace-approval-controller.js";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";
import { validateDispatchAuthorization } from "./dispatch-authorization.js";

it("fences an assessed grant across revoke and identical regrant, while fresh work can proceed", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-fence-"));
  try {
    const store = new WorkspaceApprovalStore({ path: join(root, "approvals.json"), idFactory: () => "same-id" });
    const otherProcessView = new WorkspaceApprovalStore({ path: store.path, idFactory: () => "same-id" });
    const controller = new WorkspaceApprovalController({ store });
    const executionScope = localApprovalScope("work", "session", await verifyHostExecution(root));
    const input = { workspaceRoot: root, toolName: "terminal.run", riskClass: "destructive-local" as const, targetKey: "build", executionScope };
    const request = { ...input, command: "rm -rf ./build", description: "fixture", context: { trustedWorkspace: true } };
    const options = { workspaceRoot: root, sessionId: "session", mode: "adaptive" as const };
    const first = await store.grant(input);
    const beforeRevoke = await controller.assess(createSecurityPolicyForMode("adaptive"), request, options);
    expect(beforeRevoke.decision).toBe("allow");
    expect(() => structuredClone(beforeRevoke)).not.toThrow();
    await otherProcessView.revoke(first.id, root);
    const recreated = await otherProcessView.grant(input);
    expect(recreated.id).toBe(first.id);
    expect(recreated.authorizationGeneration).toBeGreaterThan(first.authorizationGeneration!);
    await expect(validateDispatchAuthorization(beforeRevoke)).rejects.toThrow(/authority changed/);
    await expect(store.grant({ ...input, expectedRevision: first.authorizationGeneration })).rejects.toThrow(/renew/);
    const fresh = await controller.assess(createSecurityPolicyForMode("adaptive"), request, options);
    await expect(validateDispatchAuthorization(fresh)).resolves.toBeUndefined();
    await expect(validateDispatchAuthorization(fresh)).rejects.toThrow(/authority changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRuntime } from "./create-runtime.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "../security/workspace-approval-controller.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";

it("requires a runtime-issued exact action, consumes it once, and renews reusable scope without repeated prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-approvals-"));
  const trust = new WorkspaceTrustStore({ homeDir: root });
  await trust.grant(root);
  const store = new WorkspaceApprovalStore({ path: join(root, "approvals.json") });
  const runtime = await createRuntime({
    tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: { provider: "unconfigured", id: "fixture", contextWindowTokens: 8192, supportsTools: false, supportsVision: false, supportsStructuredOutput: false },
    providerRegistry: new ProviderRegistry(), homeDir: root, workspaceRoot: root, localSkillsRoot: join(root, "skills"),
    profileId: "default", sessionId: "approval-session", sessionDb: new InMemorySessionDB(), securityMode: "strict", securityPolicy: { decide: () => "ask" },
    approvalController: new WorkspaceApprovalController({ store })
  });
  try {
    const execute = (content: string) => runtime.executeTool!({ tool: "file.write", toolInput: { path: "reviewed.txt", content, overwrite: true } });
    const pending = await execute("reviewed");
    expect(pending?.decision).toBe("ask");
    expect(pending?.pendingApproval).toBeDefined();
    const grant = { toolName: "file.write", riskClass: pending!.riskClass, targetKey: pending!.targetKey, targetSummary: pending!.targetSummary, scope: "once" as const, pendingApproval: pending!.pendingApproval };
    await expect(runtime.grantApproval!({ ...grant, pendingApproval: undefined })).rejects.toThrow(/context/);
    await expect(runtime.grantApproval!({ ...grant, toolName: "terminal.run" })).rejects.toThrow(/context/);
    await runtime.grantApproval!(grant);
    await expect(runtime.grantApproval!(grant)).rejects.toThrow(/context|consumed/);
    expect((await execute("changed"))?.decision).toBe("ask");
    expect((await execute("reviewed"))?.result?.ok).toBe(true);
    expect(await readFile(join(root, "reviewed.txt"), "utf8")).toBe("reviewed");
    const again = await execute("reviewed");
    expect(again?.decision).toBe("ask");
    await runtime.grantApproval!({ ...grant, scope: "always", pendingApproval: again!.pendingApproval });
    expect((await execute("covered update"))?.result?.ok).toBe(true);
    expect((await execute("covered again"))?.result?.ok).toBe(true);
    expect((await runtime.inspectApprovals!())!.persistent).toHaveLength(1);
    await trust.revoke(root);
    expect((await execute("untrusted"))?.decision).not.toBe("allow");
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

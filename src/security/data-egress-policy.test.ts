import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SecurityApprovalMode,
  SecurityDataEgressContext,
  SecurityRequest
} from "../contracts/security.js";
import { createSecurityPolicyForMode } from "./security-policy-factory.js";
import { WorkspaceApprovalController, WorkspaceApprovalStore } from "./workspace-approval-controller.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hosted vision data egress policy", () => {
  it.each([
    ["strict", "current-turn-attachment", "ask"],
    ["strict", "explicit-reference", "ask"],
    ["strict", "browser-artifact", "ask"],
    ["strict", "generated-artifact", "ask"],
    ["strict", "agent-discovered", "ask"],
    ["adaptive", "current-turn-attachment", "allow"],
    ["adaptive", "explicit-reference", "allow"],
    ["adaptive", "browser-artifact", "allow"],
    ["adaptive", "generated-artifact", "allow"],
    ["adaptive", "agent-discovered", "ask"],
    ["open", "current-turn-attachment", "allow"],
    ["open", "explicit-reference", "allow"],
    ["open", "browser-artifact", "allow"],
    ["open", "generated-artifact", "allow"],
    ["open", "agent-discovered", "allow"]
  ] as const)("uses %s mode for %s images: %s", async (mode, provenance, decision) => {
    const policy = createSecurityPolicyForMode(mode);
    await expect(policy.assess!(request(provenance))).resolves.toMatchObject({ decision });
  });

  it("denies sensitive hosted paths in every mode, including after a grant", async () => {
    for (const mode of ["strict", "adaptive", "open"] satisfies SecurityApprovalMode[]) {
      const policy = createSecurityPolicyForMode(mode);
      for (const provenance of [
        "current-turn-attachment",
        "explicit-reference",
        "browser-artifact",
        "generated-artifact",
        "agent-discovered"
      ] satisfies SecurityDataEgressContext["sourceProvenance"][]) {
        await expect(policy.assess!(request(provenance, true))).resolves.toMatchObject({
          decision: "deny",
          deterministicRule: "sensitive-hosted-data-egress"
        });
      }
    }

    const root = await temporaryRoot();
    const approvals = new WorkspaceApprovalController({
      store: new WorkspaceApprovalStore({ path: join(root, "approvals.json") })
    });
    await approvals.grant({
      workspaceRoot: join(root, "workspace"),
      sessionId: "session-a",
      toolName: "vision.analyze",
      riskClass: "external-side-effect",
      targetKey: "vision.analyze:hosted-egress:openai",
      scope: "always"
    });
    await expect(approvals.assess(
      createSecurityPolicyForMode("open"),
      request("agent-discovered", true),
      { workspaceRoot: join(root, "workspace"), sessionId: "session-a", mode: "open" }
    )).resolves.toMatchObject({ decision: "deny" });
  });

  it("repeated ordinary attachments remain automatic in adaptive mode", async () => {
    const policy = createSecurityPolicyForMode("adaptive");
    const decisions = await Promise.all(Array.from({ length: 8 }, () =>
      policy.assess!(request("current-turn-attachment"))
    ));
    expect(decisions.every((result) => result.decision === "allow")).toBe(true);
    expect(decisions.every((result) => result.deterministicRule === "adaptive-current-turn-attachment")).toBe(true);
  });

  it("requires approval when any comparison source was agent-discovered", async () => {
    const mixed = request("agent-discovered");
    mixed.context.dataEgress = {
      ...mixed.context.dataEgress!,
      sourceProvenances: ["current-turn-attachment", "agent-discovered"],
      sourceCount: 2
    };
    await expect(createSecurityPolicyForMode("adaptive").assess!(mixed)).resolves.toMatchObject({
      decision: "ask",
      deterministicRule: "adaptive-agent-discovered-egress"
    });
  });

  it("binds persistent grants to the exact provider destination and workspace", async () => {
    const root = await temporaryRoot();
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const approvals = new WorkspaceApprovalController({
      store: new WorkspaceApprovalStore({ path: join(root, "approvals.json") })
    });
    const base = createSecurityPolicyForMode("adaptive");
    const discovered = request("agent-discovered");

    await expect(approvals.assess(base, discovered, {
      workspaceRoot: workspaceA,
      sessionId: "session-a",
      mode: "adaptive"
    })).resolves.toMatchObject({ decision: "ask" });
    await approvals.grant({
      workspaceRoot: workspaceA,
      sessionId: "session-a",
      toolName: "vision.analyze",
      riskClass: "external-side-effect",
      targetKey: discovered.targetKey,
      targetSummary: discovered.targetSummary,
      scope: "always"
    });

    await expect(approvals.assess(base, discovered, {
      workspaceRoot: workspaceA,
      sessionId: "different-session",
      mode: "adaptive"
    })).resolves.toMatchObject({ decision: "allow", deterministicRule: "persistent-workspace-approval" });
    await expect(approvals.assess(base, {
      ...discovered,
      targetKey: "vision.analyze:hosted-egress:anthropic"
    }, {
      workspaceRoot: workspaceA,
      sessionId: "session-a",
      mode: "adaptive"
    })).resolves.toMatchObject({ decision: "ask" });
    await expect(approvals.assess(base, discovered, {
      workspaceRoot: workspaceB,
      sessionId: "session-a",
      mode: "adaptive"
    })).resolves.toMatchObject({ decision: "ask" });
  });
});

function request(
  sourceProvenance: SecurityDataEgressContext["sourceProvenance"],
  sensitivePath = false
): SecurityRequest {
  return {
    toolName: "vision.analyze",
    riskClass: "external-side-effect",
    targetKey: "vision.analyze:hosted-egress:openai",
    targetSummary: "send an image to hosted vision destination: openai",
    description: "run tool vision.analyze",
    context: {
      trustedWorkspace: true,
      targetConversationIsActive: true,
      dataEgress: {
        kind: "vision-image",
        inference: "hosted",
        sourceProvenance,
        sensitivePath,
        destinations: ["openai@https://api.openai.com/v1"]
      }
    }
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-vision-egress-"));
  roots.push(root);
  return root;
}

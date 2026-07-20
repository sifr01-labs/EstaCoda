import { describe, expect, it } from "vitest";
import type { SecurityPolicy } from "../contracts/security.js";
import type { Task, TaskAttempt, TaskStep } from "../contracts/task.js";
import type { TaskStore } from "./task-store.js";
import { TaskApprovalService } from "./task-approval-service.js";

describe("TaskApprovalService security policy", () => {
  it("turns a Task require_approval ceiling into a durable ask", async () => {
    const service = new TaskApprovalService({ store: emptyStore() });
    const { task, step, attempt } = context("require_approval");
    const policy = service.securityPolicyFor(task, step, attempt, allowingPolicy());

    await expect(policy.assess!({
      riskClass: "workspace-write",
      toolName: "file.write",
      targetKey: "workspace:README.md",
      targetSummary: "write README.md",
      description: "write file",
      context: { trustedWorkspace: true }
    })).resolves.toMatchObject({ decision: "ask" });
    expect(service.takeRequest(attempt.id)).toMatchObject({
      toolName: "file.write",
      riskClass: "workspace-write",
      targetFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      targetPreview: "write README.md"
    });
  });

  it("never lets Task approval authority override a base-policy denial", async () => {
    const service = new TaskApprovalService({ store: emptyStore() });
    const { task, step, attempt } = context("require_approval");
    const deny: SecurityPolicy = {
      decide: () => "deny",
      assess: async () => ({ decision: "deny", mode: "strict", reason: "hardline", risk: "high" })
    };
    const policy = service.securityPolicyFor(task, step, attempt, deny);

    await expect(policy.assess!({
      riskClass: "workspace-write",
      toolName: "terminal.run",
      command: "dangerous command",
      description: "run command",
      context: { trustedWorkspace: true }
    })).resolves.toMatchObject({ decision: "deny", reason: "hardline" });
    expect(service.takeRequest(attempt.id)).toBeUndefined();
  });
});

function emptyStore(): TaskStore {
  return {
    profileId: "alpha",
    listApprovalLinks: () => []
  } as unknown as TaskStore;
}

function allowingPolicy(): SecurityPolicy {
  return {
    decide: () => "allow",
    assess: async () => ({ decision: "allow", mode: "adaptive", reason: "allowed", risk: "medium" })
  };
}

function context(disposition: "runtime_policy" | "require_approval"): {
  task: Task;
  step: TaskStep;
  attempt: TaskAttempt;
} {
  const riskClassPolicy = {
    "read-only-local": "forbid",
    "read-only-network": "forbid",
    "workspace-write": disposition,
    "external-side-effect": "forbid",
    "credential-access": "forbid",
    "destructive-local": "forbid",
    "shared-state-mutation": "forbid",
    "spend-money": "forbid",
    "sandbox-escape": "forbid"
  } as const;
  const authority = {
    allowedToolsets: ["files"],
    blockedTools: [],
    riskClassPolicy,
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
  const task = {
    id: "task-alpha",
    profileId: "alpha",
    creatorSessionId: "creator-alpha",
    authorityPolicy: authority
  } as unknown as Task;
  const step = {
    id: "step-alpha",
    profileId: "alpha",
    taskId: task.id,
    planRevisionId: "revision-alpha",
    authorityPolicy: authority
  } as unknown as TaskStep;
  const attempt = {
    id: "attempt-alpha",
    profileId: "alpha",
    taskId: task.id,
    planRevisionId: step.planRevisionId,
    stepId: step.id
  } as unknown as TaskAttempt;
  return { task, step, attempt };
}

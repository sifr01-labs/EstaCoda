import { validateDispatchAuthorization } from "../security/dispatch-authorization.js";
import { taskApprovalFingerprint } from "./task-approval-service.js";
import { describe, expect, it, vi } from "vitest";
import type { SecurityPolicy } from "../contracts/security.js";
import type { Task, TaskApprovalLink, TaskAttempt, TaskStep } from "../contracts/task.js";
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

  it("scopes pending approval reads in the store before the page limit", () => {
    const link = {
      id: "link-alpha",
      taskId: "task-alpha",
      stepId: "step-alpha",
      attemptId: "attempt-alpha",
      authorizedSessionId: "creator-alpha",
      pendingApprovalId: "approval-alpha",
      toolName: "file.write",
      riskClass: "workspace-write",
      targetPreview: "write README.md",
      requestedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-02T00:00:00.000Z"
    } as TaskApprovalLink;
    const listApprovalLinks = vi.fn(() => [link]);
    const store = { profileId: "alpha", listApprovalLinks } as unknown as TaskStore;
    const queue = {
      createPendingApproval: vi.fn(),
      getApproval: vi.fn(),
      resolveApproval: vi.fn()
    };
    const service = new TaskApprovalService({ store, queue });

    expect(service.listPendingForSession("creator-alpha")).toEqual([
      expect.objectContaining({ approvalId: "approval-alpha", taskId: "task-alpha" })
    ]);
    expect(listApprovalLinks).toHaveBeenCalledWith({
      statuses: ["pending"],
      authorizedSessionId: "creator-alpha",
      excludeTerminalTasks: true,
      limit: 1_000
    });
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

it("consumes a Task approval at dispatch and fences a second in-flight receipt", async () => {
  const { task, step, attempt } = context("require_approval");
  task.status = "running"; task.activePlanRevisionId = step.planRevisionId;
  const request = { toolName: "file.write", riskClass: "workspace-write" as const, targetKey: "a.txt",
    actionKey: "a".repeat(64), description: "write", context: { trustedWorkspace: true } };
  let link = { id: "approved-link", attemptId: attempt.id, status: "approved", targetFingerprint: taskApprovalFingerprint(request),
    expiresAt: "2099-01-01T00:00:00.000Z" } as TaskApprovalLink;
  const store = {
    profileId: "alpha", getTask: () => task, getStep: () => step, getAttempt: () => attempt,
    listApprovalLinks: () => link.status === "approved" ? [link] : [],
    updateApprovalLink: (updated: TaskApprovalLink) => { link = updated; },
    atomicWrite: (callback: (store: TaskStore) => unknown) => callback(store as unknown as TaskStore)
  } as unknown as TaskStore;
  const service = new TaskApprovalService({ store });
  const policy = service.securityPolicyFor(task, step, attempt, { decide: () => "ask" });
  const first = await policy.assess!(request);
  const second = await policy.assess!(request);
  expect(first.decision).toBe("allow");
  await validateDispatchAuthorization(first);
  expect(link.status).toBe("consumed");
  await expect(validateDispatchAuthorization(second)).rejects.toThrow(/authority changed/);
  expect((await policy.assess!({ ...request, actionKey: "b".repeat(64) })).decision).toBe("ask");
});

it("retains exact action identity for a durable Task approval's full lifetime", async () => {
  const { executionActionIdentity } = await import("../security/execution-action-identity.js");
  const initial = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
  try {
    const { task, step, attempt } = context("require_approval");
    task.status = "running"; task.activePlanRevisionId = step.planRevisionId;
    const request = (content = "reviewed") => ({ toolName: "file.write", riskClass: "workspace-write" as const, targetKey: "a.txt",
      actionKey: executionActionIdentity("alpha", "task-retention-worker", "file.write", "workspace-write", { path: "a.txt", content }),
      description: "write", context: { trustedWorkspace: true } });
    let link: TaskApprovalLink | undefined;
    const store = { profileId: "alpha", getTask: () => task, getStep: () => step, getAttempt: () => attempt,
      listApprovalLinks: () => link?.status === "approved" ? [link] : [],
      updateApprovalLink: (updated: TaskApprovalLink) => { link = updated; },
      atomicWrite: (callback: (store: TaskStore) => unknown) => callback(store as unknown as TaskStore) } as unknown as TaskStore;
    const service = new TaskApprovalService({ store, now: () => new Date(Date.now()) });
    const policy = service.securityPolicyFor(task, step, attempt, { decide: () => "ask" });
    expect((await policy.assess!(request())).decision).toBe("ask");
    link = { ...service.createLink({ task, step, attempt, request: service.takeRequest(attempt.id)! }), status: "approved" };
    clock.mockReturnValue(initial + 23 * 60 * 60_000);
    expect(policy.decide(request())).toBe("allow");
    expect(policy.decide(request("changed"))).toBe("ask");
    await validateDispatchAuthorization(await policy.assess!(request()));
    expect(link.status).toBe("consumed");
    expect(policy.decide(request())).toBe("ask");
  } finally { clock.mockRestore(); }
});

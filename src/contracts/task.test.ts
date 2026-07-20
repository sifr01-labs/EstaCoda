import { describe, expect, it } from "vitest";
import type { ToolRiskClass } from "./tool.js";
import {
  IllegalTaskTransitionError,
  TASK_GRAPH_LIMITS,
  TASK_TOOL_RISK_CLASSES,
  assertTaskAttemptTransition,
  assertTaskPlanRevisionTransition,
  assertTaskStepTransition,
  assertTaskTransition,
  isChildTaskAuthorityAllowed,
  isTaskAttemptTransitionAllowed,
  isTaskAuthorityNarrowerOrEqual,
  isTaskPlanRevisionTransitionAllowed,
  isTaskStepTransitionAllowed,
  isTaskTransitionAllowed,
  isTerminalTaskAttemptStatus,
  isTerminalTaskPlanRevisionStatus,
  isTerminalTaskStatus,
  isTerminalTaskStepStatus,
  validateTaskPlan,
  type TaskAuthorityDisposition,
  type TaskAuthorityPolicy,
  type TaskPlanValidationInput,
  type TaskStep
} from "./task.js";

describe("durable Task state transitions", () => {
  it("allows the fixed execution lifecycle and rejects terminal resurrection", () => {
    expect(isTaskTransitionAllowed("planning", "queued")).toBe(true);
    expect(isTaskTransitionAllowed("queued", "running")).toBe(true);
    expect(isTaskTransitionAllowed("queued", "waiting_for_host")).toBe(true);
    expect(isTaskTransitionAllowed("waiting_for_host", "queued")).toBe(true);
    expect(isTaskTransitionAllowed("running", "waiting_for_approval")).toBe(true);
    expect(isTaskTransitionAllowed("waiting_for_approval", "queued")).toBe(true);
    expect(isTaskTransitionAllowed("completed", "running")).toBe(false);
    expect(() => assertTaskTransition("completed", "running")).toThrow(IllegalTaskTransitionError);
  });

  it("keeps PlanRevision activation and supersession immutable", () => {
    expect(isTaskPlanRevisionTransitionAllowed("draft", "validated")).toBe(true);
    expect(isTaskPlanRevisionTransitionAllowed("validated", "active")).toBe(true);
    expect(isTaskPlanRevisionTransitionAllowed("active", "superseded")).toBe(true);
    expect(isTaskPlanRevisionTransitionAllowed("superseded", "active")).toBe(false);
    expect(() => assertTaskPlanRevisionTransition("rejected", "active")).toThrow(
      "Illegal plan revision transition: rejected → active"
    );
  });

  it("separates logical Step retries from terminal Attempt outcomes", () => {
    expect(isTaskStepTransitionAllowed("running", "ready")).toBe(true);
    expect(isTaskStepTransitionAllowed("running", "skipped")).toBe(true);
    expect(isTaskAttemptTransitionAllowed("running", "failed")).toBe(true);
    expect(isTaskAttemptTransitionAllowed("failed", "queued")).toBe(false);
    expect(() => assertTaskStepTransition("completed", "ready")).toThrow(IllegalTaskTransitionError);
    expect(() => assertTaskAttemptTransition("interrupted", "queued")).toThrow(IllegalTaskTransitionError);
  });

  it("classifies all terminal states explicitly", () => {
    expect(["completed", "partial", "failed", "cancelled"].every((status) =>
      isTerminalTaskStatus(status as "completed" | "partial" | "failed" | "cancelled")
    )).toBe(true);
    expect(isTerminalTaskStatus("paused")).toBe(false);
    expect(isTerminalTaskPlanRevisionStatus("superseded")).toBe(true);
    expect(isTerminalTaskPlanRevisionStatus("active")).toBe(false);
    expect(isTerminalTaskStepStatus("skipped")).toBe(true);
    expect(isTerminalTaskStepStatus("waiting_for_input")).toBe(false);
    expect(isTerminalTaskAttemptStatus("expired")).toBe(true);
    expect(isTerminalTaskAttemptStatus("leased")).toBe(false);
  });
});

describe("Task authority ceilings", () => {
  it("accepts equal or narrower authority", () => {
    const ceiling = taskAuthority();
    const candidate: TaskAuthorityPolicy = {
      ...stepAuthority(),
      riskClassPolicy: {
        ...stepAuthority().riskClassPolicy,
        "workspace-write": "forbid"
      }
    };

    expect(isTaskAuthorityNarrowerOrEqual(candidate, ceiling)).toBe(true);
  });

  it("rejects broader tools, unblocked tools, risk, child creation, or depth", () => {
    const ceiling = taskAuthority();
    const valid = stepAuthority();
    const cases: TaskAuthorityPolicy[] = [
      { ...valid, allowedToolsets: ["files", "dangerous"] },
      { ...valid, allowedTools: undefined },
      { ...valid, blockedTools: [] },
      {
        ...valid,
        riskClassPolicy: { ...valid.riskClassPolicy, "workspace-write": "runtime_policy" }
      },
      { ...valid, maxChildDepth: ceiling.maxChildDepth + 1 }
    ];

    for (const candidate of cases) {
      expect(isTaskAuthorityNarrowerOrEqual(candidate, ceiling)).toBe(false);
    }
    expect(isTaskAuthorityNarrowerOrEqual(
      { ...valid, mayCreateChildTasks: true, maxChildDepth: 1 },
      { ...ceiling, mayCreateChildTasks: false }
    )).toBe(false);
  });

  it("requires child Tasks to consume one generation of delegation depth", () => {
    const parent = taskAuthority();
    const validChild = { ...taskAuthority(), maxChildDepth: parent.maxChildDepth - 1 };

    expect(isChildTaskAuthorityAllowed(validChild, parent)).toBe(true);
    expect(isChildTaskAuthorityAllowed({ ...validChild, maxChildDepth: parent.maxChildDepth }, parent)).toBe(false);
    expect(isChildTaskAuthorityAllowed(validChild, { ...parent, mayCreateChildTasks: false, maxChildDepth: 0 })).toBe(false);
  });
});

describe("validateTaskPlan", () => {
  it("accepts a bounded acyclic plan and returns a deterministic dependency order", () => {
    const plan = validPlan();
    const result = validateTaskPlan(plan);

    expect(result).toEqual({
      ok: true,
      issues: [],
      topologicalOrder: ["step-a", "step-b", "step-c"]
    });
  });

  it("does not mutate the proposed fixed graph", () => {
    const plan = validPlan();
    const before = JSON.stringify(plan);

    validateTaskPlan(plan);

    expect(JSON.stringify(plan)).toBe(before);
  });

  it("rejects missing, duplicate, self-referential, and cyclic dependencies", () => {
    const missing = validPlan();
    missing.steps = [
      missing.steps[0]!,
      step("step-b", 1, ["missing"]),
      step("step-c", 2, ["step-c", "step-c"])
    ];
    expect(issueCodes(validateTaskPlan(missing))).toEqual(expect.arrayContaining([
      "step-dependency-missing",
      "step-dependency-self",
      "step-dependency-duplicate"
    ]));

    const cyclic = validPlan();
    cyclic.steps = [
      step("step-a", 0, ["step-c"]),
      step("step-b", 1, ["step-a"]),
      step("step-c", 2, ["step-b"])
    ];
    expect(issueCodes(validateTaskPlan(cyclic))).toContain("plan-cycle");
  });

  it("rejects duplicate identities, keys, positions, and cross-owner records", () => {
    const plan = validPlan();
    plan.revision = { ...plan.revision, profileId: "other-profile", taskId: "other-task", revision: 0 };
    plan.steps = [
      step("step-a", 0),
      {
        ...step("step-a", 0),
        key: "a",
        profileId: "other-profile",
        taskId: "other-task",
        planRevisionId: "other-revision"
      }
    ];

    const codes = issueCodes(validateTaskPlan(plan));
    expect(codes).toEqual(expect.arrayContaining([
      "plan-profile-mismatch",
      "plan-task-mismatch",
      "plan-revision-invalid",
      "step-id-duplicate",
      "step-key-duplicate",
      "step-position-duplicate",
      "step-profile-mismatch",
      "step-task-mismatch",
      "step-plan-revision-mismatch"
    ]));
    expect(codes).not.toContain("plan-cycle");
  });

  it("requires direct profile ownership and a usable workspace binding", () => {
    const plan = validPlan();
    plan.task = {
      ...plan.task,
      id: "",
      profileId: "",
      workspace: { canonicalPath: "", identityHash: "" }
    };

    expect(issueCodes(validateTaskPlan(plan))).toEqual(expect.arrayContaining([
      "task-id-empty",
      "task-profile-id-empty",
      "task-workspace-invalid"
    ]));
  });

  it("enforces hard graph limits with bounded validation", () => {
    const plan = validPlan();
    const stepLimits = {
      ...TASK_GRAPH_LIMITS,
      maxSteps: 2
    };
    expect(issueCodes(validateTaskPlan(plan, stepLimits))).toContain("plan-too-many-steps");

    const dependencyLimits = {
      ...TASK_GRAPH_LIMITS,
      maxDependencies: 1,
      maxDependenciesPerStep: 1
    };
    expect(issueCodes(validateTaskPlan(plan, dependencyLimits))).toEqual(expect.arrayContaining([
      "step-too-many-dependencies",
      "plan-too-many-dependencies"
    ]));
  });

  it("rejects Step authority that exceeds the Task ceiling", () => {
    const plan = validPlan();
    plan.steps = [
      {
        ...plan.steps[0]!,
        authorityPolicy: {
          ...stepAuthority(),
          allowedToolsets: ["files", "dangerous"]
        }
      }
    ];

    expect(issueCodes(validateTaskPlan(plan))).toContain("step-authority-exceeds-task");
  });

  it("rejects malformed Task and Step authority policies", () => {
    const plan = validPlan();
    plan.task = {
      ...plan.task,
      authorityPolicy: { ...taskAuthority(), allowedToolsets: ["files", "files"] }
    };
    plan.steps = [{
      ...plan.steps[0]!,
      authorityPolicy: { ...stepAuthority(), blockedTools: [""] }
    }];

    expect(issueCodes(validateTaskPlan(plan))).toEqual(expect.arrayContaining([
      "task-authority-invalid",
      "step-authority-invalid"
    ]));
  });

  it("rejects invalid and Task-exceeding budgets", () => {
    const invalid = validPlan();
    invalid.task = {
      ...invalid.task,
      budgetPolicy: { ...invalid.task.budgetPolicy, maxConcurrentAttempts: 0 }
    };
    expect(issueCodes(validateTaskPlan(invalid))).toContain("task-budget-invalid");

    const excessive = validPlan();
    excessive.steps = [{
      ...excessive.steps[0]!,
      budget: { ...excessive.steps[0]!.budget, maxEstimatedCostUsd: excessive.task.budgetPolicy.maxEstimatedCostUsd + 1 }
    }];
    expect(issueCodes(validateTaskPlan(excessive))).toContain("step-budget-exceeds-task");
  });

  it("requires retry safety and internally consistent result limits", () => {
    const plan = validPlan();
    plan.steps = [{
      ...plan.steps[0]!,
      idempotency: "non_idempotent",
      retryPolicy: { ...plan.steps[0]!.retryPolicy, requireIdempotent: true },
      failurePolicy: { onAttemptsExhausted: "skip_if_optional", optional: false },
      resultPolicy: { kind: "none", required: true, maxBytes: 1 }
    }];

    expect(issueCodes(validateTaskPlan(plan))).toEqual(expect.arrayContaining([
      "step-retry-policy-invalid",
      "step-failure-policy-invalid",
      "step-result-policy-invalid"
    ]));
  });

  it("allows a non-idempotent Step when its policy cannot retry", () => {
    const plan = validPlan();
    plan.steps = [{
      ...plan.steps[0]!,
      idempotency: "non_idempotent",
      retryPolicy: {
        ...plan.steps[0]!.retryPolicy,
        maxAttempts: 1,
        requireIdempotent: true
      }
    }];

    expect(validateTaskPlan(plan).ok).toBe(true);
  });

  it("rejects unsupported executor data and unbounded objectives", () => {
    const plan = validPlan();
    plan.task = { ...plan.task, objective: "x".repeat(TASK_GRAPH_LIMITS.maxTaskObjectiveChars + 1) };
    plan.steps = [{
      ...plan.steps[0]!,
      title: "x".repeat(TASK_GRAPH_LIMITS.maxStepTitleChars + 1),
      objective: "x".repeat(TASK_GRAPH_LIMITS.maxStepObjectiveChars + 1),
      executor: { kind: "agent", role: "worker", model: { id: "" } }
    }];

    expect(issueCodes(validateTaskPlan(plan))).toEqual(expect.arrayContaining([
      "task-objective-too-long",
      "step-title-too-long",
      "step-objective-too-long",
      "step-executor-invalid"
    ]));
  });
});

function validPlan(): TaskPlanValidationInput {
  return {
    task: {
      id: "task-1",
      profileId: "profile-1",
      objective: "Research two providers and compare the findings.",
      workspace: {
        canonicalPath: "/workspace/project",
        identityHash: "workspace-hash"
      },
      authorityPolicy: taskAuthority(),
      budgetPolicy: {
        maxConcurrentAttempts: 2,
        maxProviderCalls: 20,
        maxTotalTokens: 100_000,
        maxEstimatedCostUsd: 5,
        maxWallClockMs: 3_600_000
      }
    },
    revision: {
      id: "revision-1",
      profileId: "profile-1",
      taskId: "task-1",
      revision: 1,
      status: "draft",
      reason: "Initial fixed plan.",
      createdBy: { kind: "user", sessionId: "session-1" },
      createdAt: "2026-07-19T00:00:00.000Z"
    },
    steps: [
      step("step-a", 0),
      step("step-b", 1),
      step("step-c", 2, ["step-a", "step-b"])
    ]
  };
}

function step(id: string, position: number, dependsOn: readonly string[] = []): TaskStep {
  return {
    id,
    profileId: "profile-1",
    taskId: "task-1",
    planRevisionId: "revision-1",
    key: id.replace("step-", ""),
    position,
    status: "pending",
    title: `Execute ${id}`,
    objective: `Complete the objective for ${id}.`,
    dependsOn,
    executor: { kind: "agent", role: "worker" },
    authorityPolicy: stepAuthority(),
    budget: {
      maxProviderCalls: 5,
      maxTotalTokens: 20_000,
      maxEstimatedCostUsd: 1,
      maxWallClockMs: 600_000
    },
    retryPolicy: {
      maxAttempts: 2,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1_000,
      retryableFailureClasses: ["transient"],
      nonRetryableFailureClasses: ["security-deny"],
      requireIdempotent: true
    },
    failurePolicy: {
      onAttemptsExhausted: "fail_task",
      optional: false
    },
    idempotency: "idempotent",
    resultPolicy: {
      kind: "text",
      required: true,
      maxBytes: 50_000
    },
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function taskAuthority(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files", "web"],
    allowedTools: ["file.read", "web.search"],
    blockedTools: ["terminal.run"],
    riskClassPolicy: riskPolicy({
      "read-only-local": "runtime_policy",
      "read-only-network": "runtime_policy",
      "workspace-write": "require_approval",
      "shared-state-mutation": "require_approval"
    }),
    mayCreateChildTasks: true,
    maxChildDepth: 2
  };
}

function stepAuthority(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files"],
    allowedTools: ["file.read"],
    blockedTools: ["terminal.run", "terminal.exec"],
    riskClassPolicy: riskPolicy({
      "read-only-local": "runtime_policy",
      "read-only-network": "forbid",
      "workspace-write": "require_approval"
    }),
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}

function riskPolicy(
  overrides: Partial<Record<ToolRiskClass, TaskAuthorityDisposition>>
): Record<ToolRiskClass, TaskAuthorityDisposition> {
  return Object.fromEntries(
    TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, overrides[riskClass] ?? "forbid"])
  ) as Record<ToolRiskClass, TaskAuthorityDisposition>;
}

function issueCodes(result: ReturnType<typeof validateTaskPlan>): string[] {
  return result.issues.map((entry) => entry.code);
}

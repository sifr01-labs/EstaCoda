import { describe, expect, it } from "vitest";
import { EXECUTION_PLAN_MAX_ITEMS } from "../contracts/execution-plan.js";
import { ExecutionPlanController, ExecutionPlanValidationError } from "./execution-plan-controller.js";
import { ExecutionPlanStore } from "./execution-plan-store.js";
import { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { ExecutionCapabilityPreflight } from "./execution-capability-preflight.js";
import { ToolRegistry } from "../tools/tool-registry.js";

function controller() {
  return new ExecutionPlanController(new ExecutionPlanStore(), undefined, evidenceIndex());
}

function evidenceIndex() {
  const index = new ExecutionEvidenceIndex();
  index.record({
    tool: {
      name: "postman.update",
      description: "Update Postman",
      inputSchema: {},
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      progressLabel: "updating",
      maxResultSizeChars: 1000
    },
    input: { token: "must-not-persist" },
    decision: "allow",
    riskClass: "external-side-effect",
    targetSummary: "Collection token=must-not-persist",
    toolCallId: "call-1",
    result: { ok: true, content: "raw result must not persist" }
  });
  index.record({
    tool: {
      name: "postman.update",
      description: "Update Postman",
      inputSchema: {},
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      progressLabel: "updating",
      maxResultSizeChars: 1000
    },
    decision: "allow",
    riskClass: "external-side-effect",
    toolCallId: "call-failed",
    result: { ok: false, content: "failed" }
  });
  return index;
}

describe("ExecutionPlanController", () => {
  it("preflights requirements, stores only runtime assessments, and keeps a ready Mission active", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp.target.read",
      description: "read target",
      inputSchema: {},
      riskClass: "read-only-network",
      toolsets: ["mcp"],
      progressLabel: "reading",
      maxResultSizeChars: 100,
      isAvailable: () => true,
      run: async () => ({ ok: true, content: "unused" })
    });
    registry.register({
      name: "mcp.target.update",
      description: "update target",
      inputSchema: {},
      riskClass: "external-side-effect",
      toolsets: ["mcp"],
      progressLabel: "updating",
      maxResultSizeChars: 100,
      isAvailable: () => true,
      run: async () => ({ ok: true, content: "unused" })
    });
    const target = new ExecutionPlanController(
      new ExecutionPlanStore(),
      undefined,
      evidenceIndex(),
      new ExecutionCapabilityPreflight({ registry })
    );

    const plan = await target.write({
      objective: "Inspect the destination",
      items: [
        { id: "inspect", content: "Inspect target state", status: "in_progress" },
        { id: "update", content: "Update target state", status: "pending" },
        { id: "verify", content: "Verify target state", status: "pending" }
      ],
      requirements: [
        { id: "destination-read", itemId: "inspect", tool: "mcp.target.read", capability: "read" },
        { id: "destination-write", itemId: "update", tool: "mcp.target.update", capability: "mutate" },
        { id: "destination-verify", itemId: "verify", tool: "mcp.target.read", capability: "verify" }
      ],
      ...({ capabilityPreflight: { status: "ready", assessments: [] } } as object)
    }, "turn-preflight");

    expect(plan).toMatchObject({
      status: "active",
      requirements: [
        { id: "destination-read", tool: "mcp.target.read" },
        { id: "destination-write", tool: "mcp.target.update" },
        { id: "destination-verify", tool: "mcp.target.read" }
      ],
      capabilityPreflight: {
        status: "ready",
        assessments: [
          { requirementId: "destination-read", status: "ready" },
          { requirementId: "destination-write", status: "ready" },
          { requirementId: "destination-verify", status: "ready" }
        ]
      }
    });
  });

  it("blocks the associated item before substantive work when a mandatory capability is missing", async () => {
    const registry = new ToolRegistry();
    for (const [name, capability] of [
      ["mcp.target.read", "read"],
      ["mcp.target.verify", "read"]
    ] as const) {
      registry.register({
        name,
        description: capability,
        inputSchema: {},
        riskClass: "read-only-network",
        toolsets: ["mcp"],
        progressLabel: capability,
        maxResultSizeChars: 100,
        isAvailable: () => true,
        run: async () => ({ ok: true, content: "unused" })
      });
    }
    const target = new ExecutionPlanController(
      new ExecutionPlanStore(),
      undefined,
      evidenceIndex(),
      new ExecutionCapabilityPreflight({ registry })
    );
    const events: string[] = [];

    const plan = await target.write({
      objective: "Move configuration between systems",
      items: [
        { id: "inspect-source", content: "Inspect source state", status: "in_progress" },
        { id: "update-target", content: "Update target state", status: "pending" }
      ],
      requirements: [
        { id: "destination-read", itemId: "inspect-source", tool: "mcp.target.read", capability: "read" },
        { id: "destination-write", itemId: "update-target", tool: "mcp.target.update", capability: "mutate" },
        { id: "destination-verify", itemId: "update-target", tool: "mcp.target.verify", capability: "verify" }
      ]
    }, "turn-blocked", async (event) => { events.push(event.kind); });

    expect(plan.status).toBe("blocked");
    expect(plan.items).toEqual([
      expect.objectContaining({ id: "inspect-source", status: "in_progress" }),
      expect.objectContaining({
        id: "update-target",
        status: "blocked",
        blocker: {
          kind: "missing_capability",
          summary: 'Required tool "mcp.target.update" is not exposed to this session.'
        }
      })
    ]);
    expect(events).toEqual(["execution-plan-blocked"]);
  });

  it("keeps capability requirements bounded and persists no undeclared secret fields", async () => {
    const target = new ExecutionPlanController(
      new ExecutionPlanStore(),
      undefined,
      evidenceIndex(),
      new ExecutionCapabilityPreflight({ registry: new ToolRegistry() })
    );
    const plan = await target.write({
      objective: "Check destination access",
      items: [{ id: "inspect", content: "Inspect destination", status: "in_progress" }],
      requirements: [
        {
          id: "read",
          itemId: "inspect",
          tool: "mcp.target.read",
          capability: "read",
          ...({ credential: "must-not-persist" } as object)
        },
        { id: "mutate", itemId: "inspect", tool: "mcp.target.update", capability: "mutate" },
        { id: "verify", itemId: "inspect", tool: "mcp.target.verify", capability: "verify" }
      ]
    }, "turn-bounded");
    expect(JSON.stringify(plan)).not.toContain("must-not-persist");

    await expect(target.write({
      objective: "Too many requirements",
      items: [{ id: "inspect", content: "Inspect destination", status: "in_progress" }],
      requirements: Array.from({ length: 13 }, (_, index) => ({
        id: `read-${index}`,
        itemId: "inspect",
        tool: "mcp.target.read",
        capability: "read" as const
      }))
    }, "turn-overflow")).rejects.toThrow("requirements must contain 1-12");
  });

  it("rejects incomplete cross-system requirement sets", async () => {
    const target = controller();
    await expect(target.write({
      objective: "Update a destination",
      items: [
        { id: "read", content: "Read destination", status: "in_progress" },
        { id: "update", content: "Update destination", status: "pending" }
      ],
      requirements: [
        { id: "read", itemId: "read", tool: "mcp.target.read", capability: "read" },
        { id: "update", itemId: "update", tool: "mcp.target.update", capability: "mutate" }
      ]
    }, "turn-incomplete")).rejects.toThrow("destination verify capability");
  });

  it("records started, updated, completed, transferred, and abandoned lifecycle snapshots", async () => {
    const events: string[] = [];
    const target = new ExecutionPlanController(
      new ExecutionPlanStore(),
      async (event) => { events.push(event.kind); },
      evidenceIndex()
    );
    await target.write({
      objective: "Complete the mission",
      items: [{ id: "work", content: "Do the work", status: "in_progress" }]
    }, "turn-1");
    await target.merge({ items: [{ id: "work", status: "pending" }] });
    await target.merge({ items: [{ id: "work", status: "completed", evidenceCallIds: ["call-1"] }] });
    target.clear();
    await target.write({
      objective: "Delegate the mission",
      items: [{ id: "delegate", content: "Create a Task", status: "in_progress" }]
    }, "turn-2");
    await target.transfer(["task-1", "task-1"]);
    target.clear();
    await target.write({
      objective: "Replace the mission",
      items: [{ id: "old", content: "Old work", status: "pending" }]
    }, "turn-3");
    await target.prepareForTurn("Please review a different codebase");

    expect(events).toEqual([
      "execution-plan-started",
      "execution-plan-updated",
      "execution-plan-completed",
      "execution-plan-started",
      "execution-plan-transferred",
      "execution-plan-started",
      "execution-plan-abandoned"
    ]);
    expect(target.current()).toBeUndefined();
  });

  it("keeps active state for explicit continuation", async () => {
    const target = controller();
    await target.write({
      objective: "Continue this mission",
      items: [{ id: "work", content: "Continue", status: "in_progress" }]
    }, "turn-1");
    await target.prepareForTurn("continue");
    expect(target.current()?.status).toBe("active");
  });

  it("reopens a user-input-blocked Mission when the user retries", async () => {
    const events: string[] = [];
    const target = controller();
    await target.write({
      objective: "Authenticate the account",
      items: [{
        id: "verify",
        content: "Verify authentication",
        status: "blocked",
        evidenceCallIds: ["stale-failure-evidence"],
        blocker: { kind: "user_input_required", summary: "Provide corrected credentials." }
      }]
    }, "turn-1");

    await target.prepareForTurn("okay lets retry...", async (event) => { events.push(event.kind); });

    expect(target.current()).toMatchObject({
      revision: 2,
      status: "active",
      items: [{ id: "verify", status: "in_progress" }]
    });
    expect(target.current()?.items[0]).not.toHaveProperty("blocker");
    expect(target.current()?.items[0]).not.toHaveProperty("evidenceCallIds");
    expect(events).toEqual(["execution-plan-updated"]);
  });

  it("does not reopen non-user blockers or empty follow-ups", async () => {
    const external = controller();
    await external.write({
      objective: "Wait for the external service",
      items: [{
        id: "wait",
        content: "Wait for service recovery",
        status: "blocked",
        blocker: { kind: "external_state", summary: "The external service is unavailable." }
      }]
    }, "turn-1");
    await external.prepareForTurn("retry");
    expect(external.current()?.status).toBe("blocked");

    const empty = controller();
    await empty.write({
      objective: "Authenticate the account",
      items: [{
        id: "credentials",
        content: "Collect credentials",
        status: "blocked",
        blocker: { kind: "user_input_required", summary: "Provide the credentials." }
      }]
    }, "turn-2");
    await empty.prepareForTurn("...");
    expect(empty.current()?.status).toBe("blocked");
  });

  it("abandons a blocked Mission when the user cancels", async () => {
    const target = controller();
    await target.write({
      objective: "Authenticate the account",
      items: [{
        id: "credentials",
        content: "Collect credentials",
        status: "blocked",
        blocker: { kind: "user_input_required", summary: "Provide the credentials." }
      }]
    }, "turn-1");

    await target.prepareForTurn("never mind");
    expect(target.current()).toBeUndefined();
  });

  it("hydrates only when the next turn explicitly resumes", async () => {
    const persisted = {
      objective: "Resume this mission",
      originTurnId: "turn-old",
      revision: 2,
      status: "active" as const,
      items: [{ id: "work", content: "Continue", status: "in_progress" as const }]
    };
    const resumed = controller();
    resumed.hydrate(persisted);
    await resumed.prepareForTurn("resume this work");
    expect(resumed.current()).toEqual(persisted);

    const unrelated = controller();
    unrelated.hydrate(persisted);
    await unrelated.prepareForTurn("hello");
    expect(unrelated.current()).toBeUndefined();
  });

  it("writes a redacted bounded plan and derives active state", async () => {
    const target = controller();
    const plan = await target.write({
      objective: "Test API\ntoken=super-secret-value-1234567890",
      items: [
        { id: "inspect", content: "Inspect APIs", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "verify", content: "Verify collection", status: "in_progress" }
      ]
    }, "turn-1");

    expect(plan).toMatchObject({
      originTurnId: "turn-1",
      revision: 1,
      status: "active",
      items: [
        {
          id: "inspect",
          status: "completed",
          evidenceCallIds: ["call-1"],
          evidence: [{ toolCallId: "call-1", tool: "postman.update", outcome: "success" }]
        },
        { id: "verify", status: "in_progress" }
      ]
    });
    expect(plan.objective).toContain("API token=[REDACTED]");
    expect(plan.objective).not.toContain("\n");
    expect(JSON.stringify(plan)).not.toContain("super-secret-value");
    expect(JSON.stringify(plan)).not.toContain("raw result must not persist");
    expect(JSON.stringify(plan)).not.toContain("must-not-persist");
  });

  it("merges existing items, appends new items, and increments revision", async () => {
    const target = controller();
    await target.write({
      objective: "Build collection",
      items: [
        { id: "build", content: "Build it", status: "in_progress" },
        { id: "publish", content: "Publish it", status: "pending" }
      ]
    }, "turn-1");

    const plan = await target.merge({
      objective: "Build and verify collection",
      items: [
        { id: "build", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "verify", content: "Verify it", status: "in_progress" }
      ]
    });

    expect(plan).toMatchObject({
      objective: "Build and verify collection",
      revision: 2,
      status: "active",
      items: [
        { id: "build", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "publish", status: "pending" },
        { id: "verify", status: "in_progress" }
      ]
    });
  });

  it("rejects appending follow-up work while completing the final unfinished objective item", async () => {
    const target = controller();
    await target.write({
      objective: "Authenticate the account",
      items: [{ id: "verify-login", content: "Verify authenticated state", status: "in_progress" }]
    }, "turn-1");

    await expect(target.merge({
      items: [
        { id: "verify-login", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "cancel-dialogs", content: "Cancel optional pending dialogs", status: "pending" }
      ]
    })).rejects.toThrow("cannot extend a Mission while completing its final unfinished objective item");
    expect(target.current()).toMatchObject({
      revision: 1,
      status: "active",
      items: [{ id: "verify-login", status: "in_progress" }]
    });
  });

  it("allows a required discovered step while meaningful original work remains", async () => {
    const target = controller();
    await target.write({
      objective: "Build and publish the collection",
      items: [
        { id: "build", content: "Build the collection", status: "in_progress" },
        { id: "publish", content: "Publish the collection", status: "pending" }
      ]
    }, "turn-1");

    const plan = await target.merge({
      items: [
        { id: "build", status: "completed", evidenceCallIds: ["call-1"] },
        { id: "verify", content: "Verify the collection before publishing", status: "in_progress" }
      ]
    });
    expect(plan).toMatchObject({
      status: "active",
      items: [
        { id: "build", status: "completed" },
        { id: "publish", status: "pending" },
        { id: "verify", status: "in_progress" }
      ]
    });
  });

  it("derives terminal status after reasoning completion passes enforcement", async () => {
    const target = controller();
    await target.write({
      objective: "Finish work",
      items: [{ id: "finish", content: "Explain the result", status: "in_progress" }]
    }, "turn-1");

    expect((await target.merge({
      items: [{ id: "finish", status: "completed", completionKind: "reasoning" }]
    })).status).toBe("completed");
  });

  it("rejects unknown and failed evidence and reasoning for consequential actions", async () => {
    const target = controller();
    await target.write({
      objective: "Update the collection",
      items: [{ id: "update", content: "Update Postman collection", status: "in_progress" }]
    }, "turn-1");

    await expect(target.merge({
      items: [{ id: "update", status: "completed", evidenceCallIds: ["unknown-call"] }]
    })).rejects.toThrow("Unknown evidence call id");
    await expect(target.merge({
      items: [{ id: "update", status: "completed", evidenceCallIds: ["call-failed"] }]
    })).rejects.toThrow("cannot prove completion");
    await expect(target.merge({
      items: [{ id: "update", status: "completed", completionKind: "reasoning" }]
    })).rejects.toThrow("cannot use completionKind=reasoning");
    await expect(target.merge({
      items: [{
        id: "update",
        content: "Review the result and commit the changes",
        status: "completed",
        completionKind: "reasoning"
      }]
    })).rejects.toThrow("cannot use completionKind=reasoning");
    expect(target.current()?.items[0]?.status).toBe("in_progress");
  });

  it("accepts reasoning completion only for non-consequential work", async () => {
    const target = controller();
    await target.write({
      objective: "Explain the tradeoff",
      items: [{ id: "explain", content: "Explain the tradeoff", status: "in_progress" }]
    }, "turn-1");

    const completed = await target.merge({
      items: [{ id: "explain", status: "completed", completionKind: "reasoning" }]
    });
    expect(completed).toMatchObject({ status: "completed", items: [{ completionKind: "reasoning" }] });
  });

  it("rejects non-concrete blocker excuses", async () => {
    const target = controller();
    await expect(target.write({
      objective: "Finish the work",
      items: [{
        id: "work",
        content: "Finish work",
        status: "blocked",
        blocker: { kind: "external_state", summary: "Would you like me to continue?" }
      }]
    }, "turn-1")).rejects.toThrow("concrete blocker");
    await expect(target.write({
      objective: "Finish the work",
      items: [{
        id: "work",
        content: "Finish work",
        status: "blocked",
        blocker: { kind: "external_state", summary: "I need more time before finishing, please." }
      }]
    }, "turn-1")).rejects.toThrow("concrete blocker");
  });

  it("distinguishes an abandoned all-cancelled plan from completed work", async () => {
    const target = controller();
    const blocker = { kind: "external_state" as const, summary: "The target was withdrawn." };
    const plan = await target.write({
      objective: "Work that is no longer needed",
      items: [{ id: "stop", content: "Stop the work", status: "cancelled", blocker }]
    }, "turn-1");

    expect(plan.status).toBe("abandoned");
  });

  it("rejects invalid state without mutating the previous plan", async () => {
    const target = controller();
    await target.write({
      objective: "Safe objective",
      items: [{ id: "first", content: "First", status: "in_progress" }]
    }, "turn-1");

    await expect(target.merge({
      items: [{ id: "second", content: "Second", status: "in_progress" }]
    })).rejects.toThrow("Only one plan item may be in_progress");
    expect(target.current()?.items).toHaveLength(1);
    expect(target.current()?.revision).toBe(1);
  });

  it("requires reasons for blocked and cancelled items", async () => {
    const target = controller();
    await expect(target.write({
      objective: "Blocked work",
      items: [{ id: "blocked", content: "Blocked", status: "blocked" }]
    }, "turn-1")).rejects.toThrow("requires a blocker reason");
  });

  it("enforces item count, stable IDs, and merge preconditions", async () => {
    const target = controller();
    await expect(target.merge({ items: [{ id: "missing", status: "completed" }] })).rejects.toThrow(
      "Call plan with operation=write first"
    );
    await expect(target.write({
      objective: "Too many",
      items: Array.from({ length: EXECUTION_PLAN_MAX_ITEMS + 1 }, (_, index) => ({
        id: `item-${index}`,
        content: `Item ${index}`
      }))
    }, "turn-1")).rejects.toThrow(`at most ${EXECUTION_PLAN_MAX_ITEMS} items`);
    await expect(target.write({
      objective: "Bad ID",
      items: [{ id: "bad id", content: "Bad" }]
    }, "turn-1")).rejects.toThrow(ExecutionPlanValidationError);
  });
});

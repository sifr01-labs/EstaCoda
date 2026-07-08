import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAgentEvolutionPolicy, type AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { SkillEvolutionStore } from "./skill-evolution.js";
import { SkillLearningManager } from "./skill-learning.js";
import { SkillRegistry } from "./skill-registry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-skill-learning-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SkillLearningManager", () => {
  it("observes no-skill turns as new_or_missing_playbook evidence candidates", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: undefined,
      promptHash: "prompt-hash-1",
      routeConfidence: 0.82,
      outcomeStatus: "succeeded",
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(result?.candidate).toEqual(expect.objectContaining({
      kind: "new_or_missing_playbook",
      suggestedTarget: "routing_eval_addition",
      promptHash: "prompt-hash-1"
    }));
    expect(result?.evidence).toEqual(expect.objectContaining({
      skillName: "Run Release Checks workflow",
      sessionId: "session",
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: false,
      requiresHumanApproval: true
    }));
    await expect(harness.skillEvolutionStore.listLearningCandidates()).resolves.toContainEqual(expect.objectContaining({
      kind: "new_or_missing_playbook",
      evidenceIds: [result?.evidence?.id]
    }));
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: "skill-learned",
      action: "observed",
      record: expect.objectContaining({
        evidenceIds: [result?.evidence?.id],
        candidateId: result?.candidate?.id,
        candidateKind: "new_or_missing_playbook"
      })
    }));
  });

  it("observes selected-skill turns as selected_skill_refinement evidence candidates", async () => {
    const harness = await createHarness("proactive");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: skill("release-skill"),
      finalSkillUsed: "release-skill",
      promptHash: "prompt-hash-2",
      routeConfidence: 0.91,
      outcomeStatus: "succeeded",
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("file.read")]
    });

    expect(result?.candidate).toEqual(expect.objectContaining({
      kind: "selected_skill_refinement",
      selectedSkill: "release-skill",
      suggestedTarget: "routing_eval_addition",
      promptHash: "prompt-hash-2"
    }));
    expect(result?.evidence).toEqual(expect.objectContaining({
      skillName: "release-skill",
      sessionId: "session",
      sourceTrust: "runtime_internal",
      mayPromoteAutomatically: false,
      requiresHumanApproval: true
    }));
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: "skill-learned",
      action: "candidate",
      record: expect.objectContaining({
        selectedSkillName: "release-skill",
        candidateKind: "selected_skill_refinement"
      })
    }));
  });

  it("routes rejected selected-skill corrections toward negative example candidates", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: skill("wrong-skill"),
      finalSkillUsed: "better-skill",
      promptHash: "prompt-hash-3",
      routeConfidence: 0.4,
      outcomeStatus: "partial",
      correctionSignals: [{ source: "developer", kind: "rejected", skillName: "wrong-skill", replacementSkillName: "better-skill" }],
      searchedReplacementSkill: "better-skill",
      candidatesRejected: [{ skillName: "wrong-skill", reason: "developer correction" }],
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("file.read")]
    });

    expect(result?.candidate).toEqual(expect.objectContaining({
      kind: "selected_skill_refinement",
      selectedSkill: "wrong-skill",
      suggestedTarget: "negative_example_addition"
    }));
    expect(result?.evidence?.evidence).toEqual(expect.objectContaining({
      finalSkillUsed: "better-skill",
      searchedReplacementSkill: "better-skill"
    }));
  });

  it("emits no evidence when AgentEvolutionPolicy disables observation", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: undefined,
      agentEvolutionPolicy: deriveAgentEvolutionPolicy("none"),
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(result).toBeUndefined();
    await expect(harness.skillEvolutionStore.listLearningCandidates()).resolves.toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("autonomous mode remains shadow-only and only emits evidence candidates", async () => {
    const harness = await createHarness("autonomous");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: skill("release-skill"),
      promptHash: "prompt-hash-4",
      outcomeStatus: "succeeded",
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("file.read")]
    });

    expect(harness.policy.shadowAutonomousDecisions).toBe(true);
    expect(harness.policy.autoPromoteEligibleLocalChanges).toBe(false);
    expect(result?.candidate?.kind).toBe("selected_skill_refinement");
    await expect(harness.skillEvolutionStore.listProposals()).resolves.toEqual([]);
  });

  it("does not directly write SKILL.md or create local skills", async () => {
    const harness = await createHarness("autonomous");

    await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: undefined,
      promptHash: "prompt-hash-5",
      outcomeStatus: "succeeded",
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(existsSync(join(harness.localSkillsRoot, "SKILL.md"))).toBe(false);
    await expect(readdir(harness.localSkillsRoot).catch(() => [])).resolves.not.toContain("Run Release Checks workflow");
    await expect(harness.skillEvolutionStore.listProposals()).resolves.toEqual([]);
  });

  it("strips hidden reasoning from learned workflow content", async () => {
    const harness = await createHarness("proactive");

    await harness.manager.observeTurn({
      ...turnBase(),
      userText: "<think>private chain</think>Run the release checks",
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    const records = await harness.manager.inspect();
    expect(records[0]?.content).toContain("Run the release checks");
    expect(records[0]?.content).not.toContain("private chain");
    expect(records[0]?.content).not.toContain("<think>");
  });

  it("marks created records with missing createdSkillPath as stale", async () => {
    const harness = await createHarness("suggest");
    await seedSkillLearningStore(harness.storePath, [{
      ...record("missing-path"),
      status: "created"
    }]);

    const result = await harness.manager.reconcileCreatedPaths();
    const records = await harness.manager.inspect();

    expect(result).toEqual({ checked: 1, stale: 1 });
    expect(records[0]).toEqual(expect.objectContaining({
      key: "missing-path",
      status: "stale",
      staleReason: "created-path-missing",
      staleDetectedAt: expect.any(String)
    }));
  });

  it("keeps created records when the created skill path exists inside the local skills root", async () => {
    const harness = await createHarness("suggest");
    const skillPath = join(harness.localSkillsRoot, "release-checks", "SKILL.md");
    await mkdir(join(harness.localSkillsRoot, "release-checks"), { recursive: true });
    await writeFile(skillPath, "placeholder", "utf8");
    await seedSkillLearningStore(harness.storePath, [{
      ...record("existing-path"),
      status: "created",
      createdSkillPath: skillPath
    }]);

    const result = await harness.manager.reconcileCreatedPaths();
    const records = await harness.manager.inspect();

    expect(result).toEqual({ checked: 1, stale: 0 });
    expect(records[0]).toEqual(expect.objectContaining({
      key: "existing-path",
      status: "created",
      createdSkillPath: skillPath
    }));
  });

  it("does not resurrect a stale workflow when the same turn is observed again", async () => {
    const harness = await createHarness("suggest");
    const prompt = "Run the release checks";
    const workflowKey = "run the release checks::shell>file.read";
    await seedSkillLearningStore(harness.storePath, [{
      ...record(workflowKey),
      status: "stale",
      staleReason: "created-path-missing",
      staleDetectedAt: "2026-06-17T00:00:00.000Z"
    }]);

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      userText: prompt,
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });
    const records = await harness.manager.inspect();

    expect(result).toBeUndefined();
    expect(records[0]).toEqual(expect.objectContaining({
      key: workflowKey,
      status: "stale",
      occurrences: 1
    }));
    expect(harness.events).toEqual([]);
  });

  it("does not emit live candidate events for stale selected-skill records", async () => {
    const harness = await createHarness("proactive");
    const staleDetectedAt = "2026-06-17T00:00:00.000Z";
    const key = "selected:release-skill:prompt-hash-stale";
    await seedSkillLearningStore(harness.storePath, [{
      ...record(key),
      name: "release-skill refinement",
      content: "Selected skill refinement evidence: release-skill",
      status: "stale",
      staleReason: "created-path-missing",
      staleDetectedAt,
      selectedSkillName: "release-skill",
      promptHash: "prompt-hash-stale"
    }]);

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      selectedSkill: skill("release-skill"),
      promptHash: "prompt-hash-stale",
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("file.read")]
    });
    const records = await harness.manager.inspect();

    expect(result).toBeUndefined();
    expect(records[0]).toEqual(expect.objectContaining({
      key,
      status: "stale",
      staleReason: "created-path-missing",
      staleDetectedAt
    }));
    expect(harness.events).not.toContainEqual(expect.objectContaining({
      kind: "skill-learned",
      action: "candidate",
      record: expect.objectContaining({ key })
    }));
  });

  it("marks outside-root createdSkillPath as stale without probing the outside path", async () => {
    const harness = await createHarness("suggest");
    const outsideSkillPath = `/outside-root-\u0000/SKILL.md`;
    await seedSkillLearningStore(harness.storePath, [{
      ...record("outside-path"),
      status: "created",
      createdSkillPath: outsideSkillPath
    }]);

    const result = await harness.manager.reconcileCreatedPaths();
    const records = await harness.manager.inspect();

    expect(result).toEqual({ checked: 1, stale: 1 });
    expect(records[0]).toEqual(expect.objectContaining({
      status: "stale",
      staleReason: "created-path-outside-profile"
    }));
  });

  it("does not create workflow records for generic two-tool continuation prompts", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      userText: "can you try",
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(result).toBeUndefined();
    await expect(harness.manager.inspect()).resolves.toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("still creates observed workflow records for concrete two-tool task prompts", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      userText: "Run the release checks for package.json",
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(result?.action).toBe("observed");
    expect(result?.record).toEqual(expect.objectContaining({
      status: "observed",
      bounded: true
    }));
  });

  it("accepts meaningful Arabic workflow prompts without English-only token assumptions", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      userText: "راجع إعدادات الإصدار قبل تشغيل الاختبارات",
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(result?.action).toBe("observed");
    expect(result?.record.status).toBe("observed");
  });

  it("keeps secret-sensitive workflow prompts bounded as untrusted for skill creation", async () => {
    const harness = await createHarness("suggest");

    const result = await harness.manager.observeTurn({
      ...turnBase(),
      userText: "Check the deployment token handling in package.json",
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    });

    expect(result?.record).toEqual(expect.objectContaining({
      bounded: false,
      boundedReason: "prompt references secrets or credentials"
    }));
    expect(result?.candidate).toEqual(expect.objectContaining({
      suggestedTarget: "routing_metadata_update"
    }));
  });

  it("keeps repeated occurrence threshold before marking workflow records as candidates", async () => {
    const harness = await createHarness("suggest");
    const turn = {
      ...turnBase(),
      userText: "Run the release checks for package.json",
      selectedSkill: undefined,
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    };

    const first = await harness.manager.observeTurn(turn);
    const second = await harness.manager.observeTurn({
      ...turn,
      sessionId: "session-2"
    });

    expect(first?.action).toBe("observed");
    expect(second?.action).toBe("candidate");
    expect(second?.record).toEqual(expect.objectContaining({
      status: "candidate",
      occurrences: 2
    }));
    expect(second?.candidate).toEqual(expect.objectContaining({
      suggestedTarget: "skill_create"
    }));
  });

  it("prefers consolidation before creating new skills when repeated misses overlap route candidates", async () => {
    const harness = await createHarness("suggest");
    const turn = {
      ...turnBase(),
      userText: "Run the release checks for package.json",
      selectedSkill: undefined,
      candidatesShown: ["release-skill"],
      agentEvolutionPolicy: harness.policy,
      toolExecutions: [execution("shell"), execution("file.read")]
    };

    await harness.manager.observeTurn(turn);
    const second = await harness.manager.observeTurn({
      ...turn,
      sessionId: "session-2"
    });

    expect(second?.action).toBe("candidate");
    expect(second?.candidate).toEqual(expect.objectContaining({
      suggestedTarget: "skill_consolidation"
    }));
  });
});

async function createHarness(mode: "none" | "suggest" | "proactive" | "autonomous"): Promise<{
  manager: SkillLearningManager;
  skillEvolutionStore: SkillEvolutionStore;
  localSkillsRoot: string;
  storePath: string;
  policy: AgentEvolutionPolicy;
  events: SessionEvent[];
}> {
  const root = await makeTempDir();
  const localSkillsRoot = join(root, "skills");
  const storePath = join(root, "skill-learning.json");
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const events: SessionEvent[] = [];
  const manager = new SkillLearningManager({
    autonomy: mode,
    registry: new SkillRegistry(),
    localSkillsRoot,
    storePath,
    sessionDb: fakeSessionDb(events),
    skillEvolutionStore
  });
  return {
    manager,
    skillEvolutionStore,
    localSkillsRoot,
    storePath,
    policy: deriveAgentEvolutionPolicy(mode),
    events
  };
}

async function seedSkillLearningStore(storePath: string, records: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, "utf8");
}

function record(key: string): Record<string, unknown> {
  return {
    key,
    name: "Run Release Checks workflow",
    content: "Reusable workflow: Run the release checks",
    occurrences: 1,
    sourceSessionIds: ["session"],
    tools: ["shell", "file.read"],
    requiredToolsets: ["shell-write"],
    bounded: true,
    status: "observed",
    updatedAt: "2026-06-17T00:00:00.000Z"
  };
}

function turnBase(): {
  profileId: string;
  sessionId: string;
  userText: string;
} {
  return {
    profileId: "profile",
    sessionId: "session",
    userText: "Run the release checks"
  };
}

function skill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    version: "0.1.0",
    whenToUse: ["release checks"],
    requiredToolsets: ["files"],
    playbook: [],
    permissionExpectations: ["auto-read"],
    examples: [],
    evaluations: []
  };
}

function execution(name: string): ToolExecutionRecord {
  return {
    tool: {
      name,
      description: name,
      inputSchema: {},
      riskClass: "workspace-write",
      toolsets: ["shell-write"],
      progressLabel: name,
      maxResultSizeChars: 1_000
    } satisfies ToolDefinition,
    decision: "allow",
    riskClass: "workspace-write",
    result: {
      ok: true,
      content: "ok"
    }
  };
}

function fakeSessionDb(events: SessionEvent[]): SessionDB {
  return {
    appendEvent: async (_sessionId: string, event: SessionEvent) => {
      events.push(event);
    }
  } as unknown as SessionDB;
}

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      suggestedTarget: "skill_create",
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
      suggestedTarget: "skill_patch",
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

  it("routes selected-skill corrections toward routing metadata candidates", async () => {
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
      suggestedTarget: "routing_metadata_update"
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
});

async function createHarness(mode: "none" | "suggest" | "proactive" | "autonomous"): Promise<{
  manager: SkillLearningManager;
  skillEvolutionStore: SkillEvolutionStore;
  localSkillsRoot: string;
  policy: AgentEvolutionPolicy;
  events: SessionEvent[];
}> {
  const root = await makeTempDir();
  const localSkillsRoot = join(root, "skills");
  const skillEvolutionStore = new SkillEvolutionStore({
    usagePath: join(localSkillsRoot, ".usage.json"),
    evolutionRoot: join(localSkillsRoot, ".evolution")
  });
  const events: SessionEvent[] = [];
  const manager = new SkillLearningManager({
    autonomy: mode,
    registry: new SkillRegistry(),
    localSkillsRoot,
    storePath: join(root, "skill-learning.json"),
    sessionDb: fakeSessionDb(events),
    skillEvolutionStore
  });
  return {
    manager,
    skillEvolutionStore,
    localSkillsRoot,
    policy: deriveAgentEvolutionPolicy(mode),
    events
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

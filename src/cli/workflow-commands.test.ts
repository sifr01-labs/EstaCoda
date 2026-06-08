import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowCommand } from "./workflow-commands.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { SQLiteWorkflowStore } from "../workflow/sqlite-workflow-store.js";
import type { SkillDefinition } from "../contracts/skill.js";

describe("workflowCommand begin", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-workflow-command-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("requires an explicit session ID when no runtime session is available", async () => {
    const result = await workflowCommand(cliOptions(tempHome), ["begin", "refactor", "auth"]);

    expect(result).toMatchObject({
      handled: true,
      exitCode: 1
    });
    expect(result.output).toContain("Usage: estacoda workflow begin --session <sessionId> <objective>");
    expect(result.output).toContain("requires an explicit session ID");
  });

  it("creates and starts a workflow run for an explicit session without claiming activation", async () => {
    const sessionDb = await createSQLiteSessionDB({ homeDir: tempHome });
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    sessionDb.close();

    const result = await workflowCommand(cliOptions(tempHome), [
      "begin",
      "--session",
      "session-1",
      "refactor",
      "the",
      "auth",
      "module"
    ]);

    expect(result).toMatchObject({
      handled: true,
      exitCode: 0
    });
    expect(result.output).toContain("Created workflow: ");
    expect(result.output).toContain("Started workflow: ");
    expect(result.output).toContain("Not activated. Use /workflow activate ");
    expect(result.output).not.toContain("Activated workflow:");

    const readDb = await createSQLiteSessionDB({ homeDir: tempHome });
    const store = new SQLiteWorkflowStore({ db: readDb.db });
    const runs = await store.listWorkflowRuns("session-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sessionId: "session-1",
      status: "running",
      metadata: {
        activationReason: "explicit",
        objective: "refactor the auth module"
      }
    });
    const steps = await store.listWorkflowSteps(runs[0].id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      name: "Work on objective",
      description: "Continue the requested work through AgentLoop",
      status: "running",
      maxRetries: 0,
      idempotent: false
    });
    readDb.close();
  });

  it("creates and starts a skill-backed workflow run without claiming activation", async () => {
    const sessionDb = await createSQLiteSessionDB({ homeDir: tempHome });
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    sessionDb.close();

    const result = await workflowCommand(cliOptions(tempHome, {
      resolveSkill: (name: string) => name === "research-skill" ? workflowSkill() : undefined
    }), [
      "begin",
      "--skill",
      "research-skill",
      "--session",
      "session-1",
      "research",
      "the",
      "auth",
      "module"
    ]);

    expect(result).toMatchObject({
      handled: true,
      exitCode: 0
    });
    expect(result.output).toContain("Created workflow: ");
    expect(result.output).toContain("Started workflow: ");
    expect(result.output).toContain("Not activated. Use /workflow activate ");
    expect(result.output).not.toContain("Activated workflow:");

    const readDb = await createSQLiteSessionDB({ homeDir: tempHome });
    const store = new SQLiteWorkflowStore({ db: readDb.db });
    const runs = await store.listWorkflowRuns("session-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sessionId: "session-1",
      status: "running",
      selectedSkill: "research-skill",
      metadata: {
        activationReason: "playbook",
        objective: "research the auth module",
        skillName: "research-skill",
        playbook: {
          source: "skill-playbook",
          skill: "research-skill"
        }
      }
    });
    const steps = await store.listWorkflowSteps(runs[0].id);
    expect(steps.map((step) => step.name)).toEqual(["inspect", "summarize"]);
    expect(steps[0]).toMatchObject({
      status: "running",
      maxRetries: 0,
      idempotent: false
    });
    readDb.close();
  });

  it("reports skill-backed standalone begin unavailable when no runtime skill registry is available", async () => {
    const sessionDb = await createSQLiteSessionDB({ homeDir: tempHome });
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    sessionDb.close();

    const result = await workflowCommand(cliOptions(tempHome), [
      "begin",
      "--skill",
      "research-skill",
      "--session",
      "session-1",
      "research",
      "auth"
    ]);

    expect(result).toMatchObject({
      handled: true,
      exitCode: 1
    });
    expect(result.output).toBe("Skill-backed workflow begin is not available in standalone CLI without a runtime skill registry.");
  });

  it("rejects missing skill values and unknown standalone skills", async () => {
    const sessionDb = await createSQLiteSessionDB({ homeDir: tempHome });
    await sessionDb.createSession({ id: "session-1", profileId: "default" });
    sessionDb.close();

    const missing = await workflowCommand(cliOptions(tempHome), [
      "begin",
      "--skill",
      "--session",
      "session-1",
      "research",
      "auth"
    ]);

    expect(missing).toMatchObject({
      handled: true,
      exitCode: 1
    });
    expect(missing.output).toBe("Usage: estacoda workflow begin --skill <skillName> --session <sessionId> <objective>");

    const unknown = await workflowCommand(cliOptions(tempHome, {
      resolveSkill: () => undefined
    }), [
      "begin",
      "--skill",
      "missing-skill",
      "--session",
      "session-1",
      "research",
      "auth"
    ]);

    expect(unknown).toMatchObject({
      handled: true,
      exitCode: 1
    });
    expect(unknown.output).toBe("Skill not found: missing-skill");
  });

  it("rejects a session ID outside the active profile", async () => {
    const sessionDb = await createSQLiteSessionDB({ homeDir: tempHome });
    await sessionDb.createSession({ id: "session-2", profileId: "other" });
    sessionDb.close();

    const result = await workflowCommand(cliOptions(tempHome), [
      "begin",
      "--session",
      "session-2",
      "refactor",
      "auth"
    ]);

    expect(result).toMatchObject({
      handled: true,
      exitCode: 1
    });
    expect(result.output).toBe("Session not found in active profile: session-2");
  });
});

function cliOptions(homeDir: string, runtime?: { resolveSkill?: (name: string) => SkillDefinition | undefined }) {
  return {
    argv: [],
    workspaceRoot: homeDir,
    homeDir,
    ...(runtime === undefined ? {} : { runtime })
  } as any;
}

function workflowSkill(): SkillDefinition {
  return {
    name: "research-skill",
    description: "Research skill",
    version: "0.1.0",
    whenToUse: ["research"],
    requiredToolsets: ["files"],
    playbook: [
      {
        id: "inspect",
        description: "Inspect the target material",
        toolsets: ["files"],
        fallbackTo: ["summarize"],
        successCriteria: ["source inspected"]
      },
      {
        id: "summarize",
        description: "Summarize the findings",
        successCriteria: ["findings summarized"]
      }
    ],
    permissionExpectations: ["auto-read"],
    examples: [],
    evaluations: []
  };
}

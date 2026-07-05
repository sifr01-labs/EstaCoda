import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { RuntimeRouter } from "./runtime-router.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { IntentRouter } from "./intent-router.js";
import { buildSkillContract } from "../skills/skill-contract.js";
import { PDF_EXTRACTION_CAPABILITY_ID } from "../python-env/capability-registry.js";

function withHomeEnv<T>(env: { HOME?: string; ESTACODA_HOME?: string }, run: () => T): T {
  const previousHome = process.env.HOME;
  const previousEstacodaHome = process.env.ESTACODA_HOME;

  if (env.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = env.HOME;
  }

  if (env.ESTACODA_HOME === undefined) {
    delete process.env.ESTACODA_HOME;
  } else {
    process.env.ESTACODA_HOME = env.ESTACODA_HOME;
  }

  try {
    return run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousEstacodaHome === undefined) {
      delete process.env.ESTACODA_HOME;
    } else {
      process.env.ESTACODA_HOME = previousEstacodaHome;
    }
  }
}

describe("RuntimeRouter", () => {
  it("selects full prompt content for small loaded skills", () => {
    const skill = loadedSkill({
      instructions: "# Small\n\nUse the small skill.",
      resources: [
        { kind: "reference", path: "references/guide.md" },
        { kind: "script", path: "scripts/run.sh" }
      ]
    });
    const router = routerForSkill(skill);

    const result = router.route({ text: "test", channel: "cli" });

    expect(result.selectedSkill).toBe(skill);
    expect(result.selectedSkillPromptContent).toMatchObject({
      contentMode: "full",
      content: skill.instructions,
      truncated: false,
      originalChars: skill.instructions.length,
      referencePaths: ["references/guide.md"],
      scriptPaths: ["scripts/run.sh"]
    });
    expect(result.selectedSkillInstructions).toBe(skill.instructions);
    expect(result.selectedSkillResources).toBe(skill.resources);
    expect("nearbyCandidates" in result).toBe(false);
  });

  it("selects contract prompt content for large loaded skills", () => {
    const skill = loadedSkill({
      name: "large-skill",
      instructions: largeInstructions(["# Large"]),
      resources: [
        { kind: "reference", path: "references/guide.md" },
        { kind: "script", path: "scripts/run.sh" }
      ]
    });
    const contract = buildSkillContract(skill);
    const loaded = { ...skill, contract };
    const router = routerForSkill(loaded);

    const result = router.route({ text: "test", channel: "cli" });

    expect(result.selectedSkillPromptContent).toMatchObject({
      contentMode: "contract",
      content: contract?.summary,
      truncated: true,
      originalChars: loaded.instructions.length,
      referencePaths: ["references/guide.md"],
      scriptPaths: ["scripts/run.sh"],
      loadInstruction: "skill.read({ \"name\": \"large-skill\", \"mode\": \"full\" })"
    });
    expect(result.selectedSkillInstructions).toBe(contract?.summary);
    expect(result.selectedSkillInstructions).not.toBe(loaded.instructions);
    expect(result.selectedSkillResources).toBe(loaded.resources);
  });

  it("leaves prompt content undefined for unloaded skill definitions while preserving setup", () => {
    const skill: SkillDefinition = {
      name: "definition-only",
      description: "Tests unloaded skill routing.",
      version: "0.1.0",
      whenToUse: [],
      requiredToolsets: [],
      requiredEnvironmentVariables: ["MISSING_TEST_ENV"],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };
    const router = routerForSkill(skill);

    const result = router.route({ text: "test", channel: "cli" });

    expect(result.selectedSkill).toBe(skill);
    expect(result.selectedSkillPromptContent).toBeUndefined();
    expect(result.selectedSkillInstructions).toBeUndefined();
    expect(result.selectedSkillResources).toBeUndefined();
    expect(result.selectedSkillSetup?.requiredEnvironmentVariables).toEqual([
      { name: "MISSING_TEST_ENV", present: false }
    ]);
  });

  it("expands credential-file tilde paths with OS home, not ESTACODA_HOME", () => {
    const skill: SkillDefinition = {
      name: "credential-test",
      description: "Tests credential path expansion.",
      version: "0.1.0",
      whenToUse: [],
      requiredToolsets: [],
      requiredCredentialFiles: ["~/credentials.json"],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };
    const route: IntentRoute = {
      nativeIntent: "general",
      labels: ["general"],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [skill],
      confirmationRequired: false,
      evidence: [],
      rationale: "test"
    };
    const intentRouter = {
      route: () => route
    } as unknown as IntentRouter;
    const router = new RuntimeRouter({
      intentRouter,
      skillConfig: {}
    });

    const result = withHomeEnv({
      HOME: "/tmp/prod-home",
      ESTACODA_HOME: "/tmp/dev-home"
    }, () => router.route({ text: "test", channel: "cli" }));

    expect(result.selectedSkillSetup?.requiredCredentialFiles[0]?.resolvedPath)
      .toBe(join("/tmp/prod-home", "credentials.json"));
  });

  it("includes Python capability setup state for selected skills", () => {
    const skill: SkillDefinition = {
      name: "pdf-work",
      description: "Tests Python capability setup.",
      version: "0.1.0",
      whenToUse: [],
      requiredToolsets: [],
      pythonCapabilities: [{ id: PDF_EXTRACTION_CAPABILITY_ID, required: true, groups: [] }],
      pythonCapabilitySetup: [{
        id: PDF_EXTRACTION_CAPABILITY_ID,
        required: true,
        groups: [],
        status: "unavailable",
        reason: "install_required",
        message: "Managed Python capability environment has not been installed.",
        repairCommand: "estacoda python-env setup pdf-extraction"
      }],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };
    const router = routerForSkill(skill);

    const result = router.route({ text: "extract this pdf", channel: "telegram" });

    expect(result.selectedSkillSetup?.pythonCapabilities).toEqual([
      expect.objectContaining({
        id: PDF_EXTRACTION_CAPABILITY_ID,
        required: true,
        groups: [],
        status: "unavailable",
        reason: "install_required",
        repairCommand: "estacoda python-env setup pdf-extraction",
        packages: ["pymupdf==1.27.2.3", "pymupdf4llm==1.27.2.3"],
        estimatedInstallSizeMb: 120
      })
    ]);
  });
});

function routerForSkill(skill: LoadedSkill | SkillDefinition): RuntimeRouter {
  const route: IntentRoute = {
    nativeIntent: "general",
    labels: ["general"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [skill],
    confirmationRequired: false,
    evidence: [],
    rationale: "test"
  };
  const intentRouter = {
    route: () => route
  } as unknown as IntentRouter;
  return new RuntimeRouter({
    intentRouter,
    skillConfig: {}
  });
}

function loadedSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: "loaded-skill",
    description: "A loaded test skill.",
    version: "0.1.0",
    whenToUse: [],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: [],
    sourcePath: "/tmp/loaded-skill/SKILL.md",
    sourceKind: "local",
    sourceRoot: "/tmp",
    instructions: "# Loaded\n\nUse the loaded skill.",
    ...overrides
  };
}

function largeInstructions(prefixLines: string[]): string {
  return [...prefixLines, "Detailed instructions.\n".repeat(420)].join("\n");
}

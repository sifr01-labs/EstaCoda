import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_ONBOARDING_STEP_IDS,
  advanceFirstRunOnboardingState,
  buildFirstRunOnboardingPlan,
  createFirstRunOnboardingState,
  getActiveFirstRunSteps,
  getNextFirstRunStepId,
  getRequiredCredentialReference,
  type FirstRunOnboardingStep,
} from "./first-run-plan.js";

function step(plan: ReturnType<typeof buildFirstRunOnboardingPlan>, id: FirstRunOnboardingStep["id"]): FirstRunOnboardingStep {
  const match = plan.steps.find((candidate) => candidate.id === id);
  if (match === undefined) {
    throw new Error(`Missing step ${id}`);
  }
  return match;
}

describe("first-run onboarding plan", () => {
  it("includes the expected default new-user steps", () => {
    const plan = buildFirstRunOnboardingPlan();

    expect(plan.kind).toBe("first-run-onboarding-plan");
    expect(plan.steps.map((candidate) => candidate.id)).toEqual([...FIRST_RUN_ONBOARDING_STEP_IDS]);
    expect(plan.steps.every((candidate) => candidate.copyKey.startsWith("onboarding."))).toBe(true);
    expect(step(plan, "save").sensitiveSurface).toBe("config-write");
    expect(step(plan, "save").outputs[0]?.kind).toBe("config-draft");
  });

  it("keeps the language picker early in the flow", () => {
    const plan = buildFirstRunOnboardingPlan();
    const languageIndex = plan.steps.findIndex((candidate) => candidate.id === "interface-language");

    expect(languageIndex).toBe(1);
    expect(languageIndex).toBeLessThan(plan.steps.findIndex((candidate) => candidate.id === "workspace-root"));
    expect(languageIndex).toBeLessThan(plan.steps.findIndex((candidate) => candidate.id === "primary-provider"));
  });

  it("switches subsequent onboarding copy context to Arabic after selecting Arabic", () => {
    const plan = buildFirstRunOnboardingPlan({ selections: { language: "ar" } });

    expect(plan.copyLocale).toBe("ar");
    expect(step(plan, "welcome").copyLocale).toBe("en");
    expect(step(plan, "interface-language").copyLocale).toBe("en");
    expect(step(plan, "workspace-root").copyLocale).toBe("ar");
    expect(step(plan, "primary-provider").copyLocale).toBe("ar");
  });

  it("skips hosted credential collection for local provider", () => {
    const plan = buildFirstRunOnboardingPlan({
      selections: { primaryProvider: "local", primaryModel: "ollama/auto" },
    });

    expect(getActiveFirstRunSteps(plan).map((candidate) => candidate.id)).not.toContain("primary-credential");
    expect(getNextFirstRunStepId(plan, "primary-model")).toBe("security-mode");
    expect(getRequiredCredentialReference(plan.selections)).toBeUndefined();
    expect(plan.selections.primaryCredential).toEqual({ kind: "none" });
  });

  it("requires hosted provider credentials but does not invent env-var policy locally", () => {
    const plan = buildFirstRunOnboardingPlan({
      selections: { primaryProvider: "openai", primaryModel: "gpt-4.1-mini" },
    });
    const credential = step(plan, "primary-credential");

    expect(getActiveFirstRunSteps(plan).map((candidate) => candidate.id)).toContain("primary-credential");
    expect(credential.required).toBe(true);
    expect(credential.inputs[0]?.required).toBe(true);
    expect(credential.validation).toContainEqual({
      id: "hosted-provider-credential-reference",
      required: true,
      copyKey: "onboarding.providers.primaryCredential.validation.reference",
    });
    expect(getRequiredCredentialReference(plan.selections)).toBeUndefined();
    expect(getRequiredCredentialReference({
      ...plan.selections,
      primaryCredential: { kind: "env", name: "SHARED_FLOW_KEY" },
    })).toEqual({ kind: "env", name: "SHARED_FLOW_KEY" });
  });

  it("keeps workspace trust explicit", () => {
    const trust = step(buildFirstRunOnboardingPlan(), "workspace-trust");

    expect(trust.required).toBe(true);
    expect(trust.sensitiveSurface).toBe("workspace-trust");
    expect(trust.inputs).toContainEqual({
      id: "workspaceTrusted",
      kind: "boolean",
      required: true,
      sensitiveSurface: "workspace-trust",
    });
    expect(trust.validation[0]?.id).toBe("workspace-trust-explicit");
  });

  it("allows optional capabilities to be skipped without degrading core setup", () => {
    const plan = buildFirstRunOnboardingPlan({
      selections: { optionalCapabilities: [], optionalCapabilitiesSkipped: true },
    });
    const optional = step(plan, "optional-capabilities");

    expect(optional.required).toBe(false);
    expect(optional.validation[0]).toEqual({
      id: "optional-capabilities-independently-skippable",
      required: false,
      copyKey: "onboarding.optionalCapabilities.validation.skippable",
    });
    expect(getNextFirstRunStepId(plan, "optional-capabilities")).toBe("review");
  });

  it("does not reintroduce the removed backupForMain path", () => {
    const defaultPlan = buildFirstRunOnboardingPlan();

    expect(JSON.stringify(defaultPlan)).not.toContain("backupForMain");
    expect(JSON.stringify(defaultPlan)).not.toContain("backup-provider");
    expect(JSON.stringify(defaultPlan)).not.toContain("model.fallbacks");
  });

  it("keeps the plan layer free of terminal rendering fields", () => {
    const plan = buildFirstRunOnboardingPlan({ selections: { language: "ar", primaryProvider: "kimi" } });
    const json = JSON.stringify(plan);

    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Use ↑/↓");
    expect(json).not.toContain("Press Enter");
    for (const candidate of plan.steps) {
      expect("title" in candidate).toBe(false);
      expect("body" in candidate).toBe(false);
      expect("render" in candidate).toBe(false);
    }
  });

  it("advances through active steps as a pure state machine", () => {
    const initial = createFirstRunOnboardingState({ primaryProvider: "local" }, "primary-model");
    const next = advanceFirstRunOnboardingState(initial);

    expect(next.currentStepId).toBe("security-mode");
    expect(next.selections).toEqual({ primaryProvider: "local", primaryCredential: { kind: "none" } });
    expect(initial.currentStepId).toBe("primary-model");
  });

  it("does not mutate config or create state files during plan construction", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-first-run-plan-"));

    buildFirstRunOnboardingPlan({
      selections: {
        language: "ar",
        primaryProvider: "openai",
        primaryModel: "gpt-4.1-mini",
      },
    });

    expect(existsSync(join(homeDir, ".estacoda"))).toBe(false);
  });
});

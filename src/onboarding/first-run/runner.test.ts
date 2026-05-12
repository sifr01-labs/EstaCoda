import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/readline-prompt.js";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import type { ProviderId } from "../../contracts/provider.js";
import { resolveSetupCopy } from "../setup-copy.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { runFirstRunSetup, type FirstRunCatalog } from "./runner.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-first-run-runner-"));
}

function catalog(): FirstRunCatalog {
  return {
    listProviders: async () => [
      {
        id: "local",
        label: "Local",
        description: "Local OpenAI-compatible provider.",
        requiresCredential: false,
      },
      {
        id: "openai",
        label: "OpenAI",
        description: "Hosted OpenAI provider.",
        requiresCredential: true,
      },
    ],
    listModels: async (provider: ProviderId) => provider === "local"
      ? [{ provider, id: "hermes-local", label: "hermes-local" }]
      : [{ provider, id: "gpt-5.5", label: "gpt-5.5" }],
  };
}

function fakePrompt(overrides: Record<string, string | boolean> = {}): Prompt {
  const prompt = Object.assign(
    async () => "",
    {
      select: async <T>(input: SelectPromptInput<T>): Promise<T> => {
        const requested = overrides[input.title];
        const byLabel = typeof requested === "string"
          ? input.options.find((option) => option.label === requested)
          : undefined;
        const byValue = input.options.find((option) => Object.is(option.value, requested));
        return (byLabel ?? byValue ?? input.options[input.defaultIndex ?? 0] ?? input.options[0])!.value;
      },
      onboardingCard: () => undefined,
      close: () => undefined,
    }
  );
  return prompt as Prompt;
}

describe("runFirstRunSetup", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("builds a dry-run apply plan for local first-run setup without writing config or trust state", async () => {
    const output: string[] = [];

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      catalog: catalog(),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.state.kind).toBe("new-user");
    expect(result.selections.primaryProvider).toBe("local");
    expect(result.selections.primaryCredential).toEqual({ kind: "none" });
    expect(result.reviewManifest.sections["workspace-trust-grants"]).toHaveLength(1);
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    if (result.applyPlanningResult.kind === "apply-plan-ready") {
      expect(result.applyPlanningResult.applyPlan.dryRunOnly).toBe(true);
      expect(result.applyPlanningResult.applyPlan.writesConfig).toBe(false);
      expect(result.applyPlanningResult.applyPlan.writesTrustStore).toBe(false);
      expect(result.applyPlanningResult.applyPlan.metadata.credentialOperationCount).toBe(0);
      expect(result.applyPlanningResult.applyPlan.metadata.trustOperationCount).toBe(1);
    }
    expect(output.join("")).toContain(resolveSetupCopy("en", "setupReview.title"));
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")).rejects.toThrow();
  });

  it("stores only hosted provider credential references in review data", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }),
      catalog: catalog(),
    });

    expect(result.selections.primaryProvider).toBe("openai");
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(result.reviewManifest.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(JSON.stringify(result.reviewManifest)).toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-");
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    if (result.applyPlanningResult.kind === "apply-plan-ready") {
      expect(result.applyPlanningResult.applyPlan.metadata.credentialOperationCount).toBe(1);
    }
  });

  it("cancels cleanly after review without preparing an apply plan", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      catalog: catalog(),
      prompt: fakePrompt(),
      defaultSelections: { reviewAccepted: false },
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.selections.reviewAccepted).toBe(false);
    expect(result.applyPlanningResult.kind).toBe("cancelled");
    expect(result.output).toContain("cancelled");
  });

  it("lets real prompts select optional capabilities independently", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ Telegram: true, Browser: true }),
      catalog: catalog(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["channels", "browser"]);
    expect(result.reviewManifest.sections["enabled-optional-capabilities"]).toHaveLength(1);
    expect(JSON.stringify(result.reviewManifest)).toContain("channels");
    expect(JSON.stringify(result.reviewManifest)).toContain("browser");
  });

  it("renders Arabic review text from setup copy tokens", async () => {
    const output: string[] = [];

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Setup language": "العربية" }),
      catalog: catalog(),
      output: { write: (value) => output.push(value) },
    });

    const rendered = output.join("");
    expect(rendered).toContain(resolveSetupCopy("ar", "setupReview.title"));
    expect(rendered).toContain(resolveSetupCopy("ar", "setupReview.sections.securityMode"));
    expect(rendered).not.toContain("Files to write/update");
  });

  it("can execute the reviewed apply plan when an executor is provided", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      catalog: catalog(),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => ({
          stateWritable: true,
          envFilePresent: false,
          envFileSecure: true,
          workspaceTrusted: true,
          securityModeLabel: "Adaptive",
          securityModeValue: "adaptive",
          skillAutonomyLabel: "Suggest",
          skillAutonomyValue: "suggest",
          providerDiagnostic: {
            status: "ready",
            lines: ["Provider status: ready"],
            warnings: [],
          },
          toolStatus: "skipped",
          configSources: [],
          warnings: [],
          issueCodes: [],
        }),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
      model?: { provider?: string; id?: string };
    };
    expect(config.model).toEqual({ provider: "local", id: "hermes-local" });
  });
});

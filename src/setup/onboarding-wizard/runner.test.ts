import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/readline-prompt.js";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../../contracts/provider.js";
import { resolveSetupCopy } from "../setup-copy.js";
import {
  setupProviderCredentialQuestion,
  setupTelegramAllowedChatIdsQuestion,
  setupTelegramAllowedUserIdsQuestion,
  setupTelegramBotTokenQuestion,
} from "../setup-prompts.js";
import { isolateLtr } from "../../ui/bidi.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { runFirstRunSetup } from "./runner.js";
import { promptModelCandidate, promptProviderCandidate } from "../config-editor/prompts.js";
import type { FlowEngine, ModelCandidate, ProviderCandidate } from "../../providers/provider-model-selection-flow.js";
import { readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";
import type { SetupApplyExecutor } from "../setup-apply-plan.js";
import {
  gatewayServiceActivationNotNowGuidance,
  gatewayServiceActivationPromptTitle,
  maybeOfferGatewayStartAfterChannelSetup,
  type GatewayActivationServiceActions,
} from "../gateway-service-activation.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-first-run-runner-"));
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

function profileEnvPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).envPath;
}

function activeProfilePath(homeDir: string): string {
  return resolveGlobalStateHome({ homeDir }).activeProfilePath;
}

function localReadyConfigObject(): Record<string, unknown> {
  return {
    model: {
      provider: "local",
      id: "hermes-local",
    },
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        models: ["hermes-local"],
        enableNetwork: true,
      },
    },
  };
}

function flowEngine(overrides: {
  credentialAction?: "collect" | "reuse" | "none";
  baseUrl?: string;
  contextWindowTokens?: number;
  envVarName?: string;
  providerCandidates?: ProviderCandidate[];
} = {}): FlowEngine {
  const action = overrides.credentialAction ?? "collect";
  const envVarName = overrides.envVarName ?? "OPENAI_API_KEY";
  return {
    listProviderCandidates: async () => overrides.providerCandidates ?? [
      {
        id: "local" as ProviderId,
        displayName: "Local",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: 1,
        credentialReady: true,
      },
      {
        id: "openai" as ProviderId,
        displayName: "OpenAI",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: 5,
        credentialReady: action === "reuse",
      },
    ],
    listModelCandidates: async (providerId: ProviderId) => providerId === "local"
      ? [{
          id: "hermes-local",
          provider: providerId,
          profile: {
            id: "hermes-local",
            provider: providerId,
            supportsTools: false,
            supportsVision: false,
            supportsReasoning: false,
            supportsStructuredOutput: false,
            contextWindowTokens: 8192,
          },
          configured: true,
          executable: true,
          catalogOnly: false,
          supportsVision: false,
        }]
      : [{
          id: "gpt-5.5",
          provider: providerId,
          profile: {
            id: "gpt-5.5",
            provider: providerId,
            supportsTools: true,
            supportsVision: true,
            supportsReasoning: false,
            supportsStructuredOutput: true,
            contextWindowTokens: overrides.contextWindowTokens ?? 128000,
          },
          configured: true,
          executable: true,
          catalogOnly: false,
          supportsVision: true,
        }],
    resolveSelection: async (providerId: ProviderId, modelId: string) => {
      if (providerId === "local") {
        return {
          kind: "selected" as const,
          provider: providerId,
          model: modelId,
          baseUrl: overrides.baseUrl,
          apiMode: "custom_openai_compatible" as ProviderApiMode,
          authMethod: "none" as ProviderAuthMethod,
          credentialAction: { kind: "none" as const },
          profile: {
            id: modelId,
            provider: providerId,
            supportsTools: false,
            supportsVision: false,
            supportsReasoning: false,
            supportsStructuredOutput: false,
            contextWindowTokens: 8192,
          },
        };
      }
      if (action === "reuse") {
        return {
          kind: "selected" as const,
          provider: providerId,
          model: modelId,
          baseUrl: overrides.baseUrl ?? "https://api.openai.com/v1",
          apiMode: "custom_openai_compatible" as ProviderApiMode,
          authMethod: "api_key" as ProviderAuthMethod,
          credentialAction: { kind: "reuse" as const, reference: `env:${envVarName}` as `env:${string}` },
          profile: {
            id: modelId,
            provider: providerId,
            supportsTools: true,
            supportsVision: true,
            supportsReasoning: false,
            supportsStructuredOutput: true,
            contextWindowTokens: overrides.contextWindowTokens ?? 128000,
          },
        };
      }
      return {
        kind: "selected" as const,
        provider: providerId,
        model: modelId,
        baseUrl: overrides.baseUrl ?? "https://api.openai.com/v1",
        apiMode: "custom_openai_compatible" as ProviderApiMode,
        authMethod: "api_key" as ProviderAuthMethod,
        credentialAction: { kind: "collect" as const, envVarName },
        profile: {
          id: modelId,
          provider: providerId,
          supportsTools: true,
          supportsVision: true,
          supportsReasoning: false,
          supportsStructuredOutput: true,
          contextWindowTokens: overrides.contextWindowTokens ?? 128000,
        },
      };
    },
  };
}

function modelStatusCandidates(provider: ProviderId): ModelCandidate[] {
  return [
    modelStatusCandidate(provider, "model-alpha", "alpha"),
    modelStatusCandidate(provider, "model-beta", "beta"),
    modelStatusCandidate(provider, "model-deprecated", "deprecated"),
    modelStatusCandidate(provider, "model-unknown", "unknown"),
    modelStatusCandidate(provider, "model-stable", "stable"),
    modelStatusCandidate(provider, "model-missing"),
  ];
}

function modelStatusCandidate(
  provider: ProviderId,
  id: string,
  status?: ModelCandidate["profile"]["status"]
): ModelCandidate {
  return {
    id,
    provider,
    profile: {
      id,
      provider,
      contextWindowTokens: 128000,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsStructuredOutput: true,
      ...(status !== undefined ? { status } : {}),
    },
    configured: true,
    executable: true,
    catalogOnly: false,
    supportsVision: false,
  };
}

type FakePromptOverrideValue = string | boolean | readonly (string | boolean)[];

function fakePrompt(
  overrides: Record<string, FakePromptOverrideValue> = {},
  seenOptions: Record<string, readonly string[]> = {},
  seenDescriptions: Record<string, readonly (string | undefined)[]> = {},
  seenQuestions: { question: string; secret: boolean }[] = []
): Prompt {
  const overrideQueues = new Map<string, (string | boolean)[]>();
  function nextOverride(key: string): string | boolean | undefined {
    const override = overrides[key];
    if (override === undefined || typeof override === "string" || typeof override === "boolean") {
      return override;
    }
    const queue = overrideQueues.get(key) ?? [...override];
    const next = queue.shift();
    overrideQueues.set(key, queue);
    return next;
  }

  const prompt = Object.assign(
    async (question: string, options?: { secret?: boolean }) => {
      seenQuestions.push({ question, secret: options?.secret === true });
      if (options?.secret === true) {
        const secret = nextOverride("__secret");
        return typeof secret === "string" ? secret : "";
      }
      const answer = nextOverride("__prompt");
      return typeof answer === "string" ? answer : "";
    },
    {
      select: async <T>(input: SelectPromptInput<T>): Promise<T> => {
        seenOptions[input.title] = input.options.map((option) => option.label);
        seenDescriptions[input.title] = input.options.map((option) => option.description);
        const requested = nextOverride(input.title);
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

function reviewedExecutor(homeDir: string, workspaceRoot: string, profileId?: string) {
  return createReviewedSetupApplyExecutor({
    homeDir,
    workspaceRoot,
    profileId,
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
  });
}

function gatewayServiceActions(input: {
  readonly installedBefore?: boolean;
  readonly activeAfterInstall?: boolean;
} = {}): GatewayActivationServiceActions {
  const probe = vi.fn<GatewayActivationServiceActions["probe"]>();
  probe.mockResolvedValueOnce({
    kind: "systemd-user",
    installed: input.installedBefore === true,
    activeState: input.installedBefore === true ? "inactive" : undefined,
    profileId: "default",
  });
  probe.mockResolvedValue({
    kind: "systemd-user",
    installed: true,
    activeState: input.activeAfterInstall === true ? "active" : "inactive",
    profileId: "default",
  });
  return {
    probe,
    install: vi.fn<GatewayActivationServiceActions["install"]>().mockResolvedValue({
      ok: true,
      mode: "source",
    }),
    start: vi.fn<GatewayActivationServiceActions["start"]>().mockResolvedValue({
      ok: true,
    }),
  };
}

function remoteControlManifest(channelIds: readonly ("telegram" | "discord" | "whatsapp")[]): SetupReviewManifest {
  const lines = channelIds.map((channelId) => ({
    id: `remote-control-surfaces.setup-module.${channelId}.capability.remote-control`,
    section: "remote-control-surfaces" as const,
    sourceDraftIds: [`setup-module.${channelId}.capability`],
    copyKey: `setupModules.${channelId}.review`,
    summaryKey: `setupModules.${channelId}.draft`,
    riskSurface: "optional-capability" as const,
    review: {
      copyKey: `setupModules.${channelId}.review`,
      summaryKey: `setupModules.${channelId}.draft`,
      redacted: true as const,
      values: {},
    },
    severity: "info" as const,
    blockers: [],
    warnings: [],
    readOnly: false,
  }));
  return {
    kind: "setup-review-manifest",
    sourceBundleIds: ["test"],
    lines,
    sections: {
      "files-to-write-update": [],
      "secret-refs-to-store": [],
      "workspace-trust-grants": [],
      "provider-model-network": [],
      "enabled-optional-capabilities": [],
      "remote-control-surfaces": lines,
      "security-mode": [],
      "workflow-learning": [],
      "verification-checks": [],
      "launch-handoff": [],
      blockers: [],
      warnings: [],
    },
    blockers: [],
    warnings: [],
    safeToReviewForApply: true,
    suppressedNormalWrites: [],
    metadata: {
      bundleCount: 1,
      lineCount: lines.length,
      blockerCount: 0,
      warningCount: 0,
      readOnlyCount: 0,
    },
  };
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
    delete process.env.ESTACODA_TELEGRAM_BOT_TOKEN;
    delete process.env.ESTACODA_DISCORD_BOT_TOKEN;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("builds a dry-run apply plan for local first-run setup while silently preparing default profile state", async () => {
    const output: string[] = [];

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.state.kind).toBe("new-user");
    expect(result.selections.primaryProvider).toBe("local");
    expect(result.selections.primaryCredential).toEqual({ kind: "none" });
    expect(result.selections.primaryApiMode).toBe("custom_openai_compatible");
    expect(result.selections.primaryAuthMethod).toBe("none");
    expect(result.wizardState.primaryRoute).toEqual(expect.objectContaining({
      provider: "local",
      model: "hermes-local",
    }));
    expect(result.draftBundle.sourceKind).toBe("onboarding-wizard-state");
    expect(result.reviewManifest.sections["workspace-trust-grants"]).toHaveLength(1);
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    if (result.applyPlanningResult.kind === "apply-plan-ready") {
      expect(result.applyPlanningResult.applyPlan.dryRunOnly).toBe(true);
      expect(result.applyPlanningResult.applyPlan.writesConfig).toBe(false);
      expect(result.applyPlanningResult.applyPlan.writesTrustStore).toBe(false);
      expect(result.applyPlanningResult.applyPlan.metadata.credentialOperationCount).toBe(0);
      expect(result.applyPlanningResult.applyPlan.metadata.trustOperationCount).toBe(1);
    }
    const renderedOutput = output.join("");
    expect(renderedOutput).toContain("Configuration summary");
    expect(renderedOutput).toContain(`Workspace: ${result.selections.workspaceRoot}`);
    expect(renderedOutput).toContain("Primary Provider: local");
    expect(renderedOutput).not.toContain(resolveSetupCopy("en", "setupReview.title"));
    expect(renderedOutput).not.toContain(resolveSetupCopy("en", "setupReview.sections.filesToWriteUpdate"));
    expect(renderedOutput).not.toContain(resolveSetupCopy("en", "setupReview.sections.secretRefsToStore"));
    expect(renderedOutput).not.toMatch(/\bprofiles?\b/iu);
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("default");
    await expect(readFile(activeProfilePath(tempDir), "utf8")).resolves.toContain("\"profileId\": \"default\"");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toContain("\"provider\": \"unconfigured\"");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    await expect(readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")).rejects.toThrow();
  });

  it("blocks a missing workspace path before the trust prompt", async () => {
    const missingWorkspace = join(tempDir, "missing-workspace");
    const seenOptions: Record<string, readonly string[]> = {};

    await expect(runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace path unavailable": "Cancel setup",
      }, seenOptions),
      flowEngine: flowEngine(),
      defaultSelections: {
        workspaceRoot: missingWorkspace,
      },
    })).rejects.toThrow("Setup cancelled during workspace selection.");

    expect(existsSync(missingWorkspace)).toBe(false);
    expect(seenOptions["Workspace path unavailable"]).toEqual([
      "Try again",
      "Use current workspace",
      "Cancel setup",
    ]);
    expect(seenOptions["Workspace trust"]).toBeUndefined();
  });

  it("blocks a non-directory workspace path before the trust prompt", async () => {
    const filePath = join(tempDir, "not-a-directory.txt");
    await writeFile(filePath, "not a workspace\n", "utf8");
    const seenOptions: Record<string, readonly string[]> = {};

    await expect(runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace path unavailable": "Cancel setup",
      }, seenOptions),
      flowEngine: flowEngine(),
      defaultSelections: {
        workspaceRoot: filePath,
      },
    })).rejects.toThrow("Setup cancelled during workspace selection.");

    expect(seenOptions["Workspace trust"]).toBeUndefined();
  });

  it("uses the canonical workspace path in selections and trust drafts", async () => {
    const nonCanonicalWorkspace = join(workspaceRoot, "..", "workspace");
    const canonicalWorkspace = await realpath(workspaceRoot);

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot: nonCanonicalWorkspace,
      prompt: fakePrompt(),
      flowEngine: flowEngine(),
    });

    expect(result.selections.workspaceRoot).toBe(canonicalWorkspace);
    const trustDraft = result.draftBundle.drafts.find((draft) => draft.kind === "workspace-trust");
    expect(trustDraft?.target).toEqual({
      kind: "trust-store",
      workspaceRoot: canonicalWorkspace,
      trustStorePath: join(tempDir, ".estacoda", "trust.json"),
    });
    expect(JSON.stringify(result.reviewManifest)).toContain(canonicalWorkspace);
  });

  it("lets Change Workspace loop back to workspace selection", async () => {
    const secondWorkspace = join(tempDir, "second-workspace");
    await mkdir(secondWorkspace, { recursive: true });

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace trust": ["Change Workspace", "Trust"],
        __prompt: ["", secondWorkspace],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.workspaceRoot).toBe(await realpath(secondWorkspace));
    expect(result.selections.workspaceTrusted).toBe(true);
  });

  it("lets Decide Later save config without ready or complete wording", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace trust": "Decide Later",
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.selections.workspaceTrusted).toBe(false);
    expect(result.reviewManifest.sections["workspace-trust-grants"]).toHaveLength(0);
    expect(result.output).toBe("Setup saved. Workspace trust is still required before EstaCoda can run here.");
    expect(result.output).not.toContain("Setup complete");
    expect(result.output).not.toContain("Setup is ready");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toContain("\"provider\": \"local\"");
    await expect(readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")).rejects.toThrow();
  });

  it("does not treat deferred workspace trust as launch-ready", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace trust": "Decide Later",
      }, seenOptions),
      flowEngine: flowEngine(),
      defaultSelections: {
        workspaceTrusted: false,
      },
    });

    expect(result.selections.workspaceTrusted).toBe(false);
    expect(result.launchRequested).toBeUndefined();
    expect(seenOptions["Start EstaCoda now?"]).toBeUndefined();
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    if (result.applyPlanningResult.kind === "apply-plan-ready") {
      expect(result.applyPlanningResult.applyPlan.launchHandoffIntent).toBeUndefined();
    }
  });

  it("returns a launch request after successful setup when the user chooses Yes", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Start EstaCoda now?": "Yes" }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.launchRequested).toBe(true);
    expect(result.applyEndState?.kind).toBe("verified-ready");
  });

  it("does not return a launch request after successful setup when the user chooses No", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Start EstaCoda now?": "No" }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.launchRequested).toBe(false);
    expect(result.applyEndState?.kind).toBe("verified-ready");
  });

  it("does not offer launch when apply succeeds without verification", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Start EstaCoda now?": "Yes" }, seenOptions),
      flowEngine: flowEngine(),
      applyExecutor: {
        apply: () => ({
          ok: true,
          appliedOperationIds: [],
        }),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    if (result.applyEndState?.kind === "saved-not-launched") {
      expect(result.applyEndState.verification).toBeUndefined();
    }
    expect(result.launchRequested).toBeUndefined();
    expect(seenOptions["Start EstaCoda now?"]).toBeUndefined();
  });

  it("does not offer launch after degraded verification", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Start EstaCoda now?": "Yes" }, seenOptions),
      flowEngine: flowEngine(),
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
            status: "warning",
            lines: ["Provider status: warning"],
            warnings: ["Provider has warnings"],
          },
          toolStatus: "skipped",
          configSources: [],
          warnings: ["Provider has warnings"],
          issueCodes: [],
        }),
      }),
    });

    expect(result.applyEndState?.kind).toBe("verified-degraded");
    expect(result.launchRequested).toBeUndefined();
    expect(seenOptions["Start EstaCoda now?"]).toBeUndefined();
  });

  it("stores only hosted provider credential references in review data", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.primaryProvider).toBe("openai");
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(result.wizardState.credential).toEqual({
      status: "not_set",
      envVarName: "OPENAI_API_KEY",
    });
    expect(result.selections.primaryBaseUrl).toBe("https://api.openai.com/v1");
    expect(result.selections.primaryApiMode).toBe("custom_openai_compatible");
    expect(result.selections.primaryAuthMethod).toBe("api_key");
    expect(result.reviewManifest.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(JSON.stringify(result.reviewManifest)).toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-");
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    if (result.applyPlanningResult.kind === "apply-plan-ready") {
      expect(result.applyPlanningResult.applyPlan.metadata.credentialOperationCount).toBe(1);
    }
  });

  it("uses the shared flow credential action instead of first-run default env policy", async () => {
    const outputLines: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "" }),
      flowEngine: flowEngine({ envVarName: "SHARED_FLOW_OPENAI_KEY" }),
      output: { write: (value) => outputLines.push(value) },
    });

    expect(result.selections.primaryProvider).toBe("openai");
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "SHARED_FLOW_OPENAI_KEY" });
    expect(result.draftBundle.sourceKind).toBe("onboarding-wizard-state");
    expect(JSON.stringify(result.reviewManifest)).toContain("SHARED_FLOW_OPENAI_KEY");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("OPENAI_API_KEY");
    expect(outputLines.join("")).toContain("Config will expect SHARED_FLOW_OPENAI_KEY to be available externally");
  });

  it("uses shared setup editor copy for the English provider credential prompt", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "" }, {}, {}, seenQuestions),
      flowEngine: flowEngine(),
    });

    expect(seenQuestions).toContainEqual({
      question: setupProviderCredentialQuestion("en", {
        providerName: "OpenAI",
        envVarName: "OPENAI_API_KEY",
      }),
      secret: true,
    });
  });

  it("uses shared setup editor copy for the Arabic provider credential prompt", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Setup language": "العربية",
        [resolveSetupCopy("ar", "onboarding.providers.primary.title")]: "OpenAI",
        __secret: "sk-arabic-secret",
      }, {}, {}, seenQuestions),
      flowEngine: flowEngine(),
    });
    const expectedQuestion = setupProviderCredentialQuestion("ar", {
      providerName: "OpenAI",
      envVarName: "OPENAI_API_KEY",
    });

    expect(seenQuestions).toContainEqual({ question: expectedQuestion, secret: true });
    expect(expectedQuestion).toContain(isolateLtr("OpenAI"));
    expect(expectedQuestion).toContain(isolateLtr("OPENAI_API_KEY"));
    expect(JSON.stringify(result)).not.toContain("sk-arabic-secret");
    expect(JSON.stringify(result)).not.toContain("\u2066");
    expect(JSON.stringify(result)).not.toContain("\u2069");
  });

  it("uses shared setup editor copy for Telegram onboarding prompts", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: ["", "12345", ""],
        __secret: "123456:telegram-token",
      }, {}, {}, seenQuestions),
      flowEngine: flowEngine({ credentialAction: "none" }),
    });

    expect(seenQuestions).toContainEqual({
      question: setupTelegramBotTokenQuestion("en"),
      secret: true,
    });
    expect(seenQuestions).toContainEqual({
      question: setupTelegramAllowedUserIdsQuestion("en"),
      secret: false,
    });
    expect(seenQuestions).toContainEqual({
      question: setupTelegramAllowedChatIdsQuestion("en"),
      secret: false,
    });
  });

  it("uses isolated shared setup editor copy for Arabic Telegram onboarding prompts", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Setup language": "العربية",
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: ["", "12345", ""],
        __secret: "123456:telegram-token",
      }, {}, {}, seenQuestions),
      flowEngine: flowEngine({ credentialAction: "none" }),
    });
    const expectedQuestion = setupTelegramBotTokenQuestion("ar");

    expect(seenQuestions).toContainEqual({ question: expectedQuestion, secret: true });
    expect(expectedQuestion).toContain(isolateLtr("Telegram"));
    expect(setupTelegramAllowedUserIdsQuestion("ar")).toContain(isolateLtr("Telegram"));
    expect(setupTelegramAllowedChatIdsQuestion("ar")).toContain(isolateLtr("Telegram"));
    expect(result.wizardState.optionalCapabilities?.channels?.telegram).toBe("configured");
    expect(JSON.stringify(result.wizardState)).toContain("ESTACODA_TELEGRAM_BOT_TOKEN");
    expect(JSON.stringify(result.wizardState)).not.toContain("\u2066");
    expect(JSON.stringify(result.wizardState)).not.toContain("\u2069");
  });

  it("does not re-add Codex, catalog-only, or media providers filtered out by the shared flow", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": "OpenAI",
        "Optional capabilities": "Yes",
        "Configure optional capability": "Configure voice",
        "Configure other capabilities now": "Skip",
      }, seenOptions),
      flowEngine: flowEngine({
        credentialAction: "reuse",
        providerCandidates: [{
          id: "openai" as ProviderId,
          displayName: "OpenAI",
          catalogOnly: false,
          configurable: true,
          runnable: true,
          modelsCount: 5,
          credentialReady: true,
          baseUrl: "https://api.openai.com/v1",
        }],
      }),
      defaultSelections: {
        primaryProvider: "codex" as ProviderId,
        primaryModel: "codex-catalog-only",
      },
    });

    expect(seenOptions["Primary provider"]).toEqual(["OpenAI"]);
    expect(seenOptions["Primary provider"]).not.toEqual(expect.arrayContaining([
      "Codex",
      "FAL",
      "BytePlus",
      "Voice",
      "Vision and Image Generation",
    ]));
    expect(seenOptions["Configure optional capability"]).toEqual([
      "Configure channels",
      "Configure voice",
      "Configure browser",
      "Skip",
    ]);
    expect(seenOptions["Configure optional capability"]).not.toContain("Configure image generation");
    expect(result.selections.primaryProvider).toBe("openai");
    expect(result.selections.primaryModel).toBe("gpt-5.5");
    expect(result.selections.optionalCapabilities).toEqual(["voice"]);

    const providerDraft = result.draftBundle.drafts.find((draft) => draft.kind === "provider-model-route");
    const optionalDraft = result.draftBundle.drafts.find((draft) => draft.id === "setup-module.voice.capability");
    expect(providerDraft?.review.values.provider).toBe("openai");
    expect(providerDraft?.review.values.model).toBe("gpt-5.5");
    expect(providerDraft?.review.values.provider).not.toBe("codex");
    expect(optionalDraft?.review.values.sttProvider).toBe("openai");
    expect(optionalDraft?.review.values).not.toHaveProperty("ttsProvider");
    expect(result.reviewManifest.sections["provider-model-network"]).toHaveLength(1);
    expect(result.reviewManifest.sections["enabled-optional-capabilities"]).toHaveLength(1);
  });

  it("exposes the same provider candidates as the setup editor provider prompt helper", async () => {
    const providers: ProviderCandidate[] = [
      {
        id: "local" as ProviderId,
        displayName: "Local",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: 1,
        credentialReady: true,
      },
      {
        id: "openai" as ProviderId,
        displayName: "OpenAI",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: 5,
        credentialReady: false,
        baseUrl: "https://api.openai.com/v1",
      },
    ];
    const onboardingOptions: Record<string, readonly string[]> = {};
    const onboardingDescriptions: Record<string, readonly (string | undefined)[]> = {};
    const editorOptions: Record<string, readonly string[]> = {};
    const editorDescriptions: Record<string, readonly (string | undefined)[]> = {};

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({}, onboardingOptions, onboardingDescriptions),
      flowEngine: flowEngine({ providerCandidates: providers }),
    });
    await promptProviderCandidate(fakePrompt({}, editorOptions, editorDescriptions), {
      candidates: providers,
    }, "en");

    expect(onboardingOptions["Primary provider"]).toEqual(editorOptions["Primary provider"]);
    expect(onboardingDescriptions["Primary provider"]).toEqual(editorDescriptions["Primary provider"]);
  });

  it("exposes the same model candidates for a chosen provider as the setup editor model prompt helper", async () => {
    const models = modelStatusCandidates("openai" as ProviderId);
    const onboardingOptions: Record<string, readonly string[]> = {};
    const onboardingDescriptions: Record<string, readonly (string | undefined)[]> = {};
    const editorOptions: Record<string, readonly string[]> = {};
    const editorDescriptions: Record<string, readonly (string | undefined)[]> = {};
    const customFlow: FlowEngine = {
      ...flowEngine({ credentialAction: "reuse" }),
      listProviderCandidates: async () => [{
        id: "openai" as ProviderId,
        displayName: "OpenAI",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: models.length,
        credentialReady: true,
      }],
      listModelCandidates: async () => models,
    };

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }, onboardingOptions, onboardingDescriptions),
      flowEngine: customFlow,
    });
    await promptModelCandidate(fakePrompt({}, editorOptions, editorDescriptions), {
      providerId: "openai",
      candidates: models,
    }, "en");

    expect(onboardingOptions["Primary model"]).toEqual(editorOptions["Primary model"]);
    expect(onboardingDescriptions["Primary model"]).toEqual(editorDescriptions["Primary model"]);
  });

  it("uses the setup editor provider rejection wording when no provider candidates are available", async () => {
    const customFlow: FlowEngine = {
      ...flowEngine(),
      listProviderCandidates: async () => [],
    };

    await expect(runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      flowEngine: customFlow,
    })).rejects.toThrow("No setup-visible provider candidates are available.");
  });

  it("uses the setup editor model rejection wording when no model candidates are available", async () => {
    const customFlow: FlowEngine = {
      ...flowEngine(),
      listProviderCandidates: async () => [{
        id: "openai" as ProviderId,
        displayName: "OpenAI",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: 0,
        credentialReady: false,
      }],
      listModelCandidates: async () => [],
    };

    await expect(runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }),
      flowEngine: customFlow,
    })).rejects.toThrow("No setup-visible models are available for OpenAI.");
  });

  it("renders only actionable model status tags in first-run model choices", async () => {
    const seenDescriptions: Record<string, readonly (string | undefined)[]> = {};
    const baseFlow = flowEngine();
    const customFlow: FlowEngine = {
      ...baseFlow,
      listModelCandidates: async () => modelStatusCandidates("openai" as ProviderId),
    };

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }, {}, seenDescriptions),
      flowEngine: customFlow,
    });

    expect(seenDescriptions["Primary model"]).toEqual([
      "alpha",
      "beta",
      "deprecated",
      "",
      "",
      "",
    ]);
  });

  it("cancels cleanly after review without preparing an apply plan", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      flowEngine: flowEngine(),
      prompt: fakePrompt(),
      defaultSelections: { reviewAccepted: false },
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.selections.reviewAccepted).toBe(false);
    expect(result.applyPlanningResult.kind).toBe("cancelled");
    expect(result.output).toContain("cancelled");
  });

  it("does not write a collected API key when review is cancelled", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      flowEngine: flowEngine(),
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-cancelled-secret" }),
      defaultSelections: { reviewAccepted: false },
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(false);
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("sk-cancelled-secret");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toContain("\"provider\": \"unconfigured\"");
    await expect(readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")).rejects.toThrow();
  });

  it("does not write a collected API key when reviewed apply is blocked before deferred secrets", async () => {
    let deferredSecretCalls = 0;
    const blockingExecutor: SetupApplyExecutor = {
      apply: () => ({
        ok: false,
        appliedOperationIds: [],
        error: "blocked before deferred secrets",
      }),
      applyDeferredSecrets: () => {
        deferredSecretCalls += 1;
        return {
          ok: true,
          appliedSecretCount: 1,
        };
      },
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      flowEngine: flowEngine(),
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-blocked-apply-secret" }),
      applyExecutor: blockingExecutor,
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    expect(result.applyEndState?.kind).toBe("blocked");
    expect(deferredSecretCalls).toBe(0);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    expect(JSON.stringify(result)).not.toContain("sk-blocked-apply-secret");
  });

  it("does not write a collected API key when the apply executor fails before deferred secrets", async () => {
    let deferredSecretCalls = 0;
    const failingExecutor: SetupApplyExecutor = {
      apply: () => ({
        ok: false,
        appliedOperationIds: [],
        error: "intentional apply failure",
      }),
      applyDeferredSecrets: () => {
        deferredSecretCalls += 1;
        return {
          ok: true,
          appliedSecretCount: 1,
        };
      },
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      flowEngine: flowEngine(),
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-apply-failed-secret" }),
      applyExecutor: failingExecutor,
    });

    expect(result.completed).toBe(false);
    expect(result.applyEndState?.kind).toBe("blocked");
    expect(deferredSecretCalls).toBe(0);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    expect(JSON.stringify(result)).not.toContain("sk-apply-failed-secret");
  });

  it("lets real prompts select optional capabilities independently", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Configure channels", "Configure browser"],
        "Configure other capabilities now": ["Yes", "Skip"],
        __prompt: ["", "", "12345", "", "", ""],
        __secret: "",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["channels", "browser"]);
    expect(result.reviewManifest.sections["enabled-optional-capabilities"]).toHaveLength(2);
    expect(result.reviewManifest.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(JSON.stringify(result.reviewManifest)).toContain("channels");
    expect(JSON.stringify(result.reviewManifest)).toContain("telegram");
    expect(JSON.stringify(result.reviewManifest)).toContain("browser");
  });

  it("removes configured onboarding capabilities from the remaining capability menu", async () => {
    const seenOptions: Record<string, readonly string[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Configure browser", "Skip"],
        "Configure other capabilities now": "Yes",
        __prompt: ["", ""],
      }, seenOptions),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(seenOptions["Configure optional capability"]).toEqual([
      "Configure channels",
      "Configure voice",
      "Skip",
    ]);
  });

  it("skips the onboarding optional capability flow cleanly", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Optional capabilities": "No" }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(result.reviewManifest.sections["enabled-optional-capabilities"]).toHaveLength(0);
  });

  it("configures onboarding voice STT without TTS", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Configure voice",
        "Configure other capabilities now": "Skip",
        __prompt: ["", ""],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["voice"]);
    expect(result.wizardState.optionalCapabilities?.voice).toEqual({
      stt: "configured",
      tts: "not_set",
    });
    expect(result.reviewManifest.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttApiKeyEnv: "OPENAI_API_KEY",
    });
    expect(result.reviewManifest.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("ttsProvider");
  });

  it("configures onboarding voice TTS without STT", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Configure voice",
        "Configure voice": "Set Text to Speech (TTS) Provider",
        "Configure other capabilities now": "Skip",
        __prompt: ["", ""],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["voice"]);
    expect(result.wizardState.optionalCapabilities?.voice).toEqual({
      stt: "not_set",
      tts: "configured",
    });
    expect(result.reviewManifest.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "OPENAI_API_KEY",
    });
    expect(result.reviewManifest.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("sttProvider");
  });

  it("normal onboarding confirms the user-facing summary instead of the technical manifest", async () => {
    const output: string[] = [];
    const seenOptions: Record<string, readonly string[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({}, seenOptions),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(seenOptions["Configuration summary"]).toEqual(["Confirm", "Cancel"]);
    expect(seenOptions[resolveSetupCopy("en", "onboarding.review")]).toBeUndefined();

    const rendered = output.join("");
    expect(rendered).toContain("Configuration summary");
    expect(rendered).toContain("Credential status: Not set");
    expect(rendered).not.toContain(resolveSetupCopy("en", "setupReview.title"));
    expect(rendered).not.toContain(resolveSetupCopy("en", "setupReview.sections.filesToWriteUpdate"));
  });

  it("keeps redacted manifest and apply plan inspectable through the runner result", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-inspect-secret" }),
      flowEngine: flowEngine(),
    });

    expect(result.reviewManifest.metadata.lineCount).toBeGreaterThan(0);
    expect(result.reviewManifest.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(result.applyPlanningResult.kind).toBe("apply-plan-ready");
    expect(JSON.stringify(result.reviewManifest)).toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-inspect-secret");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-inspect-secret");
    expect(JSON.stringify(result)).not.toContain("sk-inspect-secret");
  });

  it("renders Arabic summary confirmation without the technical review manifest", async () => {
    const output: string[] = [];
    const seenOptions: Record<string, readonly string[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Setup language": "العربية" }, seenOptions),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });

    const rendered = output.join("");
    expect(result.selections.language).toBe("ar");
    expect(result.selections.interfaceFlavor).toBe("arabic-light");
    expect(result.selections.activityLabels).toBe("ar");
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.interfaceStyle.title")]).toBeUndefined();
    const selectedWorkspaceRoot = result.selections.workspaceRoot;
    expect(selectedWorkspaceRoot).toBeDefined();
    if (selectedWorkspaceRoot === undefined) {
      throw new Error("Expected onboarding to select a workspace root.");
    }
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.summary.confirmTitle")]).toEqual([
      resolveSetupCopy("ar", "onboarding.summary.confirmAction"),
      resolveSetupCopy("ar", "onboarding.summary.cancelAction"),
    ]);
    expect(rendered).toContain("ملخص الإعداد");
    expect(rendered).toContain(`مساحة العمل: ${isolateLtr(selectedWorkspaceRoot)} (موثوقة)`);
    expect(rendered).toContain(`اللغة: ${isolateLtr("ar")}`);
    expect(rendered).toContain("حالة بيانات الاعتماد: غير مهيأ");
    expect(rendered).not.toContain("Configuration summary");
    expect(rendered).not.toContain(resolveSetupCopy("ar", "setupReview.title"));
    expect(rendered).not.toContain(resolveSetupCopy("ar", "setupReview.sections.securityMode"));
    expect(rendered).not.toContain("Files to write/update");
  });

  it("can execute the reviewed apply plan when an executor is provided", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).toBe("verified-ready");
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
    };
    expect(config.model).toEqual({ provider: "local", id: "hermes-local", contextWindowTokens: 8192 });
  });

  it("prompts to install and start the gateway after ready Telegram onboarding before the launch prompt", async () => {
    const actions = gatewayServiceActions();
    const promptOrder: string[] = [];
    const prompt = fakePrompt({
      "Optional capabilities": "Yes",
      "Configure optional capability": "Configure channels",
      [gatewayServiceActivationPromptTitle]: "Yes",
      [resolveSetupCopy("en", "onboarding.launch.startNow")]: "No",
      __prompt: ["", "42", ""],
      __secret: "123456:telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptOrder.push(input.title);
      if (promptOrder.length > 30) {
        throw new Error(`Unexpected prompt loop: ${promptOrder.join(" -> ")}`);
      }
      return baseSelect(input);
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
      kind: "started",
      installed: true,
    }));
    expect(actions.install).toHaveBeenCalledTimes(1);
    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(promptOrder.indexOf(gatewayServiceActivationPromptTitle)).toBeGreaterThan(-1);
    expect(promptOrder.indexOf(gatewayServiceActivationPromptTitle)).toBeLessThan(
      promptOrder.indexOf(resolveSetupCopy("en", "onboarding.launch.startNow"))
    );
    expect(result.output).toContain("Gateway service installed and started for configured Telegram channel.");
    expect(JSON.stringify(result)).not.toContain("123456:telegram-token");
  });

  it("does not install or start when the onboarding gateway prompt is declined", async () => {
    const actions = gatewayServiceActions();

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Configure channels",
        [gatewayServiceActivationPromptTitle]: "Not now",
        [resolveSetupCopy("en", "onboarding.launch.startNow")]: "No",
        __prompt: ["", "42", ""],
        __secret: "123456:telegram-token",
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
      kind: "declined",
      output: gatewayServiceActivationNotNowGuidance,
    }));
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
    expect(result.output).toContain(gatewayServiceActivationNotNowGuidance);
  });

  it("does not offer the onboarding gateway prompt when no channel was configured", async () => {
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      "Optional capabilities": "No",
      [resolveSetupCopy("en", "onboarding.launch.startNow")]: "No",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("renders multiple configured channels without exposing raw secrets", async () => {
    await mkdir(join(tempDir, ".estacoda", "profiles", "default"), { recursive: true });
    await writeFile(profileConfigPath(tempDir), `${JSON.stringify({
      ...localReadyConfigObject(),
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN",
          allowedUserIds: ["42"],
        },
        discord: {
          enabled: true,
          botTokenEnv: "ESTACODA_DISCORD_BOT_TOKEN",
          allowedUsers: ["user-42"],
          allowedChannels: [],
        },
      },
    }, null, 2)}\n`, "utf8");
    process.env.ESTACODA_TELEGRAM_BOT_TOKEN = "telegram-secret-value";
    process.env.ESTACODA_DISCORD_BOT_TOKEN = "discord-secret-value";
    const actions = gatewayServiceActions({ installedBefore: true });

    const result = await maybeOfferGatewayStartAfterChannelSetup({
      prompt: fakePrompt({
        [gatewayServiceActivationPromptTitle]: "Yes",
      }),
      locale: "en",
      homeDir: tempDir,
      workspaceRoot,
      reviewManifest: remoteControlManifest(["telegram", "discord"]),
      readinessGate: true,
      serviceActions: actions,
    });

    expect(result).toEqual({
      kind: "not-offered",
      reason: "gateway-service-already-installed",
    });
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("telegram-secret-value");
    expect(JSON.stringify(result)).not.toContain("discord-secret-value");
  });

  it("does not offer the onboarding gateway prompt when channel configuration is incomplete", async () => {
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      "Optional capabilities": "Yes",
      "Configure optional capability": "Configure channels",
      [resolveSetupCopy("en", "onboarding.launch.startNow")]: "No",
      __prompt: ["", "", ""],
      __secret: "123456:telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("uses the onboarding launch-offerable readiness gate before offering gateway activation", async () => {
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      "Optional capabilities": "Yes",
      "Configure optional capability": "Configure channels",
      __prompt: ["", "42", ""],
      __secret: "123456:telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      flowEngine: flowEngine(),
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
          warnings: ["non-blocking warning"],
          issueCodes: [],
        }),
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.applyEndState?.kind).toBe("verified-degraded");
    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("uses an explicit profile for setup writes without making it active", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      profileId: "research",
      prompt: fakePrompt(),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot, "research"),
    });

    expect(result.completed).toBe(true);
    expect(readActiveProfile({ homeDir: tempDir }).profileId).toBe("default");
    const defaultConfig = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
    };
    const researchConfig = JSON.parse(await readFile(resolveProfileStateHome({ homeDir: tempDir, profileId: "research" }).configPath, "utf8")) as {
      model?: { provider?: string; id?: string };
    };
    expect(defaultConfig.model).toEqual({ provider: "unconfigured", id: "unconfigured" });
    expect(researchConfig.model).toEqual({ provider: "local", id: "hermes-local", contextWindowTokens: 8192 });
  });

  it("keeps collected API key in memory during dry-run first-run", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-fir...7890" }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    expect(JSON.stringify(result)).not.toContain("sk-fir...7890");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-fir...7890");
    expect(JSON.stringify(result.reviewManifest)).toContain("OPENAI_API_KEY");
  });

  it("writes collected API key to .env only after approved reviewed apply", async () => {
    let envFileDuringApply: string | undefined;
    const reviewed = reviewedExecutor(tempDir, workspaceRoot);
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-approved-secret" }),
      flowEngine: flowEngine(),
      applyExecutor: {
        ...reviewed,
        apply: async (plan) => {
          envFileDuringApply = await readFile(profileEnvPath(tempDir), "utf8");
          return reviewed.apply(plan);
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(envFileDuringApply).toBe("");
    const envContent = await readFile(profileEnvPath(tempDir), "utf8");
    expect(envContent).toContain('OPENAI_API_KEY="sk-approved-secret"');
    expect(JSON.stringify(result)).not.toContain("sk-approved-secret");
    expect(JSON.stringify(result.reviewManifest)).toContain("OPENAI_API_KEY");
  });

  it("does not write .env when user skips API key entry", async () => {
    const outputLines: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "" }),
      flowEngine: flowEngine(),
      output: { write: (value) => outputLines.push(value) },
    });

    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    const combined = outputLines.join("");
    expect(combined).toContain("Config will expect OPENAI_API_KEY to be available externally");
  });

  it("carries shared-flow route metadata through first-run review without raw secrets", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }),
      flowEngine: flowEngine({
        baseUrl: "https://custom.example.com/v1",
        contextWindowTokens: 256000,
      }),
    });

    expect(result.selections.primaryProvider).toBe("openai");
    expect(result.selections.primaryModel).toBe("gpt-5.5");
    expect(result.selections.primaryBaseUrl).toBe("https://custom.example.com/v1");
    expect(result.selections.primaryContextWindowTokens).toBe(256000);
    expect(result.selections.primaryApiMode).toBe("custom_openai_compatible");
    expect(result.selections.primaryAuthMethod).toBe("api_key");

    const providerModelDraft = result.draftBundle.drafts.find((d) => d.kind === "provider-model-route");
    expect(providerModelDraft?.review.values.baseUrl).toBe("https://custom.example.com/v1");
    expect(providerModelDraft?.review.values.contextWindowTokens).toBe(256000);
    expect(providerModelDraft?.review.values.apiMode).toBe("custom_openai_compatible");
    expect(providerModelDraft?.review.values.authMethod).toBe("api_key");

    const serialized = JSON.stringify(result.reviewManifest);
    expect(serialized).toContain("https://custom.example.com/v1");
    expect(serialized).toContain("256000");
    expect(serialized).not.toContain("sk-");
  });

  it("reuses existing credential without prompting when flow reports reuse", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }),
      flowEngine: flowEngine({ credentialAction: "reuse" }),
    });

    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
  });

  it("throws on malformed reuse credential reference", async () => {
    const badFlow: FlowEngine = {
      listProviderCandidates: async () => [{
        id: "openai" as ProviderId,
        displayName: "OpenAI",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: 5,
        credentialReady: true,
      }],
      listModelCandidates: async () => [{
        id: "gpt-5.5",
        provider: "openai" as ProviderId,
        profile: {
          id: "gpt-5.5",
          provider: "openai" as ProviderId,
          supportsTools: true,
          supportsVision: false,
          supportsReasoning: false,
          supportsStructuredOutput: true,
          contextWindowTokens: 128000,
        },
        configured: true,
        executable: true,
        catalogOnly: false,
        supportsVision: false,
      }],
      resolveSelection: async () => ({
        kind: "selected" as const,
        provider: "openai" as ProviderId,
        model: "gpt-5.5",
        apiMode: "custom_openai_compatible" as ProviderApiMode,
        authMethod: "api_key" as ProviderAuthMethod,
        credentialAction: { kind: "reuse" as const, reference: "invalid-ref" as `env:${string}` },
        profile: {
          id: "gpt-5.5",
          provider: "openai" as ProviderId,
          supportsTools: true,
          supportsVision: false,
          supportsReasoning: false,
          supportsStructuredOutput: true,
          contextWindowTokens: 128000,
        },
      }),
    };

    await expect(runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }),
      flowEngine: badFlow,
    })).rejects.toThrow("Malformed reuse credential reference");
  });

  it("does not persist apiMode or authMethod in saved config", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI", __secret: "sk-test" }),
      flowEngine: flowEngine({ baseUrl: "https://custom.example.com/v1", contextWindowTokens: 256000 }),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(true);
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as Record<string, unknown>;

    expect(rawConfig).not.toContain("apiMode");
    expect(rawConfig).not.toContain("authMethod");
    expect(config.model).toEqual(expect.objectContaining({
      provider: "openai",
      id: "gpt-5.5",
      contextWindowTokens: 256000,
    }));
    expect((config.providers as Record<string, unknown>)?.openai).toEqual(expect.objectContaining({
      baseUrl: "https://custom.example.com/v1",
    }));
  });
});

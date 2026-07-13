import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/prompt-contract.js";
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
import { renderOnboardingWizardSummary } from "./summary.js";
import type { FlowEngine, ModelCandidate, ProviderCandidate } from "../../providers/provider-model-selection-flow.js";
import { readActiveProfile, resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";
import type { SetupApplyExecutor, SetupApplyMode, SetupDeferredSecretWrite } from "../setup-apply-plan.js";
import {
  gatewayServiceActivationNotNowGuidance,
  gatewayServiceActivationPromptTitle,
  maybeOfferGatewayStartAfterChannelSetup,
  type GatewayActivationServiceActions,
} from "../gateway-service-activation.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import type { WhatsAppPairDeviceOptions, WhatsAppSetupDependencies } from "../whatsapp-setup-flow.js";
import * as pythonEnvManager from "../../python-env/manager.js";
import * as capabilityManager from "../../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID } from "../../python-env/capability-registry.js";

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

async function readProfileConfig(homeDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(profileConfigPath(homeDir), "utf8").catch(() => "{}");
  return JSON.parse(raw) as Record<string, unknown>;
}

function browserPromptOverrides(modeLabel: string, extra: Record<string, FakePromptOverrideValue> = {}): Record<string, FakePromptOverrideValue> {
  return {
    [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
    [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "Browser",
    [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: modeLabel,
    [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
    ...extra,
  };
}

function searchPromptOverrides(providerLabel: string, extra: Record<string, FakePromptOverrideValue> = {}): Record<string, FakePromptOverrideValue> {
  return {
    [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
    [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: resolveSetupCopy("en", "onboarding.optionalCapabilities.webSearch"),
    [resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.title")]: providerLabel,
    [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
    ...extra,
  };
}

function localReadyConfigObject(): Record<string, unknown> {
  return {
    model: {
      provider: "local",
      id: "local-test-model",
    },
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        models: ["local-test-model"],
        enableNetwork: true,
      },
    },
  };
}

function flowEngine(overrides: {
  credentialAction?: "collect" | "reuse" | "none" | "endpoint";
  baseUrl?: string;
  contextWindowTokens?: number;
  envVarName?: string;
  providerCandidates?: ProviderCandidate[];
} = {}): FlowEngine {
  const action = overrides.credentialAction ?? "collect";
  const envVarName = overrides.envVarName ?? (action === "endpoint" ? "OPENAI_COMPATIBLE_API_KEY" : "OPENAI_API_KEY");
  return {
    listProviderCandidates: async () => overrides.providerCandidates ?? [
      {
        id: "local" as ProviderId,
        displayName: "Local / Custom",
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
          id: "local-test-model",
          provider: providerId,
          profile: {
            id: "local-test-model",
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
          lifecycle: "available",
          usageClass: "primary-chat",
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
          lifecycle: "available",
          usageClass: "primary-chat",
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
          credentialAction: action === "endpoint"
            ? {
                kind: "endpoint" as const,
                baseUrl: overrides.baseUrl ?? "http://localhost:11434/v1",
                apiKeyEnv: envVarName,
              }
            : { kind: "none" as const },
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
    lifecycle: "available",
    usageClass: "primary-chat",
  };
}

type FakePromptOverrideValue = string | boolean | readonly (string | boolean)[];

function fakePrompt(
  overrides: Record<string, FakePromptOverrideValue> = {},
  seenOptions: Record<string, readonly string[]> = {},
  seenDescriptions: Record<string, readonly (string | undefined)[]> = {},
  seenQuestions: { question: string; secret: boolean }[] = [],
  seenSelectInputs: Record<string, SelectPromptInput<unknown>> = {},
  seenSelectTitles: string[] = []
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
        seenSelectTitles.push(input.title);
        seenSelectInputs[input.title] = input as SelectPromptInput<unknown>;
        seenOptions[input.title] = input.options.map((option) => option.label);
        seenDescriptions[input.title] = input.options.map((option) => option.description ?? option.cells?.details);
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

function whatsappDepsWithMissingBridge(options: { readonly installError?: unknown } = {}): WhatsAppSetupDependencies & {
  readonly installDependencies: ReturnType<typeof vi.fn>;
  readonly pairDevice: ReturnType<typeof vi.fn>;
} {
  return {
    getDependencyStatus: async () => ({
      bridgeDir: "/tmp/bridge",
      packagePresent: true,
      lockfilePresent: true,
      entrypointPresent: true,
      nodeModulesPresent: false,
      missing: ["node_modules"],
    }),
    installDependencies: vi.fn(async () => {
      if (options.installError !== undefined) throw options.installError;
    }),
    pairDevice: vi.fn<NonNullable<WhatsAppSetupDependencies["pairDevice"]>>(),
  };
}

function whatsappDepsWithInstalledBridge(options: {
  readonly pairDevice?: WhatsAppSetupDependencies["pairDevice"];
} = {}): WhatsAppSetupDependencies & { readonly pairDevice: ReturnType<typeof vi.fn> } {
  return {
    getDependencyStatus: async () => ({
      bridgeDir: "/tmp/bridge",
      packagePresent: true,
      lockfilePresent: true,
      entrypointPresent: true,
      nodeModulesPresent: true,
      missing: [],
    }),
    installDependencies: vi.fn(),
    pairDevice: vi.fn<NonNullable<WhatsAppSetupDependencies["pairDevice"]>>(options.pairDevice ?? successfulWhatsAppPairDevice()),
  };
}

function successfulWhatsAppPairDevice(qr = ""): (options: WhatsAppPairDeviceOptions) => Promise<{ ok: true }> {
  return async (options) => {
    if (qr.length > 0) options.output.write(qr);
    await mkdir(options.authDir, { recursive: true });
    await writeFile(join(options.authDir, "creds.json"), "{}\n", "utf8");
    return { ok: true };
  };
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

function readyDdgsStatus(homeDir: string): Awaited<ReturnType<typeof capabilityManager.checkManagedPythonCapabilityStatus>> {
  const stateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
  return {
    ok: true,
    status: "verified",
    capabilityId: DDGS_CAPABILITY_ID,
    version: "9.14.4",
    specHash: "hash",
    installedGroups: [],
    installedPackages: ["ddgs==9.14.4"],
    pythonPath: join(stateRoot, "python-capabilities", DDGS_CAPABILITY_ID, "bin", "python"),
    envPath: join(stateRoot, "python-capabilities", DDGS_CAPABILITY_ID),
    manifest: {
      id: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "hash",
      installedPackages: ["ddgs==9.14.4"],
      installedGroups: [],
      pythonPath: join(stateRoot, "python-capabilities", DDGS_CAPABILITY_ID, "bin", "python"),
      envPath: join(stateRoot, "python-capabilities", DDGS_CAPABILITY_ID),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      status: "verified",
    },
  };
}

function readyDdgsInstallResult(homeDir: string): Awaited<ReturnType<typeof capabilityManager.installManagedPythonCapabilityEnvironment>> {
  const status = readyDdgsStatus(homeDir);
  if (!status.ok) throw new Error("expected ready status");
  return {
    ok: true,
    capabilityId: status.capabilityId,
    version: status.version,
    specHash: status.specHash,
    installedGroups: status.installedGroups,
    installedPackages: status.installedPackages,
    pythonPath: status.pythonPath,
    envPath: status.envPath,
    manifest: status.manifest,
  };
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
    vi.restoreAllMocks();
    delete process.env.ESTACODA_TELEGRAM_BOT_TOKEN;
    delete process.env.ESTACODA_DISCORD_BOT_TOKEN;
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
    delete process.env.BRAVE_SEARCH_API_KEY;
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
      model: "local-test-model",
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

  it("presents onboarding Agent Evolution choices in the configured order", async () => {
    const seenSelectInputs: Record<string, SelectPromptInput<unknown>> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({}, {}, {}, [], seenSelectInputs),
      flowEngine: flowEngine(),
    });

    const workflowInput = seenSelectInputs[resolveSetupCopy("en", "onboarding.workflowLearning.title")];
    expect(workflowInput?.options.map((option) => option.label)).toEqual([
      "Suggest",
      "Proactive",
      "Autonomous",
      "Off",
      "Back",
    ]);
    expect(workflowInput?.options.map((option) => option.id)).toEqual([
      "suggest",
      "proactive",
      "autonomous",
      "none",
      "back",
    ]);
    expect(workflowInput?.options.slice(0, 4).map((option) => option.value)).toEqual([
      "suggest",
      "proactive",
      "autonomous",
      "none",
    ]);
    expect(workflowInput?.defaultIndex).toBe(0);
    expect(result.selections.workflowLearning).toBe("suggest");
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

  it("prompts for workspace changes with the current default on its own line", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({}, {}, {}, seenQuestions),
      flowEngine: flowEngine(),
    });

    const workspaceQuestion = seenQuestions.find((entry) =>
      entry.question.includes("Select the workspace EstaCoda should use.")
    );
    expect(workspaceQuestion).toEqual({
      question: [
        "Select the workspace EstaCoda should use.",
        "Press Enter to use the current default, or type another path.",
        "",
        `Current default: ${workspaceRoot}`,
        "",
      ].join("\n"),
      secret: false,
    });
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

  it("lets Workspace trust Back return to language while preserving the workspace root", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Setup language": ["English", "العربية"],
        "Workspace trust": "Back",
        [resolveSetupCopy("ar", "onboarding.workspace.trust.title")]: resolveSetupCopy("ar", "onboarding.workspace.trustAction.label"),
      }, seenOptions),
      flowEngine: flowEngine(),
    });

    expect(seenOptions["Workspace trust"]).toEqual([
      "Trust",
      "Change Workspace",
      "Decide Later",
      "Back",
    ]);
    expect(result.selections.language).toBe("ar");
    expect(result.selections.workspaceRoot).toBe(await realpath(workspaceRoot));
    expect(result.selections.workspaceTrusted).toBe(true);
  });

  it("does not apply partial workspace trust after Workspace trust Back", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace trust": ["Back", "Decide Later"],
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });

    expect(result.completed).toBe(true);
    expect(result.selections.workspaceTrusted).toBe(false);
    expect(result.reviewManifest.sections["workspace-trust-grants"]).toHaveLength(0);
    await expect(readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")).rejects.toThrow();
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

  it("passes firstRunTolerant mode to reviewed apply execution", async () => {
    let observedMode: SetupApplyMode | undefined;
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      flowEngine: flowEngine(),
      applyExecutor: {
        apply: (_plan, context) => {
          observedMode = context?.mode;
          return {
            ok: true,
            appliedOperationIds: [],
          };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    expect(observedMode).toBe("firstRunTolerant");
  });

  it("renders multiple onboarding apply warnings as bullet lines", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      flowEngine: flowEngine(),
      applyExecutor: {
        apply: () => ({
          ok: true,
          appliedOperationIds: [],
          warnings: [
            {
              operationId: "optional.voice",
              capability: "voice",
              subCapability: "stt",
              code: "managed_python_setup_failed",
              message: "First optional warning.",
              cause: "first raw cause",
            },
            {
              operationId: "optional.browser",
              capability: "browser",
              subCapability: "browser",
              code: "external_service_unavailable",
              message: "Second optional warning.",
              cause: "second raw cause",
            },
          ],
        }),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.output).toContain("Optional capability warnings:");
    expect(result.output).toContain("- First optional warning.");
    expect(result.output).toContain("- Second optional warning.");
    expect(result.output).not.toContain("first raw cause");
    expect(result.output).not.toContain("second raw cause");
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

  it("prompts for local endpoint base URL and treats blank endpoint auth as no-auth", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "Local / Custom", __prompt: "", __secret: "" }, {}, {}, seenQuestions),
      flowEngine: flowEngine({ credentialAction: "endpoint" }),
    });
    const providerRouteReview = result.reviewManifest.sections["provider-model-network"][0]?.review;

    expect(seenQuestions).toContainEqual({
      question: "Local endpoint base URL [http://localhost:11434/v1]:",
      secret: false,
    });
    expect(seenQuestions).toContainEqual({
      question: "Optional API key for OPENAI_COMPATIBLE_API_KEY. Leave blank for no local auth:",
      secret: true,
    });
    expect(result.selections.primaryProvider).toBe("local");
    expect(result.selections.primaryBaseUrl).toBe("http://localhost:11434/v1");
    expect(result.wizardState.primaryRoute?.baseUrl).toBe("http://localhost:11434/v1");
    expect(result.selections.primaryCredential).toEqual({ kind: "none" });
    expect(result.wizardState.credential).toMatchObject({ status: "not_set" });
    expect(result.wizardState.credential?.envVarName).toBeUndefined();
    expect(result.reviewManifest.sections["secret-refs-to-store"]).toHaveLength(0);
    expect(providerRouteReview?.values).toEqual(expect.objectContaining({
      provider: "local",
      model: "local-test-model",
      baseUrl: "http://localhost:11434/v1",
    }));
    expect(providerRouteReview?.summaryKey).toBe("setupDrafts.providerModelEndpointRoute.summary");
  });

  it("retries invalid local endpoint URLs before prompting for optional auth", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": "Local / Custom",
        __prompt: ["", "not a url", "http://127.0.0.1:9999/v1"],
        __secret: "",
      }, {}, {}, seenQuestions),
      flowEngine: flowEngine({ credentialAction: "endpoint" }),
    });

    const endpointPromptIndex = seenQuestions.findIndex((entry) =>
      entry.question === "Local endpoint base URL [http://localhost:11434/v1]:"
    );

    expect(endpointPromptIndex).toBeGreaterThanOrEqual(0);
    expect(seenQuestions[endpointPromptIndex]).toEqual({
      question: "Local endpoint base URL [http://localhost:11434/v1]:",
      secret: false,
    });
    expect(seenQuestions[endpointPromptIndex + 1]?.question).toContain("Invalid endpoint URL.");
    expect(seenQuestions[endpointPromptIndex + 1]?.question).toContain("Local endpoint base URL [http://localhost:11434/v1]:");
    expect(seenQuestions[endpointPromptIndex + 1]?.secret).toBe(false);
    expect(seenQuestions[endpointPromptIndex + 2]).toEqual({
      question: "Optional API key for OPENAI_COMPATIBLE_API_KEY. Leave blank for no local auth:",
      secret: true,
    });
    expect(result.selections.primaryBaseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(result.wizardState.primaryRoute?.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(result.selections.primaryCredential).toEqual({ kind: "none" });
    expect(result.reviewManifest.sections["secret-refs-to-store"]).toHaveLength(0);
    expect(result.reviewManifest.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      baseUrl: "http://127.0.0.1:9999/v1",
    }));
  });

  it("uses shared setup editor copy for the Arabic provider credential prompt", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const seenSelectInputs: Record<string, SelectPromptInput<unknown>> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Setup language": "العربية",
        [resolveSetupCopy("ar", "onboarding.providers.primary.title")]: "OpenAI",
        __secret: "sk-arabic-secret",
      }, {}, {}, seenQuestions, seenSelectInputs),
      flowEngine: flowEngine(),
    });
    const expectedQuestion = setupProviderCredentialQuestion("ar", {
      providerName: "OpenAI",
      envVarName: "OPENAI_API_KEY",
    });
    const credentialInput = seenSelectInputs["بيانات الاعتماد"];
    const configureLater = credentialInput?.options.find((option) => option.id === "configure-later");

    expect(seenQuestions).toContainEqual({ question: expectedQuestion, secret: true });
    expect(credentialInput?.body).toContain(isolateLtr("OPENAI_API_KEY"));
    expect(configureLater?.description).toContain(isolateLtr("OPENAI_API_KEY"));
    expect(expectedQuestion).toContain(isolateLtr("OpenAI"));
    expect(expectedQuestion).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("sk-arabic-secret");
    expect(JSON.stringify(result.wizardState)).not.toContain("\u2066");
    expect(JSON.stringify(result.wizardState)).not.toContain("\u2069");
    expect(JSON.stringify(result.selections)).not.toContain("\u2066");
    expect(JSON.stringify(result.selections)).not.toContain("\u2069");
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

  it("runs the shared WhatsApp QR setup flow from onboarding and records configured status", async () => {
    const output: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("en", "whatsappWizard.mode.title")]: "1",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: ["", "971501234567"],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({ pairDevice: successfulWhatsAppPairDevice("QR\n") }),
      output: { write: (value) => output.push(value) },
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      channels?: {
        whatsapp?: {
          enabled?: boolean;
          experimental?: boolean;
          authDir?: string;
          mode?: string;
          dmPolicy?: string;
          allowedUsers?: string[];
          pairingMode?: string;
        };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("configured");
    expect(result.selections.optionalCapabilities).toEqual(["channels"]);
    expect(output.join("")).toContain("QR");
    expect(config.channels?.whatsapp).toEqual(expect.objectContaining({
      enabled: true,
      experimental: true,
      mode: "bot",
      dmPolicy: "allowlist",
      allowedUsers: ["971501234567"],
      pairingMode: "qr",
    }));
    expect(config.channels?.whatsapp?.authDir).toContain("/gateway/whatsapp-auth");
    expect(JSON.stringify(config.channels?.whatsapp)).not.toContain("open");
  });

  it("continues onboarding when WhatsApp dependency install is declined without writing partial config", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("en", "whatsappWizard.dependencies.missingTitle")]: "n",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: [""],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithMissingBridge(),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8").catch(() => "{}");
    const config = JSON.parse(rawConfig) as { channels?: unknown };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("skipped");
    expect(config.channels).toBeUndefined();
  });

  it("records localized WhatsApp dependency decline as skipped without writing partial config", async () => {
    const output: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Setup language": "العربية",
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("ar", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("ar", "whatsappWizard.dependencies.missingTitle")]: "n",
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: [""],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithMissingBridge(),
      output: { write: (value) => output.push(value) },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8").catch(() => "{}");
    const config = JSON.parse(rawConfig) as { channels?: unknown };

    expect(result.completed).toBe(true);
    expect(result.wizardState.interfacePreferences?.language).toBe("ar");
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("skipped");
    expect(output.join("")).toContain(`تم إلغاء إعداد ${isolateLtr("WhatsApp")}`);
    expect(config.channels).toBeUndefined();
  });

  it("continues onboarding when WhatsApp dependency install fails without writing partial config", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("en", "whatsappWizard.dependencies.missingTitle")]: "y",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: [""],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithMissingBridge({ installError: new Error("offline") }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8").catch(() => "{}");
    const config = JSON.parse(rawConfig) as { channels?: unknown };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("incomplete");
    expect(config.channels).toBeUndefined();
  });

  it("continues onboarding when WhatsApp QR pairing times out without writing partial config", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("en", "whatsappWizard.mode.title")]: "1",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: ["", "971501234567"],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({
        pairDevice: vi.fn(async () => ({ ok: false as const, reason: "timeout" as const })),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8").catch(() => "{}");
    const config = JSON.parse(rawConfig) as { channels?: unknown };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("incomplete");
    expect(config.channels).toBeUndefined();
  });

  it("continues onboarding when WhatsApp QR pairing fails without writing partial config", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("en", "whatsappWizard.mode.title")]: "2",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: ["", "971501234567"],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({
        pairDevice: vi.fn(async () => ({ ok: false as const, reason: "failed" as const, message: "socket closed" })),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8").catch(() => "{}");
    const config = JSON.parse(rawConfig) as { channels?: unknown };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("incomplete");
    expect(config.channels).toBeUndefined();
  });

  it("keeps blank WhatsApp onboarding allowlists in pairing-pending mode without opening access", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.title")]: true,
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.menu.title")]: "channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "whatsapp",
        [resolveSetupCopy("en", "whatsappWizard.mode.title")]: "2",
        [resolveSetupCopy("en", "onboarding.optionalCapabilities.more.title")]: false,
        __prompt: ["", ""],
      }),
      flowEngine: flowEngine({ credentialAction: "none" }),
      whatsappSetupDependencies: whatsappDepsWithInstalledBridge({ pairDevice: successfulWhatsAppPairDevice() }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      channels?: { whatsapp?: { dmPolicy?: string; allowedUsers?: string[] } };
    };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.channels?.whatsapp).toBe("incomplete");
    expect(config.channels?.whatsapp?.dmPolicy).toBe("pairing");
    expect(config.channels?.whatsapp?.allowedUsers).toEqual([]);
    expect(JSON.stringify(config.channels?.whatsapp)).not.toContain("open");
  });

  it("does not re-add Codex, catalog-only, or media providers filtered out by the shared flow", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": "OpenAI",
        "Optional capabilities": "Yes",
        "Configure optional capability": "Voice",
        "Voice": "openai",
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

    expect(seenOptions["Primary provider"]).toEqual(["OpenAI", "Back"]);
    expect(seenOptions["Primary provider"]).not.toEqual(expect.arrayContaining([
      "Codex",
      "FAL",
      "BytePlus",
      "Voice",
      "Vision and Image Generation",
    ]));
    expect(seenOptions["Configure optional capability"]).toEqual([
      "Channels",
      "Voice",
      "Browser",
      "Search",
      "Skip",
      "Back",
    ]);
    expect(seenOptions["Configure optional capability"]).not.toContain("Image generation");
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

  it("uses the shared structured provider route prompt with Back and without Cancel", async () => {
    const providers: ProviderCandidate[] = [
      {
        id: "local" as ProviderId,
        displayName: "Local / Custom",
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
    const onboardingSelects: Record<string, SelectPromptInput<unknown>> = {};

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({}, onboardingOptions, onboardingDescriptions, [], onboardingSelects),
      flowEngine: flowEngine({ providerCandidates: providers }),
    });

    expect(onboardingOptions["Primary provider"]).toEqual(["Local / Custom", "OpenAI", "Back"]);
    expect(onboardingDescriptions["Primary provider"]).toEqual([
      "OpenAI-compatible local or custom endpoint. API key optional.",
      "Frontier models for high-quality primary reasoning. Direct API.",
      "Return to the previous step.",
    ]);
    expect(onboardingSelects["Primary provider"]?.surface).toBe("promptCard");
    expect(onboardingSelects["Primary provider"]?.columns).toEqual([
      { key: "name", header: "Name" },
      { key: "details", header: "Details" },
    ]);
    expect(onboardingSelects["Primary provider"]?.options.map((option) => option.id)).toEqual(expect.arrayContaining(["back"]));
    expect(onboardingSelects["Primary provider"]?.options.map((option) => option.id)).not.toEqual(expect.arrayContaining(["cancel"]));
  });

  it("lets Primary provider Back return to workspace trust", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Workspace trust": ["Trust", "Decide Later"],
        "Primary provider": ["Back", "Local / Custom"],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.workspaceTrusted).toBe(false);
    expect(result.selections.primaryProvider).toBe("local");
  });

  it("uses the shared structured model route prompt", async () => {
    const models = modelStatusCandidates("openai" as ProviderId);
    const onboardingOptions: Record<string, readonly string[]> = {};
    const onboardingDescriptions: Record<string, readonly (string | undefined)[]> = {};
    const onboardingSelects: Record<string, SelectPromptInput<unknown>> = {};
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
      prompt: fakePrompt({ "Primary provider": "OpenAI" }, onboardingOptions, onboardingDescriptions, [], onboardingSelects),
      flowEngine: customFlow,
    });

    expect(onboardingOptions["Primary model"]).toEqual([
      "model-alpha",
      "model-beta",
      "model-deprecated",
      "model-unknown",
      "model-stable",
      "model-missing",
      "Back",
    ]);
    expect(onboardingDescriptions["Primary model"]).toEqual([
      "128K context | Alpha",
      "128K context | Beta",
      "128K context | Deprecated",
      "128K context",
      "128K context",
      "128K context",
      "Return to the previous step.",
    ]);
    expect(onboardingSelects["Primary model"]?.surface).toBe("promptCard");
    expect(onboardingSelects["Primary model"]?.columns).toEqual([
      { key: "name", header: "Name" },
      { key: "details", header: "Details" },
    ]);
    expect(onboardingSelects["Primary model"]?.options.map((option) => option.id)).toEqual(expect.arrayContaining(["back"]));
    expect(onboardingSelects["Primary model"]?.options.map((option) => option.id)).not.toEqual(expect.arrayContaining(["cancel"]));
  });

  it("uses OpenRouter model pagination in the onboarding provider/model picker", async () => {
    const models = Array.from({ length: 30 }, (_, index) =>
      modelStatusCandidate("openrouter" as ProviderId, `openrouter-model-${String(index + 1).padStart(2, "0")}`));
    const onboardingSelects: Record<string, SelectPromptInput<unknown>> = {};
    const onboardingSelectTitles: string[] = [];
    const customFlow: FlowEngine = {
      ...flowEngine({ credentialAction: "reuse" }),
      listProviderCandidates: async () => [{
        id: "openrouter" as ProviderId,
        displayName: "OpenRouter",
        catalogOnly: false,
        configurable: true,
        runnable: true,
        modelsCount: models.length,
        credentialReady: true,
      }],
      listModelCandidates: async () => models,
    };

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": "OpenRouter",
        "Primary model": ["Next", "openrouter-model-26"],
      }, {}, {}, [], onboardingSelects, onboardingSelectTitles),
      flowEngine: customFlow,
    });

    expect(result.selections.primaryProvider).toBe("openrouter");
    expect(result.selections.primaryModel).toBe("openrouter-model-26");
    expect(onboardingSelectTitles.filter((title) => title === "Primary model")).toHaveLength(2);
    expect(onboardingSelects["Primary model"]?.technicalLines).toEqual(["Models 26-30 of 30."]);
    expect(onboardingSelects["Primary model"]?.options.map((option) => option.id)).toEqual([
      ...models.slice(25).map((model) => model.id),
      "previous-page",
      "back",
    ]);
  });

  it("keeps model Back inside the provider/model picker", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": ["OpenAI", "Local / Custom"],
        "Primary model": ["Back", "local-test-model"],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.primaryProvider).toBe("local");
    expect(result.selections.primaryModel).toBe("local-test-model");
  });

  it("lets Credential Back return to provider/model selection", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": ["OpenAI", "Local / Custom"],
        "Credential handling": "Back",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.primaryProvider).toBe("local");
    expect(result.selections.primaryCredential).toEqual({ kind: "none" });
  });

  it("preserves provider/model current selections after Credential Back", async () => {
    const seenSelectInputs: Record<string, SelectPromptInput<unknown>> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": ["OpenAI", "OpenAI"],
        "Credential handling": ["Back", "Configure later"],
      }, {}, {}, [], seenSelectInputs),
      flowEngine: flowEngine(),
    });

    expect(result.selections.primaryProvider).toBe("openai");
    expect(seenSelectInputs["Primary provider"]?.options.find((option) => option.id === "openai")?.current).toBe(true);
    expect(seenSelectInputs["Primary model"]?.options.find((option) => option.id === "gpt-5.5")?.current).toBe(true);
  });

  it("lets Security Back return to credential handling without duplicating pending secret writes", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": "OpenAI",
        "Credential handling": ["Enter API key", "Enter API key"],
        "Security mode": ["Back", "Adaptive"],
        __secret: ["sk-first-secret", "sk-second-secret"],
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(envFile).toContain("sk-second-secret");
    expect(envFile).not.toContain("sk-first-secret");
  });

  it("lets Agent Evolution Back return to security mode with current defaults preserved", async () => {
    const seenSelectInputs: Record<string, SelectPromptInput<unknown>> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Security mode": ["Strict", "Open"],
        "Agent Evolution": ["Back", "Off"],
      }, {}, {}, [], seenSelectInputs),
      flowEngine: flowEngine(),
    });

    expect(result.selections.securityMode).toBe("open");
    expect(result.selections.workflowLearning).toBe("none");
    expect(seenSelectInputs["Security mode"]?.defaultIndex).toBe(1);
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
      "128K context | Alpha",
      "128K context | Beta",
      "128K context | Deprecated",
      "128K context",
      "128K context",
      "128K context",
      "Return to the previous step.",
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
    expect(result.output).toContain("Setup cancelled. No settings were written, no credentials were saved, and this workspace was not trusted.");
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

  it("does not write optional capability config or secrets when summary Cancel is selected", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.browserbase"),
        {
          "Configuration summary": "Cancel",
          __secret: ["bb-cancelled-api-key", "bb-cancelled-project-id"],
        }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { browser?: unknown };

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult.kind).toBe("cancelled");
    expect(config.browser).toBeUndefined();
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toBe("");
    await expect(readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("bb-cancelled-api-key");
    expect(JSON.stringify(result)).not.toContain("bb-cancelled-project-id");
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
        "Configure optional capability": ["Channels", "Browser"],
        "Configure other capabilities now": ["Yes", "Skip"],
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.mode.localSupervised"),
        [resolveSetupCopy("en", "setupEditor.prompt.browser.local.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.autoLaunch.yes"),
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

  it("keeps configured onboarding capabilities available for summary-back edits", async () => {
    const seenOptions: Record<string, readonly string[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Browser", "Skip"],
        "Configure other capabilities now": "Yes",
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.mode.localSupervised"),
        [resolveSetupCopy("en", "setupEditor.prompt.browser.local.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.autoLaunch.yes"),
        __prompt: ["", "", "", ""],
      }, seenOptions),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(seenOptions["Configure optional capability"]).toEqual([
      "Channels",
      "Voice",
      "Browser",
      "Search",
      "Skip",
      "Back",
    ]);
  });

  it("offers Search in the first-run optional capability list", async () => {
    const seenOptions: Record<string, readonly string[]> = {};

    await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Skip",
      }, seenOptions),
      flowEngine: flowEngine(),
    });

    expect(seenOptions["Configure optional capability"]).toContain("Search");
    expect(seenOptions["Configure optional capability"]).not.toContain("Vision");
    expect(seenOptions["Configure optional capability"]).toContain("Back");
  });

  it("lets Optional capabilities Back return to Agent Evolution", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Agent Evolution": ["Suggest", "Off"],
        "Optional capabilities": ["Back", "No"],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.workflowLearning).toBe("none");
    expect(result.selections.optionalCapabilities).toEqual([]);
  });

  it("lets optional capability menu Back return to Optional capabilities", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": ["Yes", "No"],
        "Configure optional capability": "Back",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
  });

  it("lets Configure another capability Back return to the optional capability menu", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Browser", "Skip"],
        "Configure other capabilities now": "Back",
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.mode.disable"),
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("disabled");
  });

  it("lets Channel choice Back return to the optional capability menu", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Channels", "Skip"],
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: "Back",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(result.wizardState.optionalCapabilities?.channels?.telegram).toBe("not_set");
  });

  it("lets Voice choice Back return to the optional capability menu", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Voice", "Skip"],
        [resolveSetupCopy("en", "setupEditor.prompt.voice.mode.title")]: "Back",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(result.wizardState.optionalCapabilities?.voice).toEqual({
      stt: "not_set",
      tts: "not_set",
    });
  });

  it("lets STT provider Back return to the voice choice", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Voice",
        [resolveSetupCopy("en", "setupEditor.prompt.voice.mode.title")]: [
          resolveSetupCopy("en", "setupEditor.prompt.voice.mode.stt"),
          resolveSetupCopy("en", "setupEditor.prompt.voice.mode.tts"),
        ],
        [resolveSetupCopy("en", "setupModules.voice.title")]: ["Back", "openai"],
        __prompt: ["", ""],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["voice"]);
    expect(result.wizardState.optionalCapabilities?.voice).toEqual({
      stt: "not_set",
      tts: "configured",
    });
  });

  it("lets TTS provider Back return to the voice choice", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Voice",
        [resolveSetupCopy("en", "setupEditor.prompt.voice.mode.title")]: [
          resolveSetupCopy("en", "setupEditor.prompt.voice.mode.tts"),
          resolveSetupCopy("en", "setupEditor.prompt.voice.mode.stt"),
        ],
        [resolveSetupCopy("en", "setupModules.voice.title")]: ["Back", "openai"],
        __prompt: ["", ""],
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["voice"]);
    expect(result.wizardState.optionalCapabilities?.voice).toEqual({
      stt: "configured",
      tts: "not_set",
    });
  });

  it("lets Browser provider Back return to the optional capability menu", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Browser", "Skip"],
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: "Back",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("not_set");
  });

  it("lets Search provider Back return to the optional capability menu", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Search", "Skip"],
        [resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.title")]: "Back",
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(result.wizardState.optionalCapabilities?.webSearch).toBe("not_set");
  });

  it("preserves optional capability draft state across Summary Back", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Browser", "Skip"],
        "Configuration summary": ["Back", "Confirm"],
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.mode.disable"),
      }),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("disabled");
    expect(result.reviewManifest.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      backend: "unconfigured",
    });
  });

  it("does not duplicate optional credential writes after Summary Back and re-entry", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Browser", "Browser"],
        "Configuration summary": ["Back", "Confirm"],
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: [
          resolveSetupCopy("en", "setupEditor.prompt.browser.mode.browserbase"),
          resolveSetupCopy("en", "setupEditor.prompt.browser.mode.browserbase"),
        ],
        __secret: ["bb-first-api", "bb-first-project", "bb-second-api", "bb-second-project"],
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(envFile).toContain("bb-second-api");
    expect(envFile).toContain("bb-second-project");
    expect(envFile).not.toContain("bb-first-api");
    expect(envFile).not.toContain("bb-first-project");
  });

  it("configures Discord when Discord is selected from onboarding channels", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Channels",
        [resolveSetupCopy("en", "setupEditor.prompt.channels.title")]: resolveSetupCopy("en", "setupEditor.prompt.channels.discord"),
        __prompt: ["", "", "123456789", "", ""],
        __secret: "discord-token",
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as {
      channels?: {
        discord?: { enabled?: boolean; botTokenEnv?: string; allowedUsers?: string[] };
        telegram?: unknown;
      };
    };

    expect(result.selections.optionalCapabilities).toEqual(["channels"]);
    expect(result.wizardState.optionalCapabilities?.channels?.discord).toBe("configured");
    expect(result.wizardState.optionalCapabilities?.channels?.telegram).toBe("not_set");
    expect(config.channels?.discord).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "ESTACODA_DISCORD_BOT_TOKEN",
      allowedUsers: ["123456789"],
    }));
    expect(config.channels?.telegram).toBeUndefined();
  });

  it("offers the setup-editor browser mode choices during onboarding", async () => {
    const seenOptions: Record<string, readonly string[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.disable")
      ), seenOptions),
      flowEngine: flowEngine(),
    });

    expect(result.completed).toBe(true);
    expect(seenOptions[resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]).toEqual([
      "Recommended browser setup",
      "Local supervised browser",
      "Existing CDP browser",
      "Browserbase cloud browser",
      "Disable browser tools",
      "Back",
    ]);
  });

  it("maps recommended browser setup through onboarding to flat config fields", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.recommended")
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as {
      browser?: {
        backend?: string;
        supervised?: boolean;
        autoLaunch?: boolean;
        engine?: string;
        launchArgs?: string[];
        chromeFlags?: string[];
        hybridRouting?: boolean;
      };
    };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("configured");
    expect(config.browser).toEqual(expect.objectContaining({
      backend: "local-cdp",
      supervised: true,
      autoLaunch: true,
      engine: "cdp",
      launchArgs: [],
      chromeFlags: [],
      hybridRouting: false,
    }));
  });

  it("maps local supervised browser setup through onboarding to flat config fields", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.localSupervised"),
        {
          [resolveSetupCopy("en", "setupEditor.prompt.browser.local.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.autoLaunch.yes"),
          __prompt: ["", "", "", "--user-data-dir=/tmp/browser-profile", "--disable-gpu"],
        }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as {
      browser?: {
        backend?: string;
        supervised?: boolean;
        autoLaunch?: boolean;
        launchArgs?: string[];
        chromeFlags?: string[];
      };
    };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("configured");
    expect(config.browser).toEqual(expect.objectContaining({
      backend: "local-cdp",
      supervised: true,
      autoLaunch: true,
      launchArgs: ["--user-data-dir=/tmp/browser-profile"],
      chromeFlags: ["--disable-gpu"],
    }));
  });

  it("maps existing local CDP browser setup through onboarding to flat config fields", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.existingCdp"),
        { __prompt: ["", "http://localhost:9222"] }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as {
      browser?: {
        backend?: string;
        supervised?: boolean;
        autoLaunch?: boolean;
        cdpUrl?: string;
      };
    };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("configured");
    expect(config.browser).toEqual(expect.objectContaining({
      backend: "local-cdp",
      supervised: true,
      autoLaunch: false,
      cdpUrl: "http://localhost:9222",
    }));
  });

  it("maps Browserbase setup through onboarding and writes complete reviewed credential sources", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.browserbase"),
        { __secret: ["bb-api-key", "bb-project-id"] }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as {
      browser?: {
        backend?: string;
        cloudProvider?: string;
        hybridRouting?: boolean;
        cloudFallback?: boolean;
        cloudSpendApproved?: boolean;
      };
    };
    const env = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("configured");
    expect(config.browser).toEqual(expect.objectContaining({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudFallback: true,
      cloudSpendApproved: false,
    }));
    expect(env).toContain("BROWSERBASE_API_KEY=\"bb-api-key\"");
    expect(env).toContain("BROWSERBASE_PROJECT_ID=\"bb-project-id\"");
    expect(JSON.stringify(result.reviewManifest)).toContain("BROWSERBASE_API_KEY");
    expect(JSON.stringify(result.reviewManifest)).toContain("BROWSERBASE_PROJECT_ID");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("bb-api-key");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("bb-project-id");
  });

  it("drops incomplete Browserbase onboarding setup without writing partial secrets", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.browserbase"),
        { __secret: ["bb-api-key", ""] }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { browser?: unknown };
    const env = await readFile(profileEnvPath(tempDir), "utf8").catch(() => "");

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).not.toBe("blocked");
    expect(result.wizardState.optionalCapabilities?.browser).toBe("incomplete");
    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(config.browser).toBeUndefined();
    expect(env).not.toContain("bb-api-key");
    expect(env).not.toContain("BROWSERBASE_API_KEY");
    expect(env).not.toContain("BROWSERBASE_PROJECT_ID");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("bb-api-key");
  });

  it("drops existing CDP onboarding setup with a missing URL and still completes", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.existingCdp"),
        { __prompt: ["", ""] }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { browser?: unknown };

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).not.toBe("blocked");
    expect(result.wizardState.optionalCapabilities?.browser).toBe("incomplete");
    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(config.browser).toBeUndefined();
  });

  it("drops existing CDP onboarding setup with a non-local URL and still completes", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.existingCdp"),
        { __prompt: ["", "http://example.com:9222"] }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { browser?: unknown };

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).not.toBe("blocked");
    expect(result.wizardState.optionalCapabilities?.browser).toBe("incomplete");
    expect(config.browser).toBeUndefined();
  });

  it("writes disabled browser setup as unconfigured and summarizes it as disabled", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(browserPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.browser.mode.disable")
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { browser?: { backend?: string } };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.browser).toBe("disabled");
    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(config.browser).toEqual(expect.objectContaining({ backend: "unconfigured" }));
    expect(renderOnboardingWizardSummary(result.wizardState)).toContain("  - Browser: Disabled");
  });

  it("maps Brave Search onboarding through reviewed config and deferred secret write", async () => {
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(searchPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.brave"),
        {
          __prompt: [""],
          __secret: "brave-secret-value",
        }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as {
      web?: {
        searchBackend?: string;
        brave?: { apiKeyEnv?: string; apiKey?: string };
      };
    };
    const env = await readFile(profileEnvPath(tempDir), "utf8");
    const reviewJson = JSON.stringify(result.reviewManifest);

    expect(result.completed).toBe(true);
    expect(result.selections.optionalCapabilities).toEqual(["web-search"]);
    expect(result.wizardState.optionalCapabilities?.webSearch).toBe("configured");
    expect(config.web).toEqual(expect.objectContaining({
      searchBackend: "brave",
      brave: {
        apiKeyEnv: "BRAVE_SEARCH_API_KEY",
      },
    }));
    expect(config.web?.brave?.apiKey).toBeUndefined();
    expect(env).toContain("BRAVE_SEARCH_API_KEY=\"brave-secret-value\"");
    expect(reviewJson).toContain("BRAVE_SEARCH_API_KEY");
    expect(reviewJson).not.toContain("brave-secret-value");
    expect(result.output).not.toContain("brave-secret-value");
    expect(renderOnboardingWizardSummary(result.wizardState)).toContain("  - Search: Configured");
  });

  it("maps ready DDGS Search onboarding through reviewed config without install", async () => {
    const statusSpy = vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue(readyDdgsStatus(tempDir));
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(searchPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.ddgs")
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { web?: { searchBackend?: string } };

    expect(result.completed).toBe(true);
    expect(result.selections.optionalCapabilities).toEqual(["web-search"]);
    expect(result.wizardState.optionalCapabilities?.webSearch).toBe("configured");
    expect(statusSpy).toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
    expect(config.web?.searchBackend).toBe("ddgs");
  });

  it("confirms managed DDGS setup during first-run apply when DDGS is missing", async () => {
    const statusSpy = vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(searchPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.ddgs"),
        {
          [resolveSetupCopy("en", "setupEditor.prompt.webSearch.ddgs.install.title")]: true,
        }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { web?: { searchBackend?: string } };

    expect(result.completed).toBe(true);
    expect(result.wizardState.optionalCapabilities?.webSearch).toBe("configured");
    expect(statusSpy).toHaveBeenCalled();
    expect(installSpy).toHaveBeenCalledWith({
      stateRoot: resolveGlobalStateHome({ homeDir: tempDir }).stateRoot,
      capabilityId: DDGS_CAPABILITY_ID,
    });
    expect(config.web?.searchBackend).toBe("ddgs");
  });

  it("warns and leaves Search unconfigured when first-run DDGS setup fails", async () => {
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "pip_install_failed",
      message: "Could not install ddgs.",
      diagnostic: "Traceback: hidden details",
    });

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(searchPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.ddgs"),
        {
          [resolveSetupCopy("en", "setupEditor.prompt.webSearch.ddgs.install.title")]: true,
        }
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { web?: unknown };

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.wizardState.optionalCapabilities?.webSearch).toBe("configured");
    expect(result.output).toContain("Optional capability warnings:");
    expect(result.output).toContain(resolveSetupCopy("en", "onboarding.optionalCapabilities.webSearch.ddgsSkipped"));
    expect(result.output).not.toContain("Could not install ddgs.");
    expect(result.output).not.toContain("Traceback");
    expect(config.web).toBeUndefined();
  });

  it("skips Search without blocking first-run launch", async () => {
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(searchPromptOverrides(
        resolveSetupCopy("en", "setupEditor.prompt.webSearch.provider.none")
      )),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = await readProfileConfig(tempDir) as { web?: unknown };

    expect(result.completed).toBe(true);
    expect(result.applyEndState?.kind).not.toBe("blocked");
    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(result.wizardState.optionalCapabilities?.webSearch).toBe("skipped");
    expect(config.web).toBeUndefined();
    expect(renderOnboardingWizardSummary(result.wizardState)).toContain("  - Search: Skipped");
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
        "Configure optional capability": "Voice",
        "Voice": "openai",
        "Configure other capabilities now": "Skip",
        __secret: "voice-stt-secret",
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
        "Configure optional capability": "Voice",
        "Configure voice": "Text to Speech (TTS)",
        "Voice": "openai",
        "Configure other capabilities now": "Skip",
        __secret: "voice-tts-secret",
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
      ttsApiKeyEnv: "OPENAI_API_KEY",
    });
    expect(result.reviewManifest.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("sttProvider");
  });

  it("renders local STT setup warnings without raw causes during onboarding", async () => {
    vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: false,
      reason: "ensurepip is not available\nFailing command: python3 -m venv",
    });

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Voice",
        "Configure voice": "Speech to Text (STT)",
        "Voice": "Local (via faster-whisper)",
        "Configure other capabilities now": "Skip",
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
      stt?: unknown;
    };

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Optional capability warnings:");
    expect(result.output).toContain(resolveSetupCopy("en", "onboarding.optionalCapabilities.voice.localSttSkipped"));
    expect(result.output).not.toContain("ensurepip is not available");
    expect(result.output).not.toContain("Failing command");
    expect(config.model).toEqual({ provider: "local", id: "local-test-model", contextWindowTokens: 8192 });
    expect(config.stt).toBeUndefined();
  });

  it("renders local STT warning while writing selected onboarding TTS", async () => {
    vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: false,
      reason: "ensurepip is not available\nTraceback: hidden details",
    });

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Voice", "Voice"],
        "Configure voice": ["Speech to Text (STT)", "Text to Speech (TTS)"],
        "Voice": ["Local (via faster-whisper)", "openai"],
        "Configure other capabilities now": ["Yes", "Skip"],
        __secret: "voice-tts-secret",
      }),
      flowEngine: flowEngine(),
      applyExecutor: reviewedExecutor(tempDir, workspaceRoot),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      stt?: unknown;
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
    };

    expect(result.completed).toBe(true);
    expect(result.output).toContain("Optional capability warnings:");
    expect(result.output).toContain(resolveSetupCopy("en", "onboarding.optionalCapabilities.voice.localSttSkipped"));
    expect(result.output).not.toContain("Traceback");
    expect(config.stt).toBeUndefined();
    expect(config.tts).toEqual({
      provider: "openai",
      speed: 1,
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });
  });

  it("normal onboarding confirms the user-facing summary instead of the technical manifest", async () => {
    const output: string[] = [];
    const seenOptions: Record<string, readonly string[]> = {};
    const seenDescriptions: Record<string, readonly (string | undefined)[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({}, seenOptions, seenDescriptions),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(seenOptions["Configuration summary"]).toEqual(["Confirm", "Back", "Cancel"]);
    expect(seenDescriptions["Configuration summary"]).toEqual([
      "Write the selected configuration to EstaCoda.",
      "Go back and edit your setup choices.",
      "Exit onboarding. EstaCoda will not write settings, save credentials, or trust this workspace.",
    ]);
    expect(seenOptions[resolveSetupCopy("en", "onboarding.review")]).toBeUndefined();

    const rendered = output.join("");
    expect(rendered).toContain("Configuration summary");
    expect(rendered).toContain("Credential status: Not set");
    expect(rendered).not.toContain(resolveSetupCopy("en", "setupReview.title"));
    expect(rendered).not.toContain(resolveSetupCopy("en", "setupReview.sections.filesToWriteUpdate"));
  });

  it("lets Configuration summary Back return to optional capabilities", async () => {
    const output: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": ["No", "No"],
        "Configuration summary": ["Back", "Confirm"],
      }),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });
    const rendered = output.join("");

    expect(result.completed).toBe(true);
    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(rendered.match(/Configuration summary/g)?.length).toBe(2);
  });

  it("lets Summary Back return to the optional capability menu when optional flow was entered", async () => {
    const seenSelectTitles: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": ["Browser", "Skip"],
        "Configuration summary": ["Back", "Confirm"],
        [resolveSetupCopy("en", "setupEditor.prompt.browser.mode.title")]: resolveSetupCopy("en", "setupEditor.prompt.browser.mode.disable"),
      }, {}, {}, [], {}, seenSelectTitles),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual(["browser"]);
    expect(seenSelectTitles.filter((title) => title === "Optional capabilities")).toHaveLength(1);
    expect(seenSelectTitles.filter((title) => title === "Configure optional capability")).toHaveLength(2);
  });

  it("lets Summary Back return to Optional capabilities when optional flow was skipped", async () => {
    const seenSelectTitles: string[] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": ["No", "No"],
        "Configuration summary": ["Back", "Confirm"],
      }, {}, {}, [], {}, seenSelectTitles),
      flowEngine: flowEngine(),
    });

    expect(result.selections.optionalCapabilities).toEqual([]);
    expect(seenSelectTitles.filter((title) => title === "Optional capabilities")).toHaveLength(2);
    expect(seenSelectTitles).not.toContain("Configure optional capability");
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
    const seenDescriptions: Record<string, readonly (string | undefined)[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Setup language": "العربية" }, seenOptions, seenDescriptions),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });

    const rendered = output.join("");
    expect(result.selections.language).toBe("ar");
    expect(result.selections.interfaceFlavor).toBe("arabic-light");
    expect(result.selections.activityLabels).toBe("ar");
    expect(seenOptions["Setup language"]).toEqual(["English", "العربية"]);
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.interfaceStyle.title")]).toBeUndefined();
    const selectedWorkspaceRoot = result.selections.workspaceRoot;
    expect(selectedWorkspaceRoot).toBeDefined();
    if (selectedWorkspaceRoot === undefined) {
      throw new Error("Expected onboarding to select a workspace root.");
    }
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.summary.confirmTitle")]).toEqual([
      resolveSetupCopy("ar", "onboarding.summary.confirmAction"),
      "رجوع",
      resolveSetupCopy("ar", "onboarding.summary.cancelAction"),
    ]);
    expect(seenDescriptions[resolveSetupCopy("ar", "onboarding.summary.confirmTitle")]).toEqual([
      resolveSetupCopy("ar", "onboarding.summary.confirmAction.description"),
      resolveSetupCopy("ar", "onboarding.summary.backAction.description"),
      resolveSetupCopy("ar", "onboarding.summary.cancelAction.description"),
    ]);
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.workspace.trust.title")]).toContain("رجوع");
    expect(rendered).toContain("ملخص الإعداد");
    expect(rendered).toContain(`مساحة العمل: ${isolateLtr(selectedWorkspaceRoot)} (موثوقة)`);
    expect(rendered).toContain(`اللغة: ${isolateLtr("ar")}`);
    expect(rendered).toContain("حالة بيانات الاعتماد: غير مهيأ");
    expect(rendered).not.toContain("Configuration summary");
    expect(rendered).not.toContain(resolveSetupCopy("ar", "setupReview.title"));
    expect(rendered).not.toContain(resolveSetupCopy("ar", "setupReview.sections.securityMode"));
    expect(rendered).not.toContain("Files to write/update");
  });

  it("renders Arabic optional capability Back labels with isolated channel tokens", async () => {
    const output: string[] = [];
    const seenOptions: Record<string, readonly string[]> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Setup language": "العربية",
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.title")]: resolveSetupCopy("ar", "onboarding.optionalCapabilities.configureNow.yes"),
        [resolveSetupCopy("ar", "onboarding.optionalCapabilities.menu.title")]: resolveSetupCopy("ar", "onboarding.optionalCapabilities.skip"),
      }, seenOptions),
      flowEngine: flowEngine(),
      output: { write: (value) => output.push(value) },
    });
    const rendered = output.join("");

    expect(result.selections.language).toBe("ar");
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.optionalCapabilities.title")]).toContain("رجوع");
    expect(seenOptions[resolveSetupCopy("ar", "onboarding.optionalCapabilities.menu.title")]).toContain("رجوع");
    expect(rendered).toContain(`القنوات / ${isolateLtr("Discord")}: غير مهيأ`);
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
    expect(config.model).toEqual({ provider: "local", id: "local-test-model", contextWindowTokens: 8192 });
  });

  it("prompts to install and start the gateway after ready Telegram onboarding before the launch prompt", async () => {
    const actions = gatewayServiceActions();
    const promptOrder: string[] = [];
    const prompt = fakePrompt({
      "Optional capabilities": "Yes",
      "Configure optional capability": "Channels",
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
    const seenSelectInputs: Record<string, SelectPromptInput<unknown>> = {};

    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Optional capabilities": "Yes",
        "Configure optional capability": "Channels",
        [gatewayServiceActivationPromptTitle]: "Not now",
        [resolveSetupCopy("en", "onboarding.launch.startNow")]: "No",
        __prompt: ["", "42", ""],
        __secret: "123456:telegram-token",
      }, {}, {}, [], seenSelectInputs),
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
    expect(seenSelectInputs[gatewayServiceActivationPromptTitle]?.options.find((option) => option.id === "yes")?.group)
      .toBeUndefined();
    expect(seenSelectInputs[gatewayServiceActivationPromptTitle]?.options.find((option) => option.id === "not-now")?.group)
      .toBe("navigation");
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
      "Configure optional capability": "Channels",
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
      "Configure optional capability": "Channels",
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
    expect(researchConfig.model).toEqual({ provider: "local", id: "local-test-model", contextWindowTokens: 8192 });
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

  it("defers exactly one optional local endpoint API key write after reviewed apply", async () => {
    const reviewed = reviewedExecutor(tempDir, workspaceRoot);
    const deferredWrites: SetupDeferredSecretWrite[][] = [];
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        "Primary provider": "Local / Custom",
        __prompt: ["", "https://private.local/v1"],
        __secret: "sk-local-onboarding",
      }),
      flowEngine: flowEngine({ credentialAction: "endpoint" }),
      applyExecutor: {
        ...reviewed,
        applyDeferredSecrets: async (plan, writes) => {
          deferredWrites.push([...writes]);
          return reviewed.applyDeferredSecrets!(plan, writes);
        },
      },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
    };
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const reviewJson = JSON.stringify(result.reviewManifest);

    expect(result.completed).toBe(true);
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_COMPATIBLE_API_KEY" });
    expect(result.wizardState.credential).toEqual({
      status: "new_pending",
      envVarName: "OPENAI_COMPATIBLE_API_KEY",
    });
    expect(result.selections.primaryBaseUrl).toBe("https://private.local/v1");
    expect(result.wizardState.primaryRoute?.baseUrl).toBe("https://private.local/v1");
    expect(deferredWrites).toEqual([[{ envVarName: "OPENAI_COMPATIBLE_API_KEY", value: "sk-local-onboarding" }]]);
    expect(config.providers?.local?.baseUrl).toBe("https://private.local/v1");
    expect(config.providers?.local?.apiKeyEnv).toBe("OPENAI_COMPATIBLE_API_KEY");
    expect(rawConfig).not.toContain("sk-local-onboarding");
    expect(envFile).toContain('OPENAI_COMPATIBLE_API_KEY="sk-local-onboarding"');
    expect(reviewJson).toContain("OPENAI_COMPATIBLE_API_KEY");
    expect(reviewJson).toContain("https://private.local/v1");
    expect(reviewJson).not.toContain("sk-local-onboarding");
    expect(result.reviewManifest.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      provider: "local",
      model: "local-test-model",
      baseUrl: "https://private.local/v1",
    }));
    expect(result.reviewManifest.sections["secret-refs-to-store"][0]?.review.values).toEqual(expect.objectContaining({
      envVars: ["OPENAI_COMPATIBLE_API_KEY"],
    }));
    expect(result.reviewManifest.sections["secret-refs-to-store"][0]?.review.values).not.toHaveProperty("baseUrl");
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

  it("does not import CLI model probing for local endpoint onboarding", async () => {
    const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");

    expect(source).not.toContain("probeOpenAIModels");
    expect(source).not.toContain("cli/model-setup");
  });

  it("can reuse an existing credential reference when flow reports reuse", async () => {
    const seenOptions: Record<string, readonly string[]> = {};
    const result = await runFirstRunSetup({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ "Primary provider": "OpenAI" }, seenOptions),
      flowEngine: flowEngine({ credentialAction: "reuse" }),
    });

    expect(seenOptions["Credential handling"]).toEqual([
      "Enter API key",
      "Reuse existing env var",
      "Configure later",
      "Back",
    ]);
    expect(result.selections.primaryCredential).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(result.wizardState.credential?.status).toBe("existing_detected");
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
        lifecycle: "available",
        usageClass: "primary-chat",
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

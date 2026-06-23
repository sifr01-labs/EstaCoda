import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildOnboardingWizardDraftBundle } from "../setup-drafts.js";
import { resolveSetupCopy } from "../setup-copy.js";
import { buildSetupModuleDraftBundle, type SetupModuleContext } from "../setup-modules.js";
import { buildSetupReviewManifest } from "../setup-review-manifest.js";
import { executeSetupApplyPlan, planSetupApply, type SetupApplyMode, type SetupApplyPlan } from "../setup-apply-plan.js";
import {
  applyReviewedSetupPlanOperations,
  createReviewedSetupApplyExecutor,
  executeReviewedSetupApplyPlan,
} from "./apply-executor.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../../config/profile-home.js";
import * as pythonEnvManager from "../../python-env/manager.js";
import * as capabilityManager from "../../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID, EDGE_TTS_CAPABILITY_ID } from "../../python-env/capability-registry.js";

type ReviewValues = Record<string, string | readonly string[] | boolean | number | undefined>;

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-reviewed-apply-"));
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

function profileEnvPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).envPath;
}

function profileAuthPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).authJsonPath;
}

function onboardingPlan(input: {
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly contextWindowTokens?: number;
  readonly credentialEnv?: string;
  readonly securityMode?: "strict" | "adaptive" | "open";
  readonly workflowLearning?: "none" | "suggest" | "proactive" | "autonomous";
}): SetupApplyPlan {
  const provider = input.provider ?? "local";
  const credential = input.credentialEnv === undefined
    ? undefined
    : { status: "new_pending" as const, envVarName: input.credentialEnv };
  const bundle = buildOnboardingWizardDraftBundle({
    workspace: {
      path: input.workspaceRoot,
      trustStatus: "trusted",
    },
    primaryRoute: {
      provider,
      model: input.model ?? "local-test-model",
      baseUrl: input.baseUrl,
      contextWindowTokens: input.contextWindowTokens,
    },
    ...(credential === undefined ? {} : { credential }),
    securityMode: input.securityMode ?? "adaptive",
    agentEvolution: input.workflowLearning ?? "suggest",
    optionalCapabilities: {
      selected: [],
      channels: { telegram: "not_set" },
      voice: { stt: "not_set", tts: "not_set" },
      browser: "not_set",
    },
    optionalCapabilityDrafts: [],
  }, {
    configPath: join(input.homeDir, ".estacoda", "config.json"),
    workspaceRoot: input.workspaceRoot,
    trustStorePath: join(input.homeDir, ".estacoda", "trust.json"),
  });
  const planned = planSetupApply({
    kind: "approved-review-result",
    manifest: buildSetupReviewManifest([bundle]),
  });
  if (planned.kind !== "apply-plan-ready") {
    throw new Error("expected apply plan");
  }
  return planned.applyPlan;
}

function modulePlan(context: SetupModuleContext): SetupApplyPlan {
  const planned = planSetupApply({
    kind: "approved-review-result",
    manifest: buildSetupReviewManifest([buildSetupModuleDraftBundle(context)]),
  });
  if (planned.kind !== "apply-plan-ready") {
    throw new Error("expected apply plan");
  }
  return planned.applyPlan;
}

function fallbackPlan(values: ReviewValues): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-fallback-bundle"],
    operations: [{
      id: "test-fallback-route",
      kind: "config-patch",
      sourceLineIds: ["test-fallback-line"],
      target: {
        kind: "config-scope",
        scope: ["model.fallbacks"],
        path: "/tmp/test/config.json",
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: values.fallbackOperation === "replace"
          ? "setupDrafts.fallbackModelRoute.replace.summary"
          : "setupDrafts.fallbackModelRoute.add.summary",
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

function codexOAuthPlan(values: ReviewValues = {}): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-codex-oauth-bundle"],
    operations: [
      {
        id: "test-codex-route",
        kind: "config-patch",
        sourceLineIds: ["test-codex-route-line"],
        target: {
          kind: "config-scope",
          scope: ["model.provider", "model.id", "provider.route"],
          path: "/tmp/test/config.json",
          preserveUnrelatedConfig: true,
        },
        review: {
          copyKey: "setupDrafts.review",
          summaryKey: "setupDrafts.providerModelEndpointRoute.summary",
          redacted: true,
          values: {
            provider: "codex",
            model: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            apiMode: "custom_openai_compatible",
            authMethod: "oauth_device_pkce",
            oauthCredentialStatus: "pending",
            ...values,
          },
        },
        preserveUnrelatedConfig: true,
        writesConfig: false,
        writesTrustStore: false,
        dryRunOnly: true,
      },
      {
        id: "test-codex-oauth-credential",
        kind: "credential-reference",
        sourceLineIds: ["test-codex-oauth-line"],
        target: {
          kind: "config-scope",
          scope: ["provider.credentialReference"],
          path: "/tmp/test/config.json",
          preserveUnrelatedConfig: true,
        },
        review: {
          copyKey: "setupDrafts.review",
          summaryKey: "setupDrafts.credentialReference.summary",
          redacted: true,
          values: {
            provider: "codex",
            model: "gpt-5.5",
            credentialSurface: "oauth",
            authMethod: "oauth_device_pkce",
            oauthCredentialStatus: "pending",
            credentialValuesIncluded: false,
          },
        },
        preserveUnrelatedConfig: true,
        writesConfig: false,
        writesTrustStore: false,
        dryRunOnly: true,
      },
    ],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 2,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 1,
    },
  };
}

function telegramPlan(values: ReviewValues, input: { readonly homeDir: string }): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-telegram-bundle"],
    operations: [{
      id: "test-telegram-capability",
      kind: "config-patch",
      sourceLineIds: ["test-telegram-line"],
      target: {
        kind: "config-scope",
        scope: ["channels"],
        path: profileConfigPath(input.homeDir),
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupModules.telegram.review",
        summaryKey: "setupModules.telegram.draft",
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

function auxiliaryPlan(values: ReviewValues): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-auxiliary-bundle"],
    operations: [{
      id: "test-auxiliary-route",
      kind: "config-patch",
      sourceLineIds: ["test-auxiliary-line"],
      target: {
        kind: "config-scope",
        scope: ["auxiliaryModels.*"],
        path: "/tmp/test/config.json",
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupDrafts.auxiliaryModelRoute.summary",
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

function uiPreferencesPlan(values: ReviewValues): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-ui-preferences-bundle"],
    operations: [{
      id: "test-ui-preferences",
      kind: "config-patch",
      sourceLineIds: ["test-ui-preferences-line"],
      target: {
        kind: "config-scope",
        scope: ["ui.language", "ui.flavor", "ui.activityLabels"],
        path: "/tmp/test/config.json",
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupDrafts.uiPreferences.summary",
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

function channelCapabilityPlan(summaryKey: "setupModules.discord.draft" | "setupModules.whatsapp.draft", values: ReviewValues): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-channel-bundle"],
    operations: [{
      id: "test-channel",
      kind: "config-patch",
      sourceLineIds: ["test-channel-line"],
      target: {
        kind: "config-scope",
        scope: ["channels"],
        path: "/tmp/test/config.json",
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey,
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

function voiceCapabilityPlan(values: ReviewValues, input: { readonly homeDir: string }): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-voice-bundle"],
    operations: [{
      id: "test-voice",
      kind: "config-patch",
      sourceLineIds: ["test-voice-line"],
      target: {
        kind: "config-scope",
        scope: ["voice"],
        path: profileConfigPath(input.homeDir),
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupModules.voice.draft",
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

function webSearchCapabilityPlan(values: ReviewValues, input: { readonly homeDir: string }): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-web-search-bundle"],
    operations: [{
      id: "test-web-search",
      kind: "config-patch",
      sourceLineIds: ["test-web-search-line"],
      target: {
        kind: "config-scope",
        scope: ["web"],
        path: profileConfigPath(input.homeDir),
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupModules.webSearch.review",
        summaryKey: "setupModules.webSearch.draft",
        redacted: true,
        values,
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
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

function readyEdgeTtsStatus(homeDir: string): Awaited<ReturnType<typeof capabilityManager.checkManagedPythonCapabilityStatus>> {
  const stateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
  return {
    ok: true,
    status: "verified",
    capabilityId: EDGE_TTS_CAPABILITY_ID,
    version: "7.2.8",
    specHash: "edge-hash",
    installedGroups: [],
    installedPackages: ["edge-tts==7.2.8"],
    pythonPath: join(stateRoot, "python-capabilities", EDGE_TTS_CAPABILITY_ID, "bin", "python"),
    envPath: join(stateRoot, "python-capabilities", EDGE_TTS_CAPABILITY_ID),
    manifest: {
      id: EDGE_TTS_CAPABILITY_ID,
      version: "7.2.8",
      specHash: "edge-hash",
      installedPackages: ["edge-tts==7.2.8"],
      installedGroups: [],
      pythonPath: join(stateRoot, "python-capabilities", EDGE_TTS_CAPABILITY_ID, "bin", "python"),
      envPath: join(stateRoot, "python-capabilities", EDGE_TTS_CAPABILITY_ID),
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
      verifiedAt: "2026-06-23T00:00:01.000Z",
      status: "verified",
    },
  };
}

function readyEdgeTtsInstallResult(homeDir: string): Awaited<ReturnType<typeof capabilityManager.installManagedPythonCapabilityEnvironment>> {
  const status = readyEdgeTtsStatus(homeDir);
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

function firstRunVoiceOptionalCapabilityPlan(values: ReviewValues, input: { readonly homeDir: string }): SetupApplyPlan {
  return {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: ["test-first-run-voice-bundle"],
    operations: [{
      id: "test-first-run-voice",
      kind: "config-patch",
      sourceLineIds: ["test-first-run-voice-line"],
      target: {
        kind: "config-scope",
        scope: ["voice"],
        path: profileConfigPath(input.homeDir),
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupDrafts.optionalCapabilities.summary",
        redacted: true,
        values: {
          capabilities: ["voice"],
          ...values,
        },
      },
      preserveUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
    }],
    eligibility: {
      eligible: true,
      blockers: [],
      repairIntents: [],
    },
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: 1,
      configOperationCount: 1,
      trustOperationCount: 0,
      credentialOperationCount: 0,
    },
  };
}

describe("reviewed setup apply executor", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("applies reviewed provider, security, workflow, and workspace trust changes", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
      securityMode: "strict",
      workflowLearning: "none",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.appliedOperationIds.length).toBeGreaterThan(0);
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
      security?: { approvalMode?: string };
      skills?: { autonomy?: string };
    };
    const trust = JSON.parse(await readFile(join(tempDir, ".estacoda", "trust.json"), "utf8")) as {
      grants?: Array<{ root?: string }>;
    };

    expect(config.model).toEqual({ provider: "local", id: "local-test-model" });
    expect(config.security?.approvalMode).toBe("strict");
    expect(config.skills?.autonomy).toBe("none");
    expect(trust.grants?.[0]?.root).toBe(await realpath(workspaceRoot));
  });

  it("applies reviewed UI preferences through setupUiConfig while preserving unrelated config", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
      security: { approvalMode: "strict" },
      ui: { language: "en", flavor: "standard", activityLabels: "en" },
    }, null, 2), "utf8");
    const plan = uiPreferencesPlan({
      language: "ar",
      flavor: "arabic-light",
      activityLabels: "ar",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string };
      security?: { approvalMode?: string };
      ui?: { language?: string; flavor?: string; activityLabels?: string };
    };

    expect(result.ok).toBe(true);
    expect(config.ui).toEqual({
      language: "ar",
      flavor: "arabic-light",
      activityLabels: "ar",
    });
    expect(config.model).toEqual({ provider: "local", id: "local-test-model" });
    expect(config.security).toEqual({ approvalMode: "strict" });
  });

  it("applies hosted credential references as provider route refs without raw secret values", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
      provider: "openai",
      model: "gpt-5.5",
      credentialEnv: "OPENAI_API_KEY",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { apiKeyEnv?: string }>;
    };

    expect(config.providers?.openai?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(rawConfig).not.toContain("sk-");
  });

  it("persists deferred secrets only through the reviewed apply execution hook", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
      provider: "openai",
      model: "gpt-5.5",
      credentialEnv: "OPENAI_APPLY_SECRET_KEY",
    });
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    const applyResult = await executor.apply(plan);

    expect(applyResult.ok).toBe(true);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();

    const secretResult = await executor.applyDeferredSecrets!(plan, [{
      envVarName: "OPENAI_APPLY_SECRET_KEY",
      value: "sk-reviewed-boundary-secret",
    }]);

    expect(secretResult).toEqual({
      ok: true,
      appliedSecretCount: 1,
    });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toContain(
      'OPENAI_APPLY_SECRET_KEY="sk-reviewed-boundary-secret"'
    );
  });

  it("rejects deferred secret writes that were not present in the reviewed credential plan", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
      provider: "openai",
      model: "gpt-5.5",
      credentialEnv: "OPENAI_REVIEWED_KEY",
    });
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    const secretResult = await executor.applyDeferredSecrets!(plan, [{
      envVarName: "UNREVIEWED_KEY",
      value: "sk-unreviewed-secret",
    }]);

    expect(secretResult.ok).toBe(false);
    expect(secretResult.appliedSecretCount).toBe(0);
    expect(secretResult.error).toContain("UNREVIEWED_KEY");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("persists deferred Codex OAuth only through the reviewed apply execution hook", async () => {
    const plan = codexOAuthPlan();
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    const applyResult = await executor.apply(plan);

    expect(applyResult.ok).toBe(true);
    await expect(readFile(profileAuthPath(tempDir), "utf8")).rejects.toThrow();
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    expect(rawConfig).not.toContain("codex-access-token");
    expect(JSON.parse(rawConfig)).toMatchObject({
      model: {
        provider: "codex",
        id: "gpt-5.5",
      },
      providers: {
        codex: {
          apiMode: "custom_openai_compatible",
          authMethod: "oauth_device_pkce",
        },
      },
    });

    const oauthResult = await executor.applyDeferredOAuth!(plan, [{
      providerId: "codex",
      authMethod: "oauth_device_pkce",
      tokenRecord: {
        authMethod: "oauth_device_pkce",
        accessToken: "codex-access-token",
        refreshToken: "codex-refresh-token",
        expiresAt: "2999-01-01T00:00:00.000Z",
        scopes: ["user"],
        source: "estacoda",
      },
    }]);

    expect(oauthResult).toEqual({
      ok: true,
      appliedOAuthCount: 1,
    });
    const authStore = JSON.parse(await readFile(profileAuthPath(tempDir), "utf8")) as {
      providers?: Record<string, { accessToken?: string; authMethod?: string }>;
    };
    expect(authStore.providers?.codex).toEqual(expect.objectContaining({
      authMethod: "oauth_device_pkce",
      accessToken: "codex-access-token",
    }));
  });

  it("rejects deferred OAuth writes that were not present in the reviewed credential plan", async () => {
    const plan = codexOAuthPlan();
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    const oauthResult = await executor.applyDeferredOAuth!(plan, [{
      providerId: "openai",
      authMethod: "oauth_device_pkce",
      tokenRecord: {
        authMethod: "oauth_device_pkce",
        accessToken: "unreviewed-access-token",
      },
    }]);

    expect(oauthResult.ok).toBe(false);
    expect(oauthResult.appliedOAuthCount).toBe(0);
    expect(oauthResult.error).toContain("openai:oauth_device_pkce");
    await expect(readFile(profileAuthPath(tempDir), "utf8")).rejects.toThrow();
  });

  it("rejects unreviewed Browserbase deferred secret writes", async () => {
    const plan: SetupApplyPlan = {
      kind: "setup-save-apply-plan",
      manifestSourceBundleIds: ["browserbase-credential-test"],
      operations: [{
        id: "browserbase-credentials",
        kind: "credential-reference",
        sourceLineIds: ["browserbase-credential-line"],
        review: {
          copyKey: "setupDrafts.review",
          summaryKey: "setupModules.credentials.draft",
          redacted: true,
          values: {
            credentialSurface: "browserbase",
            envVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
            credentialValuesIncluded: false,
          },
        },
        writesConfig: false,
        writesTrustStore: false,
        dryRunOnly: true,
      }],
      eligibility: {
        eligible: true,
        blockers: [],
        repairIntents: [],
      },
      preservesUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
      metadata: {
        operationCount: 1,
        configOperationCount: 0,
        trustOperationCount: 0,
        credentialOperationCount: 1,
      },
    };
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    const reviewedResult = await executor.applyDeferredSecrets!(plan, [{
      envVarName: "BROWSERBASE_API_KEY",
      value: "bb-reviewed-secret",
    }]);
    const unreviewedResult = await executor.applyDeferredSecrets!(plan, [{
      envVarName: "BROWSERBASE_UNREVIEWED_KEY",
      value: "bb-unreviewed-secret",
    }]);

    expect(reviewedResult).toEqual({
      ok: true,
      appliedSecretCount: 1,
    });
    expect(unreviewedResult.ok).toBe(false);
    expect(unreviewedResult.appliedSecretCount).toBe(0);
    expect(unreviewedResult.error).toContain("BROWSERBASE_UNREVIEWED_KEY");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toContain(
      'BROWSERBASE_API_KEY="bb-reviewed-secret"'
    );
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.not.toContain("bb-unreviewed-secret");
  });

  it("allows reviewed Voice deferred secret writes through voice credential references", async () => {
    const plan: SetupApplyPlan = {
      kind: "setup-save-apply-plan",
      manifestSourceBundleIds: ["voice-credential-test"],
      operations: [{
        id: "voice-tts-credential",
        kind: "credential-reference",
        sourceLineIds: ["voice-credential-line"],
        review: {
          copyKey: "setupDrafts.review",
          summaryKey: "setupModules.credentials.draft",
          redacted: true,
          values: {
            credentialSurface: "voice-tts",
            envVars: ["VOICE_TOOLS_OPENAI_KEY"],
            credentialValuesIncluded: false,
          },
        },
        writesConfig: false,
        writesTrustStore: false,
        dryRunOnly: true,
      }],
      eligibility: {
        eligible: true,
        blockers: [],
        repairIntents: [],
      },
      preservesUnrelatedConfig: true,
      writesConfig: false,
      writesTrustStore: false,
      dryRunOnly: true,
      metadata: {
        operationCount: 1,
        configOperationCount: 0,
        trustOperationCount: 0,
        credentialOperationCount: 1,
      },
    };
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    const applyResult = await executor.apply(plan);
    const secretResult = await executor.applyDeferredSecrets!(plan, [{
      envVarName: "VOICE_TOOLS_OPENAI_KEY",
      value: "voice-reviewed-secret",
    }]);
    const unreviewedResult = await executor.applyDeferredSecrets!(plan, [{
      envVarName: "VOICE_UNREVIEWED_KEY",
      value: "voice-unreviewed-secret",
    }]);

    expect(applyResult.ok).toBe(true);
    expect(secretResult).toEqual({
      ok: true,
      appliedSecretCount: 1,
    });
    expect(unreviewedResult.ok).toBe(false);
    expect(unreviewedResult.appliedSecretCount).toBe(0);
    expect(unreviewedResult.error).toContain("VOICE_UNREVIEWED_KEY");
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.toContain(
      'VOICE_TOOLS_OPENAI_KEY="voice-reviewed-secret"'
    );
    await expect(readFile(profileEnvPath(tempDir), "utf8")).resolves.not.toContain("voice-unreviewed-secret");
  });

  it("applies custom provider baseUrl and contextWindowTokens from review values", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
      provider: "openai",
      model: "gpt-5.5",
      baseUrl: "https://custom.example.com/v1",
      contextWindowTokens: 256000,
      credentialEnv: "OPENAI_API_KEY",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string; contextWindowTokens?: number };
      providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
    };

    expect(config.model).toEqual(expect.objectContaining({
      provider: "openai",
      id: "gpt-5.5",
      contextWindowTokens: 256000,
    }));
    expect(config.providers?.openai).toEqual(expect.objectContaining({
      baseUrl: "https://custom.example.com/v1",
    }));
  });

  it("registers reviewed fallback provider config while appending fallback routes", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
      providers: {
        local: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
      },
    }, null, 2), "utf8");
    const plan = fallbackPlan({
      fallbackOperation: "add",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.example/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindowTokens: 1000000,
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string; apiKeyEnv?: string }> };
      providers?: Record<string, {
        kind?: string;
        baseUrl?: string;
        apiKeyEnv?: string;
        enableNetwork?: boolean;
        models?: string[];
      }>;
    };

    expect(result.ok).toBe(true);
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("local-test-model");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "deepseek", id: "deepseek-v4-pro", apiKeyEnv: "DEEPSEEK_API_KEY" }),
    ]);
    expect(config.providers?.deepseek).toEqual(expect.objectContaining({
      kind: "openai-compatible",
      enableNetwork: true,
      baseUrl: "https://api.deepseek.example/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: ["deepseek-v4-pro"],
    }));
    expect(config.providers?.local).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
  });

  it("preserves existing fallback provider fields and avoids duplicate model IDs", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
      providers: {
        deepseek: {
          kind: "catalog",
          enableNetwork: false,
          baseUrl: "https://old.deepseek.example/v1",
          apiKeyEnv: "OLD_DEEPSEEK_API_KEY",
          apiMode: "openai_chat_completions",
          headers: { "X-Existing": "kept" },
          models: ["deepseek-chat", "deepseek-v4-pro"],
        },
      },
    }, null, 2), "utf8");
    const plan = fallbackPlan({
      fallbackOperation: "add",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.example/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindowTokens: 1000000,
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { fallbacks?: Array<{ provider?: string; id?: string; apiKeyEnv?: string }> };
      providers?: Record<string, {
        kind?: string;
        baseUrl?: string;
        apiKeyEnv?: string;
        apiMode?: string;
        enableNetwork?: boolean;
        headers?: Record<string, string>;
        models?: string[];
      }>;
    };

    expect(result.ok).toBe(true);
    expect(config.providers?.deepseek).toEqual(expect.objectContaining({
      kind: "openai-compatible",
      enableNetwork: true,
      baseUrl: "https://api.deepseek.example/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiMode: "openai_chat_completions",
      headers: { "X-Existing": "kept" },
      models: ["deepseek-chat", "deepseek-v4-pro"],
    }));
    expect(config.providers?.deepseek?.models?.filter((id) => id === "deepseek-v4-pro")).toHaveLength(1);
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "deepseek", id: "deepseek-v4-pro", apiKeyEnv: "DEEPSEEK_API_KEY" }),
    ]);
  });

  it("replaces a reviewed fallback route while preserving surrounding fallbacks and unrelated config", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: {
        provider: "local",
        id: "local-test-model",
        fallbacks: [
          { provider: "openai", id: "gpt-5.5" },
          { provider: "kimi", id: "kimi-k2" },
          { provider: "anthropic", id: "claude-3-5-haiku" },
        ],
      },
      security: { approvalMode: "strict", assessor: { enabled: true } },
    }, null, 2), "utf8");
    const plan = fallbackPlan({
      fallbackOperation: "replace",
      fallbackIndex: 1,
      previousProvider: "kimi",
      previousModel: "kimi-k2",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { fallbacks?: Array<{ provider?: string; id?: string }> };
      security?: { approvalMode?: string; assessor?: { enabled?: boolean } };
    };

    expect(result.ok).toBe(true);
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5" }),
      expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
      expect.objectContaining({ provider: "anthropic", id: "claude-3-5-haiku" }),
    ]);
    expect(config.security).toEqual({ approvalMode: "strict", assessor: { enabled: true } });
  });

  it("handles invalid fallback replacement indexes safely", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: {
        provider: "local",
        id: "local-test-model",
        fallbacks: [{ provider: "openai", id: "gpt-5.5" }],
      },
    }, null, 2), "utf8");
    const plan = fallbackPlan({
      fallbackOperation: "replace",
      fallbackIndex: 4,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { fallbacks?: Array<{ provider?: string; id?: string }> };
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("valid fallback index");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5" }),
    ]);
  });

  it("applies a reviewed auxiliary route while preserving primary and fallback config", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: {
        provider: "local",
        id: "local-test-model",
        fallbacks: [{ provider: "openai", id: "gpt-5.5" }],
      },
      auxiliaryModels: {
        assessor: { provider: "local", id: "assessor-local", enabled: true },
        session_search: { provider: "local", id: "search-local", enabled: true },
      },
      security: { approvalMode: "strict" },
    }, null, 2), "utf8");
    const plan = auxiliaryPlan({
      auxiliaryTask: "compression",
      provider: "openai",
      model: "gpt-5.5",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      contextWindowTokens: 128000,
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string }> };
      auxiliaryModels?: Record<string, { provider?: string; id?: string; apiKeyEnv?: string; enabled?: boolean }>;
      security?: { approvalMode?: string };
    };

    expect(result.ok).toBe(true);
    expect(config.model).toEqual({
      provider: "local",
      id: "local-test-model",
      fallbacks: [expect.objectContaining({ provider: "openai", id: "gpt-5.5" })],
    });
    expect(config.auxiliaryModels?.compression).toEqual(expect.objectContaining({
      provider: "openai",
      id: "gpt-5.5",
      apiKeyEnv: "OPENAI_API_KEY",
      enabled: true,
    }));
    expect(config.auxiliaryModels?.assessor).toEqual({ provider: "local", id: "assessor-local", enabled: true });
    expect(config.auxiliaryModels?.session_search).toEqual({ provider: "local", id: "search-local", enabled: true });
    expect(config.security).toEqual({ approvalMode: "strict" });
  });

  it("updates assessor only through the reviewed auxiliary operation", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: {
        provider: "local",
        id: "local-test-model",
        fallbacks: [{ provider: "openai", id: "gpt-5.5" }],
      },
      auxiliaryModels: {
        assessor: { provider: "auto", enabled: true },
        compression: { provider: "local", id: "summary-local", enabled: true },
      },
    }, null, 2), "utf8");
    const plan = auxiliaryPlan({
      auxiliaryTask: "assessor",
      provider: "openai",
      model: "gpt-5.5",
      apiKeyEnv: "OPENAI_API_KEY",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { fallbacks?: Array<{ provider?: string; id?: string }> };
      auxiliaryModels?: Record<string, { provider?: string; id?: string; apiKeyEnv?: string; enabled?: boolean }>;
    };

    expect(result.ok).toBe(true);
    expect(config.auxiliaryModels?.assessor).toEqual(expect.objectContaining({
      provider: "openai",
      id: "gpt-5.5",
      apiKeyEnv: "OPENAI_API_KEY",
      enabled: true,
    }));
    expect(config.auxiliaryModels?.compression).toEqual({ provider: "local", id: "summary-local", enabled: true });
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5" }),
    ]);
  });

  it("rejects unsupported auxiliary task review values safely", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
      auxiliaryModels: {
        assessor: { provider: "local", id: "assessor-local", enabled: true },
      },
    }, null, 2), "utf8");
    const plan = auxiliaryPlan({
      auxiliaryTask: "vision",
      provider: "openai",
      model: "gpt-5.5",
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      auxiliaryModels?: Record<string, unknown>;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Auxiliary route apply requires");
    expect(config.auxiliaryModels?.assessor).toEqual({ provider: "local", id: "assessor-local", enabled: true });
    expect(config.auxiliaryModels?.vision).toBeUndefined();
  });

  it("applies reviewed browser capability fields without overriding auto-launch", async () => {
    const plan = modulePlan({
      configPath: profileConfigPath(tempDir),
      workspaceRoot,
      trustStorePath: join(tempDir, ".estacoda", "trust.json"),
      provider: { id: "local", model: "local-test-model" },
      workspaceTrust: { trusted: true },
      securityMode: "adaptive",
      workflowLearning: "suggest",
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        cdpUrl: "http://127.0.0.1:9222",
        launchExecutable: "/usr/bin/chromium",
        launchArgs: ["--headless=new"],
        chromeFlags: ["--no-first-run", "--disable-gpu"],
        autoLaunch: true,
        supervised: true,
        engine: "cdp",
        hybridRouting: true,
        cloudFallback: true,
        cloudSpendApproved: false,
        summarizeSnapshots: false,
        snapshotSummarizeThreshold: 16_000,
      },
      skippedModules: ["telegram", "voice", "vision"],
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      browser?: {
        backend?: string;
        cloudProvider?: string;
        cdpUrl?: string;
        launchExecutable?: string;
        launchArgs?: string[];
        chromeFlags?: string[];
        autoLaunch?: boolean;
        supervised?: boolean;
        engine?: string;
        hybridRouting?: boolean;
        cloudFallback?: boolean;
        cloudSpendApproved?: boolean | string;
        summarizeSnapshots?: boolean | string;
        snapshotSummarizeThreshold?: number;
      };
    };

    expect(config.browser).toEqual({
      backend: "browserbase",
      cloudProvider: "browserbase",
      cdpUrl: "http://127.0.0.1:9222",
      launchExecutable: "/usr/bin/chromium",
      launchArgs: ["--headless=new"],
      chromeFlags: ["--no-first-run", "--disable-gpu"],
      autoLaunch: true,
      supervised: true,
      engine: "cdp",
      hybridRouting: true,
      cloudFallback: true,
      cloudSpendApproved: false,
      summarizeSnapshots: false,
      snapshotSummarizeThreshold: 16_000,
    });
  });

  it("applies reviewed Brave Search config without writing raw secrets", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      web: {
        enableNetwork: true,
        maxContentChars: 12345,
        extractBackend: "stub",
      },
    }, null, 2), "utf8");
    const plan = webSearchCapabilityPlan({
      searchBackend: "brave",
      extractBackend: "stub",
      braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
      braveCredentialReady: true,
      braveCredentialValuesIncluded: false,
      secretValue: "must-not-be-written",
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      web?: {
        enableNetwork?: boolean;
        maxContentChars?: number;
        searchBackend?: string;
        extractBackend?: string;
        brave?: { apiKeyEnv?: string; apiKey?: string };
      };
    };

    expect(result.ok).toBe(true);
    expect(config.web).toEqual({
      enableNetwork: true,
      maxContentChars: 12345,
      searchBackend: "brave",
      extractBackend: "stub",
      brave: {
        apiKeyEnv: "BRAVE_SEARCH_API_KEY",
      },
    });
    expect(rawConfig).not.toContain("must-not-be-written");
    expect(config.web?.brave?.apiKey).toBeUndefined();
  });

  it("applies DDGS Search config when the registered capability is already ready", async () => {
    const statusSpy = vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue(readyDdgsStatus(tempDir));
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));
    const plan = webSearchCapabilityPlan({
      searchBackend: "ddgs",
      ddgsCapabilityId: DDGS_CAPABILITY_ID,
      ddgsCapabilityStatus: "ready",
      ddgsSetupConfirmed: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      web?: { searchBackend?: string };
    };

    expect(result.ok).toBe(true);
    expect(statusSpy).toHaveBeenCalledWith({
      stateRoot: resolveGlobalStateHome({ homeDir: tempDir }).stateRoot,
      capabilityId: DDGS_CAPABILITY_ID,
    });
    expect(installSpy).not.toHaveBeenCalled();
    expect(config.web?.searchBackend).toBe("ddgs");
  });

  it("installs only the registered DDGS capability when explicitly confirmed", async () => {
    const stateRoot = resolveGlobalStateHome({ homeDir: tempDir }).stateRoot;
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));
    const plan = webSearchCapabilityPlan({
      searchBackend: "ddgs",
      ddgsCapabilityId: DDGS_CAPABILITY_ID,
      ddgsCapabilityStatus: "missing",
      ddgsSetupConfirmed: true,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      web?: { searchBackend?: string };
    };

    expect(result.ok).toBe(true);
    expect(installSpy).toHaveBeenCalledWith({
      stateRoot,
      capabilityId: DDGS_CAPABILITY_ID,
    });
    expect(config.web?.searchBackend).toBe("ddgs");
  });

  it("does not install DDGS without explicit confirmation and preserves existing web config", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    const initialConfig = {
      web: {
        enableNetwork: true,
        searchBackend: "stub",
        maxContentChars: 5000,
      },
    };
    await writeFile(profileConfigPath(tempDir), JSON.stringify(initialConfig, null, 2), "utf8");
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyDdgsInstallResult(tempDir));
    const plan = webSearchCapabilityPlan({
      searchBackend: "ddgs",
      ddgsCapabilityId: DDGS_CAPABILITY_ID,
      ddgsCapabilityStatus: "missing",
      ddgsSetupConfirmed: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires explicit managed Python capability setup confirmation");
    expect(installSpy).not.toHaveBeenCalled();
    expect(config).toEqual(initialConfig);
  });

  it("returns actionable copy when confirmed DDGS setup fails", async () => {
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
      diagnostic: "pip failed",
    });
    const plan = webSearchCapabilityPlan({
      searchBackend: "ddgs",
      ddgsCapabilityId: DDGS_CAPABILITY_ID,
      ddgsCapabilityStatus: "missing",
      ddgsSetupConfirmed: true,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("DDGS managed Python capability setup failed");
    expect(result.error).toContain("Could not install ddgs.");
  });

  it("warns and leaves web config unchanged when first-run DDGS setup fails", async () => {
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
    const plan = webSearchCapabilityPlan({
      searchBackend: "ddgs",
      ddgsCapabilityId: DDGS_CAPABILITY_ID,
      ddgsCapabilityStatus: "missing",
      ddgsSetupConfirmed: true,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8").catch(() => "{}")) as {
      web?: unknown;
    };

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({
      capability: "web-search",
      subCapability: "search",
      code: "managed_python_setup_failed",
      message: resolveSetupCopy("en", "onboarding.optionalCapabilities.webSearch.ddgsSkipped"),
      cause: "Could not install ddgs.",
    })]);
    expect(JSON.stringify(result.warnings)).not.toContain("Traceback");
    expect(config.web).toBeUndefined();
  });

  it("installs the registered Edge TTS capability before applying reviewed Edge voice setup", async () => {
    const stateRoot = resolveGlobalStateHome({ homeDir: tempDir }).stateRoot;
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: EDGE_TTS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    const installSpy = vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue(readyEdgeTtsInstallResult(tempDir));
    const plan = voiceCapabilityPlan({
      ttsProvider: "edge",
      edgeTtsCapabilityId: EDGE_TTS_CAPABILITY_ID,
      edgeTtsCapabilityStatus: "missing",
      edgeTtsSetupConfirmed: true,
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      tts?: { provider?: string };
    };

    expect(result.ok).toBe(true);
    expect(installSpy).toHaveBeenCalledWith({
      stateRoot,
      capabilityId: EDGE_TTS_CAPABILITY_ID,
    });
    expect(config.tts?.provider).toBe("edge");
  });

  it("does not write Edge TTS config when strict reviewed capability setup fails", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    const initialConfig = {
      model: { provider: "local", id: "local-test-model" },
      tts: {
        provider: "openai",
        speed: 1,
        openai: { model: "gpt-4o-mini-tts", apiKeyEnv: "OPENAI_API_KEY" },
      },
    };
    await writeFile(profileConfigPath(tempDir), JSON.stringify(initialConfig, null, 2), "utf8");
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: EDGE_TTS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue({
      ok: false,
      capabilityId: EDGE_TTS_CAPABILITY_ID,
      reason: "pip_install_failed",
      message: "Could not install edge-tts.",
      diagnostic: "pip failed",
    });
    const plan = voiceCapabilityPlan({
      ttsProvider: "edge",
      edgeTtsCapabilityId: EDGE_TTS_CAPABILITY_ID,
      edgeTtsCapabilityStatus: "missing",
      edgeTtsSetupConfirmed: true,
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Edge TTS managed Python capability setup failed");
    expect(result.error).toContain("Could not install edge-tts.");
    expect(config).toEqual(initialConfig);
  });

  it("warns and skips Edge TTS when first-run managed capability setup fails", async () => {
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: EDGE_TTS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });
    vi.spyOn(capabilityManager, "installManagedPythonCapabilityEnvironment").mockResolvedValue({
      ok: false,
      capabilityId: EDGE_TTS_CAPABILITY_ID,
      reason: "pip_install_failed",
      message: "Could not install edge-tts.",
      diagnostic: "Traceback: hidden details",
    });
    const plan = firstRunVoiceOptionalCapabilityPlan({
      ttsProvider: "edge",
      edgeTtsCapabilityId: EDGE_TTS_CAPABILITY_ID,
      edgeTtsCapabilityStatus: "missing",
      edgeTtsSetupConfirmed: true,
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttApiKeyEnv: "OPENAI_API_KEY",
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      tts?: unknown;
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
    };

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({
      operationId: "test-first-run-voice",
      capability: "voice",
      subCapability: "tts",
      code: "managed_python_setup_failed",
      message: resolveSetupCopy("en", "onboarding.optionalCapabilities.voice.edgeTtsSkipped"),
      cause: "Could not install edge-tts.",
    })]);
    expect(JSON.stringify(result.warnings)).not.toContain("Traceback");
    expect(config.tts).toBeUndefined();
    expect(config.stt).toEqual({
      provider: "openai",
      openai: {
        model: "gpt-4o-mini-transcribe",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });
  });

  it("creates the managed Python environment before applying reviewed local STT", async () => {
    const stateRoot = resolveGlobalStateHome({ homeDir: tempDir }).stateRoot;
    const createSpy = vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: true,
      pythonBinary: join(stateRoot, "python-env", "bin", "python"),
    });
    const plan = voiceCapabilityPlan({
      sttProvider: "local",
      sttModel: "small",
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      stt?: {
        provider?: string;
        local?: {
          model?: string;
          engine?: string;
          fasterWhisper?: { enabled?: boolean; model?: string; allowModelDownload?: boolean };
        };
      };
    };

    expect(result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledWith({ stateRoot });
    expect(config.stt).toEqual({
      provider: "local",
      local: {
        model: "small",
        engine: "faster-whisper",
        fasterWhisper: {
          enabled: true,
          model: "small",
          allowModelDownload: true,
        },
      },
    });
  });

  it("does not write local STT config when managed Python setup fails", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    const initialConfig = {
      model: { provider: "local", id: "local-test-model" },
      stt: {
        provider: "openai",
        openai: { model: "gpt-4o-mini-transcribe", apiKeyEnv: "OPENAI_API_KEY" },
      },
    };
    await writeFile(profileConfigPath(tempDir), JSON.stringify(initialConfig, null, 2), "utf8");
    vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: false,
      reason: "ensurepip is not available",
    });
    const plan = firstRunVoiceOptionalCapabilityPlan({
      sttProvider: "local",
      sttModel: "base",
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Local faster-whisper STT setup failed");
    expect(result.error).toContain("ensurepip is not available");
    expect(config).toEqual(initialConfig);
  });

  it("preserves existing TTS and skips local STT when managed Python setup fails in first-run tolerant mode", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    const initialConfig = {
      model: { provider: "local", id: "local-test-model" },
      tts: {
        provider: "openai",
        speed: 1,
        openai: { model: "gpt-4o-mini-tts", apiKeyEnv: "OPENAI_API_KEY" },
      },
    };
    await writeFile(profileConfigPath(tempDir), JSON.stringify(initialConfig, null, 2), "utf8");
    vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: false,
      reason: "ensurepip is not available",
    });
    const plan = firstRunVoiceOptionalCapabilityPlan({
      sttProvider: "local",
      sttModel: "base",
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      tts?: unknown;
      stt?: unknown;
    };

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([{
      operationId: "test-first-run-voice",
      capability: "voice",
      subCapability: "stt",
      code: "managed_python_setup_failed",
      message: "Setup completed, but local faster-whisper STT was skipped because EstaCoda could not create its managed Python environment. Fix Python venv support, then reconfigure local STT from setup.",
      cause: "ensurepip is not available",
    }]);
    expect(config.tts).toEqual(initialConfig.tts);
    expect(config.stt).toBeUndefined();
  });

  it("writes new TTS and skips local STT when managed Python setup fails in first-run tolerant mode", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
    }, null, 2), "utf8");
    vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: false,
      reason: "ensurepip is not available",
    });
    const plan = firstRunVoiceOptionalCapabilityPlan({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "OPENAI_API_KEY",
      sttProvider: "local",
      sttModel: "base",
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      stt?: unknown;
    };

    expect(result.ok).toBe(true);
    expect(result.warnings?.[0]).toEqual(expect.objectContaining({
      operationId: "test-first-run-voice",
      capability: "voice",
      subCapability: "stt",
      code: "managed_python_setup_failed",
      cause: "ensurepip is not available",
    }));
    expect(result.warnings?.[0]?.message).toContain("local faster-whisper STT was skipped");
    expect(config.tts).toEqual({
      provider: "openai",
      speed: 1,
      openai: {
        model: "gpt-4o-mini-tts",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });
    expect(config.stt).toBeUndefined();
  });

  it("preserves existing STT when applying a TTS-only voice change", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    const initialStt = {
      provider: "openai",
      openai: { model: "gpt-4o-mini-transcribe", apiKeyEnv: "OPENAI_API_KEY" },
    };
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
      stt: initialStt,
    }, null, 2), "utf8");
    const createSpy = vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: true,
      pythonBinary: "/should-not-be-used",
    });
    const plan = voiceCapabilityPlan({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "OPENAI_API_KEY",
      secretValuesIncluded: false,
    }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      stt?: unknown;
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
    };

    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    expect(config.stt).toEqual(initialStt);
    expect(config.tts).toEqual({
      provider: "openai",
      speed: 1,
      openai: {
        model: "gpt-4o-mini-tts",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });
  });

  it("does not create the managed Python environment for cloud STT or TTS-only voice apply", async () => {
    const createSpy = vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
      ok: true,
      pythonBinary: "/should-not-be-used",
    });
    const cloudResult = await applyReviewedSetupPlanOperations(voiceCapabilityPlan({
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttApiKeyEnv: "OPENAI_API_KEY",
      secretValuesIncluded: false,
    }, { homeDir: tempDir }), {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const ttsResult = await applyReviewedSetupPlanOperations(voiceCapabilityPlan({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "OPENAI_API_KEY",
      secretValuesIncluded: false,
    }, { homeDir: tempDir }), {
      homeDir: tempDir,
      workspaceRoot,
      mode: "firstRunTolerant",
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
    };

    expect(cloudResult.ok).toBe(true);
    expect(ttsResult.ok).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
    expect(config.stt).toEqual({
      provider: "openai",
      openai: {
        model: "gpt-4o-mini-transcribe",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });
    expect(config.tts).toEqual({
      provider: "openai",
      speed: 1,
      openai: {
        model: "gpt-4o-mini-tts",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    });
  });

  it("blocks remote-control capabilities without allowlisted identities", async () => {
    const plan = telegramPlan({ botTokenEnv: "TELEGRAM_BOT_TOKEN" }, { homeDir: tempDir });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Telegram apply requires allowed user or chat identities.");
  });

  it("applies reviewed Discord and WhatsApp beta channel config through channel dispatch", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "local-test-model" },
    }, null, 2), "utf8");

    const discordResult = await applyReviewedSetupPlanOperations(channelCapabilityPlan("setupModules.discord.draft", {
      botTokenEnv: "DISCORD_BOT_TOKEN",
      allowedUsers: ["user-1"],
      allowedGuilds: ["guild-1"],
      allowedChannels: [],
    }), {
      homeDir: tempDir,
      workspaceRoot,
    });
    const whatsappResult = await applyReviewedSetupPlanOperations(channelCapabilityPlan("setupModules.whatsapp.draft", {
      authDir: join(tempDir, ".estacoda", "profiles", "default", "gateway", "whatsapp-auth"),
      allowedUsers: ["971501234567"],
    }), {
      homeDir: tempDir,
      workspaceRoot,
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      channels?: {
        discord?: { enabled?: boolean; botTokenEnv?: string; allowedUsers?: string[]; allowedGuilds?: string[] };
        whatsapp?: { enabled?: boolean; experimental?: boolean; authDir?: string; allowedUsers?: string[] };
      };
    };

    expect(discordResult.ok).toBe(true);
    expect(whatsappResult.ok).toBe(true);
    expect(config.channels?.discord).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "DISCORD_BOT_TOKEN",
      allowedUsers: ["user-1"],
      allowedGuilds: ["guild-1"],
    }));
    expect(config.channels?.whatsapp).toEqual(expect.objectContaining({
      enabled: true,
      experimental: true,
      allowedUsers: ["971501234567"],
    }));
  });

  it("rejects reviewed Discord and WhatsApp beta channel config without allowlists", async () => {
    const discordResult = await applyReviewedSetupPlanOperations(channelCapabilityPlan("setupModules.discord.draft", {
      botTokenEnv: "DISCORD_BOT_TOKEN",
      allowedUsers: [],
      allowedChannels: [],
    }), {
      homeDir: tempDir,
      workspaceRoot,
    });
    const whatsappResult = await applyReviewedSetupPlanOperations(channelCapabilityPlan("setupModules.whatsapp.draft", {
      allowedUsers: [],
    }), {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(discordResult.ok).toBe(false);
    expect(discordResult.error).toContain("Discord apply requires");
    expect(whatsappResult.ok).toBe(false);
    expect(whatsappResult.error).toContain("WhatsApp apply requires");
  });

  it("rejects reviewed WhatsApp beta auth directories outside the selected profile WhatsApp auth directory", async () => {
    const result = await applyReviewedSetupPlanOperations(channelCapabilityPlan("setupModules.whatsapp.draft", {
      authDir: join(tempDir, "outside-whatsapp-auth"),
      allowedUsers: ["971501234567"],
    }), {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("selected profile WhatsApp auth directory");
  });

  it("stops verification when save/apply fails", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
    });
    const badPlan: SetupApplyPlan = {
      ...plan,
      operations: plan.operations.map((operation, index) => index === 0
        ? {
            ...operation,
            review: {
              ...operation.review,
              summaryKey: "setupDrafts.unknown.summary",
            },
          }
        : operation),
    };
    let verifyCalls = 0;
    const executor = createReviewedSetupApplyExecutor({
      homeDir: tempDir,
      workspaceRoot,
    });

    const endState = await executeSetupApplyPlan(badPlan, {
      ...executor,
      verify: () => {
        verifyCalls += 1;
        throw new Error("verification should not run");
      },
    });

    expect(endState.kind).toBe("blocked");
    if (endState.kind !== "blocked") throw new Error("expected blocked");
    expect(endState.reason).toBe("save-failed");
    expect(verifyCalls).toBe(0);
  });

  it("runs post-save verification through the reviewed executor", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
    });

    const endState = await executeReviewedSetupApplyPlan(plan, {
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
        configSources: [profileConfigPath(tempDir)],
        warnings: [],
        issueCodes: [],
      }),
    });

    expect(endState.kind).toBe("verified-ready");
    if (endState.kind !== "verified-ready") throw new Error("expected verified-ready");
    expect(endState.verification?.providerDiagnostic.status).toBe("ready");
  });

  it("defaults reviewed apply execution to strict mode", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
    });
    let observedMode: SetupApplyMode | undefined;

    const endState = await executeReviewedSetupApplyPlan(plan, {
      homeDir: tempDir,
      workspaceRoot,
      collectVerification: (options) => {
        observedMode = options.mode;
        return {
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
          configSources: [profileConfigPath(tempDir)],
          warnings: [],
          issueCodes: [],
        };
      },
    });

    expect(endState.kind).toBe("verified-ready");
    expect(observedMode).toBe("strict");
  });

  it("passes explicit reviewed apply mode through execution options", async () => {
    const plan = onboardingPlan({
      homeDir: tempDir,
      workspaceRoot,
    });
    let observedMode: SetupApplyMode | undefined;

    const endState = await executeReviewedSetupApplyPlan(plan, {
      homeDir: tempDir,
      workspaceRoot,
      mode: "strict",
      collectVerification: (options) => {
        observedMode = options.mode;
        return {
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
          configSources: [profileConfigPath(tempDir)],
          warnings: [],
          issueCodes: [],
        };
      },
    }, {
      mode: "firstRunTolerant",
    });

    expect(endState.kind).toBe("verified-ready");
    expect(observedMode).toBe("firstRunTolerant");
  });

  describe("verifyReviewedSetup profile config loading", () => {
    it("ignores workspace-local config files", async () => {
      await mkdir(join(workspaceRoot, ".estacoda"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".estacoda", "config.json"),
        JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } })
      );
      const executor = createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      });
      const report = await executor.verify!({ kind: "post-save-verification-request", sourceLineIds: [], readOnly: true });
      expect(report.configSources.some((s) => s.includes(join(workspaceRoot, ".estacoda", "config.json")))).toBe(false);
    });
  });
});

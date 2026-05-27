import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildFirstRunDraftBundle } from "../setup-drafts.js";
import { buildSetupModuleDraftBundle, type SetupModuleContext } from "../setup-modules.js";
import { buildSetupReviewManifest } from "../setup-review-manifest.js";
import { executeSetupApplyPlan, planSetupApply, type SetupApplyPlan } from "../setup-apply-plan.js";
import type { FirstRunPlanSession } from "../setup-router.js";
import {
  applyReviewedSetupPlanOperations,
  createReviewedSetupApplyExecutor,
  executeReviewedSetupApplyPlan,
} from "./apply-executor.js";
import { resolveProfileStateHome } from "../../config/profile-home.js";

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

function firstRunPlan(input: {
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly contextWindowTokens?: number;
  readonly credentialEnv?: string;
  readonly securityMode?: "strict" | "adaptive" | "open";
  readonly workflowLearning?: "none" | "suggest" | "proactive" | "autonomous";
  readonly optionalCapabilities?: readonly ("channels" | "voice" | "vision" | "browser")[];
  readonly launchSelected?: boolean;
  readonly verifySelected?: boolean;
}): SetupApplyPlan {
  const provider = input.provider ?? "local";
  const credential = input.credentialEnv === undefined
    ? { kind: "none" as const }
    : { kind: "env" as const, name: input.credentialEnv };
  const bundle = buildFirstRunDraftBundle({
    plan: {
      selections: {
        workspaceRoot: input.workspaceRoot,
        workspaceTrusted: true,
        primaryProvider: provider,
        primaryModel: input.model ?? "hermes-local",
        primaryBaseUrl: input.baseUrl,
        primaryContextWindowTokens: input.contextWindowTokens,
        primaryCredential: credential,
        securityMode: input.securityMode ?? "adaptive",
        workflowLearning: input.workflowLearning ?? "suggest",
        optionalCapabilities: input.optionalCapabilities ?? [],
        optionalCapabilitiesSkipped: (input.optionalCapabilities?.length ?? 0) === 0,
        verifySelected: input.verifySelected ?? false,
        launchSelected: input.launchSelected ?? false,
      },
    },
  } as FirstRunPlanSession, {
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

describe("reviewed setup apply executor", () => {
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

  it("applies reviewed provider, security, workflow, and workspace trust changes", async () => {
    const plan = firstRunPlan({
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

    expect(config.model).toEqual({ provider: "local", id: "hermes-local" });
    expect(config.security?.approvalMode).toBe("strict");
    expect(config.skills?.autonomy).toBe("none");
    expect(trust.grants?.[0]?.root).toBe(await realpath(workspaceRoot));
  });

  it("applies hosted credential references as provider route refs without raw secret values", async () => {
    const plan = firstRunPlan({
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

  it("applies custom provider baseUrl and contextWindowTokens from review values", async () => {
    const plan = firstRunPlan({
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

  it("appends reviewed fallback routes without mutating the primary route", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: { provider: "local", id: "hermes-local" },
      providers: {
        local: { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" },
      },
    }, null, 2), "utf8");
    const plan = fallbackPlan({
      fallbackOperation: "add",
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
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string; apiKeyEnv?: string }> };
    };

    expect(result.ok).toBe(true);
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("hermes-local");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5", apiKeyEnv: "OPENAI_API_KEY" }),
    ]);
  });

  it("replaces a reviewed fallback route while preserving surrounding fallbacks and unrelated config", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), JSON.stringify({
      model: {
        provider: "local",
        id: "hermes-local",
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
        id: "hermes-local",
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
        id: "hermes-local",
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
      id: "hermes-local",
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
        id: "hermes-local",
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
      model: { provider: "local", id: "hermes-local" },
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

  it("applies reviewed browser capability without enabling auto-launch", async () => {
    const plan = modulePlan({
      configPath: profileConfigPath(tempDir),
      workspaceRoot,
      trustStorePath: join(tempDir, ".estacoda", "trust.json"),
      provider: { id: "local", model: "hermes-local" },
      workspaceTrust: { trusted: true },
      securityMode: "adaptive",
      workflowLearning: "suggest",
      browser: {
        backend: "local-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        autoLaunch: true,
      },
      skippedModules: ["telegram", "voice", "vision"],
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(true);
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      browser?: { backend?: string; cdpUrl?: string; autoLaunch?: boolean };
    };

    expect(config.browser).toEqual({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:9222",
      autoLaunch: false,
    });
  });

  it("blocks remote-control capabilities without allowlisted identities", async () => {
    const plan = firstRunPlan({
      homeDir: tempDir,
      workspaceRoot,
      optionalCapabilities: ["channels"],
    });

    const result = await applyReviewedSetupPlanOperations(plan, {
      homeDir: tempDir,
      workspaceRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Remote-control capabilities require");
  });

  it("stops verification when save/apply fails", async () => {
    const plan = firstRunPlan({
      homeDir: tempDir,
      workspaceRoot,
      verifySelected: true,
      launchSelected: true,
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
    const plan = firstRunPlan({
      homeDir: tempDir,
      workspaceRoot,
      verifySelected: true,
      launchSelected: false,
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

    expect(endState.kind).toBe("saved-not-launched");
    if (endState.kind !== "saved-not-launched") throw new Error("expected saved-not-launched");
    expect(endState.verification?.providerDiagnostic.status).toBe("ready");
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

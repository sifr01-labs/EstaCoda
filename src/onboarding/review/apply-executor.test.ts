import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
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

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-reviewed-apply-"));
}

function firstRunPlan(input: {
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly provider?: string;
  readonly model?: string;
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
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
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

  it("applies hosted credential references without raw secret values", async () => {
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
    const rawConfig = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    const config = JSON.parse(rawConfig) as {
      providers?: Record<string, { apiKeyEnv?: string }>;
      credentialPools?: Record<string, { entries?: Array<{ source?: { kind?: string; name?: string } }> }>;
    };

    expect(config.providers?.openai?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(config.credentialPools?.openai?.entries?.[0]?.source).toEqual({ kind: "env", name: "OPENAI_API_KEY" });
    expect(rawConfig).not.toContain("sk-");
  });

  it("applies reviewed browser capability without enabling auto-launch", async () => {
    const plan = modulePlan({
      configPath: join(tempDir, ".estacoda", "config.json"),
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
    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
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
        configSources: [join(tempDir, ".estacoda", "config.json")],
        warnings: [],
        issueCodes: [],
      }),
    });

    expect(endState.kind).toBe("saved-not-launched");
    if (endState.kind !== "saved-not-launched") throw new Error("expected saved-not-launched");
    expect(endState.verification?.providerDiagnostic.status).toBe("ready");
  });
});

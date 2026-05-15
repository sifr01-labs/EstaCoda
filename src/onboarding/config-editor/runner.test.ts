import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/readline-prompt.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../../contracts/provider.js";
import type { FlowEngine } from "../../providers/provider-model-selection-flow.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { runConfigEditor } from "./runner.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-config-editor-"));
}

describe("runConfigEditor", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await chmod(join(tempDir, ".estacoda"), 0o700).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("renders configured setup sections and exits without mutating config", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    const output: string[] = [];
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "cancel-setup-editor",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("configured-menu");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("configured");
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.applyEndState).toBeUndefined();
    expect(applyCalled).toBe(false);
    expect(output.join("")).toContain("EstaCoda guided setup editor");
    expect(output.join("")).toContain("Available setup actions:");
    expect(output.join("")).toContain("edit-security-mode");
    expect(output.join("")).toContain("edit-workflow-learning");
    expect(output.join("")).toContain("review-optional-capabilities");
    expect(output.join("")).toContain("verify-setup - Verify setup");
    expect(output.join("")).toContain("show-diagnostics - Show diagnostics");
    expect(output.join("")).toContain("exit - Exit");
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).resolves.toBe(before);
  });

  it("prepares the read-only verification route without applying changes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "run-readonly-verification",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.selectedActionId).toBe("verify-setup");
    expect(result.finalDecision?.kind).toBe("verify-readonly");
    expect(result.finalDecision?.setupEditorPlanSession).toBeUndefined();
    expect(result.output).toContain("Read-only setup verification route prepared");
  });

  it("shows diagnostics for configured states without requiring a repair route action", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "show-diagnostics",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("configured-menu");
    expect(result.selectedActionId).toBe("show-diagnostics");
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: configured-ready");
  });

  it("rejects unsupported route actions in the guided editor", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "review-edit-config",
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.selectedActionId).toBe("review-edit-config");
    expect(result.output).toContain("not available in the guided setup editor");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.applyEndState).toBeUndefined();
  });

  it("applies reviewed security mode changes while preserving unrelated config", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      security: {
        approvalMode: "adaptive",
        assessor: {
          enabled: true,
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["strict"] }),
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
      model?: unknown;
      providers?: unknown;
      security?: { approvalMode?: string; assessor?: { enabled?: boolean } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.reviewManifest?.sections["security-mode"].length).toBe(1);
    expect(result.reviewManifest?.sections["verification-checks"].length).toBe(1);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(config.security?.approvalMode).toBe("strict");
    expect(config.security?.assessor?.enabled).toBe(true);
    expect(config.model).toEqual((localReadyConfig() as { model: unknown }).model);
    expect(config.providers).toEqual((localReadyConfig() as { providers: unknown }).providers);
  });

  it("applies reviewed workflow learning changes while preserving unrelated skill config", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      skills: {
        autonomy: "suggest",
        externalDirs: ["/tmp/estacoda-skills"],
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["autonomous"] }),
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    const config = JSON.parse(await readFile(join(tempDir, ".estacoda", "config.json"), "utf8")) as {
      skills?: { autonomy?: string; externalDirs?: string[] };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-workflow-learning");
    expect(result.reviewManifest?.sections["workflow-learning"].length).toBe(1);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(config.skills?.autonomy).toBe("autonomous");
    expect(config.skills?.externalDirs).toEqual(["/tmp/estacoda-skills"]);
  });

  it("launches only after reviewed apply, verification, route re-collection, and explicit launch choice", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["strict", true, "launch"] }),
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(join(tempDir, ".estacoda", "config.json")),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.nextActionId).toBe("launch");
    expect(result.postApplyRouteDecision?.kind).toBe("configured-menu");
    expect(result.applyEndState?.kind).toBe("launched");
    if (result.applyEndState?.kind !== "launched") throw new Error("expected launch");
    expect(result.applyEndState.acceptedDegraded).toBe(false);
    expect(result.limitedModeAccepted).toBe(false);
    expect(result.output).toContain("Verification passed. Setup is ready.");
    expect(result.output).toContain("Launch handoff accepted");
  });

  it("requires explicit limited-mode acceptance before degraded launch handoff", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["proactive", true, "accept-limited-mode"] }),
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => degradedVerification(join(tempDir, ".estacoda", "config.json")),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.nextActionId).toBe("accept-limited-mode");
    expect(result.postApplyRouteDecision).toBeDefined();
    expect(result.applyEndState?.kind).toBe("launched");
    if (result.applyEndState?.kind !== "launched") throw new Error("expected degraded launch");
    expect(result.applyEndState.acceptedDegraded).toBe(true);
    expect(result.limitedModeAccepted).toBe(true);
    expect(result.output).toContain("Verification completed with warnings");
    expect(result.output).toContain("Limited mode accepted for launch");
  });

  it("does not expose launch after blocked verification", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: ["strict", true, "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Setup next action") {
        postApplyOptionLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => blockedVerification(join(tempDir, ".estacoda", "config.json")),
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.nextActionId).toBe("exit");
    expect(result.applyEndState?.kind).toBe("blocked");
    expect(postApplyOptionLabels).toEqual([["Repair again", "Exit"]]);
    expect(result.output).toContain("Verification blocked");
    expect(result.output).toContain("Exited after setup apply without launching");
  });

  it("does not expose launch when post-apply verification cannot run", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: ["strict", true, "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Setup next action") {
        postApplyOptionLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-security-mode",
      applyExecutor: {
        apply: () => ({ ok: true, appliedOperationIds: [] }),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.nextActionId).toBe("exit");
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    expect(postApplyOptionLabels).toEqual([["Repair again", "Exit"]]);
    expect(result.output).toContain("Setup prepared without launch handoff");
    expect(result.output).toContain("Exited after setup apply without launching");
  });

  it("does not expose launch when the fresh post-apply route is still unsafe", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: [true, true, "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Setup next action") {
        postApplyOptionLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "trust-workspace",
      applyExecutor: {
        apply: () => ({ ok: true, appliedOperationIds: [] }),
        verify: () => readyVerification(join(tempDir, ".estacoda", "config.json")),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.initialDecision.state.kind).toBe("untrusted-workspace");
    expect(result.postApplyRouteDecision?.state.kind).toBe("untrusted-workspace");
    expect(result.nextActionId).toBe("exit");
    expect(result.applyEndState?.kind).toBe("verified-ready");
    expect(postApplyOptionLabels).toEqual([["Repair again", "Exit"]]);
  });

  it("repair-again re-enters the editor with a fresh route without bypassing review/apply", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["proactive", true, "repair-again", "exit"] }),
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => degradedVerification(join(tempDir, ".estacoda", "config.json")),
      }),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(result.reviewManifest).toBeUndefined();
    expect(output.join("").match(/EstaCoda guided setup editor/g)).toHaveLength(2);
    expect(output.join("")).toContain("Repair again selected. Re-entering guided setup editor.");
  });

  it("applies guided provider route repair through the shared flow and reviewed executor", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      security: {
        approvalMode: "adaptive",
        assessor: { enabled: true },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["OpenAI", "gpt-5.5", true], secret: "sk-pr8-provider-route" }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_OPENAI_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(join(tempDir, ".estacoda", "config.json")),
      }),
    });
    const rawConfig = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; contextWindowTokens?: number; apiMode?: string; authMethod?: string };
      providers?: Record<string, { apiKeyEnv?: string; baseUrl?: string; models?: string[]; apiMode?: string; authMethod?: string }>;
      security?: { approvalMode?: string; assessor?: { enabled?: boolean } };
    };
    const envFile = await readFile(join(tempDir, ".estacoda", ".env"), "utf8");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-primary-model-route");
    expect(result.reviewManifest?.sections["provider-model-network"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["provider.route"],
    }));
    expect(config.model).toEqual({ provider: "openai", id: "gpt-5.5", contextWindowTokens: 128000 });
    expect(config.providers?.openai).toEqual(expect.objectContaining({
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "PR8_OPENAI_KEY",
    }));
    expect(config.providers?.openai?.models).toContain("gpt-5.5");
    expect(config.model?.apiMode).toBeUndefined();
    expect(config.model?.authMethod).toBeUndefined();
    expect(config.providers?.openai?.apiMode).toBeUndefined();
    expect(config.providers?.openai?.authMethod).toBeUndefined();
    expect(config.security?.assessor?.enabled).toBe(true);
    expect(envFile).toContain("PR8_OPENAI_KEY=");
    expect(rawConfig).not.toContain("sk-pr8-provider-route");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-provider-route");
  });

  it("cancels guided credential repair without writing config or .env", async () => {
    delete process.env.PR8_CANCELLED_KEY;
    await writeUserConfig(tempDir, hostedMissingCredentialConfig("PR8_CANCELLED_KEY"));
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: [false], secret: "sk-pr8-cancelled" }),
      defaultActionId: "repair-missing-credential",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_CANCELLED_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("cancelled");
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).resolves.toBe(before);
    await expect(readFile(join(tempDir, ".estacoda", ".env"), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-pr8-cancelled");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-pr8-cancelled");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-pr8-cancelled");
  });

  it("repairs the active OpenAI credential ref without mutating other available providers", async () => {
    delete process.env.PR8_REPAIRED_KEY;
    await writeUserConfig(tempDir, {
      ...hostedMissingCredentialConfig("PR8_REPAIRED_KEY"),
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "PR8_REPAIRED_KEY",
          models: ["gpt-5.5"],
          enableNetwork: true,
        },
        anthropic: {
          kind: "openai-compatible",
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          models: ["claude-sonnet-4-5"],
          enableNetwork: true,
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: [true], secret: "sk-pr8-repaired" }),
      defaultActionId: "repair-missing-credential",
      flowEngine: flowEngine({
        credentialAction: "collect",
        envVarName: "PR8_REPAIRED_KEY",
        providers: ["anthropic", "openai"],
      }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(join(tempDir, ".estacoda", "config.json")),
      }),
    });
    const rawConfig = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { apiKeyEnv?: string; models?: string[] }>;
    };
    const envFile = await readFile(join(tempDir, ".estacoda", ".env"), "utf8");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("repair-missing-credential");
    expect(result.reviewManifest?.sections["provider-model-network"]).toHaveLength(0);
    expect(result.reviewManifest?.sections["secret-refs-to-store"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["provider.credentialReference"],
    }));
    expect(config.model).toEqual({ provider: "openai", id: "gpt-5.5" });
    expect(config.providers?.openai?.apiKeyEnv).toBe("PR8_REPAIRED_KEY");
    expect(config.providers?.anthropic?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.providers?.anthropic?.models).toEqual(["claude-sonnet-4-5"]);
    expect(envFile).toContain("PR8_REPAIRED_KEY=");
    expect(rawConfig).not.toContain("sk-pr8-repaired");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-repaired");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-pr8-repaired");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-pr8-repaired");
  });

  it("returns diagnostics and writes nothing when active credential route is unavailable", async () => {
    delete process.env.PR8_UNAVAILABLE_KEY;
    await writeUserConfig(tempDir, hostedMissingCredentialConfig("PR8_UNAVAILABLE_KEY"));
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: [true], secret: "sk-pr8-unavailable" }),
      defaultActionId: "repair-missing-credential",
      flowEngine: flowEngine({
        credentialAction: "collect",
        envVarName: "PR8_UNAVAILABLE_KEY",
        providers: ["anthropic"],
      }),
      applyExecutor: {
        apply: () => {
          throw new Error("apply should not run for unavailable active route");
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.output).toContain("Use provider/model repair");
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).resolves.toBe(before);
    await expect(readFile(join(tempDir, ".estacoda", ".env"), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-pr8-unavailable");
  });

  it("treats shared-flow diagnostics as non-mutating editor output", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["OpenAI", "gpt-5.5"] }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ diagnostic: "Provider OpenAI is not runnable." }),
      applyExecutor: {
        apply: () => {
          throw new Error("apply should not run for diagnostics");
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.output).toContain("Provider/model selection failed: Provider OpenAI is not runnable.");
    expect(result.reviewManifest).toBeUndefined();
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).resolves.toBe(before);
  });

  it("grants workspace trust only after explicit confirmation and reviewed approval", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const trustStorePath = join(tempDir, ".estacoda", "trust.json");
    const store = new WorkspaceTrustStore({ path: trustStorePath });

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      trustStorePath,
      prompt: fakePrompt({ values: [true, true] }),
      defaultActionId: "trust-workspace",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        trustStorePath,
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.initialDecision.state.kind).toBe("untrusted-workspace");
    expect(result.selectedActionId).toBe("repair-workspace-trust");
    expect(result.reviewManifest?.sections["workspace-trust-grants"].length).toBe(1);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    await expect(store.isTrusted(workspaceRoot)).resolves.toBe(true);
  });

  it("does not grant workspace trust when explicit confirmation is declined", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const trustStorePath = join(tempDir, ".estacoda", "trust.json");
    const store = new WorkspaceTrustStore({ path: trustStorePath });
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      trustStorePath,
      prompt: fakePrompt({ values: [false] }),
      defaultActionId: "trust-workspace",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.output).toContain("Workspace trust was not changed");
    expect(result.reviewManifest).toBeUndefined();
    expect(applyCalled).toBe(false);
    await expect(store.isTrusted(workspaceRoot)).resolves.toBe(false);
  });

  it("leaves optional capabilities unchanged without drafting or applying changes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "review-optional-capabilities",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("review-optional-capabilities");
    expect(result.output).toContain("Optional capabilities left unchanged");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(applyCalled).toBe(false);
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).resolves.toBe(before);
  });

  it("does not offer skip for already configured optional capabilities", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "TELEGRAM_BOT_TOKEN",
          allowedUserIds: ["42"],
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const optionLabels: string[][] = [];

    const prompt = fakePrompt();
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      optionLabels.push(input.options.map((option) => option.label));
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "review-optional-capabilities",
    });

    expect(result.completed).toBe(true);
    expect(optionLabels[0]).toEqual(["Leave unchanged", "Enable/configure"]);
    expect(optionLabels.slice(1)).toEqual([
      ["Leave unchanged", "Skip", "Enable/configure"],
      ["Leave unchanged", "Skip", "Enable/configure"],
      ["Leave unchanged", "Skip", "Enable/configure"],
    ]);
    expect(result.reviewManifest).toBeUndefined();
  });

  it("blocks Telegram optional capability apply without allowed remote-control identities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "TELEGRAM_BOT_TOKEN", "", "", "unchanged", "unchanged", "unchanged", true],
      }),
      defaultActionId: "review-optional-capabilities",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(false);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections.blockers[0]?.blockers).toContain("Telegram remote control requires allowed user or chat identities.");
    expect(result.applyPlanningResult?.kind).toBe("blocked");
    expect(applyCalled).toBe(false);
    expect(JSON.stringify(result)).not.toContain("123456:");
    await expect(readFile(join(tempDir, ".estacoda", "config.json"), "utf8")).resolves.toBe(before);
  });

  it("applies reviewed Telegram optional capability with env ref and allowlisted identities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "TELEGRAM_BOT_TOKEN", "42", "-100", "unchanged", "unchanged", "unchanged", true],
      }),
      defaultActionId: "review-optional-capabilities",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: { telegram?: { enabled?: boolean; botTokenEnv?: string; allowedUserIds?: string[]; allowedChatIds?: string[] } };
    };

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.remoteControlIdentityConstraint).toBe("allowed-user-or-chat-id");
    expect(config.channels?.telegram).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      allowedUserIds: ["42"],
      allowedChatIds: ["-100"],
    }));
    expect(rawConfig).not.toContain("123456:");
    expect(JSON.stringify(result)).not.toContain("123456:");
  });

  it("applies voice, vision, and browser optional capability refs without raw secrets or browser launch", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "skip",
          "enable",
          "openai",
          "gpt-4o-mini-tts",
          "VOICE_TTS_KEY",
          "openai",
          "gpt-4o-mini-transcribe",
          "VOICE_STT_KEY",
          "enable",
          "fal",
          "fal-ai/imagen4/preview",
          "FAL_KEY",
          false,
          "enable",
          "local-cdp",
          "http://127.0.0.1:1",
          "google-chrome --remote-debugging-port=9222",
          true,
        ],
      }),
      defaultActionId: "review-optional-capabilities",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(join(tempDir, ".estacoda", "config.json"), "utf8");
    const config = JSON.parse(rawConfig) as {
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      imageGen?: { provider?: string; model?: string; fal?: { apiKeyEnv?: string } };
      browser?: { backend?: string; cdpUrl?: string; launchCommand?: string; autoLaunch?: boolean };
    };
    const browserLine = result.reviewManifest?.sections["enabled-optional-capabilities"]
      .find((line) => line.sourceDraftIds.includes("setup-module.browser.capability"));

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual(expect.arrayContaining([
      "setup-module.voice.capability",
      "setup-module.vision.capability",
      "setup-module.browser.capability",
    ]));
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).not.toContain("setup-module.telegram.capability");
    expect(browserLine?.review.values.autoLaunchRequested).toBe(false);
    expect(browserLine?.review.values.autoLaunchWillRunNow).toBe(false);
    expect(config.tts?.provider).toBe("openai");
    expect(config.tts?.openai?.apiKeyEnv).toBe("VOICE_TTS_KEY");
    expect(config.stt?.provider).toBe("openai");
    expect(config.stt?.openai?.apiKeyEnv).toBe("VOICE_STT_KEY");
    expect(config.imageGen?.provider).toBe("fal");
    expect(config.imageGen?.fal?.apiKeyEnv).toBe("FAL_KEY");
    expect(config.browser).toEqual({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:1",
      launchCommand: "google-chrome --remote-debugging-port=9222",
      autoLaunch: false,
    });
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("renders broken config as a repair-first diagnostic surface", async () => {
    await mkdir(join(tempDir, ".estacoda"), { recursive: true });
    await writeFile(join(tempDir, ".estacoda", "config.json"), "{not-json", "utf8");
    const output: string[] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "show-diagnostics",
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("repair-first-menu");
    expect(result.initialDecision.state.kind).toBe("broken-config");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("repair-first");
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: broken-config");
    expect(result.output).toContain(join(tempDir, ".estacoda", "config.json"));
    expect(result.output).toContain("Error:");
    expect(result.output).toContain("Normal config edits are blocked until the config file can be parsed.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(output.join("")).toContain("verify-setup - Verify setup");
    expect(output.join("")).toContain("show-diagnostics - Show diagnostics");
    expect(output.join("")).toContain("exit - Exit");
    expect(output.join("")).not.toContain("edit-primary-model-route");
    expect(output.join("")).not.toContain("edit-security-mode");
    expect(output.join("")).not.toContain("repair-state-directory");
  });

  it("renders state-not-writable as a repair-first diagnostic surface", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    await chmod(join(tempDir, ".estacoda"), 0o500);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "show-diagnostics",
    });

    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.initialDecision.kind).toBe("repair-first-menu");
    expect(result.initialDecision.state.kind).toBe("state-not-writable");
    expect(result.initialDecision.setupEditorPlanSession?.metadata.mode).toBe("repair-first");
    expect(result.output).toContain("State: state-not-writable");
    expect(result.output).toContain(join(tempDir, ".estacoda", "config.json"));
    expect(result.output).toContain("not writable");
    expect(result.output).toContain("write permission");
    expect(result.output).toContain("Restore write permission");
    expect(result.output).toContain("read-only verification again");
    expect(result.output).toContain("Normal writes are blocked until state write permissions are restored.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(result.output).not.toContain("Config cannot be edited normally until it can be parsed safely");
    expect(result.output).not.toContain("parse safety");
    expect(result.output).not.toContain("config parse failure");
    expect(result.initialDecision.setupEditorPlanSession?.plan.safeForNormalConfigEditing).toBe(false);
    expect(result.initialDecision.setupEditorPlanSession?.plan.actions.some((action) => action.patch !== undefined)).toBe(false);
  });
});

function fakePrompt(options: { readonly values?: readonly unknown[]; readonly secret?: string } = {}): Prompt {
  const values = [...(options.values ?? [])];
  const prompt = (async (_question: string, promptOptions?: { secret?: boolean }) => {
    if (promptOptions?.secret === true) return options.secret ?? "";
    const next = values.shift();
    return next === undefined ? "" : String(next);
  }) as Prompt;
  prompt.select = async (input) => {
    const next = values.shift();
    if (next !== undefined) {
      const match = input.options.find((option) =>
        Object.is(option.value, next) ||
        option.label === next ||
        (typeof option.value === "object" && option.value !== null && "id" in option.value && option.value.id === next)
      );
      if (match !== undefined) return match.value;
    }
    return input.options[input.defaultIndex ?? 0]?.value ?? input.options[0]!.value;
  };
  prompt.onboardingCard = () => undefined;
  prompt.close = () => undefined;
  return prompt;
}

async function writeUserConfig(homeDir: string, config: unknown): Promise<void> {
  await mkdir(join(homeDir, ".estacoda"), { recursive: true });
  await writeFile(join(homeDir, ".estacoda", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function trustWorkspace(homeDir: string, workspaceRoot: string): Promise<void> {
  await new WorkspaceTrustStore({
    path: join(homeDir, ".estacoda", "trust.json"),
  }).grant(workspaceRoot, { label: "test" });
}

function localReadyConfig(modelId = "hermes-local"): Record<string, unknown> {
  return {
    model: {
      provider: "local",
      id: modelId,
    },
    providers: {
      local: {
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        models: [modelId],
        enableNetwork: true,
      },
    },
  };
}

function hostedMissingCredentialConfig(envVarName: string): Record<string, unknown> {
  return {
    model: {
      provider: "openai",
      id: "gpt-5.5",
    },
    providers: {
      openai: {
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: envVarName,
        models: ["gpt-5.5"],
        enableNetwork: true,
      },
    },
  };
}

function readyVerification(configPath: string) {
  return {
    stateWritable: true,
    envFilePresent: true,
    envFileSecure: true,
    workspaceTrusted: true,
    securityModeLabel: "Adaptive",
    securityModeValue: "adaptive",
    skillAutonomyLabel: "Suggest",
    skillAutonomyValue: "suggest",
    providerDiagnostic: {
      status: "ready" as const,
      lines: ["Provider status: ready"],
      warnings: [],
    },
    toolStatus: "skipped" as const,
    configSources: [configPath],
    warnings: [],
    issueCodes: [],
  };
}

function degradedVerification(configPath: string) {
  return {
    ...readyVerification(configPath),
    providerDiagnostic: {
      status: "warning" as const,
      lines: ["Provider status: warning"],
      warnings: ["Network inference is disabled for the selected hosted provider."],
    },
    warnings: ["Network inference is disabled for the selected hosted provider."],
    issueCodes: ["network-disabled"],
  };
}

function blockedVerification(configPath: string) {
  return {
    ...readyVerification(configPath),
    providerDiagnostic: {
      status: "blocked" as const,
      lines: ["Provider status: blocked"],
      warnings: ["Missing API key for OPENAI_API_KEY."],
    },
    warnings: ["Missing API key for OPENAI_API_KEY."],
    issueCodes: ["missing-api-key"],
  };
}

function flowEngine(options: {
  readonly credentialAction?: "none" | "reuse" | "collect";
  readonly envVarName?: string;
  readonly diagnostic?: string;
  readonly providers?: readonly ProviderId[];
} = {}): FlowEngine {
  const envVarName = options.envVarName ?? "OPENAI_API_KEY";
  const providers = options.providers ?? (["openai"] as const);
  return {
    listProviderCandidates: async () => providers.map((providerId) => ({
      id: providerId,
      displayName: displayNameForProvider(providerId),
      catalogOnly: false,
      configurable: true,
      runnable: true,
      modelsCount: 1,
      credentialReady: options.credentialAction === "reuse",
      baseUrl: baseUrlForProvider(providerId),
    })),
    listModelCandidates: async (providerId) => [modelCandidateForProvider(providerId)],
    resolveSelection: async (providerId, modelId) => {
      if (options.diagnostic !== undefined) {
        return {
          kind: "diagnostic" as const,
          provider: providerId,
          model: modelId,
          reason: options.diagnostic,
        };
      }
      const action = options.credentialAction ?? "collect";
      return {
        kind: "selected" as const,
        provider: providerId,
        model: modelId,
        baseUrl: baseUrlForProvider(providerId),
        apiMode: "custom_openai_compatible" as ProviderApiMode,
        authMethod: "api_key" as ProviderAuthMethod,
        credentialAction: action === "none"
          ? { kind: "none" as const }
          : action === "reuse"
            ? { kind: "reuse" as const, reference: `env:${envVarName}` as `env:${string}` }
            : { kind: "collect" as const, envVarName },
        profile: {
          id: modelId,
          provider: providerId,
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: true,
          supportsReasoning: true,
          supportsStructuredOutput: true,
          status: "stable",
        },
      };
    },
  };
}

function displayNameForProvider(providerId: ProviderId): string {
  return providerId === "anthropic" ? "Anthropic" : providerId === "kimi" ? "Kimi" : "OpenAI";
}

function baseUrlForProvider(providerId: ProviderId): string {
  if (providerId === "anthropic") return "https://api.anthropic.com/v1";
  if (providerId === "kimi") return "https://api.moonshot.ai/v1";
  return "https://api.openai.com/v1";
}

function modelCandidateForProvider(providerId: ProviderId) {
  const id = providerId === "anthropic"
    ? "claude-sonnet-4-5"
    : providerId === "kimi"
      ? "kimi-k2"
      : "gpt-5.5";
  return {
    id,
    provider: providerId,
    configured: true,
    executable: true,
    catalogOnly: false,
    supportsVision: true,
    profile: {
      id,
      provider: providerId,
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsStructuredOutput: true,
      status: "stable" as const,
    },
  };
}

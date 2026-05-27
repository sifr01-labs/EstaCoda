import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/readline-prompt.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../../contracts/provider.js";
import type { FlowEngine, ModelCandidate } from "../../providers/provider-model-selection-flow.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { runConfigEditor } from "./runner.js";
import { promptModelCandidate } from "./prompts.js";
import { resolveProfileStateHome, writeActiveProfile } from "../../config/profile-home.js";

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
    delete process.env.PR8_SHELL_ONLY_KEY;
    await chmod(join(tempDir, ".estacoda"), 0o700).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("renders configured setup sections and exits without mutating config", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");
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
    expect(output.join("")).toContain("Available actions:");
    expect(output.join("")).toContain("edit-fallback-model-route");
    expect(output.join("")).toContain("edit-auxiliary-model-route");
    expect(output.join("")).toContain("edit-security-mode");
    expect(output.join("")).toContain("edit-workflow-learning");
    expect(output.join("")).toContain("configure-channels");
    expect(output.join("")).toContain("configure-voice");
    expect(output.join("")).toContain("configure-image-generation");
    expect(output.join("")).toContain("configure-browser");
    expect(output.join("")).not.toContain("edit-primary-credential-reference");
    expect(output.join("")).not.toContain("review-optional-capabilities");
    expect(output.join("")).toContain("verify-setup - Run read-only verification");
    expect(output.join("")).toContain("show-diagnostics - Show diagnostics");
    expect(output.join("")).toContain("exit - Exit without changes");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("renders only actionable model status tags in config-editor model choices", async () => {
    const descriptions: Array<string | undefined> = [];
    const prompt = fakePrompt();
    prompt.select = async (input) => {
      descriptions.push(...input.options.map((option) => option.description));
      return input.options[0]!.value;
    };

    await promptModelCandidate(prompt, {
      providerId: "openai",
      candidates: modelStatusCandidates("openai" as ProviderId),
    });

    expect(descriptions).toEqual([
      "alpha",
      "beta",
      "deprecated",
      "",
      "",
      "",
    ]);
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

    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
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

  it("writes active profile config without prompting for profile awareness", async () => {
    await writeUserConfig(tempDir, localReadyConfig("default-local"), "default");
    await writeUserConfig(tempDir, {
      ...localReadyConfig("work-local"),
      security: { approvalMode: "adaptive" },
    }, "work");
    writeActiveProfile("work", { homeDir: tempDir });
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

    const defaultConfig = JSON.parse(await readFile(profileConfigPath(tempDir, "default"), "utf8")) as {
      model?: { id?: string };
      security?: { approvalMode?: string };
    };
    const workConfig = JSON.parse(await readFile(profileConfigPath(tempDir, "work"), "utf8")) as {
      model?: { id?: string };
      security?: { approvalMode?: string };
    };

    expect(result.completed).toBe(true);
    expect(result.output).not.toMatch(/\bprofiles?\b/iu);
    expect(defaultConfig.model?.id).toBe("default-local");
    expect(defaultConfig.security?.approvalMode).toBeUndefined();
    expect(workConfig.model?.id).toBe("work-local");
    expect(workConfig.security?.approvalMode).toBe("strict");
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

    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
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
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
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
        collectVerification: () => degradedVerification(profileConfigPath(tempDir)),
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
    expect(result.output).toContain("Verification warnings:");
    expect(result.output).toContain("Network inference is disabled for the selected hosted provider.");
    expect(result.output).toContain("Configured model context window is below 64K tokens.");
    expect(result.output).toContain("Limited mode accepted for launch");
    expect(result.output.indexOf("Network inference is disabled")).toBeLessThan(
      result.output.indexOf("Limited mode accepted for launch")
    );
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
        collectVerification: () => blockedVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.nextActionId).toBe("exit");
    expect(result.applyEndState?.kind).toBe("blocked");
    expect(postApplyOptionLabels).toEqual([["Repair again", "Exit setup"]]);
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
    expect(postApplyOptionLabels).toEqual([["Repair again", "Exit setup"]]);
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
        verify: () => readyVerification(profileConfigPath(tempDir)),
      },
    });

    expect(result.completed).toBe(true);
    expect(result.initialDecision.state.kind).toBe("untrusted-workspace");
    expect(result.postApplyRouteDecision?.state.kind).toBe("untrusted-workspace");
    expect(result.nextActionId).toBe("exit");
    expect(result.applyEndState?.kind).toBe("verified-ready");
    expect(postApplyOptionLabels).toEqual([["Repair again", "Exit setup"]]);
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
        collectVerification: () => degradedVerification(profileConfigPath(tempDir)),
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
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; contextWindowTokens?: number; apiMode?: string; authMethod?: string };
      providers?: Record<string, { apiKeyEnv?: string; baseUrl?: string; models?: string[]; apiMode?: string; authMethod?: string }>;
      security?: { approvalMode?: string; assessor?: { enabled?: boolean } };
    };
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

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

  it("prompts to reuse a saved profile credential and keeps the existing key without raw key prompt", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await mkdir(dirname(profileEnvPath(tempDir)), { recursive: true });
    await writeFile(profileEnvPath(tempDir), 'PR8_REUSE_KEY="saved-reuse-secret"\n', "utf8");
    await chmod(profileEnvPath(tempDir), 0o600);
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({
      values: ["OpenAI", "gpt-5.5", "existing", true],
      secret: "sk-should-not-be-read",
    });
    const reuseChoiceLabels: string[][] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Saved provider API key") {
        reuseChoiceLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_REUSE_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(reuseChoiceLabels).toEqual([["Use existing saved API key.", "Enter a new API key."]]);
    expect(prompt.secretPromptCount()).toBe(0);
    expect(envFile).toContain("saved-reuse-secret");
    expect(envFile).not.toContain("sk-should-not-be-read");
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(JSON.stringify(result)).not.toContain("saved-reuse-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("saved-reuse-secret");
  });

  it("adds a fallback route directly when no fallbacks exist", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({
      values: ["OpenAI", "gpt-5.5", true],
      secret: "sk-fallback-add-secret",
    });
    const fallbackChoiceTitles: string[] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Fallback provider/model route") {
        fallbackChoiceTitles.push(input.title);
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_FALLBACK_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string; apiKeyEnv?: string }> };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-fallback-model-route");
    expect(fallbackChoiceTitles).toEqual([]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "add",
      provider: "openai",
      model: "gpt-5.5",
      apiKeyEnv: "PR8_FALLBACK_KEY",
    }));
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.fallbacks"],
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("hermes-local");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5", apiKeyEnv: "PR8_FALLBACK_KEY" }),
    ]);
    expect(rawConfig).not.toContain("sk-fallback-add-secret");
    expect(JSON.stringify(result)).not.toContain("sk-fallback-add-secret");
  });

  it("prompts to edit existing fallbacks or add another route", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      model: {
        provider: "local",
        id: "hermes-local",
        fallbacks: [
          { provider: "openai", id: "gpt-5.5" },
          { provider: "kimi", id: "kimi-k2" },
        ],
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = fakePrompt({ values: ["fallback-add", "Anthropic", "claude-sonnet-4-5", true] });
    const fallbackChoiceLabels: string[][] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Fallback provider/model route") {
        fallbackChoiceLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "none", providers: ["anthropic"] }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    expect(result.completed).toBe(true);
    expect(fallbackChoiceLabels).toEqual([[
      "Edit fallback 1: openai/gpt-5.5",
      "Edit fallback 2: kimi/kimi-k2",
      "Add another fallback route",
    ]]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "add",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }));
  });

  it("replaces a selected fallback route while preserving surrounding fallbacks", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      model: {
        provider: "local",
        id: "hermes-local",
        fallbacks: [
          { provider: "openai", id: "gpt-5.5" },
          { provider: "kimi", id: "kimi-k2" },
        ],
      },
      providers: {
        ...(localReadyConfig().providers as Record<string, unknown>),
        openai: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.5"], enableNetwork: true },
        kimi: { kind: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", models: ["kimi-k2"], enableNetwork: true },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["fallback-1", "Anthropic", "claude-sonnet-4-5", true] }),
      defaultActionId: "edit-fallback-model-route",
      flowEngine: flowEngine({ credentialAction: "none", providers: ["anthropic"] }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      model?: { provider?: string; id?: string; fallbacks?: Array<{ provider?: string; id?: string }> };
      providers?: Record<string, unknown>;
    };

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.summaryKey).toBe("setupDrafts.fallbackModelRoute.replace.summary");
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review.values).toEqual(expect.objectContaining({
      fallbackOperation: "replace",
      fallbackIndex: 1,
      previousProvider: "kimi",
      previousModel: "kimi-k2",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    }));
    expect(config.model?.provider).toBe("local");
    expect(config.model?.id).toBe("hermes-local");
    expect(config.model?.fallbacks).toEqual([
      expect.objectContaining({ provider: "openai", id: "gpt-5.5" }),
      expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
    ]);
    expect(config.providers?.kimi).toBeDefined();
  });

  it("selects an auxiliary task and applies a reviewed auxiliary route", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({
      values: ["compression", "OpenAI", "gpt-5.5", true],
      secret: "sk-auxiliary-compression-secret",
    });
    const taskOptions: Array<{ labels: string[]; values: unknown[] }> = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Choose auxiliary route.") {
        taskOptions.push({
          labels: input.options.map((option) => option.label),
          values: input.options.map((option) => option.value),
        });
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-auxiliary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_AUX_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string; fallbacks?: unknown };
      auxiliaryModels?: {
        compression?: { provider?: string; id?: string; apiKeyEnv?: string; enabled?: boolean };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-auxiliary-model-route");
    expect(taskOptions).toEqual([{
      labels: ["Assessor", "Compression", "Session search", "Memory compaction", "Profile context"],
      values: ["assessor", "compression", "session_search", "memory_compaction", "profile_context"],
    }]);
    expect(result.reviewManifest?.sections["provider-model-network"][0]?.review).toEqual(expect.objectContaining({
      summaryKey: "setupDrafts.auxiliaryModelRoute.summary",
      values: expect.objectContaining({
        auxiliaryTask: "compression",
        provider: "openai",
        model: "gpt-5.5",
        apiKeyEnv: "PR8_AUX_KEY",
      }),
    }));
    expect(result.reviewManifest?.sections["files-to-write-update"][0]?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["auxiliaryModels.*"],
    }));
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(config.model).toEqual({ provider: "local", id: "hermes-local" });
    expect(config.auxiliaryModels?.compression).toEqual(expect.objectContaining({
      provider: "openai",
      id: "gpt-5.5",
      apiKeyEnv: "PR8_AUX_KEY",
      enabled: true,
    }));
    expect(rawConfig).not.toContain("sk-auxiliary-compression-secret");
    expect(JSON.stringify(result)).not.toContain("sk-auxiliary-compression-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-auxiliary-compression-secret");
  });

  it("does not change assessor route when auxiliary review is cancelled", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      auxiliaryModels: {
        assessor: { provider: "auto", enabled: true },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["assessor", "OpenAI", "gpt-5.5", false],
        secret: "sk-assessor-cancelled-secret",
      }),
      defaultActionId: "edit-auxiliary-model-route",
      flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_ASSESSOR_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      auxiliaryModels?: { assessor?: { provider?: string; id?: string; enabled?: boolean } };
    };

    expect(result.completed).toBe(false);
    expect(result.applyPlanningResult?.kind).toBe("cancelled");
    expect(config.auxiliaryModels?.assessor).toEqual({ provider: "auto", enabled: true });
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(rawConfig).not.toContain("sk-assessor-cancelled-secret");
    expect(JSON.stringify(result)).not.toContain("sk-assessor-cancelled-secret");
  });

  it("replaces a saved profile credential only after reviewed approval when the user enters a new key", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await mkdir(dirname(profileEnvPath(tempDir)), { recursive: true });
    await writeFile(profileEnvPath(tempDir), 'PR8_REPLACE_KEY="old-reuse-secret"\n', "utf8");
    await chmod(profileEnvPath(tempDir), 0o600);
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["OpenAI", "gpt-5.5", "new", true],
        secret: "sk-pr8-replacement-secret",
      }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_REPLACE_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(true);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(envFile).toContain('PR8_REPLACE_KEY="sk-pr8-replacement-secret"');
    expect(envFile).not.toContain("old-reuse-secret");
    expect(result.reviewManifest?.sections["secret-refs-to-store"][0]?.sourceDraftIds).toEqual([
      "setup-editor.credentials.store-provider-credential-reference",
    ]);
    expect(result.output).not.toContain("sk-pr8-replacement-secret");
    expect(JSON.stringify(result)).not.toContain("sk-pr8-replacement-secret");
    expect(JSON.stringify(result.reviewManifest)).not.toContain("sk-pr8-replacement-secret");
    expect(JSON.stringify(result.applyPlanningResult)).not.toContain("sk-pr8-replacement-secret");
  });

  it("returns a diagnostic when replacing a saved credential with an empty key", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await mkdir(dirname(profileEnvPath(tempDir)), { recursive: true });
    await writeFile(profileEnvPath(tempDir), 'PR8_EMPTY_REUSE_KEY="old-reuse-secret"\n', "utf8");
    await chmod(profileEnvPath(tempDir), 0o600);
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["OpenAI", "gpt-5.5", "new"], secret: "" }),
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_EMPTY_REUSE_KEY" }),
      applyExecutor: {
        apply: () => {
          throw new Error("apply should not run for empty replacement credential");
        },
      },
    });
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

    expect(result.completed).toBe(false);
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(result.output).toContain("No API key was entered for PR8_EMPTY_REUSE_KEY");
    expect(envFile).toContain("old-reuse-secret");
  });

  it("does not show the saved-key prompt when only shell env has the credential", async () => {
    process.env.PR8_SHELL_ONLY_KEY = "sk-shell-only-secret";
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const prompt = trackingPrompt({ values: ["OpenAI", "gpt-5.5", true] });
    const reuseChoiceLabels: string[][] = [];
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Saved provider API key") {
        reuseChoiceLabels.push(input.options.map((option) => option.label));
      }
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-primary-model-route",
      flowEngine: flowEngine({ credentialAction: "reuse", envVarName: "PR8_SHELL_ONLY_KEY" }),
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });

    expect(result.completed).toBe(true);
    expect(reuseChoiceLabels).toEqual([]);
    expect(prompt.secretPromptCount()).toBe(0);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-shell-only-secret");
  });

  it("cancels guided credential repair without writing config or .env", async () => {
    delete process.env.PR8_CANCELLED_KEY;
    await writeUserConfig(tempDir, hostedMissingCredentialConfig("PR8_CANCELLED_KEY"));
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

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
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
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
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      model?: { provider?: string; id?: string };
      providers?: Record<string, { apiKeyEnv?: string; models?: string[] }>;
    };
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");

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
    const before = await readFile(profileConfigPath(tempDir), "utf8");

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
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
    await expect(readFile(profileEnvPath(tempDir), "utf8")).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain("sk-pr8-unavailable");
  });

  it("treats shared-flow diagnostics as non-mutating editor output", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

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
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
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
    const before = await readFile(profileConfigPath(tempDir), "utf8");
    let applyCalled = false;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(),
      defaultActionId: "configure-channels",
      applyExecutor: {
        apply: () => {
          applyCalled = true;
          return { ok: true, appliedOperationIds: [] };
        },
      },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(result.output).toContain("Telegram/channels left unchanged");
    expect(result.reviewManifest).toBeUndefined();
    expect(result.applyPlanningResult).toBeUndefined();
    expect(applyCalled).toBe(false);
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
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
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(optionLabels[0]).toEqual(["Leave unchanged", "Enable/configure"]);
    expect(optionLabels).toHaveLength(1);
    expect(result.reviewManifest).toBeUndefined();
  });

  it("lets incomplete Telegram optional capability setup skip instead of drafting blockers", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "TELEGRAM_BOT_TOKEN", "", "", "skip", true],
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections.blockers).toHaveLength(0);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(0);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
    expect(JSON.stringify(result)).not.toContain("123456:");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("lets incomplete Telegram optional capability setup retry before drafting", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "enable",
          "TELEGRAM_BOT_TOKEN",
          "",
          "",
          "retry",
          "TELEGRAM_BOT_TOKEN",
          "42",
          "",
          true,
        ],
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections.blockers).toHaveLength(0);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.allowedUserIds).toEqual(["42"]);
    expect(result.applyPlanningResult?.kind).toBe("apply-plan-ready");
  });

  it("applies reviewed Telegram optional capability with env ref and allowlisted identities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["enable", "TELEGRAM_BOT_TOKEN", "42", "-100", true],
        secret: "123456:stored-telegram-token",
      }),
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: { telegram?: { enabled?: boolean; botTokenEnv?: string; allowedUserIds?: string[]; allowedChatIds?: string[] } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.telegram.capability",
    ]);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.remoteControlIdentityConstraint).toBe("allowed-user-or-chat-id");
    expect(config.channels?.telegram).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      allowedUserIds: ["42"],
      allowedChatIds: ["-100"],
    }));
    expect(rawConfig).not.toContain("123456:");
    expect(envFile).toContain('TELEGRAM_BOT_TOKEN="123456:stored-telegram-token"');
    expect(JSON.stringify(result)).not.toContain("123456:");
  });

  it("configures voice without drafting other optional capabilities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "enable",
          "openai",
          "gpt-4o-mini-tts",
          "VOICE_TTS_KEY",
          "openai",
          "gpt-4o-mini-transcribe",
          "VOICE_STT_KEY",
          true,
        ],
      }),
      defaultActionId: "configure-voice",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: unknown;
      tts?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
      imageGen?: unknown;
      browser?: unknown;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.voice.capability",
    ]);
    expect(config.tts?.provider).toBe("openai");
    expect(config.tts?.openai?.apiKeyEnv).toBe("VOICE_TTS_KEY");
    expect(config.stt?.provider).toBe("openai");
    expect(config.stt?.openai?.apiKeyEnv).toBe("VOICE_STT_KEY");
    expect(config.channels).toBeUndefined();
    expect(config.imageGen).toBeUndefined();
    expect(config.browser).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures image generation without drafting other optional capabilities", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "enable",
          "fal",
          "fal-ai/imagen4/preview",
          "FAL_KEY",
          false,
          true,
        ],
      }),
      defaultActionId: "configure-image-generation",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: unknown;
      tts?: unknown;
      stt?: unknown;
      imageGen?: { provider?: string; model?: string; fal?: { apiKeyEnv?: string } };
      browser?: unknown;
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-image-generation");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.vision.capability",
    ]);
    expect(config.imageGen?.provider).toBe("fal");
    expect(config.imageGen?.fal?.apiKeyEnv).toBe("FAL_KEY");
    expect(config.channels).toBeUndefined();
    expect(config.tts).toBeUndefined();
    expect(config.stt).toBeUndefined();
    expect(config.browser).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures browser without drafting other optional capabilities or auto-launching", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "enable",
          "local-cdp",
          "http://127.0.0.1:1",
          "google-chrome --remote-debugging-port=9222",
          true,
        ],
      }),
      defaultActionId: "configure-browser",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: unknown;
      tts?: unknown;
      stt?: unknown;
      imageGen?: unknown;
      browser?: { backend?: string; cdpUrl?: string; launchCommand?: string; autoLaunch?: boolean };
    };
    const browserLine = result.reviewManifest?.sections["enabled-optional-capabilities"]
      .find((line) => line.sourceDraftIds.includes("setup-module.browser.capability"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-browser");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.browser.capability",
    ]);
    expect(browserLine?.review.values.autoLaunchRequested).toBe(false);
    expect(browserLine?.review.values.autoLaunchWillRunNow).toBe(false);
    expect(config.browser).toEqual({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:1",
      launchCommand: "google-chrome --remote-debugging-port=9222",
      autoLaunch: false,
    });
    expect(config.channels).toBeUndefined();
    expect(config.tts).toBeUndefined();
    expect(config.stt).toBeUndefined();
    expect(config.imageGen).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("renders broken config as a repair-first diagnostic surface", async () => {
    await mkdir(dirname(profileConfigPath(tempDir)), { recursive: true });
    await writeFile(profileConfigPath(tempDir), "{not-json", "utf8");
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
    expect(result.output).toContain(profileConfigPath(tempDir));
    expect(result.output).toContain("Error:");
    expect(result.output).toContain("Normal config edits are blocked until the config file can be parsed.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(output.join("")).toContain("verify-setup - Run read-only verification");
    expect(output.join("")).toContain("show-diagnostics - Show diagnostics");
    expect(output.join("")).toContain("exit - Exit without changes");
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
    expect(result.output).toContain(profileConfigPath(tempDir));
    expect(result.output).toContain("not writable");
    expect(result.output).toContain("write permission");
    expect(result.output).toContain("Restore write permission");
    expect(result.output).toContain("read-only verification again");
    expect(result.output).toContain("Normal writes are blocked until the state/config path is writable.");
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

function trackingPrompt(options: { readonly values?: readonly unknown[]; readonly secret?: string } = {}): Prompt & {
  readonly secretPromptCount: () => number;
} {
  const base = fakePrompt(options);
  let secretPromptCount = 0;
  const prompt = (async (question: string, promptOptions?: { secret?: boolean }) => {
    if (promptOptions?.secret === true) {
      secretPromptCount += 1;
    }
    return base(question, promptOptions);
  }) as Prompt & { readonly secretPromptCount: () => number };
  prompt.select = base.select;
  prompt.onboardingCard = base.onboardingCard;
  prompt.close = base.close;
  Object.defineProperty(prompt, "secretPromptCount", {
    value: () => secretPromptCount,
  });
  return prompt;
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
    configured: true,
    executable: true,
    catalogOnly: false,
    supportsVision: false,
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
  };
}

async function writeUserConfig(homeDir: string, config: unknown, profileId = "default"): Promise<void> {
  const configPath = profileConfigPath(homeDir, profileId);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function profileConfigPath(homeDir: string, profileId = "default"): string {
  return resolveProfileStateHome({ homeDir, profileId }).configPath;
}

function profileEnvPath(homeDir: string, profileId = "default"): string {
  return resolveProfileStateHome({ homeDir, profileId }).envPath;
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
      warnings: ["Configured model context window is below 64K tokens."],
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

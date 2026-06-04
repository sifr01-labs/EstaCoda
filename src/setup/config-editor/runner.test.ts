import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../../cli/readline-prompt.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { ProviderId, ProviderApiMode, ProviderAuthMethod } from "../../contracts/provider.js";
import type { FlowEngine, ModelCandidate } from "../../providers/provider-model-selection-flow.js";
import { createReviewedSetupApplyExecutor } from "../review/apply-executor.js";
import { runConfigEditor } from "./runner.js";
import { promptModelCandidate, setupEditorReviewSelectedAreaLabel } from "./prompts.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import { resolveProfileStateHome, writeActiveProfile } from "../../config/profile-home.js";
import { isolateLtr } from "../../ui/bidi.js";
import {
  gatewayServiceActivationNotNowGuidance,
  gatewayServiceActivationPromptTitle,
  type GatewayActivationServiceActions,
} from "../gateway-service-activation.js";
import { resolveSetupCopy } from "../setup-copy.js";
import type { SetupApplyMode } from "../setup-apply-plan.js";
import * as pythonEnvManager from "../../python-env/manager.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-config-editor-"));
}

function mockManagedPythonEnvironment(homeDir: string): void {
  vi.spyOn(pythonEnvManager, "createManagedEnvironment").mockResolvedValue({
    ok: true,
    pythonBinary: join(homeDir, ".estacoda", "python-env", "bin", "python"),
  });
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
    vi.restoreAllMocks();
    delete process.env.PR8_SHELL_ONLY_KEY;
    delete process.env.ESTACODA_TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
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
    expect(output.join("")).toContain("Setup Editor");
    expect(output.join("")).toContain("Available actions:");
    expect(output.join("")).toContain("edit-fallback-model-route");
    expect(output.join("")).toContain("Configure backup providers and models used when the primary model fails.");
    expect(output.join("")).toContain("edit-auxiliary-model-route");
    expect(output.join("")).toContain("Configure specialist models for assessment, compression, recall, and memory.");
    expect(output.join("")).toContain("edit-security-mode");
    expect(output.join("")).toContain("edit-workflow-learning");
    expect(output.join("")).toContain("edit-language - Choose language");
    expect(output.join("")).toContain("configure-channels");
    expect(output.join("")).toContain("configure-voice");
    expect(output.join("")).toContain("configure-image-generation");
    expect(output.join("")).toContain("configure-browser");
    expect(output.join("")).not.toContain("edit-primary-credential-reference");
    expect(output.join("")).not.toContain("review-optional-capabilities");
    expect(output.join("")).toContain("verify-setup - Run setup verification");
    expect(output.join("")).toContain("show-diagnostics - Show diagnostics");
    expect(output.join("")).toContain("exit - Exit without changes");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("renders setup editor copy with the configured Arabic locale", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      ui: {
        language: "ar",
        flavor: "arabic-light",
        activityLabels: "ar",
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];
    const prompts: Array<{ title: string; body: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const prompt = fakePrompt();
    prompt.select = async (input) => {
      prompts.push({
        title: input.title,
        body: input.body ?? "",
        labels: input.options.map((option) => option.label),
        descriptions: input.options.map((option) => option.description),
      });
      const exit = input.options.find((option) =>
        typeof option.value === "object" &&
        option.value !== null &&
        "id" in option.value &&
        option.value.id === "exit"
      );
      return exit?.value ?? input.options[0]!.value;
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("exit");
    expect(output.join("")).toContain("محرّر الإعدادات");
    expect(output.join("")).toContain("عدّل النموذج الأساسي");
    expect(output.join("")).toContain("حدّد المزوّد والنموذج اللي يستخدمه الوكيل.");
    expect(output.join("")).toContain("فعّل قنوات التحكم عن بُعد مثل");
    expect(output.join("")).toContain(isolateLtr("Telegram"));
    expect(prompts[0]?.title).toBe("محرّر الإعدادات");
    expect(prompts[0]?.body).toBe("اختار اللي تحب تضبطه.");
    expect(prompts[0]?.labels).toContain("اخرج بدون تغييرات");
    expect(prompts[0]?.descriptions).toContain("اخرج من الإعداد من غير تعديل أي شيء.");
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
    expect(result.output).toContain("Setup verification prepared");
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
    expect(result.output).toContain("not available in the setup editor");
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
    const reviewPrompts: Array<{ title: string; body?: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const prompt = fakePrompt({ values: ["strict"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      if (input.title === "Finalize configuration") {
        reviewPrompts.push({
          title: input.title,
          body: input.body,
          labels: input.options.map((option) => option.label),
          descriptions: input.options.map((option) => option.description),
        });
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
    expect(reviewPrompts).toEqual([expect.objectContaining({
      title: "Finalize configuration",
      body: expect.stringContaining("Selected area: Security"),
      labels: ["Confirm", "Cancel"],
      descriptions: ["Update your EstaCoda configuration", "Keep your existing configuration unchanged."],
    })]);
    expect(config.security?.approvalMode).toBe("strict");
    expect(config.security?.assessor?.enabled).toBe(true);
    expect(config.model).toEqual((localReadyConfig() as { model: unknown }).model);
    expect(config.providers).toEqual((localReadyConfig() as { providers: unknown }).providers);
  });

  it("passes strict mode to setup editor apply execution", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    let observedMode: SetupApplyMode | undefined;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["strict"] }),
      defaultActionId: "edit-security-mode",
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
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    expect(observedMode).toBe("strict");
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


  it("applies reviewed Agent Evolution changes while preserving unrelated skill config", async () => {
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

  it("applies reviewed language changes through shared interface preference prompts", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      ui: {
        language: "en",
        flavor: "standard",
        activityLabels: "en",
      },
      security: {
        approvalMode: "adaptive",
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);
    const prompts: Array<{ title: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const prompt = fakePrompt({ values: ["ar"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      prompts.push({
        title: input.title,
        labels: input.options.map((option) => option.label),
        descriptions: input.options.map((option) => option.description),
      });
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-language",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      ui?: { language?: string; flavor?: string; activityLabels?: string };
      security?: { approvalMode?: string };
      model?: unknown;
    };
    const uiLine = result.reviewManifest?.sections["files-to-write-update"]
      .find((line) => line.review.summaryKey === "setupDrafts.uiPreferences.summary");

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-language");
    expect(prompts[0]?.title).toBe("Setup language");
    expect(prompts[0]?.labels).toEqual(["English", "العربية"]);
    expect(prompts.map((prompt) => prompt.title)).not.toContain("أسلوب الواجهة");
    expect(uiLine?.review.values).toEqual(expect.objectContaining({
      language: "ar",
      flavor: "arabic-light",
      activityLabels: "ar",
    }));
    expect(config.ui).toEqual({
      language: "ar",
      flavor: "arabic-light",
      activityLabels: "ar",
    });
    expect(config.security?.approvalMode).toBe("adaptive");
    expect(config.model).toEqual((localReadyConfig() as { model: unknown }).model);
  });

  it("resets Arabic activity labels when changing language back to English", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      ui: {
        language: "ar",
        flavor: "arabic-light",
        activityLabels: "ar",
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["en"] }),
      defaultActionId: "edit-language",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const config = JSON.parse(await readFile(profileConfigPath(tempDir), "utf8")) as {
      ui?: { language?: string; flavor?: string; activityLabels?: string };
    };
    const uiLine = result.reviewManifest?.sections["files-to-write-update"]
      .find((line) => line.review.summaryKey === "setupDrafts.uiPreferences.summary");

    expect(result.completed).toBe(true);
    expect(uiLine?.review.values).toEqual(expect.objectContaining({
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    }));
    expect(config.ui).toEqual({
      language: "en",
      flavor: "standard",
      activityLabels: "en",
    });
  });

  it("applies and verifies without showing the setup editor launch prompt", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["strict", true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
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
        collectVerification: () => readyVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-security-mode");
    expect(result.nextActionId).toBeUndefined();
    expect(result.postApplyRouteDecision?.kind).toBe("configured-menu");
    expect(result.applyEndState?.kind).toBe("verified-ready");
    expect(result.output).toContain("Verification passed. Setup is ready.");
    expect(result.output).not.toContain("Launch handoff accepted");
    expect(promptTitles).not.toContain("Setup next action");
    expect(result.output).not.toContain("Selected: Launch EstaCoda");
  });

  it("returns degraded setup output without limited-mode launch handoff", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["proactive", true] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => degradedVerification(profileConfigPath(tempDir)),
      }),
    });

    expect(result.completed).toBe(true);
    expect(result.nextActionId).toBeUndefined();
    expect(result.postApplyRouteDecision).toBeDefined();
    expect(result.applyEndState?.kind).toBe("verified-degraded");
    expect(result.output).toContain("Verification completed with warnings");
    expect(result.output).toContain("Verification warnings:");
    expect(result.output).toContain("Network inference is disabled for the selected hosted provider.");
    expect(result.output).toContain("Configured model context window is below 64K tokens.");
    expect(result.output).not.toContain("Limited mode accepted for launch");
    expect(promptTitles).not.toContain("Setup next action");
  });

  it("does not expose launch after blocked verification", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: ["strict", true] });
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
    expect(result.nextActionId).toBeUndefined();
    expect(result.applyEndState?.kind).toBe("blocked");
    expect(postApplyOptionLabels).toEqual([]);
    expect(result.output).toContain("Verification blocked");
    expect(result.output).not.toContain("Exited after setup apply without launching");
  });

  it("does not expose launch when post-apply verification cannot run", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: ["strict", true] });
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
    expect(result.nextActionId).toBeUndefined();
    expect(result.applyEndState?.kind).toBe("saved-not-launched");
    expect(postApplyOptionLabels).toEqual([]);
    expect(result.output).toContain("Setup prepared without launch handoff");
    expect(result.output).not.toContain("Exited after setup apply without launching");
  });

  it("does not expose launch when the fresh post-apply route is still unsafe", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    const postApplyOptionLabels: string[][] = [];
    const prompt = fakePrompt({ values: [true, true] });
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
    expect(result.nextActionId).toBeUndefined();
    expect(result.applyEndState?.kind).toBe("verified-ready");
    expect(postApplyOptionLabels).toEqual([]);
  });

  it("does not re-enter setup editor after existing-user apply", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const output: string[] = [];

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({ values: ["proactive", true] }),
      defaultActionId: "edit-workflow-learning",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => degradedVerification(profileConfigPath(tempDir)),
      }),
      output: { write: (value) => output.push(value) },
    });

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("edit-workflow-learning");
    expect(result.reviewManifest).toBeDefined();
    expect(output.join("").match(/Setup Editor/g)).toHaveLength(1);
    expect(output.join("")).not.toContain("Repair again selected. Re-entering setup editor.");
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
      apiKeyEnv: "PR8_OPENAI_KEY",
    }));
    expect(config.providers?.openai?.baseUrl).toBeUndefined();
    expect(config.providers?.openai).not.toHaveProperty("baseUrl");
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
      if (input.title === "Fallback models") {
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
      if (input.title === "Fallback models") {
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
      "Add another fallback model",
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
      if (input.title === "Choose auxiliary model.") {
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
    expect(optionLabels[0]).toEqual(["Telegram", "WhatsApp beta", "Discord beta"]);
    expect(optionLabels[1]).toEqual(["Leave unchanged", "Enable/configure"]);
    expect(optionLabels).toHaveLength(2);
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
        values: ["telegram", "enable", "", "", "skip", true],
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
          "telegram",
          "enable",
          "",
          "",
          "retry",
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
    const seenQuestions: string[] = [];
    const seenCards: Array<{ title: string; bodyLines: readonly string[] }> = [];
    const reviewPrompts: Array<{ title: string; body?: string; labels: string[]; descriptions: Array<string | undefined> }> = [];
    const output: string[] = [];
    const basePrompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const prompt = (async (question: string, options?: { secret?: boolean }) => {
      seenQuestions.push(question);
      return basePrompt(question, options);
    }) as Prompt;
    prompt.select = async (input) => {
      if (input.title === "Finalize configuration") {
        reviewPrompts.push({
          title: input.title,
          body: input.body,
          labels: input.options.map((option) => option.label),
          descriptions: input.options.map((option) => option.description),
        });
      }
      return basePrompt.select!(input);
    };
    prompt.onboardingCard = (input) => {
      seenCards.push({ title: input.title, bodyLines: input.bodyLines });
    };
    prompt.close = basePrompt.close;

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      output: { write: (value) => output.push(value) },
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const envFile = await readFile(profileEnvPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: { telegram?: { enabled?: boolean; botTokenEnv?: string; allowedUserIds?: string[]; allowedChatIds?: string[] } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(seenQuestions.some((question) => question.includes("Env var name to store Telegram bot token under"))).toBe(false);
    expect(seenQuestions).toContain("Telegram bot API token: ");
    expect(seenQuestions).toContain("Allowed Telegram user ID(s): ");
    expect(seenQuestions).toContain("Allowed Telegram group chat ID(s): ");
    expect(seenCards.map((card) => card.title)).toEqual(["Configure Telegram", "Configure Telegram", "Configure Telegram"]);
    expect(seenCards[0]?.bodyLines).toContain("Connect Telegram bot");
    expect(seenCards[0]?.bodyLines.join("\n")).toContain("Open Telegram and search for the official @BotFather account.");
    expect(seenCards[1]?.bodyLines).toContain("Authorize Telegram users");
    expect(seenCards[1]?.bodyLines.join("\n")).toContain("Open Telegram and search for @userinfobot.");
    expect(seenCards[2]?.bodyLines).toContain("Authorize Telegram group chats");
    expect(seenCards[2]?.bodyLines.join("\n")).toContain("Add @getidsbot or @chatIDrobot to the same group chat.");
    expect(reviewPrompts).toEqual([expect.objectContaining({
      title: "Finalize configuration",
      body: expect.stringContaining("Selected area: Channels · Telegram"),
      labels: ["Confirm", "Cancel"],
      descriptions: ["Update your EstaCoda configuration", "Keep your existing configuration unchanged."],
    })]);
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.output).not.toContain("Review manifest.");
    expect(result.output).not.toContain("Configuration write.");
    expect(result.output).not.toContain("Enabled optional capabilities.");
    expect(result.output).not.toContain("Remote-control surfaces and allowed identities.");
    expect(output.join("")).not.toContain("Review manifest.");
    expect(output.join("")).not.toContain("Configuration write.");
    expect(output.join("")).not.toContain("Enabled optional capabilities.");
    expect(output.join("")).not.toContain("Remote-control surfaces and allowed identities.");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.telegram.capability",
    ]);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.remoteControlIdentityConstraint).toBe("allowed-user-or-chat-id");
    expect(config.channels?.telegram).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN",
      allowedUserIds: ["42"],
      allowedChatIds: ["-100"],
    }));
    expect(rawConfig).not.toContain("123456:");
    expect(envFile).toContain('ESTACODA_TELEGRAM_BOT_TOKEN="123456:stored-telegram-token"');
    expect(JSON.stringify(result)).not.toContain("123456:");
  });

  it("prompts after reviewed Telegram channel apply before the post-apply handoff and starts the service", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: [
        "telegram",
        "enable",
        "42",
        "-100",
        true,
        "Yes",
      ],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
      kind: "started",
      installed: true,
    }));
    expect(actions.install).toHaveBeenCalledTimes(1);
    expect(actions.start).toHaveBeenCalledTimes(1);
    expect(promptTitles.indexOf(gatewayServiceActivationPromptTitle)).toBeGreaterThan(-1);
    expect(promptTitles).not.toContain(resolveSetupCopy("en", "setupEditor.prompt.postApply.title"));
    expect(result.output).toContain("Gateway service installed and started for configured Telegram channel.");
    expect(JSON.stringify(result)).not.toContain("123456:stored-telegram-token");
  });

  it("does not install or start when the config-editor gateway prompt is declined", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "telegram",
          "enable",
          "42",
          "-100",
          true,
          "Not now",
        ],
        secret: "123456:stored-telegram-token",
      }),
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
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

  it("does not offer gateway activation when a ready channel already existed before setup editor apply", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      channels: {
        telegram: {
          enabled: true,
          botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN",
          allowedUserIds: ["42"],
        },
      },
    });
    process.env.ESTACODA_TELEGRAM_BOT_TOKEN = "existing-telegram-token";
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual({
      kind: "not-offered",
      reason: "ready-channel-already-configured",
    });
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("does not offer gateway activation when the managed service is already installed", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions({ installedBefore: true });
    const promptTitles: string[] = [];
    const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult).toEqual({
      kind: "not-offered",
      reason: "gateway-service-already-installed",
    });
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("applies reviewed Discord beta channel with env ref and fail-closed allowlist", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["discord", "enable", "DISCORD_BOT_TOKEN", "user-42", "guild-7", "channel-9", true],
        secret: "discord-token-value",
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
      channels?: {
        discord?: {
          enabled?: boolean;
          botTokenEnv?: string;
          allowedUsers?: string[];
          allowedGuilds?: string[];
          allowedChannels?: string[];
        };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-channels");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.discord.capability",
    ]);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values.remoteControlIdentityConstraint).toBe("allowed-discord-user-or-channel");
    expect(config.channels?.discord).toEqual(expect.objectContaining({
      enabled: true,
      botTokenEnv: "DISCORD_BOT_TOKEN",
      allowedUsers: ["user-42"],
      allowedGuilds: ["guild-7"],
      allowedChannels: ["channel-9"],
    }));
    expect(rawConfig).not.toContain("discord-token-value");
    expect(envFile).toContain('DISCORD_BOT_TOKEN="discord-token-value"');
    expect(JSON.stringify(result)).not.toContain("discord-token-value");
  });

  it("does not draft Discord beta channel enablement without allowed users or channels", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["discord", "enable", "DISCORD_BOT_TOKEN", "", "", "", "skip", true],
        secret: "discord-token-value",
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("discord-token-value");
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("applies reviewed WhatsApp beta channel with profile-local auth and allowed users", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "enable", "971501234567", true],
      }),
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      channels?: {
        whatsapp?: {
          enabled?: boolean;
          experimental?: boolean;
          authDir?: string;
          allowedUsers?: string[];
        };
      };
    };

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.whatsapp.capability",
    ]);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(1);
    expect(result.reviewManifest?.sections["remote-control-surfaces"][0]?.review.values).toEqual(expect.objectContaining({
      beta: true,
      experimental: true,
      allowedUsers: ["971501234567"],
      remoteControlIdentityConstraint: "allowed-whatsapp-users",
    }));
    expect(config.channels?.whatsapp).toEqual(expect.objectContaining({
      enabled: true,
      experimental: true,
      allowedUsers: ["971501234567"],
    }));
    expect(config.channels?.whatsapp?.authDir).toContain("/gateway/whatsapp-auth");
  });

  it("offers gateway activation after reviewed Discord and WhatsApp channel setup when each is ready", async () => {
    for (const scenario of [
      {
        channel: "discord",
        values: ["discord", "enable", "DISCORD_BOT_TOKEN", "user-42", "", "channel-9", true, "Not now", "exit"],
        secret: "discord-token-value",
        expected: "Discord",
      },
      {
        channel: "whatsapp",
        values: ["whatsapp", "enable", "971501234567", true, "Not now", "exit"],
        secret: undefined,
        expected: "WhatsApp",
      },
    ] as const) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await makeTempDir();
      workspaceRoot = join(tempDir, "workspace");
      await mkdir(workspaceRoot, { recursive: true });
      await writeUserConfig(tempDir, localReadyConfig());
      await trustWorkspace(tempDir, workspaceRoot);
      const promptTitles: string[] = [];
      const prompt = fakePrompt({
        values: scenario.values,
        secret: scenario.secret,
      });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        promptTitles.push(input.title);
        return baseSelect(input);
      };
      const actions = gatewayServiceActions();

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: "configure-channels",
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
        }),
        gatewayServiceActivation: { serviceActions: actions },
      });

      expect(result.gatewayServiceActivationResult).toEqual(expect.objectContaining({
        kind: "declined",
        channels: [expect.objectContaining({ label: scenario.expected })],
      }));
      expect(promptTitles).toContain(gatewayServiceActivationPromptTitle);
      expect(actions.install).not.toHaveBeenCalled();
      expect(actions.start).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("discord-token-value");
      expect(scenario.channel).toMatch(/discord|whatsapp/u);
    }
  });

  it("does not draft WhatsApp beta channel enablement without allowed users", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const before = await readFile(profileConfigPath(tempDir), "utf8");

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: ["whatsapp", "enable", "", "skip", true],
      }),
      defaultActionId: "configure-channels",
    });

    expect(result.completed).toBe(true);
    expect(result.reviewManifest?.sections["remote-control-surfaces"]).toHaveLength(0);
    await expect(readFile(profileConfigPath(tempDir), "utf8")).resolves.toBe(before);
  });

  it("does not offer gateway activation for non-channel config-editor changes", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
    const prompt = fakePrompt({ values: ["strict", true, "exit"] });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
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
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("does not offer gateway activation for provider, voice, or browser-only changes", async () => {
    for (const scenario of [
      {
        actionId: "edit-primary-model-route" as const,
        values: ["OpenAI", "gpt-5.5", true],
        secret: "sk-provider-only-secret",
        flowEngine: flowEngine({ credentialAction: "collect", envVarName: "PR8_PROVIDER_ONLY_KEY" }),
      },
      {
        actionId: "configure-voice" as const,
        values: ["stt", "enable", "openai", "gpt-4o-mini-transcribe", "VOICE_STT_KEY", true],
      },
      {
        actionId: "configure-browser" as const,
        values: ["enable", "local", "http://127.0.0.1:9222", "google-chrome --remote-debugging-port=9222", true],
      },
    ]) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await makeTempDir();
      workspaceRoot = join(tempDir, "workspace");
      await mkdir(workspaceRoot, { recursive: true });
      await writeUserConfig(tempDir, localReadyConfig());
      await trustWorkspace(tempDir, workspaceRoot);
      const actions = gatewayServiceActions();
      const promptTitles: string[] = [];
      const prompt = fakePrompt({
        values: scenario.values,
        secret: scenario.secret,
      });
      const baseSelect = prompt.select!;
      prompt.select = async (input) => {
        promptTitles.push(input.title);
        return baseSelect(input);
      };

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt,
        defaultActionId: scenario.actionId,
        ...(scenario.flowEngine === undefined ? {} : { flowEngine: scenario.flowEngine }),
        applyExecutor: createReviewedSetupApplyExecutor({
          homeDir: tempDir,
          workspaceRoot,
          collectVerification: () => readyVerification(profileConfigPath(tempDir)),
        }),
        gatewayServiceActivation: { serviceActions: actions },
      });

      expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
      expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
      expect(actions.install).not.toHaveBeenCalled();
      expect(actions.start).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("sk-provider-only-secret");
    }
  });

  it("does not offer gateway activation when channel review is cancelled", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
  const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", false],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.applyPlanningResult?.kind).toBe("cancelled");
    expect(result.gatewayServiceActivationResult).toBeUndefined();
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("does not offer gateway activation when channel apply fails", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
  const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: {
        apply: () => ({ ok: false, appliedOperationIds: [], error: "intentional apply failure" }),
      },
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.applyEndState?.kind).toBe("blocked");
    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("uses the config-editor post-apply handoff gate before offering gateway activation", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    const actions = gatewayServiceActions();
    const promptTitles: string[] = [];
  const prompt = fakePrompt({
      values: ["telegram", "enable", "42", "-100", true, "exit"],
      secret: "123456:stored-telegram-token",
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      promptTitles.push(input.title);
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-channels",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
        collectVerification: () => ({
          stateWritable: false,
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
          warnings: ["state is not writable"],
          issueCodes: ["state-not-writable"],
        }),
      }),
      gatewayServiceActivation: { serviceActions: actions },
    });

    expect(result.gatewayServiceActivationResult?.kind).toBe("not-offered");
    expect(promptTitles).not.toContain(gatewayServiceActivationPromptTitle);
    expect(actions.install).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  });

  it("configures TTS voice without drafting STT or other optional capabilities", async () => {
    await writeUserConfig(tempDir, {
      ...localReadyConfig(),
      stt: {
        provider: "local",
        local: {
          engine: "command",
          command: "existing-stt-command",
        },
      },
    });
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "tts",
          "enable",
          "openai",
          "gpt-4o-mini-tts",
          "VOICE_TTS_KEY",
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
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "VOICE_TTS_KEY",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("sttProvider");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"].map((line) => line.sourceDraftIds[0])).toEqual([
      "setup-module.voice.capability",
    ]);
    expect(config.tts?.provider).toBe("openai");
    expect(config.tts?.openai?.apiKeyEnv).toBe("VOICE_TTS_KEY");
    expect(config.stt).toEqual({
      provider: "local",
      local: {
        engine: "command",
        command: "existing-stt-command",
      },
    });
    expect(config.channels).toBeUndefined();
    expect(config.imageGen).toBeUndefined();
    expect(config.browser).toBeUndefined();
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures STT voice without drafting or writing TTS", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt({
        values: [
          "stt",
          "enable",
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
      tts?: unknown;
      stt?: { provider?: string; openai?: { model?: string; apiKeyEnv?: string } };
    };

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttApiKeyEnv: "VOICE_STT_KEY",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("ttsProvider");
    expect(config.tts).toBeUndefined();
    expect(config.stt?.provider).toBe("openai");
    expect(config.stt?.openai?.apiKeyEnv).toBe("VOICE_STT_KEY");
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("configures local faster-whisper STT with prompt-card model choices", async () => {
    await writeUserConfig(tempDir, localReadyConfig());
    await trustWorkspace(tempDir, workspaceRoot);
    mockManagedPythonEnvironment(tempDir);
    const selectCalls: Array<{
      title: string;
      body: string;
      labels: string[];
      descriptions: Array<string | undefined>;
      values: unknown[];
    }> = [];
    const prompt = fakePrompt({
      values: [
        "stt",
        "enable",
        "local",
        "base",
        true,
      ],
    });
    const baseSelect = prompt.select!;
    prompt.select = async (input) => {
      selectCalls.push({
        title: input.title,
        body: input.body ?? "",
        labels: input.options.map((option) => option.label),
        descriptions: input.options.map((option) => option.description),
        values: input.options.map((option) => option.value),
      });
      return baseSelect(input);
    };

    const result = await runConfigEditor({
      homeDir: tempDir,
      workspaceRoot,
      prompt,
      defaultActionId: "configure-voice",
      applyExecutor: createReviewedSetupApplyExecutor({
        homeDir: tempDir,
        workspaceRoot,
      }),
    });
    const rawConfig = await readFile(profileConfigPath(tempDir), "utf8");
    const config = JSON.parse(rawConfig) as {
      tts?: unknown;
      stt?: {
        provider?: string;
        local?: {
          model?: string;
          engine?: string;
          fasterWhisper?: {
            enabled?: boolean;
            model?: string;
            allowModelDownload?: boolean;
          };
        };
      };
    };
    const sttProviderPrompt = selectCalls.find((call) => call.body.includes("STT provider"));
    const localModelPrompt = selectCalls.find((call) => call.body.includes("Pick the faster-whisper STT model"));

    expect(result.completed).toBe(true);
    expect(result.selectedActionId).toBe("configure-voice");
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).toMatchObject({
      sttProvider: "local",
      sttModel: "base",
      secretValuesIncluded: false,
    });
    expect(result.reviewManifest?.sections["enabled-optional-capabilities"][0]?.review.values).not.toHaveProperty("ttsProvider");
    expect(config.tts).toBeUndefined();
    expect(config.stt).toEqual({
      provider: "local",
      local: {
        model: "base",
        engine: "faster-whisper",
        fasterWhisper: {
          enabled: true,
          model: "base",
          allowModelDownload: true,
        },
      },
    });
    expect(sttProviderPrompt?.labels).toContain("Local (via faster-whisper)");
    expect(sttProviderPrompt?.values).toContain("local");
    expect(localModelPrompt?.title).toBe("Configure STT");
    expect(localModelPrompt?.labels).toEqual([
      "Base (recommended for everyday use)",
      "Small",
      "Medium",
    ]);
    expect(localModelPrompt?.descriptions).toEqual([
      "Balanced speed and accuracy for most voice notes.",
      "Better accuracy than Base, with higher CPU and memory use.",
      "Higher accuracy for difficult audio, but slower and heavier.",
    ]);
    expect(localModelPrompt?.values).toEqual(["base", "small", "medium"]);
    expect(rawConfig).not.toContain("sk-");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  for (const model of ["small", "medium"] as const) {
    it(`configures local faster-whisper STT model ${model}`, async () => {
      await writeUserConfig(tempDir, localReadyConfig());
      await trustWorkspace(tempDir, workspaceRoot);
      mockManagedPythonEnvironment(tempDir);

      const result = await runConfigEditor({
        homeDir: tempDir,
        workspaceRoot,
        prompt: fakePrompt({
          values: [
            "stt",
            "enable",
            "local",
            model,
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
        stt?: {
          provider?: string;
          local?: {
            model?: string;
            engine?: string;
            fasterWhisper?: { enabled?: boolean; model?: string; allowModelDownload?: boolean };
          };
        };
      };

      expect(result.completed).toBe(true);
      expect(config.stt).toEqual({
        provider: "local",
        local: {
          model,
          engine: "faster-whisper",
          fasterWhisper: {
            enabled: true,
            model,
            allowModelDownload: true,
          },
        },
      });
    });
  }

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
    expect(output.join("")).toContain("Setup Editor");
    expect(output.join("")).toContain("Available actions:");
    expect(output.join("")).not.toContain("محرّر الإعدادات");
    expect(result.output).toContain("Setup diagnostics");
    expect(result.output).toContain("State: broken-config");
    expect(result.output).toContain(profileConfigPath(tempDir));
    expect(result.output).toContain("Error:");
    expect(result.output).toContain("Normal config edits are blocked until the config file can be parsed.");
    expect(result.output).toContain("Only diagnostics, verification, and exit are available");
    expect(output.join("")).toContain("verify-setup - Run setup verification");
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

describe("setupEditorReviewSelectedAreaLabel", () => {
  it("preserves existing English selected area labels", () => {
    expect(setupEditorReviewSelectedAreaLabel("configure-channels", minimalManifest(["channels.telegram"]))).toBe("Channels · Telegram");
    expect(setupEditorReviewSelectedAreaLabel("edit-security-mode", minimalManifest())).toBe("Security");
  });

  it("localizes Arabic selected area labels while isolating technical channel names", () => {
    expect(setupEditorReviewSelectedAreaLabel("configure-channels", minimalManifest(["channels.telegram"]), "ar")).toBe(
      `القنوات · ${isolateLtr("Telegram")}`
    );
    expect(setupEditorReviewSelectedAreaLabel("edit-primary-model-route", minimalManifest(), "ar")).toBe("النموذج · الأساسي");
    expect(setupEditorReviewSelectedAreaLabel("edit-security-mode", minimalManifest(), "ar")).toBe("الأمان");
  });
});

function minimalManifest(sourceBundleIds: readonly string[] = []): SetupReviewManifest {
  return {
    kind: "setup-review-manifest",
    sourceBundleIds,
    lines: [],
    sections: {
      "files-to-write-update": [],
      "secret-refs-to-store": [],
      "workspace-trust-grants": [],
      "provider-model-network": [],
      "enabled-optional-capabilities": [],
      "remote-control-surfaces": [],
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
      bundleCount: sourceBundleIds.length,
      lineCount: 0,
      blockerCount: 0,
      warningCount: 0,
      readOnlyCount: 0,
    },
  };
}

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

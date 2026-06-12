import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserSetupModule,
  buildSetupModuleDraftBundle,
  credentialsSetupModule,
  providerSetupModule,
  securityModeSetupModule,
  telegramSetupModule,
  visionSetupModule,
  voiceSetupModule,
  workflowLearningSetupModule,
  workspaceTrustSetupModule,
  type SetupModuleContext,
} from "./setup-modules.js";

function context(overrides: SetupModuleContext = {}): SetupModuleContext {
  return {
    configPath: "/tmp/home/.estacoda/config.json",
    workspaceRoot: "/tmp/workspace",
    trustStorePath: "/tmp/home/.estacoda/trust.json",
    provider: {
      id: "openai",
      model: "gpt-4.1-mini",
      credentialEnv: "OPENAI_API_KEY",
    },
    credentials: {
      envVars: ["OPENAI_API_KEY"],
      values: {
        OPENAI_API_KEY: "sk-do-not-render",
      },
    },
    workspaceTrust: {
      trusted: false,
    },
    securityMode: "adaptive",
    workflowLearning: "suggest",
    ...overrides,
  };
}

describe("setup modules", () => {
  it("provider module detects and configures route drafts", () => {
    const detected = providerSetupModule.detect(context());
    const drafts = providerSetupModule.toDrafts(context());

    expect(detected.status).toBe("configured");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe("provider-model-route");
    expect(drafts[0]?.source).toEqual({
      kind: "setup-module",
      moduleId: "provider",
      actionId: "configure-route",
    });
    expect(drafts[0]?.target).toEqual({
      kind: "config-scope",
      scope: ["model.provider", "model.id"],
      path: "/tmp/home/.estacoda/config.json",
      preserveUnrelatedConfig: true,
    });
  });

  it("hosted provider module requires a credential ref", () => {
    const detected = providerSetupModule.detect(context({
      provider: {
        id: "openai",
        model: "gpt-4.1-mini",
      },
      credentials: {
        values: {
          OPENAI_API_KEY: "sk-do-not-render",
        },
      },
    }));

    expect(detected.status).toBe("missing");
    expect(detected.blockers).toContain("Hosted providers require a credential environment-variable reference.");
    expect(JSON.stringify(detected)).not.toContain("sk-do-not-render");
  });

  it("local provider module skips credential requirements", () => {
    const localContext = context({
      provider: {
        id: "local",
        model: "hermes-local",
      },
      credentials: {
        values: {
          OPENAI_API_KEY: "sk-do-not-render",
        },
      },
    });

    expect(providerSetupModule.detect(localContext).data.hostedCredentialRequired).toBe(false);
    expect(credentialsSetupModule.detect(localContext).status).toBe("skipped");
    expect(credentialsSetupModule.toDrafts(localContext)).toEqual([]);
  });

  it("credential module redacts secret values", () => {
    const drafts = credentialsSetupModule.toDrafts(context());
    const json = JSON.stringify(drafts);

    expect(drafts[0]?.review.values.envVars).toEqual(["OPENAI_API_KEY"]);
    expect(drafts[0]?.review.values.credentialValuesIncluded).toBe(false);
    expect(json).not.toContain("sk-do-not-render");
    expect(json).not.toContain("secretValue");
  });

  it("workspace trust module produces a trust draft without granting trust", () => {
    const draft = workspaceTrustSetupModule.toDrafts(context())[0];

    expect(draft?.kind).toBe("workspace-trust");
    expect(draft?.target).toEqual({
      kind: "trust-store",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    expect(draft?.applyIntent).toEqual({
      kind: "dry-run-apply-intent",
      effect: "trust-grant",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    });
  });

  it("security mode module produces a scoped draft", () => {
    const draft = securityModeSetupModule.toDrafts(context())[0];

    expect(draft?.kind).toBe("security-mode");
    expect(draft?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["security.approvalMode"],
      preserveUnrelatedConfig: true,
    }));
  });

  it("Agent Evolution module produces a scoped draft", () => {
    const draft = workflowLearningSetupModule.toDrafts(context())[0];

    expect(draft?.kind).toBe("workflow-learning");
    expect(draft?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["skills.autonomy"],
      preserveUnrelatedConfig: true,
    }));
  });

  it("Telegram module redacts token values and shows remote-control identity constraints", () => {
    const telegramContext = context({
      telegram: {
        enabled: true,
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        botToken: "123456:do-not-render",
        allowedUserIds: ["42"],
        allowedChatIds: ["-100"],
      },
    });
    const draft = telegramSetupModule.toDrafts(telegramContext)[0];
    const json = JSON.stringify(draft);

    expect(draft?.review.values.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
    expect(draft?.review.values.tokenValueIncluded).toBe(false);
    expect(draft?.review.values.allowedUserIds).toEqual(["42"]);
    expect(draft?.review.values.allowedChatIds).toEqual(["-100"]);
    expect(draft?.review.values.remoteControlIdentityConstraint).toBe("allowed-user-or-chat-id");
    expect(json).not.toContain("123456:do-not-render");
  });

  it("browser module does not auto-launch", () => {
    const draft = browserSetupModule.toDrafts(context({
      browser: {
        backend: "local-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        autoLaunch: true,
      },
    }))[0];

    expect(draft?.review.values.autoLaunchRequested).toBe(true);
    expect(draft?.review.values.autoLaunchWillRunNow).toBe(false);
    expect(draft?.applyIntent.dryRunOnly).toBe(true);
  });

  it("browser module carries browser mode review fields without secrets", () => {
    const browserbaseDraft = browserSetupModule.toDrafts(context({
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true,
        cloudFallback: true,
        cloudSpendApproved: false,
      },
    }))[0];
    const disabledDraft = browserSetupModule.toDrafts(context({
      browser: {
        backend: "unconfigured",
        autoLaunch: false,
        supervised: false,
      },
    }))[0];

    expect(browserbaseDraft?.review.values).toMatchObject({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudFallback: true,
      cloudSpendApproved: false,
      autoLaunchRequested: false,
      autoLaunchWillRunNow: false,
    });
    expect(disabledDraft?.review.values).toMatchObject({
      backend: "unconfigured",
      supervised: false,
      autoLaunchRequested: false,
      autoLaunchWillRunNow: false,
    });
  });

  it("voice module does not print hosted secrets", () => {
    const draft = voiceSetupModule.toDrafts(context({
      voice: {
        ttsProvider: "openai",
        ttsModel: "gpt-4o-mini-tts",
        ttsApiKeyEnv: "OPENAI_API_KEY",
        ttsApiKey: "sk-voice-do-not-render",
      },
    }))[0];
    const json = JSON.stringify(draft);

    expect(draft?.review.values.ttsApiKeyEnv).toBe("OPENAI_API_KEY");
    expect(draft?.review.values.secretValuesIncluded).toBe(false);
    expect(json).not.toContain("sk-voice-do-not-render");
  });

  it("voice module review values only include the configured side", () => {
    const sttDraft = voiceSetupModule.toDrafts(context({
      voice: {
        sttProvider: "openai",
        sttModel: "gpt-4o-mini-transcribe",
        sttApiKeyEnv: "OPENAI_API_KEY",
      },
    }))[0];
    const ttsDraft = voiceSetupModule.toDrafts(context({
      voice: {
        ttsProvider: "openai",
        ttsModel: "gpt-4o-mini-tts",
        ttsApiKeyEnv: "OPENAI_API_KEY",
      },
    }))[0];
    const localSttDraft = voiceSetupModule.toDrafts(context({
      voice: {
        sttProvider: "local",
        sttModel: "base",
        sttApiKeyEnv: "",
      },
    }))[0];

    expect(sttDraft?.review.values).toMatchObject({
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttApiKeyEnv: "OPENAI_API_KEY",
      secretValuesIncluded: false,
    });
    expect(sttDraft?.review.values).not.toHaveProperty("ttsProvider");
    expect(ttsDraft?.review.values).toMatchObject({
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "OPENAI_API_KEY",
      secretValuesIncluded: false,
    });
    expect(ttsDraft?.review.values).not.toHaveProperty("sttProvider");
    expect(localSttDraft?.review.values).toMatchObject({
      sttProvider: "local",
      sttModel: "base",
      secretValuesIncluded: false,
    });
    expect(localSttDraft?.review.values).not.toHaveProperty("sttApiKeyEnv");
  });

  it("image and vision module lists provider and model without secret value", () => {
    const draft = visionSetupModule.toDrafts(context({
      vision: {
        provider: "fal",
        model: "fal-ai/imagen4/preview",
        apiKeyEnv: "FAL_KEY",
        apiKey: "fal-secret-do-not-render",
      },
    }))[0];
    const json = JSON.stringify(draft);

    expect(draft?.review.values.provider).toBe("fal");
    expect(draft?.review.values.model).toBe("fal-ai/imagen4/preview");
    expect(draft?.review.values.apiKeyEnv).toBe("FAL_KEY");
    expect(draft?.review.values.secretValuesIncluded).toBe(false);
    expect(json).not.toContain("fal-secret-do-not-render");
  });

  it("optional modules are independently skippable", () => {
    const telegramDraft = telegramSetupModule.toDrafts(context(), telegramSetupModule.configure(context(), { skip: true }))[0];
    const browserDraft = browserSetupModule.toDrafts(context({
      skippedModules: ["telegram"],
      browser: {
        backend: "mock",
      },
    }))[0];

    expect(telegramDraft?.review.values.skipped).toBe(true);
    expect(telegramDraft?.requiresReview).toBe(false);
    expect(browserDraft?.review.values.skipped).toBe(false);
    expect(browserDraft?.source).toEqual(expect.objectContaining({ moduleId: "browser" }));
  });

  it("verification remains read-only", () => {
    const verification = telegramSetupModule.verify?.(context());

    expect(verification).toEqual({
      kind: "setup-module-verification",
      moduleId: "telegram",
      readOnly: true,
      mutatesConfig: false,
      writesState: false,
      data: {
        readOnly: true,
      },
    });
  });

  it("module drafts contain no terminal rendering fields", () => {
    const bundle = buildSetupModuleDraftBundle(context({
      telegram: {
        enabled: true,
        botTokenEnv: "TELEGRAM_BOT_TOKEN",
        allowedUserIds: ["42"],
      },
      browser: {
        backend: "mock",
      },
      voice: {
        ttsProvider: "edge",
      },
      vision: {
        provider: "fal",
        model: "fal-ai/imagen4/preview",
        apiKeyEnv: "FAL_KEY",
      },
    }));
    const json = JSON.stringify(bundle);

    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(bundle);
  });

  it("does not reintroduce backupForMain", () => {
    expect(JSON.stringify(buildSetupModuleDraftBundle(context()))).not.toContain("backupForMain");
  });

  it("module draft creation does not mutate filesystem, config, or state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-setup-modules-"));
    const configPath = join(homeDir, ".estacoda", "config.json");
    const trustStorePath = join(homeDir, ".estacoda", "trust.json");

    buildSetupModuleDraftBundle(context({
      configPath,
      trustStorePath,
      workspaceRoot: join(homeDir, "workspace"),
    }));

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(trustStorePath)).toBe(false);
    expect(existsSync(join(homeDir, ".estacoda"))).toBe(false);
  });

  it("broken config blocks unsafe normal module apply drafts", () => {
    const bundle = buildSetupModuleDraftBundle(context({ brokenConfig: true }));

    expect(bundle.safeToApplyLater).toBe(false);
    expect(bundle.drafts.some((draft) => draft.kind === "diagnostic-blocker")).toBe(true);
    expect(bundle.drafts.some((draft) => draft.target.kind === "config-scope")).toBe(false);
  });
});

function assertNoRenderingFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRenderingFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/^(terminal|rendered|renderedText|promptText|ansi)$/u);
    assertNoRenderingFields(child);
  }
}

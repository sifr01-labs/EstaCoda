import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SetupDraft, SetupDraftBundle } from "./setup-drafts.js";
import { buildFirstRunDraftBundle } from "./setup-drafts.js";
import { buildSetupModuleDraftBundle, type SetupModuleContext } from "./setup-modules.js";
import { buildSetupReviewManifest } from "./setup-review-manifest.js";
import type { FirstRunPlanSession } from "./setup-router.js";

function firstRunBundle(): SetupDraftBundle {
  return buildFirstRunDraftBundle({
    plan: {
      selections: {
        workspaceRoot: "/tmp/workspace",
        workspaceTrusted: true,
        primaryProvider: "openai",
        primaryModel: "gpt-4.1-mini",
        primaryCredential: { kind: "env", name: "OPENAI_API_KEY" },
        securityMode: "adaptive",
        workflowLearning: "suggest",
        optionalCapabilitiesSkipped: true,
        verifySelected: true,
        launchSelected: true,
      },
    },
  } as FirstRunPlanSession, {
    configPath: "/tmp/home/.estacoda/config.json",
    workspaceRoot: "/tmp/workspace",
    trustStorePath: "/tmp/home/.estacoda/trust.json",
  });
}

function moduleContext(overrides: SetupModuleContext = {}): SetupModuleContext {
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
      trusted: true,
    },
    securityMode: "adaptive",
    workflowLearning: "suggest",
    telegram: {
      enabled: true,
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      botToken: "123456:do-not-render",
      allowedUserIds: ["42"],
    },
    browser: {
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:9222",
      autoLaunch: true,
    },
    voice: {
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsApiKeyEnv: "OPENAI_API_KEY",
      ttsApiKey: "sk-voice-do-not-render",
    },
    vision: {
      provider: "fal",
      model: "fal-ai/imagen4/preview",
      apiKeyEnv: "FAL_KEY",
      apiKey: "fal-secret-do-not-render",
    },
    ...overrides,
  };
}

describe("setup review manifest", () => {
  it("includes config file write/update lines for provider/model/security/workflow drafts", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);
    const fileLines = manifest.sections["files-to-write-update"];

    expect(fileLines.map((line) => line.sourceDraftIds[0])).toEqual(expect.arrayContaining([
      "first-run.provider-model-route",
      "first-run.security-mode",
      "first-run.workflow-learning",
    ]));
    expect(fileLines.every((line) => line.target?.kind === "config-scope")).toBe(true);
    expect(fileLines.every((line) => line.preserveUnrelatedConfig === true)).toBe(true);
  });

  it("includes secret refs by env var name only", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);
    const secretLine = manifest.sections["secret-refs-to-store"][0];

    expect(secretLine?.review.values.envVars).toEqual(["OPENAI_API_KEY"]);
    expect(secretLine?.review.values.credentialValuesIncluded).toBe(false);
  });

  it("never includes raw secret values", () => {
    const bundle = buildSetupModuleDraftBundle(moduleContext());
    const maliciousBundle: SetupDraftBundle = {
      ...bundle,
      drafts: [
        ...bundle.drafts,
        {
          ...bundle.drafts[0] as SetupDraft,
          id: "malicious.raw-secret",
          review: {
            copyKey: "setupDrafts.review",
            summaryKey: "setupDrafts.malicious.summary",
            redacted: true,
            values: {
              apiKey: "sk-raw-do-not-render",
              botToken: "123456:do-not-render",
              apiKeyEnv: "OPENAI_API_KEY",
            },
          },
        },
      ],
    };
    const json = JSON.stringify(buildSetupReviewManifest([maliciousBundle]));

    expect(json).not.toContain("sk-do-not-render");
    expect(json).not.toContain("sk-voice-do-not-render");
    expect(json).not.toContain("fal-secret-do-not-render");
    expect(json).not.toContain("sk-raw-do-not-render");
    expect(json).not.toContain("123456:do-not-render");
    expect(json).toContain("OPENAI_API_KEY");
  });

  it("lists workspace trust grant with exact workspace and trust-store paths", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);
    const line = manifest.sections["workspace-trust-grants"][0];

    expect(line?.target).toEqual({
      kind: "trust-store",
      workspaceRoot: "/tmp/workspace",
      trustStorePath: "/tmp/home/.estacoda/trust.json",
    });
    expect(line?.riskSurface).toBe("workspace-trust");
  });

  it("lists provider/model/network changes", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);
    const line = manifest.sections["provider-model-network"][0];

    expect(line?.review.values.provider).toBe("openai");
    expect(line?.review.values.model).toBe("gpt-4.1-mini");
    expect(line?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.provider", "model.id"],
    }));
  });

  it("lists fallback provider/model drafts as provider/model/network changes", () => {
    const manifest = buildSetupReviewManifest([singleDraftBundle({
      id: "setup-editor.model-route.edit-fallback-model-route",
      kind: "fallback-model-route",
      source: {
        kind: "setup-editor",
        sectionId: "model-route",
        actionId: "edit-fallback-model-route",
      },
      riskSurface: "provider-selection",
      target: {
        kind: "config-scope",
        scope: ["model.fallbacks"],
        path: "/tmp/home/.estacoda/config.json",
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupDrafts.fallbackModelRoute.add.summary",
        redacted: true,
        values: {
          fallbackOperation: "add",
          provider: "openai",
          model: "gpt-5.5",
        },
      },
      applyIntent: configPatchIntent(),
      preserveUnrelatedConfig: true,
      requiresReview: true,
      readOnly: false,
      blockers: [],
      warnings: [],
    })]);
    const line = manifest.sections["provider-model-network"]
      .find((candidate) => candidate.sourceDraftIds.includes("setup-editor.model-route.edit-fallback-model-route"));

    expect(line?.review.summaryKey).toBe("setupDrafts.fallbackModelRoute.add.summary");
    expect(line?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["model.fallbacks"],
    }));
  });

  it("lists auxiliary provider/model drafts as provider/model/network changes", () => {
    const manifest = buildSetupReviewManifest([singleDraftBundle({
      id: "setup-editor.model-route.edit-auxiliary-model-route",
      kind: "auxiliary-model-route",
      source: {
        kind: "setup-editor",
        sectionId: "model-route",
        actionId: "edit-auxiliary-model-route",
      },
      riskSurface: "provider-selection",
      target: {
        kind: "config-scope",
        scope: ["auxiliaryModels.*"],
        path: "/tmp/home/.estacoda/config.json",
        preserveUnrelatedConfig: true,
      },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupDrafts.auxiliaryModelRoute.summary",
        redacted: true,
        values: {
          auxiliaryTask: "compression",
          provider: "openai",
          model: "gpt-5.5",
        },
      },
      applyIntent: configPatchIntent(),
      preserveUnrelatedConfig: true,
      requiresReview: true,
      readOnly: false,
      blockers: [],
      warnings: [],
    })]);
    const line = manifest.sections["provider-model-network"]
      .find((candidate) => candidate.sourceDraftIds.includes("setup-editor.model-route.edit-auxiliary-model-route"));

    expect(line?.review.summaryKey).toBe("setupDrafts.auxiliaryModelRoute.summary");
    expect(line?.target).toEqual(expect.objectContaining({
      kind: "config-scope",
      scope: ["auxiliaryModels.*"],
    }));
  });

  it("lists enabled optional capabilities", () => {
    const manifest = buildSetupReviewManifest([buildSetupModuleDraftBundle(moduleContext())]);
    const optionalLines = manifest.sections["enabled-optional-capabilities"];

    expect(optionalLines.map((line) => line.sourceDraftIds[0])).toEqual(expect.arrayContaining([
      "setup-module.telegram.capability",
      "setup-module.voice.capability",
      "setup-module.vision.capability",
      "setup-module.browser.capability",
    ]));
  });

  it("lists Telegram remote-control identity constraints without token", () => {
    const manifest = buildSetupReviewManifest([buildSetupModuleDraftBundle(moduleContext())]);
    const remoteLine = manifest.sections["remote-control-surfaces"][0];
    const json = JSON.stringify(remoteLine);

    expect(remoteLine?.review.values.remoteControlIdentityConstraint).toBe("allowed-user-or-chat-id");
    expect(remoteLine?.review.values.allowedUserIds).toEqual(["42"]);
    expect(remoteLine?.review.values.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
    expect(json).not.toContain("123456:do-not-render");
  });

  it("lists browser capability without auto-launch side effect", () => {
    const manifest = buildSetupReviewManifest([buildSetupModuleDraftBundle(moduleContext())]);
    const browserLine = manifest.sections["enabled-optional-capabilities"]
      .find((line) => line.sourceDraftIds.includes("setup-module.browser.capability"));

    expect(browserLine?.review.values.autoLaunchRequested).toBe(true);
    expect(browserLine?.review.values.autoLaunchWillRunNow).toBe(false);
  });

  it("lists verification checks as read-only", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);
    const line = manifest.sections["verification-checks"][0];

    expect(line?.readOnly).toBe(true);
    expect(line?.target).toEqual({ kind: "verification", readOnly: true });
  });

  it("includes launch handoff preference when present", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);
    const line = manifest.sections["launch-handoff"][0];

    expect(line?.target).toEqual({
      kind: "launch",
      preference: "offer-after-verify",
    });
    expect(line?.review.values.launchSelected).toBe(true);
  });

  it("preserves blockers and warnings", () => {
    const manifest = buildSetupReviewManifest([diagnosticBundle()]);

    expect(manifest.blockers.map((line) => line.blockers).flat()).toContain("Provider setup is incomplete.");
    expect(manifest.warnings.map((line) => line.warnings).flat()).toContain("Configured model context window is below 64K tokens.");
    expect(manifest.safeToReviewForApply).toBe(false);
  });

  it("broken config produces blocker manifest, not unsafe normal write manifest", () => {
    const manifest = buildSetupReviewManifest([buildSetupModuleDraftBundle(moduleContext({ brokenConfig: true }))]);

    expect(manifest.blockers.length).toBeGreaterThan(0);
    expect(manifest.sections["files-to-write-update"]).toEqual([]);
    expect(manifest.lines.some((line) => line.target?.kind === "config-scope")).toBe(false);
    expect(manifest.suppressedNormalWrites).toEqual([{
      bundleId: "setup-modules",
      reason: "broken-config",
    }]);
    expect(manifest.safeToReviewForApply).toBe(false);
  });

  it("state-not-writable diagnostic repair produces blockers without normal write lines", () => {
    const manifest = buildSetupReviewManifest([stateDirectoryDiagnosticBundle()]);

    expect(manifest.blockers.map((line) => line.blockers).flat()).toContain("EstaCoda state directory is not writable.");
    expect(manifest.sections["files-to-write-update"]).toEqual([]);
    expect(manifest.lines.some((line) => line.target?.kind === "config-scope")).toBe(false);
    expect(manifest.suppressedNormalWrites).toEqual([{
      bundleId: "setup-editor:state-not-writable",
      reason: "unsafe-diagnostic-only",
    }]);
    expect(manifest.safeToReviewForApply).toBe(false);
  });


  it("missing-secret repairable blocker still shows normal proposed write lines plus credential repair lines", () => {
    const bundle = repairableBlockedBundle(buildSetupModuleDraftBundle(moduleContext({
      provider: {
        id: "openai",
        model: "gpt-4.1-mini",
      },
      credentials: {
        envVars: [],
      },
    })), "Missing credential environment variable OPENAI_API_KEY.");
    const manifest = buildSetupReviewManifest([bundle]);

    expect(manifest.safeToReviewForApply).toBe(false);
    expect(manifest.suppressedNormalWrites).toEqual([]);
    expect(manifest.sections["files-to-write-update"].map((line) => line.sourceDraftIds[0])).toEqual(expect.arrayContaining([
      "setup-module.provider.route",
      "setup-module.security-mode.config",
      "setup-module.workflow-learning.config",
    ]));
    expect(manifest.sections["secret-refs-to-store"].map((line) => line.sourceDraftIds[0])).toContain("setup-module.credentials.env-refs");
    expect(manifest.blockers.map((line) => line.blockers).flat()).toContain("Missing credential environment variable OPENAI_API_KEY.");
  });

  it("untrusted-workspace repairable blocker still shows normal write lines plus workspace trust repair lines", () => {
    const bundle = repairableBlockedBundle(buildSetupModuleDraftBundle(moduleContext({
      workspaceTrust: {
        trusted: false,
      },
    })), "Workspace is not trusted.");
    const manifest = buildSetupReviewManifest([bundle]);

    expect(manifest.safeToReviewForApply).toBe(false);
    expect(manifest.suppressedNormalWrites).toEqual([]);
    expect(manifest.sections["files-to-write-update"].map((line) => line.sourceDraftIds[0])).toEqual(expect.arrayContaining([
      "setup-module.provider.route",
      "setup-module.security-mode.config",
      "setup-module.workflow-learning.config",
    ]));
    expect(manifest.sections["workspace-trust-grants"].map((line) => line.sourceDraftIds[0])).toContain("setup-module.workspace-trust.grant");
    expect(manifest.blockers.map((line) => line.blockers).flat()).toContain("Workspace is not trusted.");
  });

  it("generic repairable blocker does not hide normal review lines", () => {
    const bundle = repairableBlockedBundle(buildSetupModuleDraftBundle(moduleContext()), "Manual review required before apply.");
    const manifest = buildSetupReviewManifest([bundle]);

    expect(manifest.safeToReviewForApply).toBe(false);
    expect(manifest.suppressedNormalWrites).toEqual([]);
    expect(manifest.sections["files-to-write-update"].length).toBeGreaterThan(0);
    expect(manifest.sections["provider-model-network"].length).toBeGreaterThan(0);
    expect(manifest.blockers.map((line) => line.blockers).flat()).toContain("Manual review required before apply.");
  });

  it("omits skipped capabilities from review lines", () => {
    const manifest = buildSetupReviewManifest([firstRunBundle()]);

    expect(manifest.lines.some((line) => line.review.values.skipped === true)).toBe(false);
    expect(manifest.lines.some((line) => line.sourceDraftIds.includes("first-run.optional-capabilities"))).toBe(false);
  });

  it("contains no terminal rendering fields", () => {
    const manifest = buildSetupReviewManifest([
      firstRunBundle(),
      buildSetupModuleDraftBundle(moduleContext()),
    ]);
    const json = JSON.stringify(manifest);

    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("Press Enter");
    expect(json).not.toContain("Use ↑/↓");
    assertNoRenderingFields(manifest);
  });

  it("manifest creation does not mutate filesystem, config, or state", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "estacoda-setup-review-manifest-"));
    const configPath = join(homeDir, ".estacoda", "config.json");
    const trustStorePath = join(homeDir, ".estacoda", "trust.json");

    buildSetupReviewManifest([
      buildSetupModuleDraftBundle(moduleContext({
        configPath,
        trustStorePath,
        workspaceRoot: join(homeDir, "workspace"),
      })),
    ]);

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(trustStorePath)).toBe(false);
    expect(existsSync(join(homeDir, ".estacoda"))).toBe(false);
  });

  it("does not reintroduce backupForMain", () => {
    const manifest = buildSetupReviewManifest([
      firstRunBundle(),
      buildSetupModuleDraftBundle(moduleContext()),
    ]);

    expect(JSON.stringify(manifest)).not.toContain("backupForMain");
  });
});

function diagnosticBundle(): SetupDraftBundle {
  const draft: SetupDraft = {
    id: "diagnostic.provider",
    kind: "diagnostic-blocker",
    source: {
      kind: "setup-module",
      moduleId: "provider",
      actionId: "diagnostic-only",
    },
    riskSurface: "config-repair",
    target: { kind: "diagnostic-only" },
    review: {
      copyKey: "setupDrafts.review",
      summaryKey: "setupDrafts.providerDiagnostic.summary",
      redacted: true,
      values: {},
    },
    applyIntent: {
      kind: "dry-run-apply-intent",
      effect: "diagnostic-only",
      dryRunOnly: true,
      writesConfig: false,
      writesTrustStore: false,
    },
    requiresReview: true,
    readOnly: true,
    blockers: ["Provider setup is incomplete."],
    warnings: ["Configured model context window is below 64K tokens."],
  };
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-module-session",
    sourceId: "diagnostic",
    drafts: [draft],
    blockers: ["Provider setup is incomplete."],
    warnings: ["Configured model context window is below 64K tokens."],
    safeToApplyLater: false,
    metadata: {
      draftCount: 1,
      requiresReviewCount: 1,
      readOnlyCount: 1,
    },
  };
}

function stateDirectoryDiagnosticBundle(): SetupDraftBundle {
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-editor-plan-session",
    sourceId: "setup-editor:state-not-writable",
    drafts: [{
      id: "setup-editor.config-safety.repair-state-directory",
      kind: "diagnostic-blocker",
      source: {
        kind: "setup-editor",
        sectionId: "config-safety",
        actionId: "repair-state-directory",
      },
      riskSurface: "config-repair",
      target: { kind: "diagnostic-only" },
      review: {
        copyKey: "setupDrafts.review",
        summaryKey: "setupDrafts.stateDirectory.summary",
        redacted: true,
        values: {},
      },
      applyIntent: {
        kind: "dry-run-apply-intent",
        effect: "diagnostic-only",
        dryRunOnly: true,
        writesConfig: false,
        writesTrustStore: false,
      },
      requiresReview: true,
      readOnly: true,
      blockers: ["EstaCoda state directory is not writable."],
      warnings: [],
    }],
    blockers: ["EstaCoda state directory is not writable."],
    warnings: [],
    safeToApplyLater: false,
    metadata: {
      draftCount: 1,
      requiresReviewCount: 1,
      readOnlyCount: 1,
    },
  };
}

function repairableBlockedBundle(bundle: SetupDraftBundle, blocker: string): SetupDraftBundle {
  return {
    ...bundle,
    blockers: [...bundle.blockers, blocker],
    safeToApplyLater: false,
  };
}

function singleDraftBundle(draft: SetupDraft): SetupDraftBundle {
  return {
    kind: "setup-draft-bundle",
    sourceKind: "setup-editor-plan-session",
    sourceId: `bundle.${draft.id}`,
    drafts: [draft],
    blockers: [],
    warnings: [],
    safeToApplyLater: true,
    metadata: {
      draftCount: 1,
      requiresReviewCount: draft.requiresReview ? 1 : 0,
      readOnlyCount: draft.readOnly ? 1 : 0,
    },
  };
}

function configPatchIntent(): SetupDraft["applyIntent"] {
  return {
    kind: "dry-run-apply-intent",
    effect: "config-patch",
    dryRunOnly: true,
    writesConfig: false,
    writesTrustStore: false,
  };
}

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

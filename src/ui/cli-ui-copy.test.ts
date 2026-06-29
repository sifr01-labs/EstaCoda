import { describe, it, expect } from "vitest";
import { chromeCopy, cliUiChromeCopy, type UiLocale } from "./cli-ui-copy.js";
import { isolateLtr, LRI, PDI } from "./bidi.js";

describe("chromeCopy — en", () => {
  it("returns English assistant card title", () => {
    const copy = chromeCopy("en");
    expect(copy.assistantCardTitle).toBe("EstaCoda");
    expect(copy.assistantCardTitleUnicode).toContain("EstaCoda");
    expect(copy.assistantCardTitleAscii).toContain("EstaCoda");
  });

  it("returns English status labels", () => {
    const copy = chromeCopy("en");
    expect(copy.model).toBe("model");
    expect(copy.readiness).toBe("readiness");
    expect(copy.idle).toBe("idle");
  });

  it("returns English shortcuts with no isolation marks", () => {
    const copy = chromeCopy("en");
    expect(copy.shortcuts).toBe("/help \u00b7 /tools \u00b7 /model \u00b7 /status \u00b7 /compact \u00b7 Ctrl+C exit");
    expect(copy.inputPlaceholder).toBe(copy.shortcuts);
    expect(copy.inputPlaceholder).not.toContain(">");
    expect(copy.inputPlaceholder).not.toContain("\u203a");
    expect(copy.shortcuts).not.toContain(LRI);
  });

  it("returns English startup chrome labels", () => {
    const copy = chromeCopy("en");
    expect(copy.startupVersion).toBe("version");
    expect(copy.startupWorkspaceTrust).toBe("Workspace Trust");
    expect(copy.startupSecurityMode).toBe("Security Mode");
    expect(copy.startupSkillAutonomy).toBe("Skill Autonomy");
    expect(copy.startupInteractiveCommands).toBe("Interactive Commands:");
    expect(copy.startupPromptHint).toBe("Type a message. Use /help for commands or /exit to leave.");
  });

  it("returns English providers chrome copy", () => {
    const copy = chromeCopy("en");
    expect(copy.slashCommandProvidersDescription).toBe("Browse providers, endpoints, credentials, and model readiness");
    expect(copy.providersTitle).toBe("Providers");
    expect(copy.providersActiveRoute).toBe("Active route");
    expect(copy.providersConfiguredProviders).toBe("Configured providers");
    expect(copy.providersLocalSetupHint).toBe("Run /providers local setup to configure a local endpoint.");
    expect(copy.providersDiagnosticsTitle).toBe("Provider Diagnostics");
    expect(copy.providersStatusReady).toBe("ready");
    expect(copy.providersStatusMissingCredential).toBe("missing credential");
    expect(copy.providersStatusEndpointFailed).toBe("endpoint check failed");
    expect(copy.providersStatusNotConfigured).toBe("not configured");
  });
});

describe("chromeCopy — ar", () => {
  it("returns Arabic assistant card title", () => {
    const copy = chromeCopy("ar");
    expect(copy.assistantCardTitle).toBe("\u0625\u0633\u062a\u0627\u0643\u0648\u062f\u0627");
    expect(copy.assistantCardTitleUnicode).toContain("\u0625\u0633\u062a\u0627\u0643\u0648\u062f\u0627");
    expect(copy.assistantCardTitleAscii).toContain("\u0625\u0633\u062a\u0627\u0643\u0648\u062f\u0627");
  });

  it("returns Arabic status labels", () => {
    const copy = chromeCopy("ar");
    expect(copy.model).toBe("\u0627\u0644\u0646\u0645\u0648\u0630\u062c");
    expect(copy.readiness).toBe("\u0627\u0644\u062c\u0627\u0647\u0632\u064a\u0629");
    expect(copy.idle).toBe("\u062e\u0627\u0645\u0644");
  });

  it("isolates slash commands inside Arabic shortcuts", () => {
    const copy = chromeCopy("ar");
    // Each slash command and key chord should be wrapped in LRI/PDI
    expect(copy.shortcuts).toContain(isolateLtr("/help"));
    expect(copy.shortcuts).toContain(isolateLtr("/tools"));
    expect(copy.shortcuts).toContain(isolateLtr("/model"));
    expect(copy.shortcuts).toContain(isolateLtr("/status"));
    expect(copy.shortcuts).toContain(isolateLtr("Ctrl+C"));
    expect(copy.inputPlaceholder).toBe(copy.shortcuts);
    expect(copy.inputPlaceholder).not.toContain(">");
    expect(copy.inputPlaceholder).not.toContain("\u203a");
  });

  it("preserves Arabic text around isolated tokens", () => {
    const copy = chromeCopy("ar");
    expect(copy.shortcuts).toContain("\u062e\u0631\u0648\u062c"); // "exit" in Arabic
  });

  it("returns Arabic startup chrome labels with isolated commands", () => {
    const copy = chromeCopy("ar");
    expect(copy.startupVersion).toBe("\u0627\u0644\u0625\u0635\u062f\u0627\u0631");
    expect(copy.startupWorkspaceVerification).toBe("\u062d\u0627\u0644\u0629 \u062a\u062d\u0642\u0642 \u0645\u0633\u0627\u062d\u0629 \u0627\u0644\u0639\u0645\u0644");
    expect(copy.startupSecurityMode).toBe("\u0648\u0636\u0639 \u0627\u0644\u0623\u0645\u0627\u0646");
    expect(copy.startupSkillAutonomy).toBe("\u0627\u0633\u062a\u0642\u0644\u0627\u0644\u064a\u0629 \u0627\u0644\u0645\u0647\u0627\u0631\u0627\u062a");
    expect(copy.startupCommandModel).toBe("\u0627\u0639\u0631\u0636 \u0627\u0644\u0646\u0645\u0648\u0630\u062c \u0627\u0644\u0646\u0634\u0637");
    expect(copy.startupPromptHint).toContain(isolateLtr("/help"));
    expect(copy.startupPromptHint).toContain(isolateLtr("/exit"));
  });

  it("returns Arabic providers chrome copy with isolated command hints", () => {
    const copy = chromeCopy("ar");
    expect(copy.slashCommandProvidersDescription).toBe("استعرض المزوّدين ونقاط النهاية وبيانات الاعتماد وجاهزية النماذج");
    expect(copy.providersTitle).toBe("المزوّدون");
    expect(copy.providersActiveRoute).toBe("المسار النشط");
    expect(copy.providersConfiguredProviders).toBe("المزوّدون المضبوطون");
    expect(copy.providersLocalSetupHint).toContain(isolateLtr("/providers local setup"));
    expect(copy.providersDiagnosticsTitle).toBe("تشخيص المزوّدين");
    expect(copy.providersStatusReady).toBe("جاهز");
    expect(copy.providersStatusMissingCredential).toBe("بيانات الاعتماد ناقصة");
    expect(copy.providersStatusEndpointFailed).toBe("فشل فحص نقطة النهاية");
    expect(copy.providersStatusNotConfigured).toBe("غير مضبوط");
  });
});

describe("chromeCopy — fallback", () => {
  it("falls back to English for unknown locale", () => {
    const copy = chromeCopy("unknown" as UiLocale);
    expect(copy.assistantCardTitle).toBe("EstaCoda");
    expect(copy.model).toBe("model");
  });
});

describe("cliUiChromeCopy — structural invariants", () => {
  it("has identical keys for en and ar", () => {
    const enKeys = Object.keys(cliUiChromeCopy.en).sort();
    const arKeys = Object.keys(cliUiChromeCopy.ar).sort();
    expect(arKeys).toEqual(enKeys);
  });

  it("has no empty strings", () => {
    for (const locale of ["en", "ar"] as const) {
      const copy = cliUiChromeCopy[locale];
      for (const [key, value] of Object.entries(copy)) {
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});

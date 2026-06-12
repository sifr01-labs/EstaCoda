import { describe, expect, it } from "vitest";
import {
  credentialSummaryStatusLabel,
  optionalCapabilityStatusLabel,
  renderOnboardingWizardSummary,
  workspaceTrustStatusLabel,
} from "./summary.js";
import type { OnboardingWizardState } from "./state.js";
import { isolateLtr } from "../../ui/bidi.js";

describe("onboarding wizard summary", () => {
  it("renders a stable user-facing configuration summary", () => {
    const state: OnboardingWizardState = {
      interfacePreferences: {
        language: "en",
        flavor: "standard",
        activityLabels: "en",
      },
      workspace: {
        path: "/tmp/example-workspace",
        trustStatus: "trusted",
      },
      primaryRoute: {
        provider: "openai",
        model: "gpt-5.5",
      },
      credential: {
        status: "new_pending",
      },
      securityMode: "adaptive",
      agentEvolution: "suggest",
      optionalCapabilities: {
        channels: {
          telegram: "configured",
          whatsapp: "configured",
        },
        voice: {
          stt: "configured",
          tts: "not_set",
        },
        browser: "configured",
      },
    };

    expect(renderOnboardingWizardSummary(state)).toBe([
      "Configuration summary",
      "Workspace: /tmp/example-workspace (trusted)",
      "Language: en",
      "Interface/style: standard",
      "Activity labels: en",
      "Primary Provider: openai",
      "Model: gpt-5.5",
      "Credential status: New credential pending",
      "Security Mode: adaptive",
      "Agent Evolution: suggest",
      "Optional Capabilities:",
      "  - Channels / Telegram: Configured",
      "  - Channels / WhatsApp: Configured",
      "  - Voice STT: Configured",
      "  - Voice TTS: Not set",
      "  - Browser: Configured",
    ].join("\n"));
  });

  it("renders Arabic labels while keeping technical values stable", () => {
    const state: OnboardingWizardState = {
      interfacePreferences: {
        language: "ar",
        flavor: "arabic-light",
        activityLabels: "ar",
      },
      workspace: {
        path: "/tmp/example-workspace",
        trustStatus: "trusted",
      },
      primaryRoute: {
        provider: "kimi",
        model: "kimi-k2.6",
      },
      credential: {
        status: "existing_detected",
      },
      securityMode: "adaptive",
      agentEvolution: "suggest",
      optionalCapabilities: {
        channels: {
          telegram: "not_set",
          whatsapp: "incomplete",
        },
        voice: {
          stt: "configured",
          tts: "not_set",
        },
        browser: "configured",
      },
    };

    const rendered = renderOnboardingWizardSummary(state, "ar");

    expect(rendered).toContain("ملخص الإعداد");
    expect(rendered).toContain(`مساحة العمل: ${isolateLtr("/tmp/example-workspace")} (موثوقة)`);
    expect(rendered).toContain(`اللغة: ${isolateLtr("ar")}`);
    expect(rendered).toContain(`أسلوب الواجهة: ${isolateLtr("arabic-light")}`);
    expect(rendered).toContain(`المزوّد الأساسي: ${isolateLtr("kimi")}`);
    expect(rendered).toContain(`النموذج: ${isolateLtr("kimi-k2.6")}`);
    expect(rendered).toContain("حالة بيانات الاعتماد: تم العثور على بيانات اعتماد موجودة");
    expect(rendered).toContain(`وضع الأمان: ${isolateLtr("adaptive")}`);
    expect(rendered).toContain(`تطوّر الوكيل: ${isolateLtr("suggest")}`);
    expect(rendered).toContain("القدرات الاختيارية:");
    expect(rendered).toContain(`القنوات / ${isolateLtr("Telegram")}: غير مهيأ`);
    expect(rendered).toContain(`القنوات / ${isolateLtr("WhatsApp")}: الإعداد غير مكتمل`);
    expect(rendered).toContain(`الصوت ${isolateLtr("STT")}: مهيأ`);
    expect(rendered).toContain(`الصوت ${isolateLtr("TTS")}: غير مهيأ`);
    expect(rendered).toContain("المتصفح: مهيأ");
    expect(rendered).not.toContain("Configuration summary");
    expect(rendered).not.toContain("Credential status");
  });

  it("renders unset values without inventing readiness", () => {
    expect(renderOnboardingWizardSummary({})).toBe([
      "Configuration summary",
      "Workspace: Not set (untrusted)",
      "Language: Not set",
      "Interface/style: Not set",
      "Activity labels: Not set",
      "Primary Provider: Not set",
      "Model: Not set",
      "Credential status: Not set",
      "Security Mode: Not set",
      "Agent Evolution: Not set",
      "Optional Capabilities:",
      "  - Channels / Telegram: Not set",
      "  - Channels / WhatsApp: Not set",
      "  - Voice STT: Not set",
      "  - Voice TTS: Not set",
      "  - Browser: Not set",
    ].join("\n"));
  });

  it("limits credential summary labels to the approved status vocabulary", () => {
    expect(credentialSummaryStatusLabel("not_set")).toBe("Not set");
    expect(credentialSummaryStatusLabel("existing_detected")).toBe("Existing credential detected");
    expect(credentialSummaryStatusLabel("new_pending")).toBe("New credential pending");
    expect(credentialSummaryStatusLabel(undefined)).toBe("Not set");
    expect(credentialSummaryStatusLabel("not_set", "ar")).toBe("غير مهيأ");
    expect(credentialSummaryStatusLabel("existing_detected", "ar")).toBe("تم العثور على بيانات اعتماد موجودة");
    expect(credentialSummaryStatusLabel("new_pending", "ar")).toBe("بيانات اعتماد جديدة بانتظار الحفظ");
  });

  it("does not render extra credential metadata if an unsafe caller passes it", () => {
    const state = {
      credential: {
        status: "existing_detected",
        rawSecret: "sk-test-secret-value",
        prefix: "sk-",
        suffix: "alue",
        length: 20,
        hash: "abc123",
        providerTokenMetadata: "token-owner",
      },
    } as unknown as OnboardingWizardState;

    const rendered = renderOnboardingWizardSummary(state);

    expect(rendered).toContain("Credential status: Existing credential detected");
    expect(rendered).not.toContain("sk-test-secret-value");
    expect(rendered).not.toContain("sk-");
    expect(rendered).not.toContain("alue");
    expect(rendered).not.toContain("20");
    expect(rendered).not.toContain("abc123");
    expect(rendered).not.toContain("token-owner");
  });

  it("renders optional capability and trust labels deterministically", () => {
    expect(optionalCapabilityStatusLabel("configured")).toBe("Configured");
    expect(optionalCapabilityStatusLabel("skipped")).toBe("Skipped");
    expect(optionalCapabilityStatusLabel("incomplete")).toBe("Setup incomplete");
    expect(optionalCapabilityStatusLabel("not_set")).toBe("Not set");
    expect(optionalCapabilityStatusLabel(undefined)).toBe("Not set");
    expect(workspaceTrustStatusLabel("trusted")).toBe("trusted");
    expect(workspaceTrustStatusLabel("untrusted")).toBe("untrusted");
    expect(workspaceTrustStatusLabel(undefined)).toBe("untrusted");
    expect(optionalCapabilityStatusLabel("configured", "ar")).toBe("مهيأ");
    expect(optionalCapabilityStatusLabel("skipped", "ar")).toBe("تم التخطي");
    expect(optionalCapabilityStatusLabel("incomplete", "ar")).toBe("الإعداد غير مكتمل");
    expect(optionalCapabilityStatusLabel("not_set", "ar")).toBe("غير مهيأ");
    expect(workspaceTrustStatusLabel("trusted", "ar")).toBe("موثوقة");
    expect(workspaceTrustStatusLabel("untrusted", "ar")).toBe("غير موثوقة");
  });
});

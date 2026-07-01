import { describe, expect, it } from "vitest";
import { LRI, PDI } from "../ui/bidi.js";
import { renderDoctorReport } from "./cli-renderer.js";
import type { DoctorReport } from "./types.js";

describe("renderDoctorReport", () => {
  it("renders the Papyrus doctor surface with verdict and actions", () => {
    const output = renderDoctorReport(baseReport({
      verdict: {
        status: "warning",
        title: "Ready with warnings",
        blockedCount: 0,
        warningCount: 1,
        healthyCount: 2
      },
      actions: [
        {
          id: "missing-provider-key",
          severity: "warning",
          title: "OpenRouter API key is missing",
          detailLines: ["Env: OPENROUTER_API_KEY"],
          command: "estacoda model setup"
        }
      ]
    }));

    expect(output).toContain("𓂀 EstaCoda Doctor");
    expect(output).toContain("System health inspection");
    expect(output).toContain("◇ Checks");
    expect(output).toContain("▲ Providers");
    expect(output).toContain("Ready with warnings");
    expect(output).toContain("0 blocked · 1 warnings · 2 healthy");
    expect(output).toContain("OpenRouter API key is missing");
    expect(output).toContain("Fix: estacoda model setup");
  });

  it("renders blocked config diagnostics", () => {
    const output = renderDoctorReport(baseReport({
      model: "unknown/unknown",
      verdict: {
        status: "blocked",
        title: "Blocked",
        blockedCount: 1,
        warningCount: 0,
        healthyCount: 1
      },
      actions: [
        {
          id: "config-syntax",
          severity: "blocked",
          title: "Config syntax error: Unexpected token",
          command: "estacoda setup --interactive"
        }
      ]
    }));

    expect(output).toMatch(/Model:\s+unknown\/unknown/u);
    expect(output).toContain("Blocked");
    expect(output).toContain("✕ Config syntax error: Unexpected token");
  });

  it("isolates technical tokens in Arabic output", () => {
    const output = renderDoctorReport(baseReport({
      locale: "ar",
      profile: "default",
      model: "openrouter/anthropic/claude-sonnet",
      verdict: {
        status: "warning",
        title: "جاهز مع تحذيرات",
        blockedCount: 0,
        warningCount: 1,
        healthyCount: 2
      },
      actions: [
        {
          id: "missing-env",
          severity: "warning",
          title: "ملف أسرار الملف الشخصي تنقصه قيم مطلوبة",
          detailLines: ["المتغيرات: OPENROUTER_API_KEY"],
          command: "estacoda model setup"
        }
      ]
    }));

    expect(output).toContain("فحص صحة النظام");
    expect(output).toContain("◇ الفحوصات");
    expect(output).toContain("◇ الإجراءات");
    expect(output).toContain(`${LRI}openrouter/anthropic/claude-sonnet${PDI}`);
    expect(output).toContain(`${LRI}estacoda model setup${PDI}`);
  });
});

function baseReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const locale = overrides.locale ?? "en";
  return {
    locale,
    profile: overrides.profile ?? "default",
    workspace: "/workspace/estacoda",
    home: "~/.estacoda",
    model: overrides.model ?? "openrouter/test-model",
    configSources: [],
    sections: overrides.sections ?? [
      {
        id: "checks",
        title: locale === "ar" ? "الفحوصات" : "Checks",
        checks: [
          {
            id: "runtime",
            label: locale === "ar" ? "وقت التشغيل" : "Runtime",
            severity: "healthy"
          },
          {
            id: "providers",
            label: locale === "ar" ? "المزوّدون" : "Providers",
            severity: "warning",
            summary: "missing key"
          },
          {
            id: "security",
            label: locale === "ar" ? "الأمان" : "Security",
            severity: "healthy"
          }
        ]
      }
    ],
    verdict: overrides.verdict ?? {
      status: "warning",
      title: locale === "ar" ? "جاهز مع تحذيرات" : "Ready with warnings",
      blockedCount: 0,
      warningCount: 1,
      healthyCount: 2
    },
    actions: overrides.actions ?? [],
    notes: overrides.notes ?? []
  };
}

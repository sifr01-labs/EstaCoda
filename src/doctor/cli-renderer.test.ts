import { describe, expect, it } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import { LRI, PDI } from "../ui/bidi.js";
import { createOperatorConsoleStyle } from "../ui/papyrus/operator-console/operatorConsoleStyle.js";
import { stripAnsi } from "../ui/papyrus/screen/stringWidth.js";
import { renderDoctorJsonReport, renderDoctorReport } from "./cli-renderer.js";
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

    expect(output).toContain("𓂀  EstaCoda Doctor");
    expect(output).toContain("System health inspection");
    expect(output).toContain("◇ Checks");
    expect(output).toContain("▲ Providers");
    expect(output).toContain("Ready with warnings");
    expect(output).toContain("0 blocked · 1 warnings · 2 healthy");
    expect(output).toContain("OpenRouter API key is missing");
    expect(output).toContain("Fix: estacoda model setup");
  });

  it("uses Papyrus color tokens for doctor landmarks and status icons", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const style = createOperatorConsoleStyle({
      tokens,
      capabilities: { supportsColor: true, supportsTrueColor: true }
    });
    const output = renderDoctorReport(baseReport({
      actions: [
        {
          id: "blocked-config",
          severity: "blocked",
          title: "Config syntax error: Unexpected token"
        }
      ],
      providerRoutes: [
        {
          id: "primary:primary",
          kind: "primary",
          label: "primary",
          provider: "openrouter",
          model: "anthropic/claude-sonnet",
          status: "ready",
          summary: "ready",
          details: []
        }
      ]
    }), { style });

    expect(stripAnsi(output)).toContain("𓂀  EstaCoda Doctor");
    expect(stripAnsi(output)).toContain("𓂀  Verdict");
    expect(output).toContain(`${ansiFg(tokens.contract.severity.ok)}\x1b[1m𓂀  EstaCoda Doctor\x1b[0m\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.brand)}\x1b[1m𓂀  Verdict\x1b[0m\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.accent)}\x1b[1m◇ Checks\x1b[0m\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.severity.ok)}✓\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.palette.caution)}▲\x1b[0m`);
    expect(output).toContain(`${ansiFg(tokens.contract.severity.error)}✕\x1b[0m`);
  });

  it("renders provider route rows when present", () => {
    const output = renderDoctorReport(baseReport({
      providerRoutes: [
        {
          id: "primary:primary",
          kind: "primary",
          label: "primary",
          provider: "openrouter",
          model: "anthropic/claude-sonnet",
          status: "ready",
          summary: "ready",
          details: []
        },
        {
          id: "fallback:fallback 1",
          kind: "fallback",
          label: "fallback 1",
          provider: "openai",
          model: "gpt-5-mini",
          status: "warning",
          summary: "missing env var OPENAI_API_KEY",
          details: []
        }
      ]
    }));

    expect(output).toContain("◇ Provider Routes");
    expect(output).toContain("primary");
    expect(output).toContain("openrouter/anthropic/claude-sonnet");
    expect(output).toContain("fallback 1");
    expect(output).toContain("missing env var OPENAI_API_KEY");
  });

  it("renders informational actions with Run labels", () => {
    const output = renderDoctorReport(baseReport({
      sections: [
        {
          id: "checks",
          title: "Checks",
          checks: [
            {
              id: "dependencies",
              label: "Dependencies",
              severity: "info",
              summary: "audit not run"
            }
          ]
        }
      ],
      actions: [
        {
          id: "dependency-audit",
          severity: "info",
          title: "Run dependency security audit",
          command: "estacoda doctor --audit"
        }
      ]
    }));

    expect(output).toContain("• Dependencies");
    expect(output).toContain("Run dependency security audit");
    expect(output).toContain("Run: estacoda doctor --audit");
  });

  it("renders JSON as the DoctorReport object without Papyrus framing", () => {
    const output = renderDoctorJsonReport(baseReport({
      providerRoutes: [
        {
          id: "primary:primary",
          kind: "primary",
          label: "primary",
          provider: "local",
          model: "local-test",
          status: "ready",
          summary: "ready",
          details: []
        }
      ]
    }));
    const parsed = JSON.parse(output) as DoctorReport;

    expect(output).not.toContain("╭─");
    expect(parsed.profile).toBe("default");
    expect(parsed.providerRoutes).toEqual([
      expect.objectContaining({
        kind: "primary",
        provider: "local",
        model: "local-test"
      })
    ]);
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
      ],
      notes: [
        "Memory file will be created on first write: /tmp/USER.md",
        "Dependency audit not run.",
        "1 security advisory acknowledgement(s) active.",
        "Optional managed Python capabilities not installed: ddgs"
      ]
    }));

    expect(output).toContain("فحص صحة النظام");
    expect(output).toContain("◇ الفحوصات");
    expect(output).toContain("◇ الإجراءات");
    expect(output).toContain("سيتم إنشاء ملف الذاكرة عند أول كتابة");
    expect(output).toContain("لم يتم تشغيل فحص أمان الاعتماديات");
    expect(output).toContain("تأكيدات تنبيه أمني نشطة");
    expect(output).toContain("قدرات Python المُدارة الاختيارية غير مثبتة");
    expect(output).toContain(`${LRI}/tmp/USER.md${PDI}`);
    expect(output).toContain(`${LRI}ddgs${PDI}`);
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
    providerRoutes: overrides.providerRoutes ?? [],
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

function ansiFg(hex: string): string {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}

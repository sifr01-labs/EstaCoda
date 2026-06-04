import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSetupVerificationReport,
  renderSetupVerificationReport,
  runSetupVerification,
  type SetupVerificationReport,
} from "./verification.js";
import { setupVerificationCopy, setupVerificationCopyEn } from "./setup-verification-copy.js";
import type { ProviderDiagnostic } from "../config/provider-diagnostics.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";

function makeProviderDiagnostic(status: ProviderDiagnostic["status"], warnings: string[] = []): ProviderDiagnostic {
  return {
    status,
    lines: ["Selected route: test/test"],
    warnings,
  };
}

function profileEnvPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).envPath;
}

function makeReport(overrides: Partial<SetupVerificationReport> = {}): SetupVerificationReport {
  return {
    stateWritable: true,
    envFilePresent: false,
    envFileSecure: true,
    workspaceTrusted: true,
    securityModeLabel: "Adaptive",
    securityModeValue: "adaptive",
    skillAutonomyLabel: "Suggest",
    skillAutonomyValue: "suggest",
    providerDiagnostic: makeProviderDiagnostic("ready"),
    toolStatus: "skipped",
    configSources: [],
    warnings: [],
    issueCodes: [],
    ...overrides,
  };
}

describe("renderSetupVerificationReport", () => {
  it("renders ready state when no warnings", () => {
    const report = makeReport();
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(copy.verification.title);
    expect(output).toContain(copy.verification.statusReady);
    expect(output).toContain(copy.verification.nextReady);
    expect(output).not.toContain(copy.verification.warningsTitle);
  });

  it("renders warnings when present", () => {
    const copy = setupVerificationCopyEn;
    const report = makeReport({
      stateWritable: false,
      warnings: [copy.verification.stateNotWritableWarning],
      issueCodes: ["state-not-writable"],
    });
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(copy.verification.warningsTitle);
    expect(output).toContain(copy.verification.stateNotWritableWarning);
    expect(output).toContain(copy.verification.nextActionsTitle);
    expect(output).toContain(copy.verification.actions.stateNotWritable);
  });

  it("renders next steps for provider incomplete", () => {
    const report = makeReport({
      providerDiagnostic: makeProviderDiagnostic("blocked", ["Provider setup is incomplete."]),
      warnings: ["Provider setup is incomplete."],
      issueCodes: ["provider-incomplete"],
    });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(copy.verification.actions.providerIncomplete);
  });

  it("renders blocked state directory", () => {
    const report = makeReport({ stateWritable: false });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(`${copy.verification.stateDirectory}: ${copy.verification.blocked}`);
  });

  it("renders env file mode when present", () => {
    const report = makeReport({ envFilePresent: true, envFileMode: "644" });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(copy.verification.presentMode("644"));
  });

  it("renders not present when env file missing", () => {
    const report = makeReport({ envFilePresent: false });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(`${copy.verification.secretStore}: ${copy.verification.notPresent}`);
  });

  it("renders trusted workspace status", () => {
    const report = makeReport({ workspaceTrusted: true });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(`${copy.verification.workspaceTrust}: ${copy.setupCheck.trusted}`);
  });

  it("renders not trusted workspace status", () => {
    const report = makeReport({ workspaceTrusted: false });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(`${copy.verification.workspaceTrust}: ${copy.setupCheck.notTrusted}`);
  });

  it("renders config sources", () => {
    const report = makeReport({ configSources: ["config.json", ".env"] });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain("config.json, .env");
  });

  it("falls back to default next action for unknown issues", () => {
    const report = makeReport({ warnings: ["Something weird"], issueCodes: ["unknown-code"] });
    const copy = setupVerificationCopyEn;
    const output = renderSetupVerificationReport(report, copy);
    expect(output).toContain(copy.verification.fallbackNextAction);
  });

  it("wraps Arabic report rows and isolates technical values", () => {
    const copy = setupVerificationCopy("ar");
    const report = makeReport({
      configSources: ["/tmp/home/.estacoda/profiles/default/config.json"],
      warnings: [copy.verification.actions.missingApiKey("OPENAI_API_KEY")],
      issueCodes: ["missing-api-key"],
    });
    const output = renderSetupVerificationReport(report, copy);

    expect(output).toContain(isolateRtl(`مصادر الإعداد: ${isolateLtr("/tmp/home/.estacoda/profiles/default/config.json")}`));
    expect(output).toContain(isolateRtl(`وضع الأمان: ${isolateLtr("Adaptive")} (${isolateLtr("adaptive")})`));
    expect(output).toContain(isolateRtl(`- ${copy.verification.actions.missingApiKey("OPENAI_API_KEY")}`));
    expect(output).toContain(isolateLtr("Selected route: test/test"));
  });
});

describe("collectSetupVerificationReport", () => {
  it("returns stateWritable true when state directory is writable", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const report = await collectSetupVerificationReport({
      workspaceRoot,
      homeDir: tempHome,
    });
    expect(report.stateWritable).toBe(true);
  });

  it("uses ESTACODA_HOME before HOME for verification state paths", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const prodHome = join(tempHome, "prod-home");
    const devHome = join(tempHome, "dev-home");
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(prodHome, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const previousHome = process.env.HOME;
    const previousEstacodaHome = process.env.ESTACODA_HOME;
    process.env.HOME = prodHome;
    process.env.ESTACODA_HOME = devHome;
    try {
      const report = await collectSetupVerificationReport({ workspaceRoot });

      expect(report.stateWritable).toBe(true);
      await expect(writeFile(join(devHome, ".estacoda", ".verification-proof"), "ok\n", "utf8")).resolves.toBeUndefined();
      expect(report.configSources.some((source) => source.includes(join(prodHome, ".estacoda")))).toBe(false);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousEstacodaHome === undefined) {
        delete process.env.ESTACODA_HOME;
      } else {
        process.env.ESTACODA_HOME = previousEstacodaHome;
      }
    }
  });

  it("returns workspaceTrusted false when trust store is empty", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const report = await collectSetupVerificationReport({
      workspaceRoot,
      homeDir: tempHome,
    });
    expect(report.workspaceTrusted).toBe(false);
  });

  it("returns envFilePresent false when no env file exists", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const report = await collectSetupVerificationReport({
      workspaceRoot,
      homeDir: tempHome,
    });
    expect(report.envFilePresent).toBe(false);
  });

  it("detects insecure env file permissions", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const envPath = profileEnvPath(tempHome);
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(envPath, "KEY=value\n", { mode: 0o644 });
    const report = await collectSetupVerificationReport({
      workspaceRoot,
      homeDir: tempHome,
    });
    expect(report.envFilePresent).toBe(true);
    expect(report.envFileSecure).toBe(false);
    expect(report.warnings.some((w) => w.includes("permissions"))).toBe(true);
  });

  it("ignores workspace-local config sources", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(join(workspaceRoot, ".estacoda"), { recursive: true });
    await writeFile(join(workspaceRoot, ".estacoda", "config.json"), JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } }));
    const report = await collectSetupVerificationReport({
      workspaceRoot,
      homeDir: tempHome,
    });
    expect(report.configSources.some((s) => s.includes(join(workspaceRoot, ".estacoda", "config.json")))).toBe(false);
  });
});

describe("runSetupVerification", () => {
  it("preserves existing return shape { ok, output }", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
    const workspaceRoot = join(tempHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const result = await runSetupVerification({
      workspaceRoot,
      homeDir: tempHome,
    });
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeGreaterThan(0);
  });
});

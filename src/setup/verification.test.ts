import { afterEach, describe, it, expect } from "vitest";
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
import type { Runtime } from "../runtime/create-runtime.js";

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

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
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
    browserDiagnostic: {
      status: "not-configured",
      label: setupVerificationCopyEn.verification.browserStates.notConfigured,
      lines: [],
      warnings: [],
    },
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
  afterEach(() => {
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
  });

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

  it("reports missing browser backend as not configured", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    await writeProfileConfig(tempHome, { model: { provider: "unconfigured", id: "unconfigured" } });

    const report = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });

    expect(report.browserDiagnostic!.status).toBe("not-configured");
    expect(report.browserDiagnostic!.label).toBe(setupVerificationCopyEn.verification.browserStates.notConfigured);
  });

  it("reports disabled browser backend as disabled", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    await writeProfileConfig(tempHome, { browser: { backend: "unconfigured" } });

    const report = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });

    expect(report.browserDiagnostic!.status).toBe("disabled");
    expect(report.browserDiagnostic!.label).toBe(setupVerificationCopyEn.verification.browserStates.disabled);
  });

  it("blocks existing CDP URLs that are missing or non-local", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    await writeProfileConfig(tempHome, { browser: { backend: "local-cdp", autoLaunch: false, supervised: true } });

    const missingUrl = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });
    await writeProfileConfig(tempHome, { browser: { backend: "local-cdp", autoLaunch: false, supervised: true, cdpUrl: "http://example.com:9222" } });
    const nonLocal = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });

    expect(missingUrl.browserDiagnostic!.status).toBe("invalid");
    expect(missingUrl.browserDiagnostic!.warnings).toContain(setupVerificationCopyEn.verification.browserWarnings.localSupervisedIncomplete);
    expect(nonLocal.browserDiagnostic!.status).toBe("invalid");
    expect(nonLocal.browserDiagnostic!.warnings).toContain(setupVerificationCopyEn.verification.browserWarnings.existingCdpNonLocal);
  });

  it("accepts localhost, 127.0.0.1, and ::1 CDP URLs in static validation", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    const accepted = [
      "http://localhost:9222",
      "http://127.0.0.1:9222",
      "http://[::1]:9222",
    ];

    for (const cdpUrl of accepted) {
      await writeProfileConfig(tempHome, { browser: { backend: "local-cdp", autoLaunch: false, supervised: true, cdpUrl } });
      const report = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });
      expect(report.browserDiagnostic!.status).toBe("configured");
      expect(report.browserDiagnostic!.label).toBe(setupVerificationCopyEn.verification.browserStates.configuredConnectionNotTested);
      expect(report.browserDiagnostic!.warnings).toEqual([]);
    }
  });

  it("blocks Browserbase when credential sources are missing", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    await writeProfileConfig(tempHome, {
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true,
        cloudFallback: true,
        cloudSpendApproved: false,
      },
    });

    const report = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });

    expect(report.browserDiagnostic!.status).toBe("invalid");
    expect(JSON.stringify(report.browserDiagnostic!.warnings)).toContain("BROWSERBASE_API_KEY");
    expect(JSON.stringify(report.browserDiagnostic!.warnings)).toContain("BROWSERBASE_PROJECT_ID");
  });

  it("reports Browserbase credentials with unapproved spend as runtime-blocked", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    process.env.BROWSERBASE_API_KEY = "bb-api-secret";
    process.env.BROWSERBASE_PROJECT_ID = "bb-project-secret";
    await writeProfileConfig(tempHome, {
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true,
        cloudFallback: true,
        cloudSpendApproved: false,
      },
    });

    const report = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });

    expect(report.browserDiagnostic!.status).toBe("runtime-blocked");
    expect(report.browserDiagnostic!.label).toBe(setupVerificationCopyEn.verification.browserStates.configuredRuntimeBlocked);
    expect(report.browserDiagnostic!.warnings).toContain(setupVerificationCopyEn.verification.browserWarnings.browserbaseSpendPending);
    expect(JSON.stringify(report)).not.toContain("bb-api-secret");
    expect(JSON.stringify(report)).not.toContain("bb-project-secret");
  });

  it("reports malformed browser config as invalid", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    await writeProfileConfig(tempHome, { browser: { backend: "not-real" } });

    const report = await collectSetupVerificationReport({ workspaceRoot, homeDir: tempHome });
    const result = await runSetupVerification({ workspaceRoot, homeDir: tempHome });

    expect(report.browserDiagnostic!.status).toBe("invalid");
    expect(report.browserDiagnostic!.warnings[0]).toContain("Browser config is invalid");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Browser config is invalid");
  });

  it("keeps static browser verification away from browser tools and Browserbase sessions", async () => {
    const { tempHome, workspaceRoot } = await setupVerificationFixture();
    process.env.BROWSERBASE_API_KEY = "bb-api-secret";
    process.env.BROWSERBASE_PROJECT_ID = "bb-project-secret";
    await writeProfileConfig(tempHome, {
      browser: {
        backend: "browserbase",
        cloudProvider: "browserbase",
        hybridRouting: true,
        cloudFallback: true,
        cloudSpendApproved: false,
      },
    });
    await writeFile(join(workspaceRoot, "package.json"), "{}\n", "utf8");
    const toolCalls: string[] = [];

    const report = await collectSetupVerificationReport({
      workspaceRoot,
      homeDir: tempHome,
      runtime: {
        executeTool: async (input: { readonly tool: string }) => {
          toolCalls.push(input.tool);
          return { result: { ok: true } };
        },
      } as unknown as Runtime,
    });

    expect(report.browserDiagnostic!.status).toBe("runtime-blocked");
    expect(toolCalls).toEqual(["file.read"]);
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

async function setupVerificationFixture(): Promise<{ tempHome: string; workspaceRoot: string }> {
  const tempHome = await mkdtemp(join(tmpdir(), "estacoda-verify-test-"));
  const workspaceRoot = join(tempHome, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  return { tempHome, workspaceRoot };
}

async function writeProfileConfig(homeDir: string, config: unknown): Promise<void> {
  const path = profileConfigPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

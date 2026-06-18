import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../cli/readline-prompt.js";
import * as capabilityManager from "../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID } from "../python-env/capability-registry.js";
import {
  collectOptionalCapabilityContext,
  optionalCapabilityModuleForAction,
  optionalPromptId,
  setupModuleContextFromConfig,
} from "./optional-capability-flow.js";
import { webSearchSetupModule, type SetupModuleContext } from "./setup-modules.js";

describe("optional Search capability flow", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-search-capability-"));
    workspaceRoot = join(tempDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.BRAVE_SEARCH_API_KEY;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("maps configure-web-search to the web-search optional module", () => {
    expect(optionalCapabilityModuleForAction("configure-web-search")).toBe(webSearchSetupModule);
    expect(optionalPromptId("web-search")).toBe("web-search");
  });

  it("extracts existing Search config without raw credential values", () => {
    const context = setupModuleContextFromConfig({
      homeDir: tempDir,
      workspaceRoot,
    }, {
      web: {
        searchBackend: "brave",
        extractBackend: "stub",
        crawlBackend: "stub",
        brave: {
          apiKeyEnv: "BRAVE_SEARCH_API_KEY",
        },
      },
    });

    expect(context.web).toEqual({
      searchBackend: "brave",
      extractBackend: "stub",
      crawlBackend: "stub",
      braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
    });
    expect(JSON.stringify(context)).not.toContain("apiKey");
    expect(JSON.stringify(context)).not.toContain("secretValue");
  });

  it("reuses an existing Brave credential source without deferred writes", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "env-brave-secret";

    const collected = await collectOptionalCapabilityContext(options({
      values: ["brave"],
      secret: "should-not-be-read",
    }), baseContext(), webSearchSetupModule);

    expect(collected.kind).toBe("configured");
    if (collected.kind === "configured") {
      expect(collected.context.web).toMatchObject({
        searchBackend: "brave",
        braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
        braveCredentialReady: true,
        braveCredentialValuesIncluded: false,
      });
      expect(collected.pendingCredentialWrites).toEqual([]);
      expect(JSON.stringify(collected)).not.toContain("env-brave-secret");
      expect(JSON.stringify(collected)).not.toContain("should-not-be-read");
    }
  });

  it("collects a reviewed deferred Brave secret write when no source exists", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const collected = await collectOptionalCapabilityContext(options({
      values: ["brave"],
      secret: "brave-secret",
      seenQuestions,
    }), baseContext(), webSearchSetupModule);

    expect(collected.kind).toBe("configured");
    if (collected.kind === "configured") {
      expect(collected.context.web).toMatchObject({
        searchBackend: "brave",
        braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
        braveCredentialReady: true,
      });
      expect(collected.pendingCredentialWrites).toEqual([
        { envVarName: "BRAVE_SEARCH_API_KEY", value: "brave-secret" },
      ]);
      expect(JSON.stringify(collected.context)).not.toContain("brave-secret");
    }
    expect(seenQuestions).toContainEqual({
      question: "Enter Brave Search API key: ",
      secret: true,
    });
  });

  it("preserves a custom existing Brave credential env ref when collecting a secret", async () => {
    const seenQuestions: { question: string; secret: boolean }[] = [];
    const collected = await collectOptionalCapabilityContext(options({
      values: ["brave"],
      secret: "custom-brave-secret",
      seenQuestions,
    }), baseContext({
      web: {
        searchBackend: "brave",
        braveApiKeyEnv: "CUSTOM_BRAVE_SEARCH_KEY",
      },
    }), webSearchSetupModule);

    expect(collected.kind).toBe("configured");
    if (collected.kind === "configured") {
      expect(collected.context.web).toMatchObject({
        searchBackend: "brave",
        braveApiKeyEnv: "CUSTOM_BRAVE_SEARCH_KEY",
        braveCredentialReady: true,
      });
      expect(collected.pendingCredentialWrites).toEqual([
        { envVarName: "CUSTOM_BRAVE_SEARCH_KEY", value: "custom-brave-secret" },
      ]);
      expect(JSON.stringify(collected.context)).not.toContain("custom-brave-secret");
      expect(JSON.stringify(collected)).not.toContain("apiKey");
    }
    expect(seenQuestions).toContainEqual({
      question: "Enter Brave Search API key: ",
      secret: true,
    });
  });

  it("configures DDGS when the registered managed Python capability is ready", async () => {
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: true,
      status: "verified",
      capabilityId: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "hash",
      installedGroups: [],
      installedPackages: ["ddgs==9.14.4"],
      pythonPath: "/tmp/python",
      envPath: "/tmp/env",
      manifest: {
        id: DDGS_CAPABILITY_ID,
        version: "9.14.4",
        specHash: "hash",
        status: "verified",
        installedGroups: [],
        installedPackages: ["ddgs==9.14.4"],
        pythonPath: "/tmp/python",
        envPath: "/tmp/env",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const collected = await collectOptionalCapabilityContext(options({
      values: ["ddgs"],
    }), baseContext(), webSearchSetupModule);

    expect(collected.kind).toBe("configured");
    if (collected.kind === "configured") {
      expect(collected.context.web).toMatchObject({
        searchBackend: "ddgs",
        ddgsCapabilityId: DDGS_CAPABILITY_ID,
        ddgsCapabilityStatus: "ready",
        ddgsSetupConfirmed: false,
      });
    }
  });

  it("requires explicit confirmation before planning missing DDGS setup", async () => {
    vi.spyOn(capabilityManager, "checkManagedPythonCapabilityStatus").mockResolvedValue({
      ok: false,
      capabilityId: DDGS_CAPABILITY_ID,
      reason: "install_required",
      message: "Managed Python capability environment has not been installed.",
    });

    const confirmed = await collectOptionalCapabilityContext(options({
      values: ["ddgs", true],
    }), baseContext(), webSearchSetupModule);
    const skipped = await collectOptionalCapabilityContext(options({
      values: ["ddgs", false],
    }), baseContext(), webSearchSetupModule);

    expect(confirmed.kind).toBe("configured");
    if (confirmed.kind === "configured") {
      expect(confirmed.context.web).toMatchObject({
        searchBackend: "ddgs",
        ddgsCapabilityId: DDGS_CAPABILITY_ID,
        ddgsCapabilityStatus: "missing",
        ddgsSetupConfirmed: true,
      });
      expect(JSON.stringify(confirmed.context.web)).not.toContain("ddgs==");
    }
    expect(skipped).toEqual({ kind: "skip" });
  });

  function options(input: {
    readonly values?: readonly unknown[];
    readonly secret?: string;
    readonly seenQuestions?: { question: string; secret: boolean }[];
  }): Parameters<typeof collectOptionalCapabilityContext>[0] {
    return {
      homeDir: tempDir,
      workspaceRoot,
      prompt: fakePrompt(input),
      locale: "en",
    };
  }

  function baseContext(overrides: SetupModuleContext = {}): SetupModuleContext {
    return {
      configPath: join(tempDir, ".estacoda", "profiles", "default", "config.json"),
      workspaceRoot,
      trustStorePath: join(tempDir, ".estacoda", "trust.json"),
      ...overrides,
    };
  }
});

function fakePrompt(options: {
  readonly values?: readonly unknown[];
  readonly secret?: string;
  readonly seenQuestions?: { question: string; secret: boolean }[];
} = {}): Prompt {
  const values = [...(options.values ?? [])];
  const prompt = (async (question: string, promptOptions?: { secret?: boolean }) => {
    options.seenQuestions?.push({ question, secret: promptOptions?.secret === true });
    if (promptOptions?.secret === true) return options.secret ?? "";
    const next = values.shift();
    return next === undefined ? "" : String(next);
  }) as Prompt;
  prompt.select = async (input) => {
    const next = values.shift();
    if (next !== undefined) {
      const match = input.options.find((option) => Object.is(option.value, next) || option.label === next);
      if (match !== undefined) return match.value;
    }
    return input.options[input.defaultIndex ?? 0]?.value ?? input.options[0]!.value;
  };
  prompt.onboardingCard = () => undefined;
  prompt.close = () => undefined;
  return prompt;
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { collectSetupEntryState } from "./setup-entry-state.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { resolveProfileStateHome } from "../config/profile-home.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-setup-entry-state-"));
}

async function writeUserConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = profileConfigPath(homeDir);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function profileConfigPath(homeDir: string): string {
  return resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
}

async function trustWorkspace(homeDir: string, workspaceRoot: string): Promise<void> {
  await new WorkspaceTrustStore({
    path: join(homeDir, ".estacoda", "trust.json"),
  }).grant(workspaceRoot, { label: "test" });
}

function localReadyConfig(modelId = "local-test-model"): unknown {
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

describe("collectSetupEntryState", () => {
  let tempDirs: string[];
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    tempDirs = [];
    originalOpenAiKey = process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    for (const dir of tempDirs) {
      await chmod(join(dir, ".estacoda"), 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeHomeAndWorkspace(): Promise<{ homeDir: string; workspaceRoot: string }> {
    const homeDir = await makeTempDir();
    const workspaceRoot = join(homeDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    tempDirs.push(homeDir);
    return { homeDir, workspaceRoot };
  }

  it("classifies no config as new-user", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("new-user");
    expect(state.recommendedAction).toBe("start-first-run");
    expect(state.configSources).toEqual([]);
    expect(state.providerReadiness).toBe("missing-config");
    expect(state.blockers).toContain("No setup config exists yet.");
  });

  it("classifies an unconfigured provider in an existing config as partial-provider", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, {
      model: { provider: "unconfigured", id: "unconfigured" },
    });

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("partial-provider");
    expect(state.recommendedAction).toBe("repair-provider");
    expect(state.configSources).toHaveLength(1);
  });

  it("classifies a configured provider with a missing env secret as missing-secret", async () => {
    delete process.env.OPENAI_API_KEY;
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, {
      model: { provider: "openai", id: "gpt-4.1-mini" },
      providers: {
        openai: {
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          models: ["gpt-4.1-mini"],
          enableNetwork: true,
        },
      },
    });
    await trustWorkspace(homeDir, workspaceRoot);

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("missing-secret");
    expect(state.recommendedAction).toBe("add-missing-secret");
    expect(state.providerReadiness).toBe("missing-config");
    expect(state.setupVerification.providerDiagnostic.status).toBe("blocked");
    expect(state.missingCredentials.envVars).toEqual(["OPENAI_API_KEY"]);
    expect(state.blockers).toContain("Missing credential environment variable OPENAI_API_KEY.");
  });

  it("classifies a ready trusted local provider as configured-ready", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig());
    await trustWorkspace(homeDir, workspaceRoot);

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("configured-ready");
    expect(state.recommendedAction).toBe("launch-agent");
    expect(state.providerReadiness).toBe("ready");
    expect(state.workspaceTrust).toBe("trusted");
    expect(state.workspaceVerification).toBe("verified");
  });

  it("classifies a warning-only provider as configured-degraded", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig("ollama/auto"));
    await trustWorkspace(homeDir, workspaceRoot);

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("configured-degraded");
    expect(state.recommendedAction).toBe("review-warnings");
    expect(state.providerReadiness).toBe("degraded");
    expect(state.warnings.some((warning) => warning.includes("context window"))).toBe(true);
  });

  it("classifies a ready provider in an untrusted workspace as untrusted-workspace", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig());

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("untrusted-workspace");
    expect(state.recommendedAction).toBe("trust-workspace");
    expect(state.workspaceTrust).toBe("untrusted");
    expect(state.blockers).toContain("Workspace is not trusted.");
  });

  it("keeps workspace trust separate from verification and provider readiness", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig());

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("untrusted-workspace");
    expect(state.workspaceTrust).toBe("untrusted");
    expect(state.workspaceVerification).toBe("unverified");
    expect(state.providerReadiness).toBe("ready");
    expect(state.setupVerification.workspaceTrusted).toBe(false);
    expect(state.setupVerification.providerDiagnostic.status).toBe("ready");
    expect(state.blockers).toContain("Workspace is not trusted.");
    expect(state.blockers).not.toContain("Provider setup is incomplete.");
  });

  it("classifies a non-writable state directory as state-not-writable", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig());
    await trustWorkspace(homeDir, workspaceRoot);
    await chmod(join(homeDir, ".estacoda"), 0o500);

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("state-not-writable");
    expect(state.recommendedAction).toBe("fix-state-directory");
    expect(state.stateDirectoryWritable).toBe(false);
  });

  it("classifies an unreadable config parse failure as broken-config", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await mkdir(dirname(profileConfigPath(homeDir)), { recursive: true });
    await writeFile(profileConfigPath(homeDir), "{ nope", "utf8");

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });

    expect(state.kind).toBe("broken-config");
    expect(state.recommendedAction).toBe("repair-config");
    expect(state.error).toBeDefined();
    expect(state.blockers.length).toBeGreaterThan(0);
  });

  it("reports exact config paths and loaded sources", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig());
    const state = await collectSetupEntryState({ homeDir, workspaceRoot });
    const configContent = await readFile(state.configSources[0]!, "utf8");

    expect(state.configPaths.profile).toBe(profileConfigPath(homeDir));
    expect(configContent).toContain("local-test-model");
  });

  it("ignores workspace-local config in verification", async () => {
    const { homeDir, workspaceRoot } = await makeHomeAndWorkspace();
    await writeUserConfig(homeDir, localReadyConfig());
    await mkdir(join(workspaceRoot, ".estacoda"), { recursive: true });
    await writeFile(join(workspaceRoot, ".estacoda", "config.json"), JSON.stringify({ model: { provider: "openai", id: "gpt-4o" } }));
    await trustWorkspace(homeDir, workspaceRoot);

    const state = await collectSetupEntryState({ homeDir, workspaceRoot });
    expect(state.setupVerification.configSources.some((s) => s.includes(join(workspaceRoot, ".estacoda", "config.json")))).toBe(false);
  });
});

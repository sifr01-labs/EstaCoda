import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { handleSlashCommand } from "./session-loop.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { SESSION_RECALL_UNTRUSTED_NOTICE } from "../session/session-recall-service.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { FakeWorkflowStore } from "../workflow/fake-workflow-store.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { WorkflowLockService } from "../workflow/workflow-lock-service.js";
import type { WorkflowStep } from "../workflow/types.js";
import type { Prompt } from "./prompt-contract.js";
import type { SelectPromptInput } from "./interactive-select.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { SkillDefinition } from "../contracts/skill.js";

function fakeRuntime(modelInfo: {
  provider: string;
  model: string;
  contextWindowTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
}, sessionDb = new InMemorySessionDB()) {
  return {
    sessionId: "test-session",
    sessionDb,
    getModelInfo: () => ({
      kind: "kv" as const,
      title: "Model",
      entries: [
        { key: "provider", value: modelInfo.provider },
        { key: "model", value: modelInfo.model },
        { key: "context window", value: String(modelInfo.contextWindowTokens) }
      ]
    }),
    getStatus: () => ({
      kind: "status" as const,
      title: "EstaCoda is ready",
      lines: []
    }),
    describe: () => [
      "EstaCoda is ready",
      `model: ${modelInfo.provider}/${modelInfo.model}`,
      "profile: default",
      "tools: 86"
    ].join("\n"),
    tools: () => [],
    dispose: async () => {}
  } as any;
}

function ttyCapabilities(): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: false,
    terminalWidth: 120,
    isDumb: false,
    isCI: false,
    supportsAnimation: false
  };
}

async function writeProfileConfig(homeDir: string, config: unknown): Promise<void> {
  const configPath = resolveProfileStateHome({ homeDir, profileId: "default" }).configPath;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

describe("session-loop /model", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-model-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/model shows current model info", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const result = await handleSlashCommand({
      text: "/model",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("provider: local");
    expect(outputChunks.join("")).toContain("model: qwen2.5:3b");
  });

  it("/providers renders read-only provider status without mutating config", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        },
        "enterprise-gateway": {
          kind: "openai-compatible",
          baseUrl: "https://gateway.example.com/v1",
          apiKeyEnv: "ENTERPRISE_GATEWAY_API_KEY",
          models: ["enterprise-model"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    const before = readFileSync(configPath, "utf8");
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const noPromptResult = await handleSlashCommand({
      text: "/providers",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(noPromptResult).toBe(false);
    const rendered = outputChunks.join("");
    expect(rendered).toContain("[OK] Providers");
    expect(rendered).toContain("Active route: local/qwen2.5:3b");
    expect(rendered).toContain("Configured providers");
    expect(rendered).toContain("- [OK] local: ready");
    expect(rendered).toContain("- [WARN] enterprise-gateway: missing credential");
    expect(rendered).toContain("Provider Diagnostics");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("/providers setup subcommands use reviewed setup guards when non-interactive", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const localNoPromptResult = await handleSlashCommand({
      text: "/providers local setup",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(localNoPromptResult).toBe(false);
    expect(outputChunks.join("")).toContain("cannot open reviewed provider setup");

    outputChunks = [];
    const customNoPromptResult = await handleSlashCommand({
      text: "/providers custom add",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(customNoPromptResult).toBe(false);
    expect(outputChunks.join("")).toContain("cannot open reviewed provider setup");
  });

  it("/help lists /providers and /models remains unknown", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const helpResult = await handleSlashCommand({
      text: "/help",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });
    expect(helpResult).toBe(false);
    expect(outputChunks.join("")).toContain("/providers");

    outputChunks = [];
    const modelsResult = await handleSlashCommand({
      text: "/models",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });
    expect(modelsResult).toBe(false);
    expect(outputChunks.join("")).toContain("Unknown command: /models");
  });

  it("/model picker uses prompt card selects for session provider and model", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const refreshed = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const selectInputs: Array<SelectPromptInput<unknown>> = [];
    const selections = ["local", "phi4:latest"];
    let selectionIndex = 0;
    const prompt = (async () => "") as Prompt;
    prompt.select = async <T>(input: SelectPromptInput<T>): Promise<T> => {
      selectInputs.push(input as SelectPromptInput<unknown>);
      const value = selections[selectionIndex] as T;
      selectionIndex++;
      return value;
    };

    const result = await handleSlashCommand({
      text: "/model",
      runtime,
      output,
      renderer: { render: renderPlain },
      prompt,
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    expect(selectInputs).toMatchObject([
      {
        surface: "promptCard",
        title: "Select provider",
        body: "Select the provider to use for this session only.",
        columns: [
          { key: "name", header: "Name" },
          { key: "details", header: "Details" },
        ],
        hint: "↑↓ navigate   ENTER select   CTRL+C exit",
        showColumnHeaders: false,
      },
      {
        surface: "promptCard",
        title: "Select model",
        body: "Select the model to use for this session only.",
        columns: [
          { key: "name", header: "Name" },
          { key: "details", header: "Details" },
        ],
        hint: "↑↓ navigate   ENTER select   CTRL+C exit",
        showColumnHeaders: false,
      }
    ]);
    expect(selectInputs[0]?.options).toMatchObject([
      {
        id: "local",
        cells: {
          name: "Local / Private",
          details: "http://localhost:11434/v1",
        },
        current: true,
      },
      {
        id: "cancel",
        group: "navigation",
        cells: {
          name: "Cancel",
          details: "Keep the current session model",
        },
      },
    ]);
    expect(selectInputs[1]?.options.find((option) => option.id === "qwen2.5:3b")).toMatchObject({
      cells: {
        name: "qwen2.5:3b",
        details: "tools · 128000 tokens",
      },
      current: true,
    });
    expect(selectInputs[1]?.options.find((option) => option.id === "phi4:latest")).toMatchObject({
      cells: {
        name: "phi4:latest",
        details: "128000 tokens",
      },
      current: false,
    });
    expect(selectInputs[1]?.options.find((option) => option.id === "cancel")).toMatchObject({
      group: "navigation",
      cells: {
        name: "Cancel",
        details: "Keep the current session model",
      },
    });
    const override = await sessionDb.getSessionModelOverride("test-session");
    expect(override?.route.provider).toBe("local");
    expect(override?.route.id).toBe("phi4:latest");
  });

  it("/model set stores a session-scoped override and refreshes the runtime", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const refreshed = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    const override = await sessionDb.getSessionModelOverride("test-session");
    expect(override?.route.provider).toBe("local");
    expect(override?.route.id).toBe("phi4:latest");
    expect(override?.source).toBe("cli");
  });

  it("/model set returns a focused session override notice without startup dashboard text", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const refreshed = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    expect(result).not.toBe(true);
    if (typeof result === "boolean") throw new Error("expected runtime refresh result");
    const notice = result.notice(refreshed as any);
    expect(notice).toBe([
      "Session model override set: local/phi4:latest",
      "Scope: session",
      "Fallback routes unchanged."
    ].join("\n"));
    expect(notice).not.toContain("EstaCoda is ready");
    expect(notice).not.toContain("profile:");
    expect(notice).not.toContain("tools:");
    expect(notice).not.toContain("model: local/phi4:latest");
  });

  it("/model set bolds notice labels only for TTY-capable styled output", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const refreshed = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    const modelSwitchContext = async () => {
      const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
      return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
    };

    const styledResult = await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain, capabilities: ttyCapabilities() },
      modelSwitchContext,
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });
    if (typeof styledResult === "boolean") throw new Error("expected styled runtime refresh result");
    const styledNotice = styledResult.notice(refreshed as any);
    expect(styledNotice).toContain("\u001b[1mSession model override set:\u001b[22m local/phi4:latest");
    expect(styledNotice).toContain("\u001b[1mScope:\u001b[22m session");
    expect(styledNotice).toContain("\u001b[1mFallback routes unchanged.\u001b[22m");

    const plainResult = await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext,
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });
    if (typeof plainResult === "boolean") throw new Error("expected plain runtime refresh result");
    expect(plainResult.notice(refreshed as any)).not.toContain("\u001b[1m");
  });

  it("/model --global persists only the profile primary route after local trust", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: {
        provider: "local",
        id: "qwen2.5:3b",
        fallbacks: [{ provider: "local", id: "qwen2.5:3b" }]
      },
      auxiliaryModels: {
        assessor: { provider: "local", id: "qwen2.5:3b" }
      }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    await sessionDb.setSessionModelOverride("test-session", {
      route: {
        provider: "local",
        id: "qwen2.5:3b",
        baseUrl: "http://localhost:11434/v1",
        authMethod: "none",
        apiMode: "custom_openai_compatible"
      },
      modelProfile: {
        id: "qwen2.5:3b",
        provider: "local",
        contextWindowTokens: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      },
      setAt: "2026-01-01T00:00:00.000Z",
      source: "cli"
    });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    runtime.isWorkspaceTrusted = async () => true;
    const refreshed = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model --global local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => refreshed as any,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.model.provider).toBe("local");
    expect(after.model.id).toBe("phi4:latest");
    expect(after.model.fallbacks).toEqual([{ provider: "local", id: "qwen2.5:3b" }]);
    expect(after.auxiliaryModels.assessor).toEqual({ provider: "local", id: "qwen2.5:3b" });
    await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeUndefined();
  });

  it("/model set --global parses --global before normalization and rejects global clear", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);
    runtime.isWorkspaceTrusted = async () => true;
    const modelSwitchContext = async () => {
      const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
      return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
    };

    const setResult = await handleSlashCommand({
      text: "/model set --global local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext,
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(setResult).not.toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8")).model.id).toBe("phi4:latest");
    outputChunks = [];

    const clearResult = await handleSlashCommand({
      text: "/model --global clear",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(clearResult).toBe(false);
    expect(outputChunks.join("")).toContain("Clearing the global primary model is not supported");
    expect(JSON.parse(readFileSync(configPath, "utf8")).model.id).toBe("phi4:latest");
  });

  it("/model --global rejects missing credentials and untrusted workspaces without mutating config", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
      const originalConfig = {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"],
            apiKeyEnv: "OPENAI_API_KEY"
          }
        },
        model: { provider: "openai", id: "gpt-4o" }
      };
      await writeProfileConfig(tempHome, originalConfig);
      const sessionDb = new InMemorySessionDB();
      await sessionDb.createSession({ id: "test-session", profileId: "default" });
      await sessionDb.setSessionModelOverride("test-session", {
        route: {
          provider: "local",
          id: "qwen2.5:3b",
          baseUrl: "http://localhost:11434/v1",
          authMethod: "none",
          apiMode: "custom_openai_compatible"
        },
        modelProfile: {
          id: "qwen2.5:3b",
          provider: "local",
          contextWindowTokens: 128000,
          supportsTools: true,
          supportsVision: false,
          supportsStructuredOutput: true
        },
        setAt: "2026-01-01T00:00:00.000Z",
        source: "cli"
      });
      const runtime = fakeRuntime({
        provider: "local",
        model: "qwen2.5:3b",
        contextWindowTokens: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      }, sessionDb);
      runtime.isWorkspaceTrusted = async () => true;

      const missingResult = await handleSlashCommand({
        text: "/model --global openai/gpt-4o",
        runtime,
        output,
        renderer: { render: renderPlain },
        modelSwitchContext: async () => {
          const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
          return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
        },
        workspaceRoot: tempHome,
        homeDir: tempHome
      });

      expect(missingResult).toBe(false);
      expect(outputChunks.join("")).toContain("estacoda model setup openai");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(originalConfig);
      await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeDefined();

      outputChunks = [];
      process.env.OPENAI_API_KEY = "sk-secret-session-global";
      runtime.isWorkspaceTrusted = async () => false;
      const untrustedResult = await handleSlashCommand({
        text: "/model openai/gpt-4o --global",
        runtime,
        output,
        renderer: { render: renderPlain },
        modelSwitchContext: async () => {
          const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
          return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
        },
        workspaceRoot: tempHome,
        homeDir: tempHome
      });

      expect(untrustedResult).toBe(false);
      expect(outputChunks.join("")).toContain("Global model changes require a trusted workspace/profile");
      expect(outputChunks.join("")).not.toContain("sk-secret-session-global");
      expect(JSON.stringify(JSON.parse(readFileSync(configPath, "utf8")))).not.toContain("sk-secret-session-global");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(originalConfig);
      await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeDefined();
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it("/model set does not write provider config", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b", "phi4:latest"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    }, null, 2);
    writeFileSync(configPath, original);

    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = readFileSync(configPath, "utf8");
    expect(after).toBe(original);
  });

  it("/model clear removes the session override and refreshes the runtime", async () => {
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    await sessionDb.setSessionModelOverride("test-session", {
      route: {
        provider: "local",
        id: "phi4:latest",
        baseUrl: "http://localhost:11434/v1",
        apiMode: "custom_openai_compatible",
        authMethod: "none",
        contextWindowTokens: 128000
      },
      modelProfile: {
        id: "phi4:latest",
        provider: "local",
        contextWindowTokens: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      },
      setAt: "2030-01-01T00:00:00.000Z",
      source: "cli"
    });
    const runtime = fakeRuntime({
      provider: "local",
      model: "phi4:latest",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model clear",
      runtime,
      output,
      renderer: { render: renderPlain },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).not.toBe(false);
    await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeUndefined();
  });

  it("/model set does not change persistent config.model.provider or config.model.id", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    }, null, 2);
    writeFileSync(configPath, original);

    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.model.provider).toBe("local");
    expect(after.model.id).toBe("qwen2.5:3b");
  });

  it("/model set does not add provider entries, API keys, or fallback routes", async () => {
    const configPath = resolveProfileStateHome({ homeDir: tempHome, profileId: "default" }).configPath;
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    }, null, 2);
    writeFileSync(configPath, original);

    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      switchRuntime: async () => runtime,
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(after.providers)).toEqual(["local"]);
    expect(after.providers.local.apiKey).toBeUndefined();
    expect(after.model.fallbacks).toBeUndefined();
  });

  it("/model set rejects unresolved model input with setup guidance", async () => {
    await writeProfileConfig(tempHome, {
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434/v1",
          models: ["qwen2.5:3b"],
          enableNetwork: true
        }
      },
      model: { provider: "local", id: "qwen2.5:3b" }
    });
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "test-session", profileId: "default" });
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    }, sessionDb);

    const result = await handleSlashCommand({
      text: "/model set badmodel",
      runtime,
      output,
      renderer: { render: renderPlain },
      modelSwitchContext: async () => {
        const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
        return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
      },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("Could not resolve");
    expect(outputChunks.join("")).toContain("estacoda model setup");
  });

  it("/model set rejects missing credentials without collecting secrets", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await writeProfileConfig(tempHome, {
        providers: {
          openai: {
            kind: "openai-compatible",
            models: ["gpt-4o"],
            apiKeyEnv: "OPENAI_API_KEY"
          }
        },
        model: { provider: "local", id: "qwen2.5:3b" }
      });
      const sessionDb = new InMemorySessionDB();
      await sessionDb.createSession({ id: "test-session", profileId: "default" });
      const runtime = fakeRuntime({
        provider: "local",
        model: "qwen2.5:3b",
        contextWindowTokens: 128000,
        supportsTools: true,
        supportsVision: false,
        supportsStructuredOutput: true
      }, sessionDb);

      const result = await handleSlashCommand({
        text: "/model set openai/gpt-4o",
        runtime,
        output,
        renderer: { render: renderPlain },
        modelSwitchContext: async () => {
          const loaded = await loadRuntimeConfig({ workspaceRoot: tempHome, homeDir: tempHome, profileId: "default" });
          return { config: loaded.config, providerRegistry: loaded.providerRegistry, homeDir: tempHome };
        },
        workspaceRoot: tempHome,
        homeDir: tempHome
      });

      expect(result).toBe(false);
      expect(outputChunks.join("")).toContain("Credentials are not configured for openai/gpt-4o");
      expect(outputChunks.join("")).toContain("estacoda model setup openai");
      await expect(sessionDb.getSessionModelOverride("test-session")).resolves.toBeUndefined();
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });
});

describe("session-loop session recall", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-recall-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/session recall uses the manual recall surface", async () => {
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      recallSession: async (query: string) => ({
        query,
        blocks: [
          {
            sessionId: "historical-session",
            sourceSessionIds: ["historical-session"],
            summary: "Source session historical-session: recalled alpha detail",
            hitMessageIds: ["message-1"],
            usedFallback: false,
            untrustedNotice: SESSION_RECALL_UNTRUSTED_NOTICE
          }
        ],
        diagnostics: {
          rawHitCount: 1,
          groupedSessionCount: 1,
          returnedSessionCount: 1,
          fallbackCount: 0,
          warnings: []
        }
      })
    };

    const result = await handleSlashCommand({
      text: "/session recall alpha detail",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const text = outputChunks.join("");
    expect(text).toContain("Session recall for \"alpha detail\"");
    expect(text).toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
    expect(text).toContain("Source session historical-session");
  });

  it("/search remains a raw session search surface", async () => {
    const sessionDb = new InMemorySessionDB();
    await sessionDb.createSession({ id: "active-session", profileId: "default" });
    await sessionDb.createSession({ id: "historical-session", profileId: "default" });
    await sessionDb.appendMessage({
      id: "message-1",
      sessionId: "historical-session",
      role: "user",
      content: "alpha raw search detail"
    });
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      sessionId: "active-session",
      sessionDb
    };

    const result = await handleSlashCommand({
      text: "/search alpha",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const text = outputChunks.join("");
    expect(text).toContain("Search results for \"alpha\"");
    expect(text).toContain("[historical-session] user: alpha raw search detail");
    expect(text).not.toContain(SESSION_RECALL_UNTRUSTED_NOTICE);
  });
});

describe("session-loop session compaction", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-compact-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/compact uses manual session compaction and passes the focus topic", async () => {
    const calls: Array<{ focusTopic?: string; preserveTranscript?: boolean }> = [];
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      compactSession: async (input?: { focusTopic?: string; preserveTranscript?: boolean }) => {
        calls.push(input ?? {});
        return compactResult();
      }
    };

    const result = await handleSlashCommand({
      text: "/compact billing topic",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(calls).toEqual([{ focusTopic: "billing topic", preserveTranscript: false }]);
    const text = outputChunks.join("");
    expect(text).toContain("Compacted 8 messages -> 4 messages");
    expect(text).toContain("Token estimate: 2000 -> 900");
    expect(text).toContain("Focus topic: billing topic");
  });

  it("/compact stays separate from /workflow summarize", async () => {
    let workflowDispatched = false;
    let compactCalled = false;
    const runtime = {
      ...fakeRuntime({
        provider: "local",
        model: "test",
        contextWindowTokens: 4096,
        supportsTools: false,
        supportsVision: false,
        supportsStructuredOutput: true
      }),
      compactSession: async () => {
        compactCalled = true;
        return compactResult();
      },
      workflow: {
        dispatcher: {
          dispatch: async () => {
            workflowDispatched = true;
            return { ok: true, message: "workflow summarized" };
          }
        }
      }
    };

    await handleSlashCommand({
      text: "/compact",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(compactCalled).toBe(true);
    expect(workflowDispatched).toBe(false);
  });
});

describe("session-loop /workflow begin", () => {
  let tempHome: string;
  let outputChunks: string[];
  let output: NodeJS.WritableStream;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-session-workflow-test-"));
    outputChunks = [];
    output = {
      write: (chunk: string | Buffer) => { outputChunks.push(String(chunk)); },
      end: () => {}
    } as NodeJS.WritableStream;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("/workflow begin rejects an empty objective with usage", async () => {
    const runtime = workflowRuntime();

    const result = await handleSlashCommand({
      text: "/workflow begin",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("Usage: /workflow begin <objective>");
  });

  it("/workflow begin reports unavailable when workflow is not wired", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "test",
      contextWindowTokens: 4096,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const result = await handleSlashCommand({
      text: "/workflow begin refactor auth module",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("Workflow is not available. It requires SQLite session persistence.");
  });

  it("/workflow begin creates, starts, and activates a conservative workflow run", async () => {
    const runtime = workflowRuntime();

    const result = await handleSlashCommand({
      text: "/workflow begin refactor the auth module",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const outputText = outputChunks.join("");
    expect(outputText).toContain("Created workflow: ");
    expect(outputText).toContain("Started workflow: ");
    expect(outputText).toContain("Activated workflow: ");
    expect(runtime.workflow.activeRunId).toMatch(/^[-\w]+/u);
    const activeRunId = runtime.workflow.activeRunId;
    if (activeRunId === null) throw new Error("expected active workflow run");

    const run = await runtime.workflow.store.getWorkflowRun(activeRunId);
    expect(run).toEqual(expect.objectContaining({
      id: activeRunId,
      sessionId: "test-session",
      status: "running",
      metadata: {
        activationReason: "explicit",
        objective: "refactor the auth module"
      }
    }));

    const steps = await runtime.workflow.store.listWorkflowSteps(activeRunId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      name: "Work on objective",
      description: "Continue the requested work through AgentLoop",
      status: "running",
      maxRetries: 0,
      idempotent: false,
      failurePolicy: expect.objectContaining({
        allowSkipIfSkippable: false,
        defaultAction: "stop"
      })
    });
  });

  it("/workflow begin --skill creates, starts, and activates a skill playbook workflow run", async () => {
    const runtime = workflowRuntime([workflowSkill()]);

    const result = await handleSlashCommand({
      text: "/workflow begin --skill research-skill research auth options",
      runtime: runtime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const outputText = outputChunks.join("");
    expect(outputText).toContain("Created workflow: ");
    expect(outputText).toContain("Started workflow: ");
    expect(outputText).toContain("Activated workflow: ");

    const activeRunId = runtime.workflow.activeRunId;
    if (activeRunId === null) throw new Error("expected active workflow run");
    const run = await runtime.workflow.store.getWorkflowRun(activeRunId);
    expect(run).toEqual(expect.objectContaining({
      id: activeRunId,
      sessionId: "test-session",
      status: "running",
      selectedSkill: "research-skill",
      metadata: {
        activationReason: "playbook",
        objective: "research auth options",
        skillName: "research-skill",
        playbook: {
          source: "skill-playbook",
          skill: "research-skill"
        }
      }
    }));

    const steps = await runtime.workflow.store.listWorkflowSteps(activeRunId);
    expect(steps.map((step: WorkflowStep) => step.name)).toEqual(["inspect", "summarize"]);
    expect(steps.map((step: WorkflowStep) => step.description)).toEqual([
      "Inspect the target material",
      "Summarize the findings"
    ]);
    expect(steps[0]).toMatchObject({
      status: "running",
      maxRetries: 0,
      idempotent: false,
      failurePolicy: expect.objectContaining({
        allowSkipIfSkippable: false,
        defaultAction: "stop"
      })
    });
  });

  it("/workflow begin --skill rejects missing skill values and unknown skills", async () => {
    const missingRuntime = workflowRuntime([workflowSkill()]);

    const missingResult = await handleSlashCommand({
      text: "/workflow begin --skill",
      runtime: missingRuntime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(missingResult).toBe(false);
    expect(outputChunks.join("")).toContain("Usage: /workflow begin --skill <skillName> <objective>");

    outputChunks = [];
    const unknownRuntime = workflowRuntime([workflowSkill()]);
    const unknownResult = await handleSlashCommand({
      text: "/workflow begin --skill missing-skill research auth",
      runtime: unknownRuntime as any,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(unknownResult).toBe(false);
    expect(outputChunks.join("")).toContain("Skill not found: missing-skill");
    expect(unknownRuntime.workflow.activeRunId).toBeNull();
  });
});

function workflowRuntime(skills: SkillDefinition[] = []) {
  const store = new FakeWorkflowStore();
  const lockService = new WorkflowLockService({ store });
  const engine = new WorkflowEngine({ store, lockService, ownerId: "test" });
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const runtime = {
    ...fakeRuntime({
      provider: "local",
      model: "test",
      contextWindowTokens: 4096,
      supportsTools: false,
      supportsVision: false,
      supportsStructuredOutput: true
    }),
    workflow: {
      engine,
      store,
      activeRunId: null as string | null,
      setActiveRunId(runId: string | null) {
        this.activeRunId = runId;
      }
    },
    resolveSkill(name: string) {
      return skillByName.get(name);
    }
  };
  return runtime;
}

function workflowSkill(): SkillDefinition {
  return {
    name: "research-skill",
    description: "Research skill",
    version: "0.1.0",
    whenToUse: ["research"],
    requiredToolsets: ["files"],
    playbook: [
      {
        id: "inspect",
        description: "Inspect the target material",
        toolsets: ["files"],
        fallbackTo: ["summarize"],
        successCriteria: ["source inspected"]
      },
      {
        id: "summarize",
        description: "Summarize the findings",
        successCriteria: ["findings summarized"]
      }
    ],
    permissionExpectations: ["auto-read"],
    examples: [],
    evaluations: []
  };
}

function compactResult() {
  return {
    didCompress: true,
    messages: [
      { id: "m1", role: "user", content: "head" },
      { id: "summary", role: "system", content: "summary", metadata: { semanticCompression: true } },
      { id: "m7", role: "agent", content: "tail" },
      { id: "m8", role: "user", content: "latest" }
    ],
    diagnostics: {
      shouldCompress: true,
      reason: "forced",
      preTokens: 2000,
      postTokens: 900,
      estimatedSavingsTokens: 1100,
      estimatedSavingsRatio: 0.55,
      sourceMessageCount: 8,
      summarizedMessageCount: 4,
      protectedMessageCount: 4,
      protectedFirstN: 1,
      protectedLastN: 1,
      protectedSpans: [],
      protectedCategories: [],
      summaryFormatVersion: "v1",
      summaryChars: 100,
      fallbackUsed: false,
      warnings: [],
      eventWarnings: [],
      prunedToolResults: 0,
      scopeKey: "profile:session",
      ineffectiveCompressionCount: 0
    },
    userFacingMessage: "Session history compacted"
  };
}

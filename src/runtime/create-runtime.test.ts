import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "./create-runtime.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import type { ModelProfile, ProviderAdapter } from "../contracts/provider.js";
import type { ThemeDefinition } from "../contracts/theme.js";

const mockModel: ModelProfile = {
  id: "mock-model",
  provider: "unconfigured",
  contextWindowTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  supportsStructuredOutput: false
};

const mockTheme: ThemeDefinition = {
  name: "test",
  description: "test theme",
  colors: {
    bannerBorder: "",
    bannerTitle: "",
    bannerAccent: "",
    bannerDim: "",
    bannerText: "",
    uiAccent: "",
    uiLabel: "",
    uiOk: "",
    uiError: "",
    uiWarn: "",
    prompt: "",
    inputRule: "",
    responseBorder: "",
    sessionLabel: "",
    sessionBorder: "",
    statusBarBg: "",
    voiceStatusBg: "",
    completionMenuBg: "",
    completionMenuCurrentBg: "",
    completionMenuMetaBg: "",
    completionMenuMetaCurrentBg: ""
  },
  spinner: {
    waitingFaces: [],
    thinkingFaces: [],
    thinkingVerbs: [],
    wings: []
  },
  branding: {
    agentName: "Test",
    responseLabel: "Test",
    promptSymbol: ">",
    helpHeader: "",
    taglinePrimary: "",
    taglineSecondary: ""
  },
  toolPrefix: "",
  toolSymbols: {}
};

function createMockProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const mockProvider: ProviderAdapter = {
    id: "unconfigured",
    name: "Mock",
    health: () => ({ available: false }),
    listModels: () => [mockModel],
    complete: async () => ({ ok: true, content: "", model: "mock-model", provider: "unconfigured" })
  };
  registry.register(mockProvider);
  return registry;
}

async function minimalRuntimeOptions(overrides: {
  projectConfigTrust?: "trusted" | "untrusted";
  mcpServers?: Record<string, { command: string; args?: string[] }>;
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-runtime-test-"));
  return {
    theme: mockTheme,
    model: mockModel,
    providerRegistry: createMockProviderRegistry(),
    workspaceRoot,
    localSkillsRoot: join(workspaceRoot, "skills"),
    sessionId: `test-${Date.now()}`,
    ...overrides
  };
}

describe("createRuntime MCP trust gating", () => {
  it("does not start/register MCP when projectConfigTrust is omitted", async () => {
    const options = await minimalRuntimeOptions({
      mcpServers: { echo: { command: "echo", args: ["hello"] } }
    });
    const runtime = await createRuntime(options);
    const servers = runtime.inspectMcpServers();
    expect(servers).toEqual([]);
  });

  it("does not start/register MCP when projectConfigTrust is 'untrusted'", async () => {
    const options = await minimalRuntimeOptions({
      mcpServers: { echo: { command: "echo", args: ["hello"] } },
      projectConfigTrust: "untrusted"
    });
    const runtime = await createRuntime(options);
    const servers = runtime.inspectMcpServers();
    expect(servers).toEqual([]);
  });

  it("attempts to start/register MCP when projectConfigTrust is 'trusted'", async () => {
    const options = await minimalRuntimeOptions({
      mcpServers: { echo: { command: "echo", args: ["hello"] } },
      projectConfigTrust: "trusted"
    });
    const runtime = await createRuntime(options);
    const servers = runtime.inspectMcpServers();
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe("echo");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSlashCommand } from "./session-loop.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";

function fakeRuntime(modelInfo: {
  provider: string;
  model: string;
  contextWindowTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
}) {
  return {
    sessionId: "test-session",
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
    tools: () => [],
    dispose: async () => {}
  } as any;
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

  it("/model set refuses with clear message", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const result = await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    const text = outputChunks.join("");
    expect(text).toContain("Session-scoped model switching is not supported");
    expect(text).toContain("Persistent `estacoda model set` is deprecated and disabled");
    expect(text).toContain("estacoda model setup local");
  });

  it("/model set does not write provider config", async () => {
    const estacodaDir = join(tempHome, ".estacoda");
    mkdirSync(estacodaDir, { recursive: true });
    const configPath = join(estacodaDir, "config.json");
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

    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = readFileSync(configPath, "utf8");
    expect(after).toBe(original);
  });

  it("/model set does not change persistent config.model.provider or config.model.id", async () => {
    const estacodaDir = join(tempHome, ".estacoda");
    mkdirSync(estacodaDir, { recursive: true });
    const configPath = join(estacodaDir, "config.json");
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

    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.model.provider).toBe("local");
    expect(after.model.id).toBe("qwen2.5:3b");
  });

  it("/model set does not add provider entries, API keys, or fallback routes", async () => {
    const estacodaDir = join(tempHome, ".estacoda");
    mkdirSync(estacodaDir, { recursive: true });
    const configPath = join(estacodaDir, "config.json");
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

    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    await handleSlashCommand({
      text: "/model set local/phi4:latest",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(after.providers)).toEqual(["local"]);
    expect(after.providers.local.apiKey).toBeUndefined();
    expect(after.model.fallbacks).toBeUndefined();
  });

  it("/model set rejects missing slash syntax with unsupported message", async () => {
    const runtime = fakeRuntime({
      provider: "local",
      model: "qwen2.5:3b",
      contextWindowTokens: 128000,
      supportsTools: true,
      supportsVision: false,
      supportsStructuredOutput: true
    });

    const result = await handleSlashCommand({
      text: "/model set badmodel",
      runtime,
      output,
      renderer: { render: renderPlain },
      workspaceRoot: tempHome,
      homeDir: tempHome
    });

    expect(result).toBe(false);
    expect(outputChunks.join("")).toContain("Session-scoped model switching is not supported");
  });
});

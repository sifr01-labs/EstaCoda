import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { benchCommand } from "../cli/bench-command.js";

type LocalSmokeTask = {
  schemaVersion: 1;
  id: string;
  benchmark: {
    name: string;
    version: string;
    taskId: string;
  };
  model: string;
  instruction: string;
  workspace: {
    files: Record<string, string>;
  };
  expected: {
    files: Array<{
      path: string;
      content: string;
    }>;
  };
};

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("local benchmark smoke", () => {
  it("runs the local fake task through bench run and verifies workspace artifacts", async () => {
    const task = await loadLocalSmokeTask("file-create");
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    const homeDir = join(root, "bench-home");
    await materializeWorkspace(workspace, task.workspace.files);

    const runtime = localSmokeRuntime(workspace, task);
    const result = await benchCommand(
      {
        argv: [],
        workspaceRoot: workspace,
        homeDir: join(root, "caller-home")
      },
      [
        "run",
        "--workspace", workspace,
        "--instruction", task.instruction,
        "--out", outDir,
        "--model", task.model,
        "--benchmark-name", task.benchmark.name,
        "--benchmark-version", task.benchmark.version,
        "--task-id", task.benchmark.taskId,
        "--temperature", "0",
        "--timeout-ms", "5000"
      ],
      {
        loadConfig: async () => fakeLoadedConfig(),
        createRuntime: (async () => runtime) as typeof import("../runtime/create-runtime.js").createRuntime,
        makeTempHome: async () => homeDir,
        getPackageVersion: async () => "0.1.test",
        getGitCommit: async () => "local-smoke",
        now: sequentialNow([
          new Date("2026-07-05T00:00:00.000Z"),
          new Date("2026-07-05T00:00:02.000Z")
        ])
      }
    );

    expect(result).toMatchObject({
      handled: true,
      exitCode: 0
    });

    for (const file of task.expected.files) {
      await expect(readFile(join(workspace, file.path), "utf8")).resolves.toBe(file.content);
    }

    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      runMode: "headless-benchmark",
      benchmark: {
        name: task.benchmark.name,
        version: task.benchmark.version,
        taskId: task.benchmark.taskId,
        attempt: 1
      },
      execution: {
        status: "success",
        workspace,
        home: homeDir,
        homeMode: "generated"
      },
      model: {
        provider: "openai",
        id: "gpt-test",
        settings: {
          temperature: 0,
          maxTokens: null
        }
      },
      metrics: {
        providerCalls: 1,
        toolCalls: 2,
        providerToolCalls: 1
      },
      finalAnswer: "Local smoke task complete."
    });

    const events = await readFile(join(outDir, "events.ndjson"), "utf8");
    expect(events).toContain("\"provider-tool-call\"");
    expect(events).toContain("\"tool-start\"");
    await expect(readFile(join(outDir, "stdout.txt"), "utf8")).resolves.toContain("Local smoke task complete.");
  });
});

async function loadLocalSmokeTask(id: string): Promise<LocalSmokeTask> {
  const path = fileURLToPath(new URL(`../../benchmarks/local-smoke/tasks/${id}.json`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as LocalSmokeTask;
}

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "estacoda-local-benchmark-smoke-"));
  return tempDir;
}

async function materializeWorkspace(workspace: string, files: Record<string, string>): Promise<void> {
  await mkdir(workspace, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function localSmokeRuntime(workspace: string, task: LocalSmokeTask): Runtime {
  return {
    sessionId: "local-smoke-session",
    trajectoryId: "local-smoke-trajectory",
    handle: vi.fn(async (input) => {
      await input.onEvent?.({
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150
        }
      });
      await input.onEvent?.({
        kind: "provider-tool-call",
        provider: "openai",
        model: "gpt-test",
        name: "file.write"
      });
      for (const file of task.expected.files) {
        await input.onEvent?.({
          kind: "tool-start",
          tool: "file.write",
          targetSummary: file.path
        });
        await writeFile(join(workspace, file.path), file.content, "utf8");
        await input.onEvent?.({
          kind: "tool-result",
          tool: "file.write",
          ok: true
        });
      }
      await input.onEvent?.({
        kind: "tool-start",
        tool: "file.read",
        targetSummary: task.expected.files[0]?.path
      });
      await input.onEvent?.({
        kind: "tool-result",
        tool: "file.read",
        ok: true
      });
      return {
        label: "EstaCoda",
        text: "Local smoke task complete.",
        providerExecution: undefined,
        toolExecutions: [],
        progress: []
      } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
    }),
    dispose: vi.fn(async () => {}),
    tools: () => [],
    skills: () => [],
    describe: () => "local smoke runtime",
    agentEvolutionPolicy: () => ({ enabled: false }) as never,
    getStatus: () => ({ kind: "status", title: "", groups: [] }) as never,
    getModelInfo: () => ({ kind: "keyValueBlock", title: "", items: [] }) as never,
    getStartup: () => ({ kind: "startup", title: "", subtitle: "", sections: [] }) as never,
    getStartupReadiness: async () => ({ status: "ready", checks: [] }) as never,
    latestResumeNote: async () => undefined,
    inspectMemoryPromotions: async () => [],
    inspectMcpServers: () => [],
    trustWorkspace: async () => {},
    isWorkspaceTrusted: async () => true,
    revokeWorkspaceTrust: async () => false,
    sessionDb: {} as never
  } as Runtime;
}

function fakeLoadedConfig(): LoadedRuntimeConfig {
  const model: ModelProfile = {
    provider: "unconfigured",
    id: "unconfigured",
    contextWindowTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false
  };
  const primaryModelRoute: ResolvedModelRoute = {
    provider: "unconfigured",
    id: "unconfigured",
    profile: model,
    contextWindowTokens: model.contextWindowTokens
  };

  return {
    config: {
      providers: {},
      model: {
        provider: "unconfigured",
        id: "unconfigured"
      }
    },
    sources: [],
    homeDir: "/tmp/home",
    profileId: "default",
    model,
    primaryModelRoute,
    modelFallbackRoutes: [],
    providerRegistry: {} as never,
    auxiliaryModels: {} as never,
    web: {
      enableNetwork: false
    },
    security: {
      approvalMode: "adaptive",
      assessor: {},
      allowPrivateUrls: false,
      websiteBlocklist: []
    },
    mcp: {
      servers: {}
    },
    skills: {
      externalDirs: [],
      autonomy: "off",
      config: {}
    },
    ui: {
      language: "en",
      flavor: "standard",
      activityLabels: "en",
      showResponseProgress: false
    },
    profile: {
      mode: "focused",
      responseLanguage: "en"
    },
    compression: {} as never,
    memory: {} as never,
    externalMemory: {} as never,
    browser: {
      backend: "unconfigured",
      autoLaunch: false,
      summarizeSnapshots: "auto",
      snapshotSummarizeThreshold: 0
    },
    imageGen: {} as never,
    tts: {} as never,
    stt: {} as never,
    channels: {
      telegram: {
        ready: false
      }
    }
  } as unknown as LoadedRuntimeConfig;
}

function sequentialNow(values: Date[]): () => Date {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

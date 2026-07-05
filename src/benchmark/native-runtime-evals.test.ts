import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { benchCommand } from "../cli/bench-command.js";

const execFileAsync = promisify(execFile);

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("native runtime eval scenarios", () => {
  it("runs a deterministic one-file bug scenario through benchmark artifacts", async () => {
    const fixture = scenarioFixture("one-file-bug");
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    const homeDir = join(root, "bench-home");
    await cp(join(fixture, "workspace"), workspace, { recursive: true });

    await expect(runVerifier(fixture, workspace)).rejects.toThrow();

    const originalTest = await readFile(join(workspace, "test/totals.test.js"), "utf8");
    const instruction = await readFile(join(fixture, "instruction.txt"), "utf8");
    const runtime = oneFileBugRuntime({ fixture, workspace });

    const result = await benchCommand(
      {
        argv: [],
        workspaceRoot: workspace,
        homeDir: join(root, "caller-home")
      },
      [
        "run",
        "--workspace", workspace,
        "--instruction", instruction,
        "--out", outDir,
        "--model", "openai/gpt-test",
        "--benchmark-name", "native-runtime-evals",
        "--benchmark-version", "0.1.0",
        "--task-id", "one-file-bug",
        "--temperature", "0",
        "--timeout-ms", "5000"
      ],
      {
        loadConfig: async () => fakeLoadedConfig(),
        createRuntime: (async () => runtime) as typeof import("../runtime/create-runtime.js").createRuntime,
        makeTempHome: async () => homeDir,
        getPackageVersion: async () => "0.1.test",
        getGitCommit: async () => "native-runtime-evals",
        now: sequentialNow([
          new Date("2026-07-06T00:00:00.000Z"),
          new Date("2026-07-06T00:00:03.000Z")
        ])
      }
    );

    expect(result).toMatchObject({
      handled: true,
      exitCode: 0
    });
    await expect(runVerifier(fixture, workspace)).resolves.toBeUndefined();
    await expect(readFile(join(workspace, "test/totals.test.js"), "utf8")).resolves.toBe(originalTest);
    await expect(readFile(join(workspace, "src/totals.js"), "utf8")).resolves.toContain("subtotal * (1 + taxRate)");

    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      runMode: "headless-benchmark",
      benchmark: {
        name: "native-runtime-evals",
        version: "0.1.0",
        taskId: "one-file-bug",
        attempt: 1
      },
      execution: {
        status: "success",
        workspace,
        home: homeDir,
        homeMode: "generated"
      },
      metrics: {
        providerCalls: 1,
        providerToolCalls: 1,
        toolCalls: 5,
        toolFailures: 1,
        providerBudgetExhaustions: 0,
        securityEscalations: 0,
        contextUsageEvents: 1,
        estimatedCostUsd: null
      }
    });
    expect(summary.finalAnswer).toContain("root cause");
    expect(summary.finalAnswer).toContain("tax rate was added as a flat amount");

    const eventLines = (await readFile(join(outDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; targetSummary?: string; ok?: boolean });
    const evidence = eventLines.map((event) => event.targetSummary).filter(Boolean);
    expect(evidence).toEqual(expect.arrayContaining([
      "src/totals.js",
      "test/totals.test.js",
      "verifier before patch",
      "verifier after patch"
    ]));
    expect(eventLines.some((event) => event.kind === "tool-result" && event.targetSummary === "verifier before patch" && event.ok === false)).toBe(true);
    expect(eventLines.some((event) => event.kind === "tool-result" && event.targetSummary === "verifier after patch" && event.ok === true)).toBe(true);
  });
});

function scenarioFixture(id: string): string {
  return fileURLToPath(new URL(`../../benchmarks/native-runtime-evals/${id}/`, import.meta.url));
}

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "estacoda-native-runtime-eval-"));
  return tempDir;
}

async function runVerifier(fixture: string, workspace: string): Promise<void> {
  await execFileAsync("sh", [join(fixture, "verifier.sh"), workspace]);
}

function oneFileBugRuntime(input: { fixture: string; workspace: string }): Runtime {
  return {
    sessionId: "native-runtime-eval-session",
    trajectoryId: "native-runtime-eval-trajectory",
    handle: vi.fn(async (request) => {
      await request.onEvent?.({
        kind: "context-usage",
        filled: 1800,
        total: 4096,
        source: "assembled-prompt"
      });
      await request.onEvent?.({
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 300,
          outputTokens: 90,
          totalTokens: 390
        }
      });
      await request.onEvent?.({
        kind: "provider-tool-call",
        provider: "openai",
        model: "gpt-test",
        name: "file.edit"
      });

      await emitReadEvidence(request, input.workspace, "src/totals.js");
      await emitReadEvidence(request, input.workspace, "test/totals.test.js");

      await request.onEvent?.({
        kind: "tool-start",
        tool: "terminal.run",
        targetSummary: "verifier before patch"
      });
      await runVerifier(input.fixture, input.workspace).catch(async () => {
        await request.onEvent?.({
          kind: "tool-result",
          tool: "terminal.run",
          targetSummary: "verifier before patch",
          ok: false
        });
      });

      await request.onEvent?.({
        kind: "tool-start",
        tool: "file.write",
        targetSummary: "src/totals.js"
      });
      await writeFile(join(input.workspace, "src/totals.js"), fixedTotalsSource(), "utf8");
      await request.onEvent?.({
        kind: "tool-result",
        tool: "file.write",
        targetSummary: "src/totals.js",
        ok: true
      });

      await request.onEvent?.({
        kind: "tool-start",
        tool: "terminal.run",
        targetSummary: "verifier after patch"
      });
      await runVerifier(input.fixture, input.workspace);
      await request.onEvent?.({
        kind: "tool-result",
        tool: "terminal.run",
        targetSummary: "verifier after patch",
        ok: true
      });

      return {
        label: "EstaCoda",
        text: "The root cause was that the tax rate was added as a flat amount instead of multiplying the subtotal by 1 + taxRate. Patched src/totals.js and verified the totals tests pass.",
        providerExecution: undefined,
        toolExecutions: [],
        progress: []
      } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
    }),
    dispose: vi.fn(async () => {}),
    tools: () => [],
    skills: () => [],
    describe: () => "native runtime eval fake runtime",
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

async function emitReadEvidence(
  request: Parameters<Runtime["handle"]>[0],
  workspace: string,
  targetSummary: string
): Promise<void> {
  await request.onEvent?.({
    kind: "tool-start",
    tool: "file.read",
    targetSummary
  });
  await readFile(join(workspace, targetSummary), "utf8");
  await request.onEvent?.({
    kind: "tool-result",
    tool: "file.read",
    targetSummary,
    ok: true
  });
}

function fixedTotalsSource(): string {
  return `function subtotalWithTax(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  return subtotal * (1 + taxRate);
}

module.exports = {
  subtotalWithTax
};
`;
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

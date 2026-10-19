import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { benchCommand } from "../cli/bench-command.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import type { ModelProfile } from "../contracts/provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("benchmark real runtime integration", () => {
  it.each([
    { explicitHome: false, scenario: "read" },
    { explicitHome: true, scenario: "read" },
    { explicitHome: true, scenario: "write" },
    { explicitHome: true, scenario: "failure" }
  ])("executes $scenario with scoped trust (explicit home: $explicitHome)", async ({ explicitHome, scenario }) => {
    const failTools = scenario === "failure";
    root = await realpath(await mkdtemp(join(tmpdir(), "estacoda-bench-runtime-")));
    const workspace = join(root, "workspace");
    const homeDir = join(root, "home");
    const outside = join(root, "outside");
    const outDir = join(root, "artifacts");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "input.txt"), "synthetic benchmark input\n");
    const originalTrust = new WorkspaceTrustStore({ homeDir });
    await originalTrust.grant(outside);
    const originalTrustBytes = await readFile(originalTrust.path, "utf8");
    const model: ModelProfile = {
      provider: "local", id: "benchmark-fixture", contextWindowTokens: 32000,
      supportsTools: true, supportsVision: false, supportsStructuredOutput: false
    };
    const registry = new ProviderRegistry();
    const complete = vi.fn(async () => {
      const iteration = complete.mock.calls.length;
      const writes = scenario === "write" && iteration === 1;
      const call = failTools || iteration <= (scenario === "write" ? 2 : 1);
      return {
        ok: true, provider: model.provider, model: model.id,
        content: call ? "" : scenario === "write" ? "Created and verified output.txt." : "The file contains synthetic benchmark input.",
        ...(call ? { raw: { output: [{
          type: "function_call", call_id: `fixture-${iteration}`, name: writes ? "file_write" : "file_read",
          arguments: JSON.stringify({ path: failTools ? "missing.txt" : scenario === "write" ? "output.txt" : "input.txt",
            ...(writes ? { content: "synthetic benchmark output\n" } : {}) })
        }] } } : {})
      };
    });
    registry.register({ id: model.provider, name: "Offline fixture", health: () => ({ available: true }), listModels: () => [model], complete });
    let trustPath: string | undefined;
    const result = await benchCommand(
      { argv: [], workspaceRoot: workspace, homeDir: join(root, "caller-home") },
      ["run", "--workspace", workspace, "--instruction", scenario === "write"
        ? "Write output.txt with synthetic benchmark output and verify its contents."
        : "Read input.txt and report its contents.", "--out", outDir,
        ...(explicitHome ? ["--home", homeDir] : []), "--timeout-ms", "10000", "--max-provider-iterations", "3"],
      {
        makeTempHome: async () => homeDir,
        loadConfig: async (options) => ({
          ...await loadRuntimeConfig(options), model,
          primaryModelRoute: { provider: model.provider, id: model.id, profile: model },
          providerRegistry: registry
        }),
        createRuntime: async (options) => {
          trustPath = options.trustStorePath;
          const store = new WorkspaceTrustStore({ path: trustPath });
          expect(await store.isTrusted(workspace)).toBe(true);
          expect(await store.isTrusted(outside)).toBe(false);
          const runtime = await createRuntime(options);
          const handle = runtime.handle.bind(runtime);
          runtime.handle = async (input) => {
            const response = await handle(input);
            // Open mode still enforces the hardline floor, even in a benchmark.
            const denied = await runtime.executeTool!({ tool: "terminal.run", toolInput: { command: "rm -rf /" } });
            expect(denied?.decision).toBe("deny");
            return response;
          };
          return runtime;
        },
        getPackageVersion: async () => "0.1.test", getGitCommit: async () => null, getGitBranch: async () => null
      }
    );
    expect(result.exitCode, result.output).toBe(failTools ? 1 : 0);
    if (!failTools) expect(complete).toHaveBeenCalledTimes(scenario === "write" ? 3 : 2);
    if (scenario === "write") expect(await readFile(join(workspace, "output.txt"), "utf8")).toBe("synthetic benchmark output\n");
    const events = (await readFile(join(outDir, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ kind: "tool-result", tool: "file.read", ok: !failTools }));
    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary.execution.status).toBe(failTools ? "task_failed" : "success");
    if (failTools) expect(summary.failure.code).toBe("budget_exhausted");
    expect(await readFile(originalTrust.path, "utf8")).toBe(originalTrustBytes);
    expect(await originalTrust.isTrusted(workspace)).toBe(false);
    await expect(readFile(trustPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(join(homeDir, ".estacoda"))).filter((name) => name.startsWith("benchmark-trust-"))).toEqual([]);
  });

  it.each(["startup", "execution", "timeout"])("removes run trust after %s failure", async (failure) => {
    root = await realpath(await mkdtemp(join(tmpdir(), "estacoda-bench-cleanup-")));
    const workspace = join(root, "workspace");
    const homeDir = join(root, "home");
    await mkdir(workspace);
    let trustPath: string | undefined;
    const result = await benchCommand(
      { argv: [], workspaceRoot: workspace },
      ["run", "--workspace", workspace, "--instruction", "Read input.txt", "--out", join(root, "out"), "--model", "local/fixture", "--timeout-ms", "10"],
      {
        makeTempHome: async () => homeDir,
        createRuntime: async (options) => {
          trustPath = options.trustStorePath;
          expect(await new WorkspaceTrustStore({ path: trustPath }).isTrusted(workspace)).toBe(true);
          if (failure === "startup") throw new Error("Startup failed");
          return {
            handle: async () => {
              if (failure === "execution") throw new Error("Execution failed");
              return new Promise(() => {});
            },
            dispose: async () => {}
          } as unknown as Awaited<ReturnType<typeof createRuntime>>;
        },
        getPackageVersion: async () => "0.1.test", getGitCommit: async () => null, getGitBranch: async () => null
      }
    );
    expect(result.exitCode).toBe(1);
    expect(trustPath).toBeDefined();
    await expect(readFile(trustPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await new WorkspaceTrustStore({ homeDir }).isTrusted(workspace)).toBe(false);
  });
});

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchCommand } from "../cli/bench-command.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import type { ModelProfile, ProviderRequest } from "../contracts/provider.js";
import { ProviderRegistry } from "../providers/provider-registry.js";

type Operation = { name: string; input: Record<string, unknown> };
const run = (command: string, verification: string): Operation => ({ name: "terminal_run", input: { command, verification, timeoutMs: 1000 } });

describe("completion recovery through the production runtime", () => {
  it.each(["topic-input", "excluded-file", "renamed-check", "crashed-check", "denied-check", "unrepaired-check"])("handles %s without weakening validation", async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "completion-recovery-")));
    try {
      const workspace = join(root, "work");
      const artifacts = join(root, "artifacts");
      await mkdir(workspace);
      await writeFile(join(workspace, "schema.json"), '{"enabled":true}\n');
      const output = scenario === "topic-input" ? "CONFIGURATION.md" : scenario === "excluded-file" ? "index.md" : "output.txt";
      const instruction = scenario === "topic-input" ? "Write CONFIGURATION.md documenting every key in schema.json. Preserve schema.json."
        : scenario === "excluded-file" ? "Write index.md listing the Markdown files, excluding index.md."
        : "Repair the local implementation and verify that it works.";
      const operations: Operation[] = [{ name: "file_write", input: { path: output, content: "ready\n" } }];
      if (scenario === "renamed-check") operations.push(run("estacoda_missing_interpreter_41983", "behavior-check"), run("test -s output.txt", "renamed-check"));
      if (["crashed-check", "unrepaired-check"].includes(scenario)) operations.push(run("exit 139", "behavior-check"), { name: "file_read", input: { path: output } });
      if (scenario === "denied-check") operations.push(run('python3 -c "exec(\'print(1)\')"', "behavior-check"), run("test -s output.txt", "behavior-check"));
      const model: ModelProfile = { provider: "local", id: "completion-fixture", contextWindowTokens: 32000, supportsTools: true, supportsVision: false, supportsStructuredOutput: false };
      const registry = new ProviderRegistry();
      const feedback: string[] = [];
      let calls = 0;
      let repaired = false;
      registry.register({ id: model.provider, name: "Offline completion fixture", health: () => ({ available: true }), listModels: () => [model],
        complete: async (request: ProviderRequest) => {
          calls++;
          const context = JSON.stringify(request.messages);
          let operation = operations[calls - 1];
          if (calls > operations.length && context.includes("Declared checks remain unresolved:")) {
            feedback.push(context);
            if (!repaired && scenario !== "unrepaired-check") {
              expect(context).toContain("behavior-check");
              operation = run("test -s output.txt", "behavior-check");
              repaired = true;
            }
          }
          return { ok: true, provider: model.provider, model: model.id, content: operation ? "" : "The requested work is complete.",
            ...(operation ? { raw: { output: [{ type: "function_call", call_id: `operation-${calls}`, name: operation.name, arguments: JSON.stringify(operation.input) }] } } : {}) };
        }
      });
      const result = await benchCommand({ argv: [], workspaceRoot: workspace, homeDir: join(root, "caller") },
        ["run", "--workspace", workspace, "--instruction", instruction, "--out", artifacts, "--home", join(root, "home"), "--timeout-ms", "15000", "--max-provider-iterations", "12"],
        { loadConfig: async options => ({ ...await loadRuntimeConfig(options), model,
          primaryModelRoute: { provider: model.provider, id: model.id, profile: model }, providerRegistry: registry }),
        getPackageVersion: async () => "0.1.test", getGitCommit: async () => null, getGitBranch: async () => null });
      expect(result.exitCode, result.output).toBe(scenario === "unrepaired-check" ? 1 : 0);
      expect(await readFile(join(workspace, output), "utf8")).toBe("ready\n");
      expect(await readFile(join(workspace, "schema.json"), "utf8")).toBe('{"enabled":true}\n');
      if (["renamed-check", "crashed-check"].includes(scenario)) expect(repaired).toBe(true);
      if (scenario === "unrepaired-check") {
        expect(feedback.length).toBeGreaterThan(0);
        expect(calls).toBeLessThanOrEqual(operations.length + 3); // Existing two-repair ceiling.
        const finalOutput = await readFile(join(artifacts, "stdout.txt"), "utf8");
        expect(finalOutput).toContain("Required validation remains incomplete: behavior-check");
        expect(finalOutput).not.toContain("The requested work is complete.");
      }
      const events = (await readFile(join(artifacts, "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      if (scenario === "denied-check") {
        expect(events.some(e => e.kind === "tool-result" && e.tool === "terminal.run" && e.decision === "deny")).toBe(true);
        expect(events.some(e => e.kind === "tool-result" && e.commandOutcome?.exitCode === 0)).toBe(true);
        expect(repaired).toBe(false); // Authorized recovery happened before the first completion attempt.
      }
      if (["crashed-check", "unrepaired-check"].includes(scenario)) expect(events.some(e => e.commandOutcome?.exitCode === 139)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
});

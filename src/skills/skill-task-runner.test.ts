import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runSkillTaskSuite, parseSkillTaskSuite } from "./skill-task-runner.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";

const suite = { version: 1, id: "extract", cases: ["a", "b"].map(id => ({ id, instruction: "Extract the count.", input: "Count: 2", expected: { count: 2 } })) };
it("executes both definitions on each fixture, keeps answers out of prompts, and fails ties or unexecuted answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "paired-skills-"));
  const complete = vi.fn(async (request) => ({ ok: true, toolCalls: [], response: { content: request.messages[0].content.includes("improved") ? '{"count":2}' : '{"count":1}' } }));
  const route = { provider: "test", id: "model" } as ResolvedModelRoute;
  try {
    const result = await runSkillTaskSuite({ baseline: "old", candidate: "improved", suite, executor: { complete } as never, route, artifactRoot: root });
    expect(result.passed).toBe(true);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(complete.mock.calls)).not.toContain('"expected"');
    expect(result.report.cases.map(test => [test.baseline.score, test.candidate.score])).toEqual([[0, 1], [0, 1]]);
    expect(JSON.parse(await readFile(join(result.directory, "report.json"), "utf8"))).toEqual(result.report);
    complete.mockImplementation(async () => ({ ok: true, toolCalls: [], response: { content: '{"count":2}' } }));
    expect((await runSkillTaskSuite({ baseline: "old", candidate: "improved", suite, executor: { complete } as never, route, artifactRoot: root })).passed).toBe(false);
    complete.mockImplementation(async () => ({ ok: false, toolCalls: [], response: { content: '{"count":2}' } }));
    expect((await runSkillTaskSuite({ baseline: "old", candidate: "improved", suite, executor: { complete } as never, route, artifactRoot: root })).passed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects oversized, duplicate and missing fixtures before provider calls", () => {
  expect(() => parseSkillTaskSuite({ ...suite, cases: [suite.cases[0]] })).toThrow();
  expect(() => parseSkillTaskSuite({ ...suite, cases: [suite.cases[0], suite.cases[0]] })).toThrow();
  expect(() => parseSkillTaskSuite({ ...suite, cases: suite.cases.map(test => ({ ...test, input: "x".repeat(48_001) })) })).toThrow();
});

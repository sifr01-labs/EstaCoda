import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Task, TaskStep, TaskResult } from "../contracts/task.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TaskStore } from "./task-store.js";
import { groundResearchResult } from "./research-result-evidence.js";
import { readTaskResultEvidence } from "./task-result-read-evidence.js";

const url = "https://example.org/study";
const claim = `| Source URL | Supported claim | Limitation |\n| --- | --- | --- |\n| ${url} | Reported result | Small synthetic sample |`;
const now = new Date("2026-09-24T12:00:00Z");
const task = { id: "task" } as Task;
const contract = { version: 1 as const, objective: "Fresh research", requirements: { skillReferences: [], issues: [], research: { fresh: true, domain: "general" as const } } };
const worker = { id: "worker", status: "completed", dependsOn: [], executor: { kind: "agent", role: "worker", research: { scope: "methods", requireLiveSources: true, requireRepositoryEvidence: false }, requestContract: contract } } as unknown as TaskStep;
const store = { listResults: () => [], getStep: () => worker } as unknown as TaskStore;
function execution(name: string, metadata: Record<string, unknown>, content = "", decision: ToolExecutionRecord["decision"] = "allow"): ToolExecutionRecord {
  return { tool: { name }, decision, result: { ok: true, content, metadata } } as ToolExecutionRecord;
}
function page(content: string, metadata: Record<string, unknown> = {}) {
  return execution("task.result.read", { taskId: "task", resultId: "result", disposition: "accepted", offset: 0, totalChars: Array.from(content).length,
    contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`, hasMore: false, primary: true, ...metadata }, content);
}
function ground(text = claim, executions = [execution("web.search", { results: [{ url, snippet: "Published: 2025-06-10. A result." }] })]) {
  return groundResearchResult({ task, step: worker, store, text, executions, now });
}

describe("research result evidence", () => {
  it("preserves original retrieval dates for reused extracts across midnight", () => {
    const reused = { ...execution("web.extract", { url, content: "Observation", retrievedAt: "2026-09-23T23:59:59.000Z" }), readReuseOf: "original" };
    expect(ground(claim, [reused]).text).toContain("2026-09-23 | extracted");
    delete reused.result!.metadata!.retrievedAt;
    expect(ground(claim, [reused]).text).toContain("unknown | extracted");
  });
  it("adds retrieval facts, observed dates and conservative access status without trusting provider columns", () => {
    const result = ground();
    expect(result.text).toContain("Source access: search summaries only");
    expect(result.text).toContain("not scientific accuracy");
    expect(result.text).toContain("2025-06-10 | 2026-09-24 | snippet; full text unavailable");
    const forged = result.text!.replace("2025-06-10", "2099-01-01").replace("snippet; full text unavailable", "full-text");
    expect(ground(forged).text).toBe(result.text);
    expect(ground(claim, [execution("web.extract", { url, content: "An abstract with no publication date" })]).text).toContain("unknown | 2026-09-24 | extracted; full text unverified");
  });
  it.each(["missing", "unobserved", "denied", "oversized", "empty-limitation"])("rejects %s evidence", (kind) => {
    const text = kind === "missing" ? `Source ${url}` : kind === "unobserved" ? claim.replace(url, "https://example.org/invented")
      : kind === "oversized" ? claim.replace("Reported result", "x".repeat(601)) : kind === "empty-limitation" ? claim.replace("Small synthetic sample", "") : claim;
    const calls = kind === "denied" ? [execution("web.search", { results: [{ url }] }, "", "deny")] : undefined;
    expect(ground(text, calls).failure).toBeDefined();
  });
  it.each(["`", "``", "", "<"])("parses observed URLs inside Markdown (%s)", delimiter => {
    const end = delimiter === "<" ? ">" : delimiter;
    expect(ground(`${claim}\nObserved source: ${delimiter}${url}${end}.`).failure).toBeUndefined();
    const rejected = ground(`${claim}\nRemoved unsupported citation: ${delimiter}https://invented.example/${end}.`);
    expect(rejected.failure).toBe("unobserved-source");
    expect(rejected.feedback).not.toContain("%60");
    expect(rejected.feedback).toContain("do not repeat rejected URLs");
  });
  it("does not turn a failed retrieval into a source observation", () => {
    const failed = { ...execution("web.extract", { url: "https://failed.example/", status: 403 }), result: { ok: false, content: "Blocked", metadata: { url: "https://failed.example/", status: 403 } } };
    expect(ground(`${claim}\nClaim from https://failed.example/`, [execution("web.search", { results: [{ url }] }), failed]).failure).toBe("unobserved-source");
  });
  it("requires complete accepted dependency reads and preserves missing scope accounting", () => {
    const content = ground().text!;
    const read = page(content);
    const result = { id: "result", stepId: "worker", status: "available", disposition: "accepted", contentHash: read.result!.metadata!.contentHash } as TaskResult;
    const failed = { ...worker, id: "failed", status: "failed", executor: { ...worker.executor, research: { ...worker.executor.research!, scope: "missing materials" } } } as TaskStep;
    const sourceStore = { listResults: () => [result], getStep: (id: string) => id === "worker" ? worker : failed } as unknown as TaskStore;
    const synthesis = { ...worker, id: "synthesis", dependsOn: ["worker", "failed"], executor: { ...worker.executor, role: "synthesis" } } as TaskStep;
    const input = { task, step: synthesis, store: sourceStore, text: claim, executions: [read], now };
    const settled = groundResearchResult(input);
    expect(settled.text).toContain("Research coverage is partial. Missing or failed scopes: missing materials");
    expect(settled.text).toContain("Unknown publication dates do not establish recency");
    expect(groundResearchResult({ ...input, executions: [] }).failure).toBe("unread-worker-results");
    expect(groundResearchResult({ ...input, text: claim.replace("Small synthetic sample", "No limitations") }).failure).toBe("changed-source-claim");
    expect(groundResearchResult({ ...input, executions: [page(content, { disposition: "diagnostic" })] }).failure).toBeDefined();
  });
});

describe("complete Task result read evidence", () => {
  it("reassembles Unicode pages and rejects missing, altered, diagnostic and foreign pages", () => {
    const content = "First 😀 then العربية";
    const split = 8;
    const chars = Array.from(content);
    const first = page(content); first.result!.content = chars.slice(0, split).join(""); first.result!.metadata!.hasMore = true;
    const last = page(content, { offset: split }); last.result!.content = chars.slice(split).join("");
    expect(readTaskResultEvidence([first, last], "task")[0]?.content).toBe(content);
    expect(readTaskResultEvidence([first], "task")).toEqual([]);
    expect(readTaskResultEvidence([last], "task")).toEqual([]);
    expect(readTaskResultEvidence([page(content, { disposition: "diagnostic" })], "task")).toEqual([]);
    expect(readTaskResultEvidence([page(content)], "foreign")).toEqual([]);
    const altered = page(content); altered.result!.content = "Different";
    expect(readTaskResultEvidence([altered], "task")).toEqual([]);
  });
});

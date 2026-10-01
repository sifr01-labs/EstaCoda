import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { taskResultContext } from "./task-result-context.js";
function read(body: string, offset = 0, extra: Record<string, unknown> = {}): ToolExecutionRecord {
  return { tool: { name: "task.result.read", description: "Read result", inputSchema: {}, riskClass: "read-only-local", toolsets: ["core"], progressLabel: "Reading", maxResultSizeChars: 22000 }, decision: "allow", riskClass: "read-only-local", result: { ok: true, content: body,
    metadata: { taskId: "task", resultId: "result", contentHash: "hash", offset, totalChars: 40_000, hasMore: true, nextOffset: offset + Array.from(body).length, disposition: "accepted", ...extra } } };
}
describe("task result prompt context", () => {
  it("retains complete Unicode pages and pagination metadata once across rereads", () => {
    const first = read("أ😀".repeat(7000));
    const second = read("SECOND-PAGE-END", 14000, { hasMore: false, nextOffset: undefined });
    const context = taskResultContext([first, second, first], 128000)!;
    expect(context.truncated).toBe(false);
    expect(context.content).toContain(first.result!.content);
    expect(context.content).toContain('"nextOffset":14000');
    expect(context.content.match(/SECOND-PAGE-END/g)).toHaveLength(1);
    expect(context.content.match(/<task-result-data>/g)).toHaveLength(2);
  });
  it("never publishes denied, failed or unrelated tool bodies", () => {
    const denied = { ...read("secret"), decision: "deny" } as ToolExecutionRecord;
    const failed = read("failed"); failed.result!.ok = false;
    const other = read("unrelated"); other.tool = { ...other.tool, name: "file.read" };
    expect(taskResultContext([denied, failed, other], 128000)).toBeUndefined();
  });
  it("marks omitted pages explicitly rather than silently clipping them", () => {
    const context = taskResultContext([read("unique payload ".repeat(2000))], 8000)!;
    expect(context.truncated).toBe(true);
    expect(context.content).toContain("NOT delivered");
    expect(context.content).not.toContain("unique payload");
    expect(context.content).toContain('"offset":0');
  });
  it("discards stale versions, distinguishes Tasks, and redacts credentials", () => {
    const context = taskResultContext([read("old"), read("password: hunter2", 0, { contentHash: "new" }), read("other task", 0, { taskId: "other" })], 128000)!;
    expect(context.content).not.toContain("hunter2");
    expect(context.content).not.toContain('"contentHash":"hash","offset":0,"totalChars":40000,"nextOffset":3');
    expect(context.content).toContain("other task");
    expect(context.content).toContain("[REDACTED]");
  });
});

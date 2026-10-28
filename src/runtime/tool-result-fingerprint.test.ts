import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { toolOperationFingerprint, toolResultFingerprint } from "./tool-result-fingerprint.js";

function call(command: string, content: string, pid = 10): ToolExecutionRecord {
  return { tool: { name: "terminal.run", description: "command", inputSchema: {}, riskClass: "workspace-write",
    toolsets: ["shell-write"], progressLabel: "command", maxResultSizeChars: 10000 },
    decision: "allow", riskClass: "workspace-write", input: { command, timeoutMs: pid },
    result: { ok: false, content: `Command failed: exit code 1, status failed.\n\nstarted pid ${pid}\n\n${content}`,
      metadata: { process: { cwd: "/workspace" } } } };
}
describe("tool observation identities", () => {
  it("ignores dispatch PID and deadline changes but preserves real diagnostic differences", () => {
    const a = call("check", "same failure", 10), b = call("check", "same failure", 20);
    expect(toolOperationFingerprint(a)).toBe(toolOperationFingerprint(b));
    expect(toolResultFingerprint(a)).toBe(toolResultFingerprint(b));
    expect(toolResultFingerprint(a)).not.toBe(toolResultFingerprint(call("check", "different failure")));
  });
  it("distinguishes long diagnostics beyond the old truncated failure prefix", () => {
    expect(toolResultFingerprint(call("check", "x".repeat(3000) + "A")))
      .not.toBe(toolResultFingerprint(call("check", "x".repeat(3000) + "B")));
  });
  it("keeps command and workspace identities separate", () => {
    expect(toolOperationFingerprint(call("check A", "error"))).not.toBe(toolOperationFingerprint(call("check B", "error")));
    const other = call("check A", "error"); other.input!.cwd = "/other";
    expect(toolOperationFingerprint(call("check A", "error"))).not.toBe(toolOperationFingerprint(other));
  });
  it("does not discard PID-shaped user output from tools without managed-process metadata", () => {
    const a = call("check", "data"); delete a.result!.metadata;
    const b = call("check", "data", 20); delete b.result!.metadata;
    expect(toolResultFingerprint(a)).not.toBe(toolResultFingerprint(b));
  });
});

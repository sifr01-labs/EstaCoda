import { describe, expect, it } from "vitest";
import type { Runtime } from "../runtime/create-runtime.js";
import { runOneShotPrompt } from "./one-shot.js";

describe("one-shot prompt", () => {
  it("uses shared tool display labels for provider calls and final tool summaries", async () => {
    const runtime = {
      tools: () => [],
      handle: async (input: {
        onEvent?: (event: { kind: "provider-tool-call"; provider: string; model: string; name: string }) => void;
      }) => {
        input.onEvent?.({
          kind: "provider-tool-call",
          provider: "test",
          model: "test-model",
          name: "terminal.run",
        });
        return {
          label: "assistant",
          text: "done",
          toolExecutions: [
            {
              tool: { name: "terminal.run" },
              decision: "allow",
              riskClass: "destructive-local",
            },
          ],
          progress: [],
        };
      },
    } as unknown as Runtime;

    const result = await runOneShotPrompt({ runtime, argv: ["hello"] });

    expect(result.output).toContain("provider requested Run Command");
    expect(result.output).toContain("tools: Run Command");
    expect(result.output).not.toContain("provider requested terminal.run");
    expect(result.output).not.toContain("tools: terminal.run");
  });

  it("prints bounded delegated child lifecycle lines", async () => {
    const runtime = {
      tools: () => [],
      handle: async (input: { onEvent?: (event: import("../contracts/runtime-event.js").RuntimeEvent) => void }) => {
        const metadata = {
          kind: "delegation-progress" as const,
          subagentId: "child-secret",
          childSessionId: "child-session-secret",
          parentSessionId: "parent-secret",
          role: "leaf" as const,
          depth: 1,
          taskIndex: 0,
          batchId: "batch-secret",
        };
        input.onEvent?.({
          ...metadata,
          childEvent: { kind: "agent-start", sessionId: "child-session-secret" },
        });
        input.onEvent?.({
          ...metadata,
          childEvent: { kind: "tool-start", tool: "file.read" },
        });
        input.onEvent?.({
          ...metadata,
          childEvent: { kind: "delegation-result", status: "timeout" },
        });
        return {
          label: "assistant",
          text: "done",
          toolExecutions: [],
          progress: [],
        };
      },
    } as unknown as Runtime;

    const result = await runOneShotPrompt({ runtime, argv: ["delegate this"] });

    expect(result.output).toContain("subagent Leaf 1: started");
    expect(result.output).toContain("subagent Leaf 1: timed out");
    expect(result.output).not.toContain("Read File");
    expect(result.output).not.toContain("child-session-secret");
    expect(result.output).not.toContain("batch-secret");
    expect(result.output.split("\n").filter((line) => line.includes("subagent Leaf 1"))).toEqual([
      "subagent Leaf 1: started",
      "subagent Leaf 1: timed out",
    ]);
  });
});

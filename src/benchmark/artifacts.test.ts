import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { writeBenchmarkEventArtifact, writeBenchmarkEventLogArtifact, writeBenchmarkSummaryArtifact } from "./artifacts.js";
import { createBenchmarkRunSummary } from "./schema.js";

describe("benchmark artifact writers", () => {
  it("writes valid redacted summary JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-artifacts-"));
    const path = join(dir, "summary.json");
    const summary = createBenchmarkRunSummary({
      estacoda: { version: "0.1.0", gitCommit: null },
      execution: {
        status: "runtime_error",
        startedAt: "2026-07-05T00:00:00.000Z",
        endedAt: "2026-07-05T00:00:01.000Z",
        wallClockMs: 1_000,
        workspace: "/app",
        home: "/tmp/home",
        homeMode: "generated",
        policy: "container-benchmark",
        sessionId: null,
        trajectoryId: null
      },
      model: { provider: "openai", id: "gpt-5", settings: { temperature: 0, maxTokens: null } },
      finalAnswer: "OPENAI_API_KEY=super-secret-value",
      artifacts: { summary: path, eventLog: join(dir, "events.jsonl"), trajectory: null, stdout: null, stderr: null },
      failure: { status: "runtime_error", message: "Bearer abcdefghijklmnopqrstuvwxyz123456" }
    });

    await writeBenchmarkSummaryArtifact(path, summary);

    const parsed = JSON.parse(await readFile(path, "utf8")) as typeof summary;
    expect(parsed.finalAnswer).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(parsed.failure?.message).toBe("Bearer [REDACTED]");
  });

  it("writes valid event JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-events-"));
    const path = join(dir, "events.jsonl");
    const events: RuntimeEvent[] = [
      { kind: "agent-start", sessionId: "session-1", input: "token=abcdefghijklmnopqrstuvwxyz1234567890abcdef" },
      { kind: "agent-final", text: "done" }
    ];

    await writeBenchmarkEventLogArtifact(path, events);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!) as RuntimeEvent).toMatchObject({ kind: "agent-start", input: "token=[REDACTED]" });
    expect(JSON.parse(lines[1]!) as RuntimeEvent).toMatchObject({ kind: "agent-final", text: "done" });
  });

  it("appends one event per line for streaming use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-event-append-"));
    const path = join(dir, "events.jsonl");

    await writeBenchmarkEventArtifact(path, { kind: "tool-start", tool: "terminal.run" });
    await writeBenchmarkEventArtifact(path, { kind: "tool-result", tool: "terminal.run", ok: true });

    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });
});

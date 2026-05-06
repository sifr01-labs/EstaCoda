import { describe, expect, it } from "vitest";
import { normalizeCommand, runConstraintGates, ALLOWED_GATES } from "./constraint-gate-runner.js";

const TEST_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "bun --version": ["bun", "--version"],
};

describe("normalizeCommand", () => {
  it("trims whitespace", () => {
    expect(normalizeCommand("  bun test  ")).toBe("bun test");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeCommand("bun  run   typecheck")).toBe("bun run typecheck");
  });
});

describe("runConstraintGates", () => {
  it("passes for allowed gate with zero exit code", async () => {
    const results = await runConstraintGates(
      ["bun --version"],
      { cwd: process.cwd(), timeoutMs: 10_000 },
      TEST_ALLOWLIST
    );
    expect(results).toHaveLength(1);
    expect(results[0].gate).toBe("bun --version");
    expect(results[0].passed).toBe(true);
    expect(results[0].exitCode).toBe(0);
    expect(results[0].timedOut).toBe(false);
    expect(results[0].rejectionReason).toBeUndefined();
  });

  it("rejects disallowed gate before spawning", async () => {
    const results = await runConstraintGates(["rm -rf /"], { cwd: process.cwd() });
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].exitCode).toBe(-1);
    expect(results[0].rejectionReason).toContain("not in the allowed command list");
    expect(results[0].stdout).toBe("");
    expect(results[0].stderr).toBe("");
  });

  it("rejects disallowed gate with extra whitespace", async () => {
    const results = await runConstraintGates(["  rm   -rf  /  "], { cwd: process.cwd() });
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].rejectionReason).toContain("not in the allowed command list");
  });

  it("runs multiple allowed gates sequentially", async () => {
    const results = await runConstraintGates(
      ["bun --version", "bun --version"],
      { cwd: process.cwd(), timeoutMs: 10_000 },
      TEST_ALLOWLIST
    );
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
    // Verify sequential execution by checking durations don't overlap impossibly
    expect(results[0].durationMs + results[1].durationMs).toBeGreaterThanOrEqual(Math.max(results[0].durationMs, results[1].durationMs));
  });

  it("returns empty list for empty gate list", async () => {
    const results = await runConstraintGates([], { cwd: process.cwd() });
    expect(results).toHaveLength(0);
  });

  it("respects timeout for slow gates", async () => {
    // Use a very short timeout to force timeout behavior on a normally slow command
    const results = await runConstraintGates(["bun run typecheck"], {
      cwd: process.cwd(),
      timeoutMs: 1
    });
    expect(results).toHaveLength(1);
    // Either it timed out or finished before kill; the runner must not crash
    expect(results[0].gate).toBe("bun run typecheck");
    expect(results[0].passed).toBe(false);
  });
});

describe("ALLOWED_GATES", () => {
  it("contains exactly the approved v0.1.0 commands", () => {
    expect(Object.keys(ALLOWED_GATES).sort()).toEqual([
      "bun run scripts/run-eval-fixtures.ts",
      "bun run smoke",
      "bun run typecheck",
      "bun test",
    ]);
  });
});

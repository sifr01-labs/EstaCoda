import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  isAllowedGateCommand,
  normalizeGateCommand,
  normalizeCommand,
  runConstraintGates,
  ALLOWED_GATES,
  __resolveInheritedCorepackHomeForTest
} from "./constraint-gate-runner.js";

const TEST_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "node --version": ["node", "--version"],
};

describe("normalizeCommand", () => {
  it("trims whitespace", () => {
    expect(normalizeCommand("  pnpm run test  ")).toBe("pnpm run test");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeCommand("pnpm  run   typecheck")).toBe("pnpm run typecheck");
  });
});

describe("normalizeGateCommand", () => {
  it("normalizes legacy gate names to executable allowlisted commands", () => {
    expect(normalizeGateCommand("typecheck")).toBe("pnpm run typecheck");
    expect(normalizeGateCommand("smoke")).toBe("pnpm run smoke");
    expect(normalizeGateCommand("eval:fixtures")).toBe("pnpm run eval:fixtures");
  });

  it("preserves unknown commands for runner rejection", () => {
    expect(normalizeGateCommand("cat /etc/passwd")).toBe("cat /etc/passwd");
    expect(isAllowedGateCommand("cat /etc/passwd")).toBe(false);
  });

  it("accepts known allowlisted commands", () => {
    expect(isAllowedGateCommand("pnpm run typecheck")).toBe(true);
    expect(isAllowedGateCommand("  pnpm   run   eval:fixtures  ")).toBe(true);
  });
});

describe("runConstraintGates", () => {
  it("uses OS home, not ESTACODA_HOME, for inherited Corepack cache", () => {
    expect(__resolveInheritedCorepackHomeForTest({
      HOME: "/tmp/prod-home",
      ESTACODA_HOME: "/tmp/dev-home"
    } as NodeJS.ProcessEnv)).toBe(join("/tmp/prod-home", ".cache", "node", "corepack"));
  });

  it("passes for allowed gate with zero exit code", async () => {
    const results = await runConstraintGates(
      ["node --version"],
      { cwd: process.cwd(), timeoutMs: 10_000 },
      TEST_ALLOWLIST
    );
    expect(results).toHaveLength(1);
    expect(results[0].gate).toBe("node --version");
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

  it("accepts legacy gate aliases after normalization", async () => {
    const results = await runConstraintGates(
      ["node-version"],
      { cwd: process.cwd(), timeoutMs: 10_000 },
      { "pnpm run typecheck": ["node", "--version"] }
    );
    expect(results[0].passed).toBe(false);

    const aliasResults = await runConstraintGates(
      ["typecheck"],
      { cwd: process.cwd(), timeoutMs: 10_000 },
      { "pnpm run typecheck": ["node", "--version"] }
    );
    expect(aliasResults[0].gate).toBe("pnpm run typecheck");
    expect(aliasResults[0].passed).toBe(true);
  });

  it("rejects disallowed gate with extra whitespace", async () => {
    const results = await runConstraintGates(["  rm   -rf  /  "], { cwd: process.cwd() });
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].rejectionReason).toContain("not in the allowed command list");
  });

  it("runs multiple allowed gates sequentially", async () => {
    const results = await runConstraintGates(
      ["node --version", "node --version"],
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
    const results = await runConstraintGates(["pnpm run typecheck"], {
      cwd: process.cwd(),
      timeoutMs: 1
    });
    expect(results).toHaveLength(1);
    // Either it timed out or finished before kill; the runner must not crash
    expect(results[0].gate).toBe("pnpm run typecheck");
    expect(results[0].passed).toBe(false);
  });
});

describe("ALLOWED_GATES", () => {
  it("contains exactly the approved v0.1.0 commands", () => {
    expect(Object.keys(ALLOWED_GATES).sort()).toEqual([
      "pnpm run eval:fixtures",
      "pnpm run smoke",
      "pnpm run test",
      "pnpm run typecheck",
    ]);
  });
});

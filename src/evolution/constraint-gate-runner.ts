import { spawn } from "node:child_process";
import { join } from "node:path";

export type GateResult = {
  gate: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  rejectionReason?: string;
};

export const ALLOWED_GATES: Readonly<Record<string, readonly string[]>> = {
  "pnpm run typecheck": ["pnpm", "run", "typecheck"],
  "pnpm run test": ["pnpm", "run", "test"],
  "pnpm run smoke": ["pnpm", "run", "smoke"],
  "pnpm run eval:fixtures": ["pnpm", "run", "eval:fixtures"],
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const INHERITED_COREPACK_HOME = process.env.COREPACK_HOME ??
  (process.env.HOME === undefined ? undefined : join(process.env.HOME, ".cache", "node", "corepack"));

export function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export async function runConstraintGates(
  gates: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
  allowedGates: Readonly<Record<string, readonly string[]>> = ALLOWED_GATES
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const normalized = normalizeCommand(gate);
    const argv = allowedGates[normalized];
    if (argv === undefined) {
      results.push({
        gate: normalized,
        passed: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        rejectionReason: `Gate '${normalized}' is not in the allowed command list for v0.1.0`,
      });
      continue;
    }
    const result = await runSingleGate(normalized, argv, options);
    results.push(result);
  }
  return results;
}

function runSingleGate(
  gate: string,
  argv: readonly string[],
  options: { cwd?: string; timeoutMs?: number }
): Promise<GateResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: INHERITED_COREPACK_HOME === undefined
        ? process.env
        : { ...process.env, COREPACK_HOME: process.env.COREPACK_HOME ?? INHERITED_COREPACK_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // Force kill after grace period
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        gate,
        passed: false,
        exitCode: -1,
        stdout,
        stderr: stderr || String(error),
        durationMs: Date.now() - start,
        timedOut: false,
        rejectionReason: `Spawn error: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const timedOut = killed;
      const passed = !timedOut && code === 0;
      resolve({
        gate,
        passed,
        exitCode: code ?? -1,
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 50_000),
        durationMs,
        timedOut,
      });
    });
  });
}

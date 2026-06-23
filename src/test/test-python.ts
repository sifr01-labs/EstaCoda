import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const PYTHON_PROBE_MARKER = "ESTACODA_TEST_PYTHON_OK";
const PYTHON_PROBE_CODE = `import sys; print(${JSON.stringify(PYTHON_PROBE_MARKER)}); print(sys.executable)`;
const DIAGNOSTIC_EXCERPT_LIMIT = 240;

let cachedPythonBinary: string | undefined;

export async function resolveTestPythonBinary(): Promise<string> {
  if (cachedPythonBinary !== undefined) {
    return cachedPythonBinary;
  }

  const codexRuntimeHome = process.env.CODEX_SQLITE_HOME === undefined
    ? undefined
    : dirname(dirname(process.env.CODEX_SQLITE_HOME));
  const candidateHomes = [
    process.env.ESTACODA_TEST_ORIGINAL_HOME,
    resolveRealUserHome(),
    codexRuntimeHome,
    process.env.HOME,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const candidates = uniqueCandidates([
    process.env.ESTACODA_TEST_PYTHON_BINARY,
    ...candidateHomes.map((home) =>
      join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "bin", "python3")
    ),
    "python3",
  ]);

  cachedPythonBinary = await resolveUsableTestPythonBinary(candidates);
  return cachedPythonBinary;
}

export async function resolveUsableTestPythonBinary(
  candidates: readonly string[],
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<string> {
  const failures: PythonCandidateFailure[] = [];
  for (const candidate of candidates) {
    if (candidate !== "python3") {
      try {
        if (!existsSync(candidate)) {
          failures.push({ candidate, reason: "missing path" });
          continue;
        }
      } catch (error) {
        failures.push({ candidate, reason: `path check failed: ${errorMessage(error)}` });
        continue;
      }
    }

    const result = await probePythonCandidate(candidate, timeoutMs);
    if (result.ok) {
      return candidate;
    }
    failures.push({ candidate, reason: formatProbeFailure(result) });
  }

  const failureDetails = failures.length === 0
    ? "No candidates were provided."
    : failures.map((failure) => `- ${failure.candidate}: ${failure.reason}`).join("\n");
  throw new Error(
    `No usable Python interpreter found for tests. Tried: ${candidates.length === 0 ? "(none)" : candidates.join(", ")}\n${failureDetails}`
  );
}

export function resetTestPythonBinaryCache(): void {
  cachedPythonBinary = undefined;
}

function uniqueCandidates(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function resolveRealUserHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

type PythonCandidateFailure = {
  readonly candidate: string;
  readonly reason: string;
};

type PythonProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "spawn error" | "timeout" | "non-zero exit" | "probe output invalid";
      readonly error?: string;
      readonly exitCode?: number | null;
      readonly stdout?: string;
      readonly stderr?: string;
    };

async function probePythonCandidate(candidate: string, timeoutMs: number): Promise<PythonProbeResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(candidate, ["-c", PYTHON_PROBE_CODE], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      finish({ ok: false, reason: "timeout", stdout, stderr });
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, reason: "spawn error", error: error.message, stdout, stderr }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: "non-zero exit", exitCode: code, stdout, stderr });
        return;
      }
      finish(isValidPythonProbeOutput(stdout)
        ? { ok: true }
        : { ok: false, reason: "probe output invalid", stdout, stderr });
    });

    function finish(result: PythonProbeResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}

function formatProbeFailure(result: Exclude<PythonProbeResult, { readonly ok: true }>): string {
  const parts: string[] = [result.reason];
  if (result.exitCode !== undefined) parts.push(`exit=${String(result.exitCode)}`);
  if (result.error !== undefined) parts.push(`error=${result.error}`);
  const stdout = excerpt(result.stdout);
  const stderr = excerpt(result.stderr);
  if (stdout.length > 0) parts.push(`stdout=${JSON.stringify(stdout)}`);
  if (stderr.length > 0) parts.push(`stderr=${JSON.stringify(stderr)}`);
  return parts.join("; ");
}

function excerpt(value: string | undefined): string {
  if (value === undefined) return "";
  const trimmed = value.trim();
  if (trimmed.length <= DIAGNOSTIC_EXCERPT_LIMIT) return trimmed;
  return `${trimmed.slice(0, DIAGNOSTIC_EXCERPT_LIMIT)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidPythonProbeOutput(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  const markerIndex = lines.indexOf(PYTHON_PROBE_MARKER);
  if (markerIndex < 0) {
    return false;
  }
  const executable = lines[markerIndex + 1];
  return typeof executable === "string" && executable.length > 0;
}

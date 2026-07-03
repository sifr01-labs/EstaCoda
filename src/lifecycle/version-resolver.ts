import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

export type VersionInfo = {
  current: string;
  latest: string;
  releaseNotesUrl: string;
  breakingChanges: boolean;
};

export type VersionResolverResult =
  | { ok: true; info: VersionInfo }
  | { ok: false; error: string };

export type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitCommandRunner = (args: readonly string[], options: { cwd: string }) => Promise<GitCommandResult>;

export type GitUpdateInfo = {
  current: string;
  latest: string;
  branch: string;
  remote: string;
  repoDir: string;
  commitsBehind?: number;
};

export type GitUpdateResolverResult =
  | { ok: true; kind: "up-to-date"; info: GitUpdateInfo }
  | { ok: true; kind: "available"; info: GitUpdateInfo }
  | { ok: false; error: string };

const GITHUB_API_LATEST = "https://api.github.com/repos/sifr01-labs/EstaCoda/releases/latest";

export async function getLocalVersion(options: {
  cwd?: string;
  packagePath?: string;
  gitRunner?: GitCommandRunner;
} = {}): Promise<string> {
  const modulePath = fileURLToPath(import.meta.url);
  const projectRoot = join(dirname(modulePath), "..", "..");

  try {
    const packagePath = options.packagePath ?? join(projectRoot, "package.json");
    const raw = await readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return await getGitVersionFallback({
      cwd: options.cwd ?? projectRoot,
      gitRunner: options.gitRunner
    }) ?? "0.0.0";
  }
}

export async function resolveLatestVersion(fetchFn?: typeof fetch): Promise<VersionResolverResult> {
  const current = await getLocalVersion();
  const fetchLike = fetchFn ?? globalThis.fetch;

  try {
    const response = await fetchLike(GITHUB_API_LATEST, {
      headers: { "User-Agent": "estacoda-version-resolver" }
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Release check failed: HTTP ${response.status}`
      };
    }

    const data = await response.json() as {
      tag_name?: string;
      html_url?: string;
      body?: string;
    };

    const latest = normalizeTagVersion(data.tag_name ?? "0.0.0");
    const breakingChanges = detectBreakingChanges(data.body ?? "");

    return {
      ok: true,
      info: {
        current,
        latest,
        releaseNotesUrl: data.html_url ?? GITHUB_API_LATEST,
        breakingChanges
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Release check failed: ${message}`
    };
  }
}

function normalizeTagVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

function detectBreakingChanges(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("breaking change") || lower.includes("breaking:");
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const maxLen = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < maxLen; i++) {
    const a = leftParts[i] ?? 0;
    const b = rightParts[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

export async function resolveGitUpdateInfo(options: {
  repoDir: string;
  branch: string;
  remote?: string;
  mutateRemoteRefs?: boolean;
  gitRunner?: GitCommandRunner;
}): Promise<GitUpdateResolverResult> {
  const repoDir = options.repoDir;
  const branch = options.branch;
  const remote = options.remote ?? "origin";
  const gitRunner = options.gitRunner ?? runGit;

  if (repoDir.length === 0 || branch.length === 0) {
    return { ok: false, error: "Git update check requires a repository directory and branch." };
  }

  const current = await gitRunner(["rev-parse", "HEAD"], { cwd: repoDir });
  if (current.exitCode !== 0) {
    return { ok: false, error: formatGitError("resolve current HEAD", current) };
  }

  let latestSha: string;
  let commitsBehind: number | undefined;

  if (options.mutateRemoteRefs === false) {
    const remoteRef = await gitRunner(["ls-remote", remote, `refs/heads/${branch}`], { cwd: repoDir });
    if (remoteRef.exitCode !== 0) {
      return { ok: false, error: formatGitError(`check ${remote}/${branch}`, remoteRef) };
    }
    latestSha = parseLsRemoteHead(remoteRef.stdout);
    if (!isLikelyGitObjectId(latestSha)) {
      return { ok: false, error: `Git update check failed: ${remote}/${branch} was not found.` };
    }
  } else {
    const fetchResult = await gitRunner(["fetch", "--quiet", "--no-tags", remote, branch], { cwd: repoDir });
    if (fetchResult.exitCode !== 0) {
      return { ok: false, error: formatGitError(`fetch ${remote}/${branch}`, fetchResult) };
    }

    const fetchHead = await gitRunner(["rev-parse", "FETCH_HEAD"], { cwd: repoDir });
    if (fetchHead.exitCode !== 0) {
      return { ok: false, error: formatGitError("resolve FETCH_HEAD", fetchHead) };
    }
    latestSha = fetchHead.stdout.trim();
    if (!isLikelyGitObjectId(latestSha)) {
      return { ok: false, error: "Git update check failed: FETCH_HEAD did not resolve to a commit." };
    }

    const behind = await gitRunner(["rev-list", "--count", "HEAD..FETCH_HEAD"], { cwd: repoDir });
    if (behind.exitCode === 0) {
      const parsed = Number.parseInt(behind.stdout.trim(), 10);
      if (Number.isFinite(parsed)) {
        commitsBehind = parsed;
      }
    }
  }

  const currentSha = current.stdout.trim();
  const info: GitUpdateInfo = {
    current: currentSha,
    latest: latestSha,
    branch,
    remote,
    repoDir,
    commitsBehind
  };

  if (currentSha === latestSha || commitsBehind === 0) {
    return { ok: true, kind: "up-to-date", info: { ...info, commitsBehind: 0 } };
  }

  return { ok: true, kind: "available", info };
}

async function getGitVersionFallback(options: {
  cwd: string;
  gitRunner?: GitCommandRunner;
}): Promise<string | undefined> {
  const gitRunner = options.gitRunner ?? runGit;
  const result = await gitRunner(["describe", "--tags", "--always", "--dirty"], { cwd: options.cwd });

  if (result.exitCode !== 0) {
    return undefined;
  }

  const version = result.stdout.trim();
  return version.length > 0 ? normalizeTagVersion(version) : undefined;
}

function parseLsRemoteHead(output: string): string {
  const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.split(/\s+/)[0] ?? "";
}

function isLikelyGitObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

function formatGitError(action: string, result: GitCommandResult): string {
  const detail = redactGitOutput(result.stderr.trim() || result.stdout.trim()) || `exit ${result.exitCode}`;
  return `Git update check failed during ${action}: ${detail}`;
}

function redactGitOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+@)/gi, "$1[redacted]@")
    .replace(/(git@[^:\s]+:)[^\s]+/gi, "$1[redacted]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s]+/g, "$1[redacted]")
    .slice(0, 500);
}

function runGit(args: readonly string[], options: { cwd: string }): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd: options.cwd }, (error, stdout, stderr) => {
      const exitCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
        ? error.code
        : error === null
          ? 0
          : 1;

      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

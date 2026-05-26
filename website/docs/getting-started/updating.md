---
title: Updating
description: Keep EstaCoda current without guessing.
sidebar_position: 5
---

# Updating

EstaCoda updates through the same channel that installed it. The update command detects how you installed the system, then either applies a guarded source update or tells you exactly which external command to run. It does not silently overwrite contributor worktrees, mutate package-manager installs, or restart services blindly.

## Why this exists

An agent system that cannot update itself safely becomes a liability. EstaCoda treats update as a stateful, method-routed operation with pre-flight checks, rollback capability, and install-method awareness. The goal is not speed. The goal is predictable recovery when something goes wrong.

## Update commands

| Command | Behavior | Exit code |
|---|---|---|
| `estacoda update --check` | Check only. Never modifies files. | `0` if update available, `2` if up-to-date, `1` on error |
| `estacoda update` | Default behavior depends on install method. See below. | `0` on success/routing, `1` on error, `3` on dirty worktree |
| `estacoda update --backup` | Accepted for explicitness. Default behavior already backs up user state before mutation. | Same as default |
| `estacoda update --no-backup` | Skip user-state backup. Not recommended. | Same as default |
| `estacoda update --gateway` | Non-interactive mode. Logs to `~/.estacoda/logs/update.log`. Restarts managed gateway service on success, or prints manual restart instruction. | Same as default |

`--dry-run` is accepted as an alias for `--check` on non-managed-source installs. On managed-source installs, `estacoda update` without flags performs the actual update.

## Install-method routing

EstaCoda detects your install method at runtime and routes update behavior accordingly.

| Method | `estacoda update` behavior |
|---|---|
| `managed-source` | Guarded source update: fetch origin, verify fast-forward safety, check worktree cleanliness, pull, install dependencies, build, validate. Rollback to pre-pull SHA on build failure. |
| `manual-source` | Check and advise only. Prints `git fetch origin && git status`. No self-mutation. |
| `homebrew` | Prints `brew upgrade kemetresearch/tap/estacoda`. No self-mutation. |
| `docker` | Prints `docker pull ghcr.io/kemetresearch/estacoda:latest`. No self-mutation. |
| `npm-global` | Prints `npm install -g estacoda@latest`. No self-mutation. |
| `pnpm-global` | Prints `pnpm add -g estacoda@latest`. No self-mutation. |
| `unknown` | Prints reinstall guidance. No self-mutation. |

Install method is determined by `.install-method.json` stamp detection, path heuristics, and container runtime probes. `managed-source` requires a valid stamp that matches the current repository origin, branch, and directory.

## Managed-source update flow

If you installed via `curl \| bash` or another managed installer, `estacoda update` performs the following sequence:

1. **Validate stamp** — `.install-method.json` must declare `managed-source` with matching `installDir`, `sourceUrl`, and branch.
2. **Verify repository integrity** — current directory must be a git repository whose origin and branch match the stamp.
3. **Check worktree** — refuses if uncommitted changes exist. Exit code `3`.
4. **Capture pre-pull SHA** — saved for potential rollback.
5. **Back up user state** — copies protected paths to `~/.estacoda/.backups/<label>/` unless `--no-backup` is passed.
6. **Fetch origin** — non-mutating remote ref check.
7. **Compute distance** — counts commits behind `origin/<branch>`.
8. **Fast-forward pull** — `git pull --ff-only origin <branch>`.
9. **Install dependencies** — `pnpm install --frozen-lockfile`.
10. **Build** — `pnpm run build`.
11. **Validate** — `node dist/index.js --version` and `--help` must succeed.
12. **Write cache** — marks `~/.estacoda/update-cache.json` as up-to-date.

If any step after the pull fails, the checkout is rolled back to the pre-pull SHA automatically.

## Startup update checks

EstaCoda checks for updates in the background during interactive sessions.

- **When**: after session init, only when no command-line arguments are provided and a TTY is available.
- **How**: non-blocking prefetch that does not delay your first prompt.
- **Cache**: `~/.estacoda/update-cache.json` with a 6-hour TTL.
- **Failure**: network errors fail silently. They do not interrupt your session.
- **Hint**: if the cached status says `update-available`, a hint is rendered during startup readiness. The hint includes the recommended update command for your install method.

For source installs (managed and manual), the prefetch uses git remote checks without mutating local refs. For release installs, it queries the GitHub releases API.

## Safety boundaries

- **No hard reset outside managed directories.** Only `managed-source` stamped directories may be reconciled.
- **Dirty worktree refusal.** Managed-source updates refuse to proceed if the worktree has uncommitted changes. Exit code `3`.
- **User state is preserved.** `~/.estacoda/profiles/`, `memory/`, `sessions.sqlite`, `trust.json`, and other protected paths are never destroyed by update.
- **Rollback on failure.** Build or validation failure after a pull triggers automatic rollback to the pre-pull SHA.
- **Gateway mode does not guess.** `--gateway` restarts only managed gateway services detected through the service-manager abstraction. If no managed service is found, it prints a manual restart instruction. It never restarts arbitrary user processes.

## State paths

| Path | Purpose |
|---|---|
| `~/.estacoda/update-cache.json` | Update check cache. Global, not profile-local. 6-hour TTL. |
| `~/.estacoda/logs/update.log` | Update operation log. Written during `--gateway` mode and managed-source updates. Credential-bearing output is redacted. |
| `~/.estacoda/.backups/<label>/` | User-state backup created before managed-source mutation. Contains copies of protected paths, not the source repository itself. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, routing message printed, or update available info shown. |
| `1` | Error: network failure, build failure, safety refusal, backup failure, or stamp mismatch. |
| `2` | Up-to-date. No action needed. |
| `3` | Dirty worktree. Commit, stash, or discard changes before retrying. |

## Artifact-only update path

The `ESTACODA_UPDATE_ARTIFACT` environment variable provides a deprecated artifact-only update path. It is reachable but not the recommended v0.1.0 update mechanism. Use `estacoda update` for managed-source installs or the package-manager command appropriate to your install method.

## Troubleshooting

**Update refused with exit code 3**
Your managed-source worktree has uncommitted changes. Commit, stash, or discard them, then retry.

**"Install method stamp does not match"**
The `.install-method.json` stamp disagrees with the current repository origin, branch, or root directory. This happens if you moved the repository or changed remotes after installation. Treat the checkout as manual-source and update with `git pull` directly.

**Build failed and rollback message appears**
The pull succeeded but `pnpm install` or `pnpm run build` failed. The repository was rolled back to the pre-pull SHA. Inspect the output, fix any local environment issues (Node version, pnpm availability), then retry.

**No startup update hint appears**
The background prefetch runs only in interactive sessions with no arguments. If you always run with arguments or in a non-TTY environment, the prefetch does not fire. Run `estacoda update --check` manually.

**Gateway service not restarted after `--gateway` update**
The gateway restart only attempts managed services registered through `estacoda gateway install-service`. If you run the gateway manually, restart it with `estacoda gateway restart`.

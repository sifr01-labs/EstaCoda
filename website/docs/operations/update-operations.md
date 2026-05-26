---
title: Update Operations
description: How the update engine behaves, fails, and recovers.
sidebar_position: 7
---

# Update Operations

This page is for operators and maintainers who need to understand how EstaCoda updates itself, where the boundaries are, and what to inspect when something fails. It is not a marketing page. If you are looking for the user-facing update guide, see [Updating](../getting-started/updating.md).

## What the update engine is

The update engine is a method-routed state machine. It detects how EstaCoda was installed, validates that the current environment matches the install stamp, and then either performs a guarded source mutation or declines and prints the correct external command. It does not guess. It does not mutate package-manager installs. It does not restart services unless it can prove they are managed.

## Managed-source update internals

Managed-source is the only install method that `estacoda update` is permitted to mutate in place. The full sequence is:

### 1. Stamp validation

The engine reads `.install-method.json` and verifies:

- `method` is `managed-source`
- `source` is `stamp` (not inferred from path)
- `installDir`, `sourceUrl`, and branch are present and non-empty

If any of these fail, the update is refused before touching the filesystem.

### 2. Repository integrity checks

- The stamped `installDir` must contain a `.git` directory.
- `git rev-parse --show-toplevel` must resolve to the stamped `installDir`.
- `git remote get-url origin` must normalize to the same canonical URL as the stamp (GitHub URLs are normalized to `github.com/<owner>/<repo>`).
- `git rev-parse --abbrev-ref HEAD` must match the expected branch.

Mismatch on any of these produces an error with the exact divergence printed.

### 3. Worktree gate

`git status --porcelain` is checked. If output is non-empty, the update refuses with exit code `3`:

```
Update refused: managed-source worktree has uncommitted changes.
Commit, stash, or discard local changes before running `estacoda update`.
Exit code: 3
```

Auto-stash is not implemented in v0.1.0.

### 4. Pre-pull SHA capture

`git rev-parse HEAD` is captured before any mutation. This SHA is the rollback target.

### 5. User-state backup

`backupState()` copies protected paths to `~/.estacoda/.backups/pre-source-update-<timestamp>/`:

- `active-profile.json`
- `profiles/`
- `trust.json`
- `workspace-approvals.json`
- `sessions.sqlite`
- `memory/`
- `packs/registry.jsonl`
- Project `config.json` (if workspace root is known)

If the backup creates zero files and `--no-backup` was not passed, the update aborts.

`--no-backup` skips this step. `--backup` is accepted but redundant because default behavior already backs up.

### 6. Fetch and distance check

`git fetch origin` runs, followed by `git rev-list --count HEAD..origin/<branch>`. If the count is zero or undefined, the update reports "Already up to date" and exits `0`.

### 7. Fast-forward pull

`git pull --ff-only origin <branch>` is the only permitted merge strategy. Non-fast-forward situations produce an error and trigger rollback.

### 8. Dependency install and build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

Failure here triggers rollback.

### 9. Post-update validation

```bash
node dist/index.js --version
node dist/index.js --help
```

Both must exit `0`. Failure triggers rollback.

### 10. Cache write

`~/.estacoda/update-cache.json` is written with `versionStatus: "up-to-date"`.

## Rollback and recovery

If any mutation-phase step fails (pull, install, build, validation), the engine executes `git reset --hard <prePullSha>` to restore the repository to its pre-update state.

The rollback result is included in the error output:

- If rollback succeeds: "Rolled back managed-source checkout to `<sha>`.
- If rollback fails: "Rollback failed: ..." plus a manual recovery instruction.

User-state backups are preserved regardless of rollback success. They are not automatically restored; you must copy them back manually if needed.

## Manual-source behavior

Manual-source installs are stamped `.install-method.json` with `method: manual-source`. The update engine treats these as contributor-owned.

- `estacoda update --check`: reports commits behind `origin/<branch>` if reachable.
- `estacoda update`: prints routing advice and exits `0`. No files are modified.
- `estacoda update --apply`: not supported. Returns exit `1` with routing message.

The engine never runs `git pull`, `pnpm install`, or build in a manual-source directory.

## Package-manager and container routing

For installs that are not self-updating, `estacoda update` prints the recommended external command and exits `0`:

| Method | Command |
|---|---|
| Homebrew | `brew upgrade kemetresearch/tap/estacoda` |
| Docker | `docker pull ghcr.io/kemetresearch/estacoda:latest` |
| npm global | `npm install -g estacoda@latest` |
| pnpm global | `pnpm add -g estacoda@latest` |

These installs are detected by path heuristics and container runtime probes, not by stamp files.

## Gateway update mode

`--gateway` is designed for unattended updates of managed gateway deployments.

Behavior:

- Non-interactive. No prompts.
- Update progress is logged to `~/.estacoda/logs/update.log` through the resilience layer.
- Stdout and stderr are guarded against broken pipes.
- SIGHUP is caught and logged; the update continues where possible.
- On success, the engine attempts to restart the managed gateway service through the service-manager abstraction.
- If no managed gateway service is detected, it prints:
  ```
  Gateway restart: no managed gateway service was detected.
  Restart the gateway manually with: estacoda gateway restart
  ```
- If the restart command fails, it prints the failure reason and the manual restart command, including `--system` if the detected service is system-scoped.

Gateway mode never restarts arbitrary user processes. It only touches services installed via `estacoda gateway install-service`.

## Update resilience and logging

Managed-source updates are wrapped in `runManagedSourceUpdateWithResilience()`, which provides:

- **SIGHUP handling**: catches terminal session hangs and logs them.
- **Broken-pipe guarding**: stdout/stderr write failures are logged without crashing the update.
- **Credential redaction**: URLs with embedded auth tokens, Bearer headers, and common secret patterns are redacted from logs.
- **Log path**: `~/.estacoda/logs/update.log`.

Log entries are timestamped ISO-8601 lines prefixed with the update phase.

## Startup prefetch

`scheduleStartupUpdatePrefetch()` is called from the main entry point when:

- `argv.length === 0` (no subcommand)
- `canRunInteractive()` returns true

It schedules `prefetchStartupUpdateStatus()` on the next event loop tick. The prefetch:

1. Reads the cache. If it is not stale, returns immediately.
2. Detects the install method.
3. For managed-source and manual-source: runs a non-mutating git remote check.
4. For other methods: queries the GitHub releases API.
5. Writes the cache with `versionStatus` and a hint string.

All errors are caught and swallowed. The prefetch must never delay or crash an interactive session.

## Validation

The repo includes validation scripts for install and update behavior:

| Script | Scope |
|---|---|
| `pnpm run validate:install` | Full install matrix (temp directories, no real `~/.estacoda` mutation) |
| `pnpm run validate:source-install` | Source installer focus |
| `pnpm run validate:uninstall` | Uninstall behavior focus |
| `pnpm run validate:docker` | Docker image build and run |
| `pnpm run validate:homebrew` | Formula syntax check |
| `pnpm run verify:package-bin` | npm pack contents validation |

These scripts use temporary home directories and prefixes. They do not write to your real `~/.estacoda`.

## What is intentionally unsupported in v0.1.0

- **Cross-branch updates.** `managed-source` updates stay on the stamped branch. Switching branches is manual.
- **Auto-stash.** Dirty worktrees are refused, not automatically stashed.
- **Binary artifact updates.** The `ESTACODA_UPDATE_ARTIFACT` path exists in code but is not the public v0.1.0 update mechanism.
- **Non-fast-forward reconciliation.** Only `git pull --ff-only` is permitted.
- **Skill sync on update.** The update engine prints "Bundled skill sync: no-op for v0.1.0." Skill synchronization after update is not implemented.

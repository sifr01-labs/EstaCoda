---
title: Troubleshooting
description: Common problems, causes, and repairs.
sidebar_position: 8
---

# Troubleshooting

This page is for operators who need to fix something without guessing. Each entry gives a symptom, a likely cause, and a concrete repair step.

## Wrong active profile

**Symptom:** Commands behave as if settings or credentials are missing, but they exist in a different profile.

**Likely cause:** The active profile is not the one you are editing.

**Inspect:**

```bash
cat ~/.estacoda/active-profile.json
estacoda profiles list
```

**Repair:**

```bash
estacoda profile switch work
# or use --profile for a single command
estacoda gateway status --profile work
```

## Missing provider key

**Symptom:** Provider setup needed error, or model route reports missing credentials.

**Likely cause:** The env var referenced by `apiKeyEnv` is absent from the selected profile `.env` or the process environment.

**Inspect:**

```bash
estacoda config show
# Check whether the referenced env var is present
grep VOICE_TOOLS_OPENAI_KEY ~/.estacoda/profiles/<id>/.env
```

**Repair:**

```bash
estacoda model setup --provider openai --api-key <key>
# or edit ~/.estacoda/profiles/<id>/.env directly
```

## Provider route unavailable

**Symptom:** Model responds with unavailable or the route is skipped silently.

**Likely cause:** Catalog-only provider selected, missing credentials, or provider endpoint unreachable.

**Inspect:**

```bash
estacoda model status
estacoda gateway diagnose
```

**Repair:**

- Switch to a live-proven provider.
- Verify credentials.
- Check network connectivity.

## Browser not configured

**Symptom:** Browser tool returns not configured or backend unavailable.

**Likely cause:** `browser.backend` is unset or set to a cloud provider that is not live-implemented.

**Inspect:**

```bash
estacoda config show | grep -A 5 browser
```

**Repair:**

Set `browser.backend` to `local-cdp` in profile config. Cloud browser providers are registered but cannot create live sessions in v0.1.0.

## Gateway channel not ready

**Symptom:** `estacoda gateway diagnose` reports warnings for a channel.

**Likely cause:** Missing token env var, missing allowlist, or adapter disabled.

**Inspect:**

```bash
estacoda gateway diagnose
estacoda channels status telegram
```

**Repair:**

```bash
estacoda channels enable telegram
# Verify token env var is present in profile .env
# Verify allowedUserIds or allowedSenders are configured
```

## Telegram token or env var missing

**Symptom:** Telegram adapter fails to start with missing token error.

**Likely cause:** `ESTACODA_TELEGRAM_TOKEN` (or the env named in `botTokenEnv`) is absent.

**Inspect:**

```bash
grep ESTACODA_TELEGRAM_TOKEN ~/.estacoda/profiles/<id>/.env
echo $ESTACODA_TELEGRAM_TOKEN
```

**Repair:**

Add the token to the selected profile `.env` and restart the gateway.

## Workspace trust or approval required

**Symptom:** Command is blocked with a trust or approval message.

**Likely cause:** The workspace is not trusted, or the tool call requires explicit approval.

**Inspect:**

```bash
estacoda workspace trust status
estacoda gateway approvals
```

**Repair:**

```bash
estacoda workspace trust
# or approve the pending approval
estacoda gateway approvals approve <id>
```

## Command denied by hard safety block

**Symptom:** Tool call is rejected with a hard-block message. No approval button is offered.

**Likely cause:** The command matches a hardline safety pattern (destructive disk operation, secret read, fork bomb, etc.).

**Inspect:**

Review the command against the hardline floor. Hard blocks cannot be overridden by approval, `/yolo`, or open mode.

**Repair:**

Rephrase or decompose the command so it does not match a hardline pattern. If the block is a false positive, report it with the exact command and context.

## Memory write rejected

**Symptom:** `memory.curate` returns a scanner or safety rejection.

**Likely cause:** The content matches secret-looking patterns, prompt-injection markers, or invisible control characters.

**Inspect:**

Check the content for API-key-like strings or unusual Unicode.

**Repair:**

Remove the suspicious content and retry. Scanner/safety rejection prevents secrets from being promoted into memory.

## Skill not selected or hidden

**Symptom:** The agent does not use a skill you expect.

**Likely cause:** The skill is archived, stale, missing a required toolset, or filtered by platform restrictions.

**Inspect:**

```bash
estacoda skills list
```

**Repair:**

- Refresh the session with `/reset` or start a new session.
- Verify the skill has the required toolsets available.
- Check whether the skill is archived or stale.

## Session missing, stale, or profile-scoped away

**Symptom:** Previous session context is not visible.

**Likely cause:** Sessions are profile-scoped. A session created in profile `default` does not appear in profile `work`.

**Inspect:**

```bash
estacoda sessions list --profile default
estacoda sessions list --profile work
```

**Repair:**

Switch to the profile that owns the session, or attach the surface to the correct session.

## Update says install is manual-source

**Symptom:** `estacoda update` prints `git fetch origin && git status` instead of applying an update.

**Likely cause:** The `.install-method.json` stamp is missing, invalid, or mismatched. EstaCoda treats the checkout as contributor-owned.

**Inspect:**

```bash
cat .install-method.json 2>/dev/null || echo "No stamp found"
git remote get-url origin
git rev-parse --abbrev-ref HEAD
```

**Repair:**

If you installed via `curl | bash` and the stamp is missing, the checkout may have been moved or the stamp deleted. Update manually with `git pull` or reinstall via the installer.

## Update refuses dirty worktree

**Symptom:** `estacoda update` exits with code 3 and reports uncommitted changes.

**Likely cause:** The managed-source worktree has local modifications.

**Inspect:**

```bash
git status --short
```

**Repair:**

Commit, stash, or discard changes, then retry. Auto-stash is not implemented in v0.1.0.

## Update rollback occurred

**Symptom:** `estacoda update` reports failure during build or validation, then "Rolled back managed-source checkout to `<sha>`".

**Likely cause:** `pnpm install` or `pnpm run build` failed after the pull.

**Inspect:**

```bash
git log --oneline -3
node --version
which pnpm
```

**Repair:**

Fix the local environment issue (Node version, pnpm availability), then retry `estacoda update`.

## Startup update hint looks stale

**Symptom:** A startup hint says an update is available, but `estacoda update --check` reports up-to-date.

**Likely cause:** The `~/.estacoda/update-cache.json` TTL is 6 hours. If you updated through another means (e.g., `git pull` directly), the cache may be stale.

**Repair:**

The cache will refresh on the next successful update check. Ignore the hint or run `estacoda update --check` to refresh it.

## Gateway update did not restart service

**Symptom:** `estacoda update --gateway` succeeded but the gateway is still running the old version.

**Likely cause:** No managed gateway service was detected. `--gateway` only restarts services installed via `estacoda gateway install-service`.

**Repair:**

Restart the gateway manually: `estacoda gateway restart`.

## Uninstall refuses to delete install directory

**Symptom:** `estacoda uninstall` reports "managed-source stamp was not trusted" and preserves the install directory.

**Likely cause:** The `.install-method.json` stamp is missing, mismatched, or the `installDir` is not in the safe list (`estacoda`, `estacoda.git`, `estacoda-source`).

**Repair:**

Remove the directory manually if you are certain it is installer-owned. The safety gate exists to prevent accidental deletion of contributor checkouts.

## Purge refused

**Symptom:** `estacoda uninstall --purge` exits with code 1 and says "Re-run with --purge --yes".

**Likely cause:** `--purge` without `--yes` is rejected. Both flags are required for non-interactive confirmation.

**Repair:**

Run `estacoda uninstall --purge --yes` if you intend to remove `~/.estacoda`.

## Package-manager install routes to package-manager command

**Symptom:** `estacoda update` or `estacoda uninstall` prints an external command instead of acting directly.

**Likely cause:** EstaCoda detected a package-manager or container install. It does not self-mutate package-manager-managed installs.

**Repair:**

Run the printed command (`brew upgrade`, `docker pull`, `npm install -g`, etc.) or use the package manager's native uninstall path.

## Related docs

- [FAQ](./faq.md) — short operational answers
- [State and Files](./state-and-files.md) — file paths for inspection
- [Configuration](./configuration.md) — config validation

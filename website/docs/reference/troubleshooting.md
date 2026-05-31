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

## Local STT setup fails

**Symptom:** `estacoda voice setup --stt-provider local` fails while creating Python, installing `faster-whisper==1.2.1`, or verifying `import faster_whisper`.

**Likely cause:** System Python is missing, `python -m venv` is unavailable, the package install failed, or the managed venv at `~/.estacoda/python-env` is corrupted.

**Inspect:**

```bash
estacoda voice status
ls -la ~/.estacoda/python-env
ls -la ~/.estacoda/cache/huggingface
```

**Repair:**

```bash
estacoda voice setup --stt-provider local
# or use an operator-owned Python environment
estacoda voice setup --stt-provider local --python-binary /path/to/python
```

The managed venv is for pinned `faster-whisper==1.2.1` only. Do not use it for arbitrary packages. If you use `--python-binary`, EstaCoda skips managed env check/create and leaves that Python environment to you.

## Gateway local STT download denied

**Symptom:** Gateway voice transcription reports that faster-whisper model download is not allowed.

**Likely cause:** Local faster-whisper allows model downloads for normal local use by default, but gateway-triggered model downloads default to disabled.

**Inspect:**

```bash
estacoda config show
ls -la ~/.estacoda/cache/huggingface
```

**Repair:**

Pre-cache the model during local setup/use, or explicitly set `stt.local.fasterWhisper.gatewayAllowModelDownload: true` only when gateway-triggered model fetches are acceptable.

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

## Native tool history is not active

**Symptom:** A supported-looking tool session is replayed as flat text instead of native assistant/tool history.

**Likely cause:** One of the native replay gates failed, or there was no complete safe provider tool group to replay.

**Inspect:**

```bash
estacoda trace list --limit 5
estacoda trace dump <trajectory-id> --raw
```

Look for `structured-tool-history-skipped` and its coarse reason. Common reasons include provider unsupported, model tools unsupported, no native messages, malformed history, budget fallback, missing echo, oversized echo, or unsafe arguments.

**Repair:**

- Use a tested OpenAI-compatible Chat Completions route with tool support.
- Do not expect native replay on Responses or Anthropic routes; those paths remain fallback/deferred.
- If the turn is unsafe, fix the tool input or let the sanitized flat fallback carry the context.

## Echo-required replay fails closed

**Symptom:** DeepSeek or Kimi thinking-mode tool history falls back instead of serializing native tool calls.

**Likely cause:** The provider requires same-provider/API-mode `reasoning_content` echo, but the prior turn has missing, oversized, or mismatched `providerReplayEcho`.

**Inspect:**

Check count-only diagnostics for `missing_echo` or `echo_oversized`. Do not search logs for echo values; they should not be there.

**Repair:**

- Continue on the same provider family and Chat Completions API mode when native echo replay is required.
- If echo was not captured or was over cap, allow flat fallback or start a fresh tool turn.
- Do not add placeholder echo unless the provider path has explicit test coverage.

## Tool replay disabled by secret-bearing arguments

**Symptom:** A provider tool-call turn is present, but native replay is skipped with unsafe arguments.

**Likely cause:** A tool-call argument contained obvious credential material, so faithful arguments were not stored.

**Inspect:**

Look for `nativeReplaySafe: false` and `argumentsRedacted: true` on the provider tool-call turn. Diagnostics may count `unsafe_arguments`, but they should not contain the argument value.

**Repair:**

Remove the credential material from the requested tool arguments. Use secret references, configuration, or environment-backed credentials instead of putting secret values into prompts or tool-call arguments.

## Multi-call tool history fails closed

**Symptom:** A multi-call assistant turn does not serialize as native tool history.

**Likely cause:** At least one call was missing a valid matching tool result before the next non-tool message, or the group was malformed.

**Inspect:**

Compare `metadata.providerToolCalls[].id` on the provider tool-call turn with following tool result `metadata.tool_call_id` values.

**Repair:**

Treat the group as corrupted native history. Let flat fallback carry the context, or rerun the workflow so the provider tool-call turn and tool results are captured cleanly. Do not create synthetic tool results to patch the transcript.

## Native continuation appears to duplicate tool results

**Symptom:** A tool result appears once as a native `tool` message and again in the flat continuation instruction.

**Likely cause:** This should not happen for selected native tool groups. The continuation path excludes selected native tool-call IDs from the flat executed-results block.

**Inspect:**

Check whether the duplicate result belongs to a selected native group or to an older unselected group. Non-selected tool results may still appear in flat continuation text.

**Repair:**

If a selected native result is duplicated, treat it as a bug in prompt assembly and run:

```bash
pnpm exec vitest run src/prompt/prompt-assembly.test.ts
```

## Native replay diagnostics contain content

**Symptom:** A `structured-tool-history-*` event includes arguments, tool results, echo values, raw reasoning, provider payloads, message content, paths, hashes, request bodies, or content fingerprints.

**Likely cause:** A diagnostic event crossed the observability boundary and captured sensitive prompt material.

**Inspect:**

Use `estacoda trace dump <trajectory-id> --raw` and review only the diagnostic payload shape.

**Repair:**

Treat this as a security bug. Diagnostics must be counts and coarse reasons only.

## Related docs

- [FAQ](./faq.md) — short operational answers
- [State and Files](./state-and-files.md) — file paths for inspection
- [Configuration](./configuration.md) — config validation

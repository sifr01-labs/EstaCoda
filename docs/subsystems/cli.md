---
title: "CLI & Onboarding"
description: "CLI commands, interactive session loop, trace/eval inspection, and first-run onboarding."
---

# CLI & Onboarding

## Files

| File | Lines | Role |
|------|-------|------|
| `src/cli/cli.ts` | ~2,600 | CLI command surface and dispatch |
| `src/cli/session-loop.ts` | 906 | Interactive terminal loop |
| `src/cli/cli-session-store.ts` | ~120 | Persisted active session pointer |
| `src/cli/one-shot.ts` | ~140 | One-shot prompt execution |
| `src/cli/slash-menu.ts` | ~180 | Slash command menu rendering |
| `src/cli/tool-activity-renderer.ts` | ~160 | Tool activity display |
| `src/cli/trace-commands.ts` | ~275 | `estacoda trace` commands |
| `src/cli/eval-commands.ts` | ~100 | `estacoda eval` commands |
| `src/onboarding/setup-entry-state.ts` | 283 | Setup readiness classifier |
| `src/onboarding/setup-router.ts` | 364 | Setup route planner |
| `src/onboarding/first-run/runner.ts` | 718 | Reviewed first-run setup runner |
| `src/onboarding/review/apply-executor.ts` | 483 | Reviewed setup apply executor |
| `src/onboarding/setup-copy.ts` | 372 | Token-based setup copy registry |
| `src/onboarding/setup-verification-copy.ts` | 111 | Setup verification labels and actions |

## Commands

```bash
pnpm run dev                    # Interactive CLI
pnpm run dev -- setup           # Canonical reviewed setup entrypoint
pnpm run dev -- verify          # Verify configuration
pnpm run dev -- settings        # Show current settings
pnpm run dev -- doctor --live   # Live provider check
pnpm run dev -- telegram setup  # Configure Telegram
pnpm run dev -- gateway start   # Start gateway (channels must be enabled first)
```

## Installability

Local source checkouts validate the compiled entrypoint directly:

```bash
pnpm run build
node dist/index.js --version
node dist/index.js --help
```

Packed binary behavior is validated from a tarball installed into a temporary prefix:

```bash
scripts/verify-package-bin.sh
```

The npm package metadata exposes `bin.estacoda` for packed installs, but public npm publication remains blocked with `private: true`. The current local/manual installer is `bash scripts/install.sh`; the hosted curl installer is the planned launch direction and should not be described as live until release validation proves it. Do not claim `npm install -g estacoda` or `npx estacoda` works before publication.

## Trace Commands

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
```

- `list` shows recent trajectories with session IDs and outcomes
- `dump` outputs full JSON (redacted by default)
- `timeline` outputs chronological human-readable events
- `failures` lists classified failures for a trajectory
- `--raw` bypasses redaction (use with care)

**Evidence:** `smoke-tested`

## Eval Commands

```bash
estacoda eval [fixture-id]
```

Runs deterministic eval fixtures:
- `provider-text-response` — mock provider returns text without tool calls
- `tool-security-block` — detects blocked `rm -rf /`
- `missing-tool-failure` — handles unavailable tool gracefully

Returns pass/fail per assertion with timing.

**Evidence:** `smoke-tested`

## Interactive Session Loop

In-session commands:

| Command | Purpose |
|---------|---------|
| `/sessions` | List active sessions |
| `/search <query>` | Search session history |
| `/switch <session-id>` | Switch to another session |
| `/reset` | Start fresh session |
| `/trust` | Show workspace trust status |
| `/yolo` | Toggle open approval mode |
| `/skills` | List visible skills |
| `/tools` | List available tools |
| `/security` | Show recent security decisions |
| `/security debug` | Detailed security audit |
| `/cron` | List scheduled tasks |
| `/reload-mcp` | Reload MCP servers |
| `/exit` | Exit session |

## Session Resume

CLI startup restores the active workspace session from `cli-session-store.ts`. Fresh launches are no longer forced back to the default `scaffold` session.

## Setup And Onboarding

**Evidence:** `live-proven` (English and Arabic)

`estacoda setup` is the canonical setup entrypoint. Bare `estacoda` launch uses setup-route decisions when setup is incomplete and points users to setup instead of running the product flow inline.

Interactive setup uses the reviewed setup architecture:

1. Interface language and expression style
2. Workspace trust prompt
3. Primary provider and model selection
4. Hosted-provider API key capture (masked input, saved to `~/.estacoda/.env` with `0600`)
5. Security mode selection
6. Workflow-learning mode selection
7. Optional capabilities (Telegram, voice, vision, browser)
8. Review manifest before apply
9. Reviewed apply operations perform config, credential-reference, and trust writes
10. Structured read-only verification after apply
11. Launch handoff for verified-ready setup, or explicit accepted degraded state

### Setup Routes

`estacoda setup --interactive` routes the current setup state through a deterministic setup decision:

| State | Route behavior |
|-------|----------------|
| `first-run` / no usable config | Runs first-run setup and review/apply. |
| configured ready | Opens the guided setup editor with launch, review, verification, and exit choices. |
| configured degraded | Shows verification warnings; repair or explicit limited-mode acceptance is required before launch. |
| partial provider / broken route | Runs guided provider/model repair through the shared provider/model selection flow. |
| missing credential | Repairs the active route credential reference; review shows env var references only. |
| broken config | Shows config paths and parse/load diagnostics; normal config edits remain blocked until parsing is safe. |
| untrusted workspace | Offers an explicit workspace trust grant through reviewed apply. |
| state-not-writable | Shows state/config path permission guidance and blocks normal writes until state is writable. |

Configured, degraded, untrusted, and repair states use the guided setup editor. First-run setup uses the first-run runner. Read-only verification remains a separate route and does not write config, trust, state, or `.env`.

### Review, Apply, And Launch Safety

- Setup builds a review manifest before apply.
- Cancelling review produces no apply plan and no mutation.
- Raw secrets are not displayed in review metadata or apply planning output.
- Credential repair stores route/auth references and env var names, not raw key values.
- Verification after apply is read-only.
- Launch requires verified-ready setup, or explicit limited-mode acceptance after degraded warnings are shown.
- Broken config, missing credential, untrusted workspace, state-not-writable, failed verification, and blocked verification do not expose a launch path.

### Provider And Optional Capability Boundaries

Primary provider/model setup and repair use the shared provider/model flow. That flow applies provider visibility, runnable/configurable gates, and credential boundaries owned by the provider layer.

Optional capabilities stay separate from the primary LLM route:

| Optional capability | Setup behavior |
|---------------------|----------------|
| Telegram/channels | Remote-control surface. Setup requires token env var reference plus allowed user or chat identities before enable can apply. |
| Voice | Optional/native voice configuration. It does not change the primary provider/model route. |
| Vision/image generation | Optional/native image capability configuration. It does not change the primary provider/model route. |
| Browser | Records backend, URL, or command references. Setup planning does not auto-launch a browser or open a CDP connection. |

Skipping optional capabilities keeps core setup valid.

Direct provider/model flags remain as an advanced setup path:

```bash
estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
estacoda setup --advanced --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
```

These flags are compatibility/direct paths. They are not the preferred guided repair path for existing users.

Runtime mutating onboarding tools are removed. The runtime no longer exposes `onboarding.status` or `onboarding.complete`; setup mutation stays behind reviewed CLI setup/apply.

Backup/fallback routes are managed through `estacoda model fallback ...`; first-run onboarding no longer offers the legacy backup-provider prompt.

**Arabic support:**
- Selector chrome is localized
- Technical tokens (provider names, paths, env vars, commands) remain in English with LTR isolation
- Full runtime CLI localization is **not** complete

## Profile / UI Foundation

Global config supports:

| Setting | Values |
|---------|--------|
| `ui.language` | `en`, `ar` |
| `ui.flavor` | aesthetic flavor presets |
| `agent.mode` | behavior mode |
| `agent.responseLanguage` | response language policy |

**Evidence:** `smoke-tested`

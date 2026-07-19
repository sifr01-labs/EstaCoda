---
title: CLI Commands
description: Operational reference for the estacoda CLI command surface.
sidebar_position: 1
---

# CLI Commands

EstaCoda is a command-line agent system. Every surface that mutates state, inspects configuration, or changes runtime behavior is reachable from the terminal. This page documents the implemented command families. It does not document planned or pending behavior.

## Global option

```bash
estacoda --profile <id> <command>
estacoda -p <id> <command>
```

The `--profile` / `-p` flag selects a profile for the current command only. It does not change `active-profile.json`. Only `estacoda profile use <name>` changes the active profile. The flag is valid before any command.

---

## Setup

### `estacoda setup`

Opens the Setup Editor.

```bash
estacoda setup                          # interactive setup/repair
estacoda setup --interactive            # explicit interactive mode
estacoda setup --advanced               # advanced options in interactive mode
estacoda setup --provider <p> --model <m> --api-key-env <env>
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json`
- `~/.estacoda/profiles/<id>/.env` (credential references, not raw values)
- `~/.estacoda/profiles/<id>/trust.json`

**Profile boundary:** Uses the active profile, or the profile selected via `--profile`.

**Behavior:** Routes through a deterministic setup decision based on current state (`first-run`, configured-ready, configured-degraded, partial-provider, missing-credential, broken-config, untrusted-workspace, state-not-writable). The internal `first-run` state opens the Onboarding Wizard. Normal onboarding uses `summary -> confirm -> apply -> verify`; the redacted manifest and apply plan remain internal/operator-inspectable. Configured-ready state opens the Setup Editor with primary model route edit, fallback route edit, auxiliary route edit, optional capability configuration, security mode edit, Agent Evolution edit, EstaCoda Doctor, and exit. Doctor is the read-only health action for required fixes and provider route status. Cancelling review or summary confirmation produces no mutation. Raw secrets are never displayed in review metadata.

**Failure modes:**
- Broken config blocks normal edits until parsing is safe.
- State-not-writable blocks writes until permissions are fixed.
- Missing credentials route to credential repair without collecting raw values inline.
- Deferred workspace trust can save setup, but launch is blocked with `Setup saved. Workspace trust is still required before EstaCoda can run here.`
- `Start EstaCoda now?` appears only after apply and verification. The launch handoff reloads profile config and trust state, rebuilds runtime from fresh config, then enters the normal interactive launcher.

### `estacoda init`

Bootstraps state directories and default config.

```bash
estacoda init                           # create state skeleton
estacoda init --home <dir>              # custom state home
estacoda init --yes                     # non-interactive; use defaults
```

**State touched:** `~/.estacoda/`, default profile skeleton, `active-profile.json`.

**Failure modes:** Directory creation failures surface as exit code 1 with the path that failed.

### `estacoda verify`

Runs read-only verification of setup readiness.

```bash
estacoda verify
```

Checks:
- Provider config syntax validity
- Provider credential and endpoint readiness
- State directory backup readiness
- Pack registry validity

**Exit code:** 0 if ready, 1 if warnings exist.

---

## Python environments

```bash
estacoda python-env list
estacoda python-env status <id>
estacoda python-env setup <id>
estacoda python-env verify <id>
estacoda python-env upgrade <id>
estacoda python-env reset <id>
```

These commands manage runtime-owned Python environments for capabilities that need pinned Python packages.

| Command | Behavior |
|---|---|
| `python-env list` | Lists registered Python capabilities and their environment status. |
| `python-env status <id>` | Shows the environment path, Python path when available, manifest state, installed groups, and repair hint. |
| `python-env setup <id>` | Creates the environment, installs pinned packages from the registered runtime spec, verifies imports, and writes the manifest. |
| `python-env verify <id>` | Verifies configured imports only. It does not install packages. |
| `python-env upgrade <id>` | Updates an installed environment when the registered spec changes, then verifies it. |
| `python-env reset <id>` | Deletes the managed environment for that capability after confirmation. |

`setup` and `upgrade` require explicit local approval before network package installation. `reset` is destructive.

Optional groups can be selected with group flags when a capability defines them:

```bash
estacoda python-env setup <id> --group <name>
estacoda python-env setup <id> --groups <a,b>
estacoda python-env status <id> --group <name>
```

Skills do not install packages during normal execution. Missing capability environments are reported with a repair command for the local operator.

---

## Model and provider

### `estacoda model`

The model command family manages which LLM EstaCoda uses, how credentials are loaded, and what happens when the primary route fails.

```bash
estacoda model                          # interactive picker or overview
estacoda model status                   # primary, fallback, and auxiliary route status
estacoda model list                     # configurable models in the catalog
estacoda model list --live              # include live network probes
estacoda model search <query>           # search catalog by name or provider
estacoda model providers                # list known providers
estacoda model refresh                  # refresh provider catalog from network
estacoda model diagnose                 # full diagnostic with executable status
estacoda model auxiliary status         # auxiliary route readiness
estacoda model fallback                 # manage fallback chain
estacoda model setup local [--base-url <url>] [--model <id>] [--api-key <key>] [--context-window <n>]
                                        # configure Local / Custom OpenAI-compatible endpoint
estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]
                                        # configure named custom OpenAI-compatible provider
estacoda model setup codex              # OAuth device-code setup for Codex
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json` (primary route, fallback chain, provider registration)
- `~/.estacoda/profiles/<id>/.env` (optional raw API key values after reviewed setup)
- `~/.estacoda/profiles/<id>/auth.json` (Codex OAuth tokens for the selected profile)

**Profile boundary:** All model config is profile-scoped.

**Behavior:**
- Bare `estacoda model` opens an interactive picker in setup mode when a TTY is available; otherwise prints an overview.
- `model setup local` configures the built-in `local` provider for Ollama, LM Studio, llama.cpp, vLLM, or another OpenAI-compatible local/custom endpoint. It defaults to `http://localhost:11434/v1`, requires no API key by default, and stores an optional `--api-key` as `OPENAI_COMPATIBLE_API_KEY`.
- `model setup custom` configures a separate named OpenAI-compatible provider ID with an explicit `baseUrl`; use it when you need more than the built-in `local` provider identity.
- `model setup codex` authenticates through OAuth device code flow, stores tokens in the selected profile's `auth.json`, and configures the `codex/gpt-5.5` route with auth method `oauth_device_pkce` and API mode `openai_responses`.
- Bare `estacoda model` can also configure Codex where the nested OpenAI choice is enabled: choose `OpenAI`, then `Codex`. The `OpenAI Models` choice is the API-key OpenAI path; `Codex` is the OAuth path.
- Setup Editor primary and fallback model-route edits can configure Codex through reviewed apply. OAuth tokens are written only after review approval; cancelling review after OAuth does not persist tokens. First-run onboarding and auxiliary model routes do not add Codex OAuth setup in this pass.
- `/providers` is the interactive-session surface for provider status and reviewed provider setup. `/model` remains the model status/switching command, and `/models` is not a slash command.
- `model fallback` manages the ordered fallback chain and is also accessible through the Setup Editor (`edit-fallback-model-route`). `estacoda model set` is deprecated and rejected.

**Failure modes:**
- Unknown model input returns exit code 1 with candidate suggestions.
- Ambiguous input lists matching candidates.
- Credential required but no prompt available returns a repair instruction.
- Config save failures report the path and error.

---

## Profile management

Profiles isolate configuration, secrets, identity memory, skills, cron state, gateway state, logs, caches, and channel media under `~/.estacoda/profiles/<id>/`.

```bash
estacoda profile create <name>
estacoda profile create <name> --blank
estacoda profile create <name> --from <profile> --files user,memory,soul
estacoda profile list
estacoda profile use <name>
estacoda profile show [name]
estacoda profile delete <name>
estacoda profile delete <name> --force
estacoda profile rename <old> <new>
```

**State touched:**
- `~/.estacoda/profiles/<id>/` (full skeleton)
- `~/.estacoda/active-profile.json`

**Profile boundary:** `profile use` changes the global active profile. All other profile commands operate on the named profile.

**Failure modes:**
- `profile delete` refuses active or non-empty profiles unless `--force` is provided.
- `profile rename` updates the active profile record when the renamed profile was active.

---

## Gateway and channels

### `estacoda gateway`

Manages the channel gateway lifecycle, service installation, and diagnostics.

```bash
estacoda gateway run                    # foreground gateway supervisor
estacoda gateway run --dry-run          # readiness check; no PID/lock writes
estacoda gateway run --once             # one supervisor pass, then exit
estacoda gateway run --profile <id>     # bind foreground gateway to a specific profile
estacoda gateway start                  # start installed user-scope service
estacoda gateway start --system         # start installed system-scope service
estacoda gateway stop                   # SIGTERM; prefers managed service if installed
estacoda gateway stop --force           # SIGKILL for unmanaged; systemd stop for managed
estacoda gateway restart                # restart installed user-scope service
estacoda gateway restart --graceful     # alias for restart in v0.1.0
estacoda gateway restart --system       # restart system-scope service
estacoda gateway status                 # full status: service manager, channels, cron, approvals, memory finalization
estacoda gateway diagnose               # per-channel readiness; exits 1 on warnings
estacoda gateway approvals              # pending approvals count
estacoda gateway install                # install user-scope systemd/launchd service
estacoda gateway install --force        # replace existing service unit
estacoda gateway install --profile <id> # install service bound to profile
estacoda gateway install --system --run-as-user <user>
estacoda gateway uninstall              # remove user-scope service
estacoda gateway uninstall --system     # remove system-scope service
```

**State touched:**
- `~/.estacoda/profiles/<id>/gateway.pid`
- `~/.estacoda/profiles/<id>/gateway.lock`
- `~/.estacoda/profiles/<id>/gateway-state/`
- systemd user units / launchd plists (when managed)

**Lifecycle boundary:** `gateway run` is foreground/debug mode. `gateway start` requires an installed service and defaults to the user-scope service. Use `gateway start --system` when only a system-scope service is installed. `gateway start --background` is deprecated; use `gateway install` followed by `gateway start`. `gateway restart` no longer starts an unmanaged detached process when no service exists. `gateway stop` still keeps the unmanaged PID/lock cleanup fallback where supported.

**Profile boundary:** Gateway processes bind to the profile selected at start time. Changing `active-profile.json` does not mutate a running gateway.

**Failure modes:**
- `start --background` refuses to spawn if a live PID file or active gateway lock exists.
- `stop` prefers a managed user-scope service; if only a system service exists, rerun with `--system`.
- systemd user services may stop on logout unless linger is enabled.
- Source-mode installs hardcode the absolute workspace path; moving the repo requires reinstall.

### `estacoda channels`

```bash
estacoda channels list                  # compact table of all channels
estacoda channels status <name>         # detailed status for one channel
estacoda channels enable <name>         # set enabled: true in config
estacoda channels disable <name>        # set enabled: false in config
```

Valid channel names: `telegram`, `discord`, `email`, `whatsapp` (case-insensitive).

**State touched:** `~/.estacoda/profiles/<id>/config.json` (channel block).

**Failure modes:** Invalid channel names return exit code 1.

---

## Cron

```bash
estacoda cron list                      # all jobs with schedule and next run
estacoda cron show <job-id>             # job detail + last 5 executions
estacoda cron history [job-id]          # execution history
estacoda cron add --schedule <schedule> --command "<prompt>"
estacoda cron edit <job-id> [flags]
estacoda cron run <job-id>              # request a manual run
estacoda cron pause <job-id>
estacoda cron resume <job-id>
estacoda cron remove <job-id>
estacoda cron tick                      # manual scheduler tick
```

Useful add/edit flags include `--skill`, `--script`, `--script-arg`, `--script-timeout-ms`, `--no-agent`, `--agent`, `--context-from`, `--clear-context-from`, `--model`, `--provider`, `--clear-model`, `--toolset`, `--clear-toolsets`, `--workdir`, and `--clear-workdir`.

**State touched:**
- `~/.estacoda/profiles/<id>/cron/jobs.json`
- `~/.estacoda/sessions.sqlite` (execution history)
- `~/.estacoda/profiles/<id>/cron/output/`

**Profile boundary:** Cron jobs are profile-scoped. Storage can also use the default top-level cron directory when a default/manual `CronStore` is constructed.

**Failure modes:**
- Stale locks from crashed processes are recovered on startup.
- Cron runtimes are isolated and cannot use cron, messaging, or clarify toolsets.
- Invalid context, model/provider, toolset, workdir, and unsafe prompt inputs are rejected before persistence where validation context exists.
- Delivery failures are classified and persisted in execution history.
- No-agent jobs do not create runtime trajectories.

See [Scheduled Jobs](../user-guide/cron.md) for the full cron behavior model.

---

## Sessions

```bash
estacoda sessions list                  # recent sessions with attached surfaces
estacoda sessions show <session-id>     # session detail + surface pointers
estacoda sessions current               # current runtime session
estacoda sessions attach <surface> <id> <session-id>
estacoda sessions detach <surface> <id>
estacoda sessions recall <query>        # summarize historical session matches
estacoda session recall <query>         # alias
estacoda sessions compact <session-id> [--topic <topic>]
```

Valid surfaces: `cli`, `telegram`, `discord`, `whatsapp`, `email`.

**State touched:** SQLite session DB (`~/.estacoda/sessions.sqlite`).

**Profile boundary:** Sessions are profile-scoped. `sessions recall` is bounded to the active profile and workspace when metadata is available.

**Failure modes:**
- `sessions compact` is non-rotating in this implementation; it does not adopt a compacted child session.
- Attach/detach requires the session to exist in the active profile.

---

## Memory

```bash
estacoda memory status
estacoda memory index path
estacoda memory index status
estacoda memory index rebuild
estacoda memory search <query> [--include-protected] [--max-results N] [--max-chars N]
estacoda memory read <USER.md|MEMORY.md|SOUL.md|shared> [key] [--include-protected] [--max-chars N]
estacoda memory mode [auto|review|manual]
estacoda memory recent [--limit N]
estacoda memory review [--limit N]
estacoda memory apply <record-id> [candidate-id|all]
estacoda memory reject <record-id> [candidate-id|all]
estacoda memory undo <record-id>
estacoda memory forget <USER.md|MEMORY.md> <exact text>
estacoda memory populate
estacoda memory edit
estacoda memory clear [USER.md|MEMORY.md|all] --yes
estacoda memory finalization list [--status pending|running|completed|failed] [--limit N]
estacoda memory finalization retry <job-id>
estacoda memory finalization prune [--keep N]
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json` for `memory mode`
- `~/.estacoda/profiles/<id>/USER.md` and `MEMORY.md` for writes/clears
- `~/.estacoda/profiles/<id>/memory-curation.json` for curation history
- profile-local `memory-index.sqlite` for index rebuild/sync

**Behavior:**
- `memory status` reports profile memory configuration/history plus background-finalization `pending`, `running`, `retrying`, and `failed` counts.
- `memory finalization list` shows bounded profile-scoped job metadata without transcript content; `retry` requeues failed jobs with a fresh attempt budget, and `prune` retains the newest terminal rows.
- `memory mode` shows or updates profile-local curation mode. `auto` is the default and applies only conservative low-risk candidates.
- `memory recent` shows recent curation records, including auto-applied, pending-review, ignored, and failed checkpoints.
- `memory review` shows pending-review records and stored low-risk candidate operations.
- `memory apply <record-id> [candidate-id|all]` applies pending review candidates through the shared memory mutation path.
- `memory reject <record-id> [candidate-id|all]` marks pending review candidates rejected without writing memory.
- `memory undo <record-id>` reverses applied operations for a curation record.
- `memory forget <USER.md|MEMORY.md> <exact text>` removes exact text from learned memory.
- `memory populate` dispatches a manual curation checkpoint through an active runtime. Run `/memory populate` inside an active CLI session or authorized channel when no attached runtime is available to the top-level command.
- `memory edit` prints safe edit targets and repair guidance for `USER.md` and `MEMORY.md`; `SOUL.md` is protected.
- `memory clear` requires `--yes`, creates backups for existing files, and never clears `SOUL.md` or shared memory.

**Gateway parity:** Authorized Telegram sessions expose the same curation subcommands through `/memory ...`.

---

## Workflow

The `estacoda workflow ...` command family is retired after the durable Task persistence cutover. Every subcommand exits non-zero with explicit guidance. Task operator commands are not available in this build.

**State touched:** None.

---

## Security and approvals

```bash
estacoda security                       # view current security mode
estacoda security --mode <mode>         # set approval mode
```

Valid modes: `strict`, `normal`, `open`. Hard safety blocks apply in all modes.

**State touched:** `~/.estacoda/profiles/<id>/config.json`.

---

## Browser

```bash
estacoda browser status
estacoda browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222 --launch-executable /path/to/chrome --launch-arg --headless=new --chrome-flag --no-first-run --auto-launch
estacoda browser setup --backend browserbase --cloud-provider browserbase --hybrid-routing
estacoda browser approve-cloud
estacoda browser revoke-cloud
estacoda browser test
estacoda browser disable
```

**State touched:** `~/.estacoda/profiles/<id>/config.json`.

**Behavior:**
- `setup --backend local-cdp` configures manual CDP or supervised local auto-launch.
- `--launch-executable`, repeated `--launch-arg`, and repeated `--chrome-flag` write structured launch config.
- `--launch-command` remains accepted as deprecated compatibility data and is not shell-parsed.
- `setup --backend browserbase --cloud-provider browserbase --hybrid-routing` configures Browserbase/hybrid routing but does not create a cloud session.
- `approve-cloud` sets `browser.cloudSpendApproved: true`; `revoke-cloud` disables billable cloud session creation again.

**Failure modes:**
- Browserbase requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`.
- Browserbase sessions may incur charges and remain blocked until `estacoda browser approve-cloud` is run.
- Cloud spend approval failure does not fall back to local.
- `test` reports configuration readiness; live navigation is verified through browser tools during runtime.

---

## Tools and MCP

```bash
estacoda tools                          # list available tools grouped by toolset
estacoda mcp status                     # configured MCP servers and readiness
estacoda mcp reload                     # reload MCP config
```

**State touched:** None for `tools`. `mcp reload` refreshes the runtime tool registry from current config.

**Failure modes:** MCP servers missing from config are not errors; they simply do not appear.

---

## Diagnostics

```bash
estacoda doctor                         # health report and required fixes
estacoda doctor --live                  # includes live provider endpoint probes
estacoda doctor --json                  # structured DoctorReport for automation
estacoda doctor --fix                   # safe local state skeleton repairs
```

**State touched:** None by default. `--fix`, `--fix-config`, `--repair-sessions`, and `--ack` are explicit repair or acknowledgement paths.

**Exit code:** 0 if ready, 1 if warnings or blockers exist.

**More:** [Doctor](../user-guide/doctor.md).

---

## Voice

```bash
estacoda voice status
estacoda voice setup --stt-provider local
estacoda voice setup --stt-provider local --python-binary /path/to/python
estacoda voice setup --tts-provider openai
estacoda voice mode on|off|tts|status
```

**State touched:**
- `~/.estacoda/profiles/<id>/config.json`
- `~/.estacoda/profiles/<id>/.env` when storing voice provider secrets
- `~/.estacoda/python-env` for managed local STT setup
- `~/.estacoda/cache/huggingface` for faster-whisper model cache at runtime

**Behavior:**
- `estacoda voice setup --stt-provider local` checks the managed Python environment, creates or repairs it when needed, installs pinned `faster-whisper==1.2.1`, and writes local STT config only after setup succeeds.
- Setup progress is curated. Raw pip output is not the normal CLI UX.
- `--python-binary /path/to/python` skips managed environment check/create and stores the custom path. The operator owns that Python environment.
- `estacoda voice setup --tts-provider openai` is TTS-only. It does not mutate STT config and does not touch the managed Python environment.
- Runtime resolves configured Python first, then the managed venv path. Runtime does not install packages in Phase 1.

**Failure modes:**
- Missing/corrupted managed Python env is repaired during explicit local STT setup.
- Failed package install exits without writing a broken local STT config.
- Custom Python failures are repaired by the operator, not by EstaCoda.

---

## Trace and eval

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
estacoda eval [fixture-id]
```

**State touched:** SQLite session DB (trajectory storage).

**Failure modes:** `--raw` bypasses redaction. Use with care.

---

## Packs and skills

```bash
estacoda packs list                     # installed packs
estacoda packs inspect <id>             # full manifest and metadata
estacoda packs install <path>           # install from local path
estacoda packs enable <id>
estacoda packs disable <id>
estacoda packs uninstall <id>

estacoda skills list                    # available skills from enabled packs
estacoda skills inspect <name>          # skill metadata
estacoda skills view <name>             # full SKILL.md content
```

**State touched:**
- `~/.estacoda/profiles/<id>/packs.json`
- `~/.estacoda/packs/` (shared pack storage)

**Profile boundary:** Packs are installed globally; enablement is per-profile. Skills visibility depends on enabled packs.

---

## Settings

```bash
estacoda settings                       # overview of all categories
estacoda settings profile               # profile mode and response language
estacoda settings profile --mode <mode> --response-language <lang>
estacoda settings ui                    # UI language, flavor, activity labels
estacoda settings ui --language <en|ar> --flavor <f> --activity-labels <l>
estacoda settings skills                # skill autonomy
estacoda settings skills --autonomy <level>
estacoda settings security              # security mode
estacoda settings browser               # browser backend config
estacoda settings voice                 # voice provider readiness
estacoda settings image                 # image generation config
estacoda settings telegram              # Telegram channel config
estacoda settings provider              # provider diagnostic summary
```

**State touched:** `~/.estacoda/profiles/<id>/config.json`.

---

## Knowledge, evolution, curator, manifest, proposal

Development-facing command families. They operate on skill manifests, knowledge graphs, and evolution proposals.

```bash
estacoda knowledge <subcommand>
estacoda evolution <subcommand>
estacoda curator <subcommand>
estacoda manifest diff <id>
estacoda proposal <subcommand>
```

These are advanced surfaces. Run `--help` on each for subcommands.

---

## Update

```bash
estacoda update --check                 # check only; never modify files
estacoda update                         # apply update (managed-source) or print routing
estacoda update --backup                # force backup before applying
estacoda update --no-backup             # skip user-state backup
estacoda update --gateway               # non-interactive gateway/service update mode
```

**Install-method routing:** `estacoda update` detects how EstaCoda was installed and routes accordingly.

| Method | Behavior |
|---|---|
| `managed-source` | Guarded source update: fetch, ff-only check, worktree check, pull, install deps, build, validate. Rollback on failure. |
| `manual-source` | Check and advise only. No self-mutation. |
| `homebrew` | Print `brew upgrade kemetresearch/tap/estacoda`. |
| `docker` | Print `docker pull ghcr.io/sifr01-labs/estacoda:latest`. |
| `npm-global` | Print `npm install -g estacoda@latest`. |
| `pnpm-global` | Print `pnpm add -g estacoda@latest`. |
| `unknown` | Print reinstall guidance. |

**State touched:**
- `~/.estacoda/update-cache.json` — update check cache
- `~/.estacoda/logs/update.log` — update operation log (gateway mode)
- `~/.estacoda/.backups/<label>/` — user-state backup before managed-source mutation

**Exit codes:** 0 on success/routing, 1 on error, 2 if up-to-date, 3 if dirty worktree.

**Related docs:** [Updating](../getting-started/updating.md), [Update Operations](../operations/update-operations.md)

## Uninstall

```bash
estacoda uninstall                      # keep data; remove code/wrappers/services
estacoda uninstall --purge --yes        # remove user data too
```

**Behavior:** Default mode removes managed-source install code, known wrappers, installer-owned PATH entries, and gateway services while preserving `~/.estacoda`. `--yes` alone does not purge. Full data deletion requires both `--purge` and `--yes`.

**Install-method routing:**

| Method | Behavior |
|---|---|
| `managed-source` | Gateway teardown, remove wrappers/PATH lines, remove install dir (if stamp is trusted), preserve `~/.estacoda` |
| `manual-source` | Gateway teardown, remove wrappers/PATH lines, preserve clone and `~/.estacoda` |
| `homebrew` | Print `brew uninstall estacoda` |
| `docker` | Print container/image guidance |
| `npm-global` | Print `npm uninstall -g estacoda` |
| `pnpm-global` | Print `pnpm remove -g estacoda` |
| `unknown` | Remove known wrappers/PATH lines, preserve user data |

**State touched:** May remove install directory, wrappers, PATH entries, gateway services. With `--purge --yes`, removes `~/.estacoda`.

**Related docs:** [Uninstall](../getting-started/uninstall.md)

---

## Version and help

```bash
estacoda --version
estacoda -v
estacoda --help
estacoda -h
estacoda help
```

---

## ACP server

```bash
estacoda acp                            # start the ACP stdio server
```

Starts the Agent Communication Protocol stdio server for external integration.

---

## Handoff

```bash
estacoda handoff <surface>
```

Generates a handoff code to share the current CLI session with a channel surface. Currently only `telegram` is supported.

**State touched:** `~/.estacoda/profiles/<id>/gateway-state/handoff-codes.json`.

---

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error, warning, or command rejected |
| 2 | Up-to-date (update command) |
| 3 | Dirty worktree; stash or commit before retrying (update command) |

Most commands exit 0 on success and 1 on any failure, diagnostic warning, or invalid input. The update command uses 2 when already up-to-date and 3 when the managed-source worktree has uncommitted changes. The gateway family follows the same convention.

---

## Related docs

- [Slash Commands](./slash-commands.md) — in-session command reference
- [Tools Reference](./tools-reference.md) — tool classes and availability boundaries
- [State and Files](./state-and-files.md) — where profile state lives
- [Provider Reference](./provider-reference.md) — model provider maturity and setup

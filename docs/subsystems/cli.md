---
title: "CLI & Setup"
description: "CLI commands, interactive session loop, trace/eval inspection, and the Onboarding Wizard."
---

# CLI & Setup

## Files

| File | Role |
|------|------|
| `src/cli/cli.ts` | CLI command surface and dispatch |
| `src/cli/session-loop.ts` | Interactive terminal loop |
| `src/cli/cli-session-store.ts` | Persisted active session pointer |
| `src/cli/one-shot.ts` | One-shot prompt execution |
| `src/cli/papyrus-prompt.ts` | Papyrus-capable interactive prompt factory |
| `src/cli/paste-interceptor.ts` | Bracketed paste interception and newline restoration |
| `src/cli/bottom-chrome-controller.ts` | Managed terminal chrome below/above prompt regions |
| `src/cli/active-turn-command-controller.ts` | CLI-local active-turn command lane |
| `src/cli/slash-menu.ts` | Slash command menu rendering |
| `src/cli/tool-activity-renderer.ts` | Tool activity display |
| `src/cli/trace-commands.ts` | `estacoda trace` commands |
| `src/cli/eval-commands.ts` | `estacoda eval` commands |
| `src/setup/setup-entry-state.ts` | Setup readiness classifier |
| `src/setup/setup-router.ts` | Setup route planner |
| `src/setup/onboarding-wizard/runner.ts` | Reviewed Onboarding Wizard runner |
| `src/setup/review/apply-executor.ts` | Reviewed setup apply executor |
| `src/setup/setup-copy.ts` | Token-based setup copy registry |
| `src/setup/setup-verification-copy.ts` | Setup verification labels and actions |

## Commands

```bash
pnpm run dev                    # Interactive CLI
pnpm run dev -- setup           # Canonical reviewed setup entrypoint
pnpm run dev -- verify          # Verify configuration
pnpm run dev -- settings        # Show current settings
pnpm run dev -- doctor --live   # Live provider check
pnpm run dev -- profile list    # Advanced profile management
pnpm run dev -- telegram setup  # Configure Telegram
pnpm run dev -- gateway run     # Run foreground gateway (channels must be enabled first)
```

Global command option:

```bash
estacoda --profile work model status
estacoda -p work doctor
```

`--profile` / `-p` selects a profile for the current command only. It does not change `active-profile.json`; only `estacoda profile use <name>` changes the active profile.

## Python Environment Commands

`estacoda python-env` manages runtime-owned Python capability environments.

Use it for capabilities that need pinned Python packages:

```bash
estacoda python-env list
estacoda python-env status <id>
estacoda python-env setup <id>
estacoda python-env verify <id>
estacoda python-env upgrade <id>
estacoda python-env reset <id>
```

`list` and `status` are read-only. `setup` and `upgrade` require explicit local approval before package installation. `reset` is destructive and removes only the managed capability environment path.

Normal skill execution does not run these commands and does not install packages automatically.

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

The npm package metadata exposes `bin.estacoda` for packed installs. The hosted curl installer is the default public path. `npm install -g estacoda` will work once the package is published.

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

## Memory And Session Recall Commands

Top-level session recall commands:

```bash
estacoda session recall <query>
estacoda sessions recall <query>
```

Both command forms summarize historical session matches. They use the selected profile, apply workspace scoping when a workspace root is available, resolve the auxiliary `session_search` route when configured, and fall back to deterministic snippets if auxiliary summarization is unavailable or fails.

Top-level semantic session compaction:

```bash
estacoda sessions compact <session-id> [--topic <topic>]
```

This calls the active runtime's session compaction service. It is semantic session compression for a session transcript, not Workflow event summaries and not Memory File Compaction. This top-level CLI command is non-rotating in the current implementation; it does not create/adopt a compacted child session.

Memory-file compaction is exposed as runtime tools, not as a top-level CLI command in this implementation:

| Tool | Purpose |
|------|---------|
| `memory.file_compact` | Manually compact `USER.md` or `MEMORY.md`; supports dry-run |
| `memory.file_compaction_restore` | Restore `USER.md` or `MEMORY.md` from a compaction backup |

No top-level memory prompt, memory compact, or memory restore-backup CLI command is available in this implementation.

Read-only semantic compression diagnostics are exposed as a runtime tool:

| Tool | Purpose |
|------|---------|
| `config.compression.status` | Shows normalized compression config, auxiliary `compression` route status, and latest session compression state/event summary when available |

`config.compression.status` does not mutate config, enable compression, write session events, expose raw summaries, or expose credentials. There is no `config.compression.setup` tool or top-level CLI alias in this implementation.

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
| `/session recall <query>` | Summarize historical session matches |
| `/sessions recall <query>` | Alias for session recall where supported |
| `/compact [topic]` | Compact this in-session context through semantic session compression |
| `/model` | Show ready/runnable model choices for this session |
| `/model <provider>/<model>` | Set a session-scoped model override |
| `/model set <provider>/<model>` | Compatibility syntax for the same session-scoped override |
| `/model clear` | Clear the session-scoped model override |
| `/model --global <provider>/<model>` | Persist the selected route as the profile primary model after trust checks |
| `/switch <session-id>` | Switch to another session |
| `/reset` | Start fresh session |
| `/trust` | Show workspace trust status |
| `/yolo` | Toggle open approval mode |
| `/skills` | List visible skills |
| `/tools` | List available tools |
| `/security` | Show recent security decisions |
| `/security debug` | Detailed security audit |
| `/cron` | List scheduled tasks |
| `/approvals` | Show current one-time, session, and persistent approvals |
| `/revoke <approval-id>` | Revoke a persistent approval by id |
| `/reload-mcp` | Reload MCP servers |
| `/exit` | Exit session |

Interactive `/compact [topic]` is semantic session compression for the current session, but it is non-rotating in this implementation. Gateway `/compact` has separate adoption logic and can preserve the parent transcript by switching the channel to a compacted child session.

### Papyrus Prompt And Active-Turn Controls

The idle CLI prompt is Papyrus-owned raw input. The Papyrus prompt factory owns
interactive setup/operator prompts, core session input, slash autocomplete,
approval cards, paste references, and terminal cleanup. The bottom chrome is
redrawn around the Papyrus-managed prompt region instead of treating the prompt
row as an ad hoc output line.

The terminal regions are intentionally separate:

```text
Transcript area:
  durable user rails
  durable assistant cards
  durable tool activity rows

Bottom prompt region:
  status rail
  input row / placeholder
  fixed-height slash completion panel
  compact paste notice/reference when applicable
```

Tool-start and tool-result rows are durable transcript output above bottom chrome. The active spinner and status rail stay in the bottom prompt region.

Bracketed paste is enabled only for TTY prompts that run through the paste interceptor. Small single-line pastes remain inline. Multiline and large pastes display as compact `[Pasted text #...]` references when a paste reference store is available. Paste files are written under the active profile temp state, not the workspace, and are temporary operational artifacts, not a permanent knowledge store. The submitted runtime input restores the original pasted content. Secret prompts bypass paste preview and paste reference storage; pasted secret content must not be logged, echoed in chrome/status text, or mirrored outside the prompt answer path.

Shortcut hints are shown as input-lane placeholder copy while the idle input line is empty. The prompt row owns the prompt marker, so placeholder copy must not include its own `>` or `›`. The hint disappears as soon as the user starts typing. Slash hints take priority when idle input starts with `/`; the hint model is built from the current line before submit, rendered through the Papyrus bottom chrome path, and cleared when the line no longer starts with `/` or the prompt resolves. Slash completions render in a fixed-height prompt-region panel, so fewer matches do not shrink the panel. Plain, non-TTY, or non-bottom-chrome sessions keep the direct startup hint fallback.

Arabic setup chrome is direction-aware for localized setup selectors, rails, onboarding summaries, prompt cards, raw setup prompts, verification reports, and the startup dashboard. Arabic picker rows are RTL/right-aligned as full option rows; selected output uses `تم تحديد`, and technical selected values are LTR-isolated. The Arabic startup dashboard uses two RTL-aware columns at normal terminal widths and falls back to a bounded stacked layout on narrow terminals. Technical tokens such as paths, env vars, provider/model IDs, slash commands, and version numbers remain untranslated and isolated. Do not describe this as full runtime Arabic localization.

Onboarding provider credential prompts and Telegram token prompts share the setup editor prompt copy. Arabic display strings isolate product names, provider names, `Telegram`, env vars, and other technical tokens. Stored config, env, auth, and state values remain raw; secret prompts remain masked.

After a normal message is submitted, the idle prompt is gone. The active turn shows status, timing, spinner, durable tool activity, approval/setup output, and transient active-lane messages; it does not show a fake read-only prompt box containing the submitted user text. The submitted prompt remains visible in the transcript rail/history.

While `runtime.handle()` is active in a local interactive CLI session, the active prompt lane accepts visible input. Normal text submitted mid-turn is queued for the next turn, does not interrupt the current turn, and is sent only after the current response completes. Slash commands in this lane remain control input and are not persisted as user transcript/history content.

Active-turn commands:

| Command | Behavior |
|---------|----------|
| `/interrupt` | Aborts the current active turn with `CLI interrupt`. It does not retry. |
| `/steer <note>` | Aborts the current active turn with `CLI steer`, then queues one retry using the original submitted text plus an explicit steering note block. |

`/steer` V1 is abort-and-retry steering. It is not true in-flight provider steering, and it does not add a runtime/provider steering primitive. The retried text is inspectable:

```text
<original user text>

[Steering note while previous turn was interrupted]
<note>
```

`<note>` is documentation notation only. The actual input is free-form text after the command:

```text
/steer try the safer approach instead
```

An empty `/steer` shows usage and does not abort. Repeated steering attempts for the same submitted turn are bounded; the same note is not reapplied indefinitely if the retry fails, is cancelled, or is interrupted.

Cursor-control-heavy changes in this area need unit coverage and real terminal smoke. The test harness checks split paste markers, prompt wrapping, bottom chrome line accounting, active-turn commands, and retry behavior, but manual smoke is still the way to catch terminal-emulator cursor quirks.

### In-Session Model Switching

`/model` inside an active CLI session is session-scoped by default. `/model <provider>/<model>` writes a model override for the active session only, and `/model set <provider>/<model>` is compatibility syntax for the same session-scoped behavior. It does not resurrect the old persistent `estacoda model set` command. `/model clear` removes the session override and returns the session to the configured primary route.

The interactive `/model` picker labels the two selection steps as `Select provider` and `Select model`. Both prompts use session-only wording: `Select the provider to use for this session only.` and `Select the model to use for this session only.` These picker choices do not mutate profile config.

After a successful session override, the CLI prints a compact session notice only:

```text
Model: deepseek-v4-flash
Session model override set: deepseek/deepseek-v4-flash
Scope: session
Fallback routes unchanged.
```

The notice must not replay the startup dashboard or runtime status fields such as `EstaCoda is ready`, `profile:`, or `tools:`. Plain, CI, and non-TTY output remains unstyled. Standard interactive terminals with styling capability may bold notice labels.

The picker only presents ready, runnable model choices. Credentialed routes missing required credentials are rejected with terminal setup guidance; active sessions do not collect API keys, OAuth tokens, or other credential values. Session overrides persist with the session and are revalidated when a runtime is created. Stale or invalid overrides are ignored non-fatally and the runtime falls back to the configured primary route. Fallback routes and auxiliary routes are preserved by session switching.

`/model --global <provider>/<model>` and `/model set --global <provider>/<model>` are explicit global forms. They persist the selected route as the profile-level primary model only after the existing local workspace/profile trust path authorizes the write. They do not collect credentials. `/model --global clear` is rejected because clearing the profile primary route has no product-defined meaning. Use `estacoda model setup` for credentials and primary setup, and `estacoda model fallback` for fallback route management.

## Interactive Approval Prompt

When a CLI tool execution reaches an active approval prompt, these bare answers are accepted:

- `once` — grant this exact action one time and retry.
- `session` — grant matching actions for the current session and retry.
- `always` — persist a workspace approval for matching actions and retry.
- `deny`, `reject`, `no`, `n` — deny the gated action without retrying.

The prompt also accepts slash-style aliases inside the same active approval prompt:

- `/approve once`
- `/approve session`
- `/approve always`
- `/deny`

These aliases normalize into the same choices as the bare answers and use the same `runtime.grantApproval()` path. Invalid slash approval input such as `/approve banana` follows the existing invalid-answer guidance path and does not grant approval. No delayed CLI approval queue was added; these aliases are not a durable out-of-band approval system.

Approval inspection commands are normal interactive slash commands:

- `/approvals` lists current one-time, session, and persistent approvals for the active CLI runtime.
- `/revoke <approval-id>` removes a persistent approval by id when the runtime exposes revocation.

## Session Resume

CLI startup restores the active workspace session from `cli-session-store.ts`. Fresh launches are no longer forced back to the default `scaffold` session.

## Setup And Onboarding

**Evidence:** `live-proven` (English and Arabic)

`estacoda setup` is the canonical setup entrypoint. Bare `estacoda` launch uses setup-route decisions when setup is incomplete and points users to setup instead of running the product flow inline.

The normal Onboarding Wizard flow is deliberately shorter than the backend pipeline:

1. Setup detection
2. Profile bootstrap
3. Welcome
4. Language/style
5. Workspace
6. Workspace trust
7. Model route
8. Safety
9. Agent Evolution
10. Optional capabilities
11. Summary
12. Apply
13. Launch

Normal users see `summary -> confirm -> apply -> verify`. They do not see the technical redacted manifest as a separate screen. Operators still care about the backend path because it explains why setup can be inspected, blocked, or safely cancelled:

```text
OnboardingWizardState -> draft bundle -> redacted manifest -> apply plan -> reviewed apply -> verification
```

The Onboarding Wizard silently creates and selects the default profile before writing configuration. Normal day-one setup copy should not require users to know profiles exist; profile commands are an advanced surface for multi-context setups.

### Setup Routes

`estacoda setup --interactive` routes the current setup state through a deterministic setup decision:

| State | Route behavior |
|-------|----------------|
| `first-run` / no usable config | Runs the Onboarding Wizard. `first-run` is the internal route state; the user-facing surface is the Onboarding Wizard. |
| configured ready | Opens the Setup Editor with primary model route edit, fallback route edit, auxiliary route edit, optional capability configuration, security mode edit, Agent Evolution edit, read-only verification, launch after verification, and exit choices. |
| configured degraded | Shows verification warnings; repair or explicit limited-mode acceptance is required before launch. |
| partial provider / broken route | Runs guided provider/model repair through the shared provider/model selection flow. |
| missing credential | Repairs the active route credential reference; review shows env var references only. |
| broken config | Shows config paths and parse/load diagnostics; normal config edits remain blocked until parsing is safe. |
| untrusted workspace | Offers an explicit workspace trust grant through reviewed apply. |
| state-not-writable | Shows state/config path permission guidance and blocks normal writes until state is writable. |

Configured, degraded, untrusted, and repair states use the Setup Editor. The internal `first-run` state uses the Onboarding Wizard runner. Read-only verification remains a separate route and does not write config, trust, state, or `.env`.

### Review, Apply, And Launch Safety

- The Onboarding Wizard builds a redacted manifest and apply plan internally after the user confirms the summary.
- The Setup Editor remains the advanced/reviewable configuration surface and may show technical review/manifest details.
- No wizard step writes secrets.
- No wizard step serializes raw secrets.
- No cancellation path writes secrets.
- No blocked apply writes secrets.
- Only reviewed apply execution writes secrets.
- Credential status may display only `Not set`, `Existing credential detected`, or `New credential pending`. It must not display raw values, prefixes, suffixes, lengths, hashes, partial keys, or token-derived identifiers.
- Credential repair stores route/auth references and env var names, not raw key values.
- Verification after apply is read-only.
- Workspace trust is required before EstaCoda can run in that workspace. If trust is deferred, setup may be saved, but launch is blocked with `Setup saved. Workspace trust is still required before EstaCoda can run here.`
- `Start EstaCoda now?` is a first-run onboarding post-success prompt after apply and verification, not a pre-apply setup preference.
- Onboarding launch reloads the selected profile config, reloads trust state, verifies workspace trust, rebuilds runtime from fresh config, and enters the normal interactive launcher. No pre-setup runtime state is reused.
- Onboarding launch requires verified-ready setup.
- Broken config, missing credential, untrusted workspace, state-not-writable, failed verification, and blocked verification do not expose a launch path.

Existing-user Setup Editor apply uses a separate handoff. The final review prompt is titled `Finalize configuration`, shows `Confirm selected configuration`, and includes a dynamic selected area such as `Channels · Telegram` or `Security`. The visible choices are `Confirm` (`Update your EstaCoda configuration`) and `Cancel` (`Keep your existing configuration unchanged.`). Cancel preserves existing config and writes no config or secret changes. Confirm still creates and applies the reviewed plan.

Setup Editor keeps review manifest details internal after the final review. User-facing output must not print the technical section headers `Review manifest.`, `Configuration write.`, `Enabled optional capabilities.`, or `Remote-control surfaces and allowed identities.` The runner result may still carry the redacted `reviewManifest` for inspection and tests.

After existing-user Setup Editor apply and verification, the flow returns with applied or verified output. It does not show `Setup next action`, does not output `Selected: Launch EstaCoda`, and does not hand off to `Launch EstaCoda`. First-run onboarding keeps its launch prompt.

### Provider And Optional Capability Boundaries

Primary provider/model setup and repair use the shared provider/model flow. That flow applies provider visibility, runnable/configurable gates, and credential boundaries owned by the provider layer.

The built-in `local` provider is displayed and documented as Local / private endpoint. It accepts local or private OpenAI-compatible endpoints such as Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, or internal gateways. Local endpoint setup keeps no-auth as the default and adds a credential-reference draft only when an optional API key is entered. Endpoint/base URL changes are provider-route changes, not credential-only mutations.

Codex OAuth setup is implemented on the model setup and Setup Editor route surfaces, not in the Onboarding Wizard. Onboarding Wizard copy must not imply it can complete Codex OAuth until it deliberately delegates to that flow.

The interactive model picker can configure Codex where the nested OpenAI choice is enabled: choose `OpenAI`, then choose `Codex`. `OpenAI Models` remains the API-key OpenAI path. `Codex` is the OAuth path and configures provider `codex`, default model `gpt-5.5`, auth method `oauth_device_pkce`, and Responses API mode (`openai_responses`) with no `apiKeyEnv`.

`estacoda model setup codex` remains the direct CLI setup path. It authenticates through OAuth device code, stores tokens in the selected profile's `auth.json`, and configures the `codex/gpt-5.5` route. Raw OAuth tokens are not printed. Route config remains separate from token storage.

The Setup Editor can configure Codex for primary and fallback model routes through reviewed apply. OAuth tokens from the Setup Editor are written only after review approval; cancelling review after OAuth does not persist tokens. Auxiliary model routes remain unchanged in this pass and do not introduce Codex OAuth setup.

Optional capabilities stay separate from the primary LLM route. In the Onboarding Wizard, the menu is limited to Channels, Voice STT/TTS, Browser, and Skip. Vision/image generation is intentionally absent from that menu.

The Setup Editor is the broader operator surface. It keeps technical review/manifest behavior and exposes capabilities that the Onboarding Wizard does not show, including Vision/image generation. Each Setup Editor capability creates its own single-module draft bundle through an independent action:

| Action | Setup behavior |
|--------|----------------|
| `configure-channels` | Remote-control surface. Setup requires token env var reference plus allowed user or chat identities before enable can apply. Creates a single-module draft bundle. |
| `configure-voice` | Optional/native voice configuration. Does not change the primary provider/model route. Creates a single-module draft bundle. |
| `configure-image-generation` | Optional/native image capability configuration. Does not change the primary provider/model route. Creates a single-module draft bundle. |
| `configure-browser` | Records backend, URL, or command references. Setup planning does not auto-launch a browser or open a CDP connection. Creates a single-module draft bundle. |

Skipping optional capabilities keeps core setup valid.

Direct provider/model flags remain as an advanced setup path:

```bash
estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
estacoda setup --advanced --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
```

These flags are compatibility/direct paths. They are not the preferred guided repair path for existing users.

Legacy runtime mutating onboarding tools are removed. The runtime no longer exposes `onboarding.status` or `onboarding.complete`; setup mutation stays behind reviewed CLI setup/apply.

Fallback routes are manageable through both the Setup Editor (`edit-fallback-model-route`) and `estacoda model fallback ...`. Auxiliary routes (including assessor, compression, session_search, memory_compaction, and profile_context) are configurable through the Setup Editor (`edit-auxiliary-model-route`). The Onboarding Wizard no longer offers the legacy backup-provider prompt.

**Arabic support:**
- Selector chrome is localized
- Technical tokens (provider names, paths, env vars, commands) remain in English with LTR isolation
- Full runtime CLI localization is **not** complete

## Profile Commands

Profiles isolate configuration, secrets, identity memory, skills, cron state, gateway state, logs, caches, and channel media under `~/.estacoda/profiles/<id>/`.

```bash
estacoda profile create <name>
estacoda profile list
estacoda profile use <name>
estacoda profile show [name]
estacoda profile delete <name>
estacoda profile rename <old> <new>
```

Behavior:

- `profile create <name>` creates the full profile skeleton. By default it copies `USER.md` and `MEMORY.md` from the active profile and creates a fresh empty `SOUL.md`.
- `profile create <name> --blank` creates empty memory files.
- `profile create <name> --from <profile> --files user,memory,soul` copies selected memory files from another profile.
- `profile use <name>` is the only normal command that updates `active-profile.json`.
- `profile show [name]` reports paths and model summary while redacting secret values.
- `profile delete <name>` refuses active or non-empty profiles unless `--force` is provided.
- `profile rename <old> <new>` updates the active profile record when the renamed profile was active.

## Settings / UI Foundation

Selected profile config supports:

| Setting | Values |
|---------|--------|
| `ui.language` | `en`, `ar` |
| `ui.flavor` | aesthetic flavor presets |
| `agent.mode` | behavior mode |
| `agent.responseLanguage` | response language policy |

**Evidence:** `smoke-tested`

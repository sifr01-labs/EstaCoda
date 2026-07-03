---
title: Quickstart
description: Install EstaCoda, run onboarding, and verify a working local session.
sidebar_position: 2
---

# Quickstart

This guide gets EstaCoda from a clean machine to a verified local session. Install it, run onboarding, configure one working provider/model setup, verify readiness, and start the CLI before adding channels, voice, browser, image generation, or other runtime surfaces.

## Who this is for

Use this page if you are:

- Installing EstaCoda for the first time
- Setting up one provider/model pair
- Verifying the CLI before enabling Telegram, WhatsApp, voice, browser, or image generation
- Recovering from an install that completed but does not produce a working session
- Preparing a source checkout for development

## The fastest path

Pick the row that matches your goal:

| Goal | Start here | Then |
|---|---|---|
| I want EstaCoda working locally | Install, then run `estacoda setup` | Accept the launch prompt or run `estacoda` |
| I already installed it | `estacoda verify` | Check `estacoda model status` |
| I ran `estacoda` and setup appears | Continue the setup prompt | Use `estacoda setup` if you exit early |
| I want Telegram or WhatsApp | Get one local CLI session working first | Configure channels after verification |
| I want voice, Search, browser, or image generation | Finish the base setup first | Add optional capabilities one at a time |
| I want to modify the source | Clone the repo | Run `./scripts/setup-estacoda.sh` |
| Something feels broken | `estacoda doctor` | Fix the first blocker before adding features |

If a normal local CLI session does not work, do not enable channels, voice, browser, image generation, or evolution surfaces yet. First get one clean local turn working.

---

## 1. Install EstaCoda

The default install path uses the public installer:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash
```

This creates a managed-source install under `~/.estacoda/estacoda`, builds the project, writes a wrapper to `~/.local/bin/estacoda`, and runs `estacoda init`.

If `~/.local/bin` is not on your `PATH`, add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. Run first-run onboarding

Start the reviewed setup flow:

```bash
estacoda setup
```

If you run bare `estacoda` before setup is complete, EstaCoda detects the incomplete state and guides you back to setup.

The Onboarding Wizard walks through the setup in this order:

| Step | What it does | Result |
|---|---|---|
| Language and interface style | Chooses setup language and terminal style | Setup uses the selected UI mode |
| Workspace | Selects the workspace path | EstaCoda knows where it is allowed to operate |
| Workspace trust | Sets trust for the selected directory | Tool behavior follows the trust decision |
| Provider endpoint and model | Chooses the primary provider/model setup, including local/custom endpoint URL when needed | A usable model configuration is ready |
| Credential handling | Stores, reuses, or skips credentials depending on provider auth | Secrets remain out of review output |
| Security mode | Chooses approval behavior | Risky actions require the configured approval level |
| Agent Evolution | Chooses learning behavior | Evolution behavior follows review settings |
| Optional capabilities | Channels, voice, Search, and browser setup | Extra surfaces are configured only when selected |
| Review and apply | Shows a final summary before writing | Changes are applied after confirmation |
| Verify and launch | Checks readiness and offers launch | You reach a local session |

Setup is reviewed before apply. The wizard shows a summary before committing configuration changes, and raw secrets are not displayed in review output.

The wizard includes `Back` on choice prompts where it helps correct a prior setup choice. Text and secret entry prompts keep their normal behavior.

First-run onboarding can configure Channels, Voice, Search, and Browser. Image generation, fallback models, and deeper provider configuration are available after the base setup through the Setup Editor and dedicated CLI commands.

## 3. Configure one working model

Choose one working provider/model pair first. For local or custom OpenAI-compatible servers such as Ollama, LM Studio, llama.cpp, or vLLM, select the Local / Custom Endpoint path and enter the endpoint URL when prompted. API keys are optional for that path. Do not configure fallback models, channels, or optional capabilities until the base setup verifies.

After setup, inspect the active model configuration:

```bash
estacoda model status
```

Profile state is written under:

```text
~/.estacoda/profiles/default/
```

## 4. Start your first session

If the setup wizard offers to launch EstaCoda, accept it. Otherwise run:

```bash
estacoda
```

Use a prompt that is easy to verify:

```text
Check this directory and tell me what kind of project this is.
Then list the first three files you would inspect next.
```

A working first session means:

| Check | What success looks like |
|---|---|
| Startup | EstaCoda starts without provider or model errors |
| Model configuration | `estacoda model status` shows the selected setup |
| First answer | The agent responds normally |
| Second turn | A follow-up works in the same session |
| Tools | `/tools` shows available tools or explains why tools are unavailable |
| Safety | Approvals or denials explain what happened |

## 5. Verify setup

Run these after the first session:

```bash
estacoda verify
estacoda model status
estacoda doctor
```

Use `estacoda doctor --live` only when the local setup looks correct but provider connectivity still fails.

## 6. Try the core controls

Inside a session:

| Command | Use |
|---|---|
| `/help` | Show available session commands |
| `/tools` | List available tools |
| `/model` | Inspect or change the session model configuration |
| `/status` | Show current session/runtime status |
| `/interrupt` | Cancel an active turn |
| `/exit` | Leave the session |

Type `/` to open the slash menu. Use `/help` inside a session to see the active controls for your installed version.

## 7. Add the next layer

Only add optional surfaces after the local CLI works.

| Next layer | Use when | Start with |
|---|---|---|
| Telegram | You want remote access from Telegram | [Channels](../user-guide/channels.md) |
| WhatsApp | You want QR-linked WhatsApp access | [Channels](../user-guide/channels.md) |
| Voice | You want STT/TTS | [Voice](../user-guide/voice.md) |
| Search | You want live web search from Brave or DDGS | [Provider Reference](../reference/provider-reference.md#web-research-providers) |
| Browser | You want browser-backed work | [Browser](../user-guide/browser.md) |
| Image generation | You want provider-backed image tools | [Image Generation](../user-guide/image-generation.md) |
| Skills | You want reusable task procedures | [Skills](../user-guide/skills.md) |
| MCP | You want external tool servers | [Tools](../user-guide/tools.md) |

## 8. Common failure modes

| Symptom | Likely cause | First fix |
|---|---|---|
| `estacoda` opens setup instead of a session | Setup is incomplete | Run `estacoda setup` |
| Setup completes but launch is blocked | Workspace trust was deferred | Re-run setup or trust the workspace |
| A model is configured but cannot answer | Missing or invalid credential | Run `estacoda model status`, then `estacoda setup` |
| Commands are missing after install | `~/.local/bin` is not on `PATH` | Add it to your shell profile and reload |
| Tools are unavailable | Tool policy or profile config does not expose them | Run `/tools` and `estacoda verify` |
| Channel messages do not arrive | Channel auth, allowlist, or platform setup is incomplete | Check channel docs and diagnostics |
| Behavior changed after edits | Profile config or trust state changed | Run `estacoda doctor` before changing more settings |

## 9. Recovery order

Use this order before manual debugging:

```bash
estacoda verify
estacoda model status
estacoda doctor
estacoda setup
```

Use `estacoda doctor --live` after that only if provider connectivity is still the suspected failure.

## 10. Advanced install paths

Install to a custom directory and skip the initial state bootstrap:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash -s -- --dir <path> --skip-init
```

If you plan to modify the source, clone the repo and run the setup script:

```bash
git clone https://github.com/sifr01-labs/EstaCoda.git
cd EstaCoda
./scripts/setup-estacoda.sh
```

This creates a manual-source install. The checkout is preserved during uninstall, and update operates in check-and-advise mode.

For all install paths, see [Installation](./installation.md).

## 11. Quick reference

| Command | Use |
|---|---|
| `estacoda` | Start an interactive session, or open setup if setup is incomplete |
| `estacoda setup` | Run reviewed onboarding, setup, or repair |
| `estacoda verify` | Check setup readiness |
| `estacoda model status` | Inspect active provider/model configuration |
| `estacoda doctor` | Health report and required fixes |
| `estacoda doctor --live` | Include live provider checks |
| `estacoda --help` | Show CLI help |

## What next

- [Installation](./installation.md) — install paths, OS support, and runtime requirements
- [CLI](../user-guide/cli.md) — sessions, slash commands, and terminal behavior
- [Doctor](../user-guide/doctor.md) — setup health checks and safe repairs
- [Providers](../user-guide/providers.md) — provider setup and maturity
- [Channels](../user-guide/channels.md) — Telegram and WhatsApp
- [State and Files](../reference/state-and-files.md) — where profile state lives
- [Troubleshooting](../reference/troubleshooting.md) — common repairs

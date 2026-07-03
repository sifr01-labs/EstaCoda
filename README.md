![EstaCoda banner](assets/estacoda-readme-banner.png)

# EstaCoda

[العربية](./README.ar.md)

Open-source runtime for Agent Evolution — the first of its kind built in the Arab world.

EstaCoda is a terminal-native AI agent that gets better from real work. It uses tools, remembers across sessions, runs through messaging channels, schedules recurring jobs, and turns repeated execution patterns into reusable skills and workflows.

Bring your own model. Run it locally, on a server, through Docker, or from WSL2. Use it from the terminal, Telegram, and gated WhatsApp. Discord and Email adapters are present for operators who validate them in their own deployment.

EstaCoda is built with Arabic as a first-class operating language, including shaped, bidirectional Arabic rendering for terminal workflows.

When EstaCoda proposes changes to its own harness, they stay reviewable: evidence, hypothesis, approval, and rollback — not silent mutation.

Built by SIFR01.

---

## Why EstaCoda

| If you want... | EstaCoda gives you... |
|---|---|
| An agent that improves over time | Skills, memory, workflows, and reviewable improvement proposals based on real execution patterns. |
| A real operator terminal | CLI sessions with tool execution, approvals, profile state, durable history, and shaped bidirectional Arabic rendering. |
| An agent that follows you | CLI and Telegram as the strongest channels, gated WhatsApp through an isolated bridge, and Discord/Email adapters for operator-validated deployments. |
| Work that runs without babysitting | Cron jobs and durable workflows that can run unattended and deliver results back to you. |
| Model freedom | OpenRouter, Kimi, DeepSeek, OpenAI, Google, local/custom endpoints, and other configured providers. |
| More than chat | Web research, browser automation, hosted voice providers, image generation, files, shell commands, and tool workflows. |
| Power without mystery mutation | Explicit proposals, evidence, approval, rollback, and hard safety boundaries. |

---

## The Agent Evolution Loop

1. Give EstaCoda real work.
2. It uses tools, memory, skills, browser automation, shell commands, scheduled jobs, and channel delivery as needed.
3. When a useful pattern repeats, it can propose a reusable skill, workflow, or harness improvement.
4. You review the evidence, approve the change, revise it, or reject it.
5. Future sessions start with more useful context and reusable capability than the last one.

---

## Example Uses

```text
"Every morning, check my orders, supplier emails, and delivery issues. Send me a Telegram summary in Arabic with anything that needs action."

"Monitor customer messages from Telegram and email, group them by issue, and draft replies in Arabic and English."

"Compare payment gateways for an online store selling across Egypt, Saudi Arabia, and the UAE. Check pricing, settlement times, local support, and integration effort."

"Watch competitor websites and social pages across the GCC, Egypt, and Jordan. Summarize new products, pricing changes, and campaigns every Sunday."

"Track this GitHub repo and tell me what changed before our weekly release meeting. Turn the release checklist into a reusable workflow."

"Research packaging suppliers in Cairo, Riyadh, Casablanca, and Dubai. Compare minimum order quantities, lead times, and estimated cost."

"Prepare a weekly sales follow-up list from my email threads. Separate hot leads, blocked deals, and people who need a reminder."

"Watch property listings in Riyadh, Cairo, Amman, and Dubai. Alert me when prices change or a comparable unit appears."

"Track tenders and procurement announcements in my sector. Summarize relevant opportunities and deadlines each week."

"Research cafés, clinics, or boutiques launching new branches in my city. Build a short partnership or sales prospect list."
```

---

## Quick Install

macOS, Linux, WSL2, and Termux:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash
```

The installer creates a managed-source install, symlinks a wrapper to `~/.local/bin/estacoda`, and adds PATH to your shell rc if needed. After installation, reload your shell or open a new terminal.

For the full setup flow, see the [Quickstart](https://www.estacoda.com/docs/getting-started/quickstart).

---

## First Run

```bash
estacoda init    # create the default profile and state directories
estacoda setup   # configure provider, model, security mode, and optional channels
estacoda         # start an interactive session
```

`estacoda setup` walks through provider selection, endpoint or credential setup where needed, security mode, and optional capabilities. It shows the proposed configuration before anything is written.

---

## Common Commands

```bash
estacoda                       # start a terminal session
estacoda init                  # initialize profile and state directories
estacoda setup                 # run the interactive setup wizard
estacoda update                # update using the current install method
estacoda update --check        # check for updates without modifying files
estacoda uninstall             # remove install code and wrappers; keep user data
estacoda uninstall --purge     # remove install code and user data
estacoda whatsapp              # start the WhatsApp setup wizard
```

For the full command surface, see [CLI Commands](https://www.estacoda.com/docs/reference/cli-commands).

---

## Capability and Maturity

EstaCoda distinguishes between live-proven, configurable, experimental, and emerging functionality. The root README gives the short version; the docs contain the full setup and troubleshooting details.

### LLM Providers

| Provider | Maturity |
|---|---|
| OpenAI | Live-proven |
| Kimi | Live-proven |
| DeepSeek | Live-proven |
| OpenRouter | Live-proven |
| Google | Configurable |
| Local / custom endpoint | Supported through OpenAI-compatible local or custom endpoints, with optional API key auth |

Use the built-in `local` provider for Ollama, LM Studio, llama.cpp, vLLM, or another OpenAI-compatible local/custom endpoint. Custom OpenAI-compatible providers remain available when you need a separate named provider ID with an explicit `baseUrl`. Catalog-known providers are not automatically runnable; check the provider reference before treating one as a primary route.

### Channels

| Channel | Maturity |
|---|---|
| CLI | Primary |
| Telegram | Live-proven |
| WhatsApp | Operational with external API risk; gated by `channels.whatsapp.experimental: true` |
| Discord | Implemented and test-backed; operator validation required |
| Email | Implemented and test-backed; operator validation required |

WhatsApp uses an isolated Baileys bridge under `scripts/whatsapp-bridge/`. The bridge dependencies are managed separately and are not part of the root pnpm workspace. See the channel docs for setup, authorization, pairing, and delivery behavior.

### Other Capabilities

| Capability | Status |
|---|---|
| Arabic terminal support | Supported with shaped, bidirectional Arabic rendering for terminal workflows. |
| Browser automation | Local CDP is supported, including supervised Chrome/Chromium auto-launch. Browserbase is implemented behind explicit cloud spend approval. |
| Web research | Guarded built-in fetch/extraction is supported. Additional search providers are registered but not all are live-supported. |
| Voice | Hosted TTS and hosted STT are supported. Local STT defaults to managed faster-whisper under `~/.estacoda/python-env`. |
| Image generation | FAL and BytePlus/Seedream are supported. |
| Cron scheduling | Supported. |
| Workflow durable execution | Supported. |
| Skills | Supported. |
| Memory | Supported. |

---

## Supported Platforms

| Platform | Status |
|---|---|
| macOS 11+ | Supported |
| Linux | Supported; validated on Ubuntu 22.04+ and Debian 12+ |
| Docker | Supported in Docker-capable environments |
| WSL2 | Best-effort; voice/microphone and systemd user services may have edge cases |
| Termux | Best-effort; resolves `$PREFIX/bin` layout, not a primary validation target |
| Native Windows | Unsupported |

---

## Requirements

### Core requirements

- Node.js >= 22.18.0
- pnpm via Corepack or equivalent
- Git
- POSIX shell

### Optional by install path or feature

- Docker for container usage
- Homebrew for the Homebrew install path
- ffmpeg for some media and voice delivery flows

---

## State and Profiles

EstaCoda stores user state under `~/.estacoda/`.

| State | Contents |
|---|---|
| Global state | Active profile, trust records, sessions database, update cache |
| Profile state | Configuration, credentials, memory files, skills, cron jobs, gateway settings, logs |

The active profile is selected in:

```bash
~/.estacoda/active-profile.json
```

Profiles own their configuration, credentials, memory, gateway state, and logs.

See [State and Files](https://www.estacoda.com/docs/reference/state-and-files) for the full state model.

---

## Safety Boundaries

EstaCoda is designed for powerful agent workflows, but it keeps high-impact changes explicit.

- Setup shows the proposed configuration before writing it.
- Hard safety blocks remain active in all security modes.
- `open` mode is not “security off.”
- Updates mutate only install locations owned by the selected install method.
- Managed installs require installer ownership stamps before removing install code.
- User data is preserved by default during uninstall.
- Harness improvements require reviewable proposals rather than silent self-mutation.

See [Security and Approvals](https://www.estacoda.com/docs/user-guide/security-and-approvals) for the full model.

---

## Documentation

All documentation lives at [www.estacoda.com/docs](https://www.estacoda.com/docs/).

| Section | What's Covered |
|---|---|
| [Quickstart](https://www.estacoda.com/docs/getting-started/quickstart) | Install, setup, and first session |
| [Installation](https://www.estacoda.com/docs/getting-started/installation) | Install paths and OS support |
| [Updating](https://www.estacoda.com/docs/getting-started/updating) | Update commands, routing, and safety |
| [Uninstall](https://www.estacoda.com/docs/getting-started/uninstall) | Removal behavior and data boundaries |
| [CLI Usage](https://www.estacoda.com/docs/user-guide/cli) | Commands, sessions, profiles |
| [Providers](https://www.estacoda.com/docs/user-guide/providers) | Provider setup, maturity, and routing |
| [Channels](https://www.estacoda.com/docs/user-guide/channels) | Telegram, WhatsApp, and channel setup |
| [Gateway](https://www.estacoda.com/docs/user-guide/gateway) | Service mode, diagnostics, approvals |
| [Skills](https://www.estacoda.com/docs/user-guide/skills) | Loading, evolution, and proposals |
| [Memory](https://www.estacoda.com/docs/user-guide/memory) | Profile memory, promotion, and limits |
| [Security and Approvals](https://www.estacoda.com/docs/user-guide/security-and-approvals) | Modes, trust boundaries, and hard blocks |
| [Configuration](https://www.estacoda.com/docs/reference/configuration) | Config file reference |
| [CLI Commands](https://www.estacoda.com/docs/reference/cli-commands) | Full command and flag reference |
| [Troubleshooting](https://www.estacoda.com/docs/reference/troubleshooting) | Common failures and recovery |

---

## Contributor Install

```bash
git clone https://github.com/sifr01-labs/EstaCoda.git
cd EstaCoda
./scripts/setup-estacoda.sh
```

The setup script installs dependencies, builds the project, and offers to symlink a local wrapper. This creates a manual-source install.

After setup:

```bash
estacoda init
estacoda setup
estacoda
```

Before opening a pull request, run the project validation commands documented in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Updating

```bash
estacoda update
```

Update behavior follows the install method:

| Install method | Behavior |
|---|---|
| managed-source | Guarded git pull, dependency reinstall, build, validation, and rollback on build failure |
| manual-source | Check and advise only; no self-mutation |
| Homebrew | Routes to `brew upgrade` |
| Docker | Routes to `docker pull` |
| npm | Routes to `npm install -g estacoda@latest` once published |

Useful flags:

```bash
estacoda update --check    # report availability without modifying files
estacoda update --yes      # apply without interactive confirmation where safe
estacoda update --gateway  # run in non-interactive service mode
```

Startup update checks are enabled by default. They run as non-blocking background prefetches in interactive CLI sessions, use a six-hour cache, and fail silently on network errors.

See [Updating](https://www.estacoda.com/docs/getting-started/updating) for the full update surface.

---

## Uninstalling

```bash
estacoda uninstall               # remove install code and wrappers; keep user data
estacoda uninstall --purge --yes  # also remove user data
```

Default uninstall preserves `~/.estacoda`.

Managed-source directories are removed only when a valid installer stamp proves ownership. Manual-source checkouts are preserved. Package-manager and container installs are routed to their respective tools rather than self-mutated.

See [Uninstall](https://www.estacoda.com/docs/getting-started/uninstall) for method-specific behavior and ownership rules.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, branch workflow, validation commands, and contribution rules.

See [AGENTS.md](./AGENTS.md) for guidance when using AI coding assistants with this codebase.

See [SECURITY.md](./SECURITY.md) for the security model, vulnerability reporting process, and supported versions.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

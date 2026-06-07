![EstaCoda banner](assets/estacoda-readme-banner.png)

# EstaCoda

The first open-source agentic harness built in the Middle East, designed for governed self-evolution.

EstaCoda is a terminal-native runtime that executes tools, preserves durable sessions across channels, and improves its own harness through operator-approved proposals. It does not silently mutate itself. Every proposed change carries evidence, a hypothesis, and a rollback path.

It runs on macOS, Linux, Docker, and WSL2. It does not require a cloud account or a dashboard.

---

## Quick Install

macOS, Linux, WSL2, Termux:

```bash
curl -fsSL https://estacoda.kemetresearch.com/install.sh | bash
```

The installer creates a managed-source install, symlinks a wrapper to `~/.local/bin/estacoda`, and adds PATH to your shell rc if needed. After installation, reload your shell or open a new terminal.

---

## First Run

```bash
estacoda init    # create default profile and state directories
estacoda setup   # configure provider, model, security mode, optional channels
estacoda         # start a session
```

`estacoda setup` walks through provider selection, API key storage, security mode, and optional capabilities. Review the proposed configuration before anything is written. Setup is read-only until you approve it.

For the full quickstart, see the [documentation site](https://estacoda.kemetresearch.com/docs/getting-started/quickstart).

---

## Contributor Install

```bash
git clone https://github.com/KemetResearch/EstaCoda.git
cd EstaCoda
./scripts/setup-estacoda.sh
```

The setup script installs dependencies, builds the project, and offers to symlink a local wrapper. This creates a manual-source install. Run `estacoda init` and `estacoda setup` after the script finishes.

---

## Update

```bash
estacoda update
```

Updates follow the install method:

- **managed-source** (curl installer): guarded git pull, dependency reinstall, build, and validation. Automatic rollback on build failure.
- **manual-source** (git clone): check and advise only. No self-mutation.
- **Homebrew**: routes to `brew upgrade`.
- **Docker**: routes to `docker pull`.
- **npm**: routes to `npm install -g estacoda@latest` once published.

`estacoda update --check` reports availability without modifying files. `estacoda update --yes` applies without interactive confirmation where safe. `estacoda update --gateway` runs in non-interactive service mode.

Startup update checks are enabled by default: non-blocking background prefetch with a six-hour cache. They run only in interactive CLI sessions and fail silently on network errors.

See [Updating](https://estacoda.kemetresearch.com/docs/getting-started/updating) for the full command surface and safety boundaries.

---

## Uninstall

```bash
estacoda uninstall              # remove install code and wrappers; keep user data
estacoda uninstall --purge --yes # also remove user data
```

Default uninstall preserves `~/.estacoda`. Managed-source directories are removed only when a valid installer stamp proves ownership. Manual-source checkouts are preserved. Package-manager and container installs are routed to their respective tools rather than self-mutated.

See [Uninstall](https://estacoda.kemetresearch.com/docs/getting-started/uninstall) for method-specific behavior and ownership rules.

---

## Supported Platforms

| Platform | Status |
|---|---|
| macOS 11+ | Supported |
| Linux (systemd, glibc) | Supported — validated on Ubuntu 22.04+ and Debian 12+ |
| Docker | Supported — any Docker-capable environment |
| WSL2 | Best-effort — voice/microphone and systemd user services have edge cases |
| Termux | Best-effort — resolves `$PREFIX/bin` layout; not a primary validation target |
| Native Windows | Unsupported |

---

## Runtime Requirements

- **Node.js >= 22.18.0**
- **pnpm** via Corepack or equivalent
- **Git** (for source install and update flows)
- **POSIX shell** (for curl installer and setup scripts)
- **Docker** (for container usage)
- **Homebrew** (for Homebrew install path)

---

## Capability and Maturity

### LLM Providers

| Provider | Maturity |
|---|---|
| OpenAI | Live-proven |
| Kimi | Live-proven |
| DeepSeek | Live-proven |
| OpenRouter | Live-proven |
| Codex | Implemented — public setup path via `estacoda model setup codex`; excluded from the Onboarding Wizard by design |
| Google | Configurable |
| Anthropic | Catalog-known, not runnable in this build |
| MiniMax | Catalog-known, not runnable in this build |
| Nous | Catalog-known, not runnable in this build |

Custom OpenAI-compatible providers work with an explicit `baseUrl`.

### Channels

| Channel | Maturity |
|---|---|
| CLI | Supported direct interaction surface |
| Telegram | Live-proven |
| Discord | Present, not live-proven |
| Email | Present, not live-proven |
| WhatsApp | Experimental-only — gated behind `experimental: true` |

### Other Capabilities

- **Browser automation**: local CDP is supported, including supervised Chrome/Chromium auto-launch. Browserbase is implemented behind explicit cloud spend approval. browser-use, Firecrawl, and Camofox remain registered deferred providers.
- **Web research**: guarded built-in fetch/extraction is supported. Firecrawl, Parallel, Tavily, Exa, SearXNG, Brave, and DDGS are registered but not live-supported.
- **Voice**: hosted TTS (OpenAI, ElevenLabs, MiniMax, Gemini, xAI) and hosted STT (OpenAI, Groq, xAI) are supported. Local STT defaults to managed faster-whisper under `~/.estacoda/python-env`; command-mode local STT remains an explicit `stt.local.engine: "command"` opt-in. Local TTS and Mistral voice remain deferred.
- **Image generation**: FAL and BytePlus/Seedream are supported.
- **Cron scheduling**, **TaskFlow durable execution**, **skills**, and **memory** are supported.

---

## State and Safety

EstaCoda stores user state under `~/.estacoda/`:

- Global state: active profile, trust records, sessions database, update cache.
- Profile state: configuration, credentials, memory files, skills, cron jobs, gateway settings, logs.

Profiles own their configuration, credentials, memory, gateway state, and logs. The active profile is selected in `~/.estacoda/active-profile.json`.

Hard safety blocks remain active in all security modes. `open` mode is not "security off." Updates and uninstall obey ownership boundaries: managed installs mutate only stamped directories, and user data is never destroyed by default.

See [State and Files](https://estacoda.kemetresearch.com/docs/reference/state-and-files) and [Security and Approvals](https://estacoda.kemetresearch.com/docs/user-guide/security-and-approvals) for the full model.

---

## Documentation

All documentation lives at [estacoda.kemetresearch.com/docs](https://estacoda.kemetresearch.com/docs/):

| Section | What's Covered |
|---|---|
| [Quickstart](https://estacoda.kemetresearch.com/docs/getting-started/quickstart) | Install, setup, and first session |
| [Installation](https://estacoda.kemetresearch.com/docs/getting-started/installation) | All install paths and OS support |
| [Updating](https://estacoda.kemetresearch.com/docs/getting-started/updating) | Update commands, routing, and safety |
| [Uninstall](https://estacoda.kemetresearch.com/docs/getting-started/uninstall) | Removal behavior and data boundaries |
| [CLI Usage](https://estacoda.kemetresearch.com/docs/user-guide/cli) | Commands, sessions, profiles |
| [Providers](https://estacoda.kemetresearch.com/docs/user-guide/providers) | Setup, maturity, and routing |
| [Channels](https://estacoda.kemetresearch.com/docs/user-guide/channels) | Telegram, Discord, Email, WhatsApp |
| [Gateway](https://estacoda.kemetresearch.com/docs/user-guide/gateway) | Service mode, diagnostics, approvals |
| [Skills](https://estacoda.kemetresearch.com/docs/user-guide/skills) | Loading, evolution, and proposals |
| [Memory](https://estacoda.kemetresearch.com/docs/user-guide/memory) | Profile memory, promotion, and limits |
| [Security and Approvals](https://estacoda.kemetresearch.com/docs/user-guide/security-and-approvals) | Modes, trust boundaries, and hard blocks |
| [Configuration](https://estacoda.kemetresearch.com/docs/reference/configuration) | Config file reference |
| [CLI Commands](https://estacoda.kemetresearch.com/docs/reference/cli-commands) | Full command and flag reference |
| [Troubleshooting](https://estacoda.kemetresearch.com/docs/reference/troubleshooting) | Common failures and recovery |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, branch workflow, validation commands, and contribution rules.

See [SECURITY.md](./SECURITY.md) for the security model, vulnerability reporting process, and supported versions.

See [AGENTS.md](./AGENTS.md) for guidance when using AI coding assistants with this codebase.

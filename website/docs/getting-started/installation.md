---
title: Installation
description: Install EstaCoda via curl, git clone, npm, Homebrew, or Docker.
sidebar_position: 3
---

# Installation

EstaCoda installs as a command-line agent system with explicit install ownership. The installer detects your platform, validates dependencies, builds from source, and stamps the install method so that future updates and uninstalls know what they are dealing with.

## Installer architecture

The installation surface has three layers:

| Layer | Role | URL |
|---|---|---|
| Public entrypoint | Stable URL advertised in docs | `https://www.estacoda.com/install.sh` |
| Repo installer | Actual installer logic | `scripts/install.sh` in the EstaCoda repository |
| Direct-source fallback | Raw GitHub URL for debug/pre-release | `https://raw.githubusercontent.com/sifr01-labs/EstaCoda/main/scripts/install.sh` |

The public entrypoint is a thin launcher that downloads `scripts/install.sh` from the repo and executes it. The installer implementation does not depend on `www.estacoda.com`. That would create circular ownership.

## Supported platforms

| OS | Status | Notes |
|---|---|---|
| macOS 11+ | Supported | Floor driven by Node.js 22.18.0 runtime contract |
| Linux (systemd, glibc) | Supported | Validated on Ubuntu 22.04+, Debian 12+. FHS root layout supported for root installs. |
| Docker | Supported | Any Docker-capable environment |
| WSL2 | Best-effort | Node/pnpm stack runs; voice/microphone and systemd user services have edge cases |
| Termux | Best-effort | Installer resolves `$PREFIX/bin` layout; not a primary validation target |
| Native Windows | Unsupported | Not part of the v0.1.0 support surface |

## Runtime requirements

- Node.js >= 22.18.0
- pnpm (via Corepack or manual install)
- Git (for source install and update flows)
- POSIX shell (for curl installer and setup scripts)
- Docker (for container usage)
- Homebrew (for Homebrew install path)

## Install paths

### curl | bash (default)

The canonical quickstart command:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash
```

With flags:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash -s -- --dir <path> --skip-init
```

This creates a **managed-source** install. The installer:

1. Detects platform and validates Node.js >= 22.18.0
2. Ensures pnpm is available
3. Clones the repo into `~/.estacoda/estacoda` (or a custom `--dir`)
4. Builds `dist/` with `pnpm install --frozen-lockfile && pnpm run build`
5. Writes a bash wrapper to `~/.local/bin/estacoda`
6. Stamps `.install-method.json` with `method: managed-source`
7. Runs `estacoda init` unless `--skip-init` is provided

If the directory already contains a managed-source install with a matching stamp, the installer updates it with `git fetch`, `git checkout`, and `git pull --ff-only` instead of re-cloning.

**Direct-source fallback** (for debug or pre-release testing):

```bash
curl -fsSL https://raw.githubusercontent.com/sifr01-labs/EstaCoda/main/scripts/install.sh | bash
```

### git clone + setup script (contributor path)

For developers who want to work on the source:

```bash
git clone https://github.com/sifr01-labs/EstaCoda.git
cd EstaCoda
./scripts/setup-estacoda.sh
```

This creates a **manual-source** install. The setup script:

1. Validates Node.js and pnpm
2. Builds `dist/`
3. Writes a bash wrapper to `~/.local/bin/estacoda`
4. Stamps `.install-method.json` with `method: manual-source`
5. Runs `estacoda init` unless `--skip-init` is provided

Manual-source installs are treated as contributor checkouts. `estacoda update` checks and advises but does not self-mutate.

### npm global (release target)

```bash
npm install -g estacoda
```

npm global install is a v0.1.0 launch requirement. The package metadata is publish-ready (`private: false`, `repository` field set, `bin.estacoda` configured). The actual publication happens at release time. Until then, treat this path as release-target documentation.

npm global installs are managed by npm. `estacoda update` routes them to `npm install -g estacoda@latest` and does not attempt source mutation.

### Homebrew

```bash
brew install kemetresearch/tap/estacoda
```

Homebrew builds from the GitHub source tarball using Node and Corepack/pnpm. The formula lives in the external `KemetResearch/homebrew-tap` repository. `estacoda update` routes Homebrew installs to `brew upgrade kemetresearch/tap/estacoda`.

### Docker

```bash
docker run ghcr.io/kemetresearch/estacoda:v0.1.0
```

Docker images are published to GHCR. `estacoda update` routes Docker installs to `docker pull ghcr.io/kemetresearch/estacoda:latest`. The CLI does not mutate the container filesystem.

## Install ownership modes

EstaCoda distinguishes six install ownership modes. The update and uninstall commands route behavior based on the detected mode.

| Mode | How created | Self-update? | Uninstall behavior |
|---|---|---|---|
| `managed-source` | curl \| bash installer | Yes (guarded git pull) | Removes managed dir, wrappers, PATH entries; preserves user data |
| `manual-source` | git clone + setup script | No (check and advise only) | Removes wrappers/PATH entries; preserves clone and user data |
| `npm-global` | `npm install -g estacoda` | No (routed to npm) | Prints `npm uninstall -g estacoda` |
| `pnpm-global` | `pnpm add -g estacoda` | No (routed to pnpm) | Prints `pnpm remove -g estacoda` |
| `homebrew` | `brew install` | No (routed to brew) | Prints `brew uninstall estacoda` |
| `docker` | `docker run` | No (routed to docker pull) | Prints container/image guidance |
| `unknown` | Could not detect | No | Removes wrappers/PATH entries best-effort |

## Installer flags

Flags for `scripts/install.sh` (passed via `bash -s --` when using curl):

| Flag | Behavior |
|---|---|
| `--branch <branch>` | Clone or update from this branch (default: `main`) |
| `--dir <path>` | Custom managed source directory |
| `--skip-init` | Do not run `estacoda init` after building |
| `--fhs` | Use Linux FHS paths: `/usr/local/lib/estacoda` and `/usr/local/bin/estacoda` |
| `-h, --help` | Show help without changing files |

The setup script (`scripts/setup-estacoda.sh`) supports `--skip-init` and `--help` only.

## Validation

Repo-side validation scripts test install behavior using temporary homes and prefixes. They do not write to the real `~/.estacoda`.

```bash
pnpm run validate:install        # full matrix
pnpm run validate:source-install # source installer focus
pnpm run validate:uninstall      # uninstall behavior focus
pnpm run validate:docker         # Docker image build/run
pnpm run validate:homebrew       # formula syntax check
pnpm run verify:package-bin      # npm pack contents verification
```

Docker and Homebrew checks are skipped when the dependencies are unavailable, unless `ESTACODA_REQUIRE_DOCKER=1` or `ESTACODA_REQUIRE_HOMEBREW=1` is set.

## Troubleshooting

**"Node.js >= 22.18.0 is required"**
Install Node.js 22.18.0 or newer. The installer does not install Node for you.

**"pnpm is required"**
Enable Corepack (`corepack enable`) or install pnpm manually.

**"Refusing to overwrite non-empty unmanaged directory"**
The target directory exists and is not stamped as a managed-source install. Choose a different `--dir` or remove the directory first.

**"Refusing to update because it is not stamped as this managed-source install"**
The directory contains a git repo but the `.install-method.json` stamp does not match the current source URL and branch. This protects manual checkouts from being overwritten.

**Wrapper not on PATH**
The installer writes the wrapper to `~/.local/bin/estacoda` (or `$PREFIX/bin/estacoda` on Termux). Add the bin directory to your PATH if it is not already there.

## Related docs

- [Quickstart](./quickstart.md) — get to a first working command
- [Uninstall](./uninstall.md) — remove EstaCoda safely
- [Updating](./updating.md) — update behavior and routing
- [State and Files](../reference/state-and-files.md) — where install stamps and state live

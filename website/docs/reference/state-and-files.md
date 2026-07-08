---
title: State and Files
description: Global and profile-local state paths.
sidebar_position: 7
---

# State and Files

EstaCoda stores state in two scopes: global (under `~/.estacoda/`) and profile-local (under `~/.estacoda/profiles/<profile-id>/`). The active profile is tracked globally; everything else is owned by the selected profile.

## Global state

Default root: `~/.estacoda/`

| Path | Purpose | Created by |
|------|---------|------------|
| `active-profile.json` | Active profile pointer | `estacoda init`, `estacoda profile switch` |
| `trust.json` | Workspace trust grants | `estacoda workspace trust` |
| `workspace-approvals.json` | Workspace approval grants | Approval commands |
| `sessions.sqlite` | Global session database with `profile_id` scoping | Runtime initialization |
| `update-cache.json` | Update check cache (global, 6-hour TTL) | Startup prefetch, update command |
| `packs/registry.jsonl` | Global pack cache | Pack operations |
| `memory/shared/` | Global shared memory snippets | Memory operations |
| `python-env/` | Managed Python virtual environment for local faster-whisper STT | `estacoda voice setup --stt-provider local` |
| `cache/huggingface/` | Default faster-whisper / Hugging Face model cache | Runtime faster-whisper STT |
| `cache/pip/` | pip cache constrained under EstaCoda state for managed local STT setup | Managed Python setup |
| `logs/update.log` | Update operation log (gateway mode and managed-source updates) | Update command |
| `.backups/<label>/` | User-state backups before managed-source mutation | `estacoda update` |

Global state is not deleted when a profile is removed. If you want a clean slate, delete the global root. Backup your sessions database first if you care about history.

The managed local STT venv and model cache are intentionally separate:

```text
~/.estacoda/python-env
~/.estacoda/cache/huggingface
```

The model cache does not live inside the venv. Removing one does not repair the other; rerun `estacoda voice setup --stt-provider local` to recreate the managed Python environment.

## Managed Python environments

Managed Python capability environments live under the EstaCoda state root.

```text
<stateRoot>/python-envs/<capability-id>/
<stateRoot>/python-envs/<capability-id>/env.json
<stateRoot>/cache/pip/<capability-id>/
```

The virtualenv path stores the Python environment for one registered capability. The manifest records the installed spec hash, package list, optional groups, paths, timestamps, and verification status. The pip cache is scoped per capability.

These paths are not profile-local. Profile-local skill state, temporary caches, and user-facing artifacts are separate concerns.

Local faster-whisper STT keeps its existing managed environment path for compatibility. It is not silently moved to the generic capability path.

## Install-local state

Source install directories may contain an `.install-method.json` stamp that proves install ownership. EstaCoda uses this stamp to decide whether a checkout is `managed-source` (installer-owned, may be mutated by update) or `manual-source` (contributor-owned, never self-mutated).

| Path | Purpose | Created by |
|------|---------|------------|
| `.install-method.json` | Install method stamp: method, source URL, branch, installDir | Installer (`scripts/install.sh`, `scripts/setup-estacoda.sh`) |

## Profile-local state

Profile root: `~/.estacoda/profiles/<id>/`

| Path | Purpose | Created by |
|------|---------|------------|
| `config.json` | Selected profile runtime configuration | `estacoda init`, `estacoda setup`, manual edit |
| `.env` | Selected profile secrets | Setup flows, secret store |
| `auth.json` | Selected profile OAuth auth state | Codex OAuth setup |
| `USER.md` | Profile user preferences and communication style | Memory promotion, `memory.curate` |
| `SOUL.md` | Profile identity and safety memory | `memory.curate` |
| `MEMORY.md` | Profile learned facts and conventions | Memory promotion, `memory.curate` |
| `promotions.json` | Promotion metadata | Memory promotion |
| `memory-curation.json` | Memory curation checkpoint history | Runtime curation checkpoints, `/memory populate` |
| `gateway/` | Gateway state: sessions, approvals, voice mode, handoff codes | Gateway runtime |
| `cron/jobs.json` | Cron job definitions | `estacoda cron create` |
| `skills/` | Profile-installed skills | Skill operations, learning |
| `skills/.usage.json` | Skill usage telemetry | Runtime |
| `skills/.evolution/` | Skill evolution proposals and manifests | Skill evolution |
| `logs/` | Profile logs | Gateway, runtime |
| `channel-media/` | Channel attachment downloads | Gateway adapters |
| `audio-cache/` | Audio cache | Voice tools |
| `image-cache/` | Generated and edited image cache | `image.generate`, `image.edit` |
| `temp/` | Temporary files | Various operations |
| `temp/delegation/` | Bounded delegation timeout/stale-heartbeat diagnostics when enabled | Delegation runtime |
| `temp/audio/` | CLI recordings, auto-TTS temps, Telegram conversion, Discord receive audio | Voice operations |
| `external-memory/` | File-backed external memory records | External memory (if enabled) |

Delegation also writes session rows/events to `sessions.sqlite`. Child sessions are linked with `parentSessionId`. Delegation outcomes are stored as bounded session/result and trajectory telemetry, not through canonical prompt memory. Stale-file warnings are session/result metadata and do not store file contents or diffs.

## Ownership rule

- Global files are shared across all profiles.
- Profile-local files belong to exactly one profile.
- Commands that create state report which profile owns the change.
- Commands that inspect state require the selected profile or an explicit `--profile` flag.

## Recovery and inspection

```bash
# See which profile is active
cat ~/.estacoda/active-profile.json

# Inspect profile config
estacoda config show

# List all profiles
estacoda profiles list

# Check a specific profile's state tree
ls -la ~/.estacoda/profiles/work/

# View logs for the selected profile
tail -f ~/.estacoda/profiles/work/logs/gateway.log
```

## What not to do

- Do not edit `sessions.sqlite` directly unless you know the schema.
- Do not copy `.env` files between profiles without updating the paths and secrets.
- Do not delete `gateway/` while the gateway is running; stop the gateway first.
- Do not delete `.install-method.json` unless you intend to convert a `managed-source` install to `manual-source`.
- Do not hand-edit `update-cache.json`; it is a machine-generated cache.

## Related docs

- [Configuration](./configuration.md) — config file content
- [Environment Variables](./environment-variables.md) — env var storage
- [Profiles](../user-guide/profiles.md) — profile management
- [Memory](../user-guide/memory.md) — memory file behavior

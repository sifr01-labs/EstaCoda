---
title: Profiles
description: Profile creation, switching, and operational boundaries for v0.1.0.
sidebar_position: 3
---

# Profiles

Profiles are operational boundaries, not cosmetic preferences. Each profile isolates configuration, credentials, memory, skills, cron state, gateway state, and logs. Switching profiles switches the entire runtime context.

This page explains how profiles work, where their state lives, and what happens when you get the active profile wrong.

---

## What Profiles Are

A profile is a directory under `~/.estacoda/profiles/<profile-id>/` that contains a complete self-contained runtime context. When you select a profile, EstaCoda loads its config, credentials, memory, skills, and session database. Nothing leaks between profiles.

Profiles are for multi-context usage: different providers, different workspaces, different identities, different security postures. They are not lightweight themes.

---

## Profile-Local Paths

```
~/.estacoda/profiles/<profile-id>/
  config.json              # Runtime configuration
  .env                     # Credential environment variables (0600)
  auth.json                # OAuth tokens and auth state
  USER.md                  # User preferences and style
  SOUL.md                  # Agent identity
  MEMORY.md                # Facts, conventions, lessons
  promotions.json          # Promotion metadata
  skills/                  # Profile-local skills
  cron/                    # Cron job state
  gateway/                 # Gateway state and logs
    logs/
    state/
  external-memory/         # File-backed external memory
  .memory-file-compaction-backups/  # Compaction backups
```

The active profile is recorded in:

```
~/.estacoda/active-profile.json
```

---

## Profile Commands

```bash
# Create a profile
estacoda profile create <name>

# Create an empty profile
estacoda profile create <name> --blank

# Copy memory files from another profile
estacoda profile create <name> --from <profile> --files user,memory,soul

# List profiles
estacoda profile list

# Switch active profile
estacoda profile use <name>

# Show profile details (redacts secrets)
estacoda profile show [name]

# Delete a profile
estacoda profile delete <name>

# Rename a profile
estacoda profile rename <old> <new>
```

Behavior:

- `profile create` copies `USER.md` and `MEMORY.md` from the active profile by default and creates a fresh empty `SOUL.md`.
- `profile create --blank` creates empty memory files.
- `profile use` is the only normal command that updates `active-profile.json`.
- `profile show` reports paths and model summary while redacting secret values.
- `profile delete` refuses active or non-empty profiles unless `--force` is provided.
- `profile rename` updates the active profile record when the renamed profile was active.

---

## One-Shot Profile Selection

```bash
estacoda --profile work model status
estacoda -p work doctor
```

`--profile` / `-p` selects a profile for the current command only. It does not change `active-profile.json`. This is useful for one-shot commands against a non-active profile without switching context.

---

## What a Profile Owns

| State | Location | Scoped To |
|---|---|---|
| Provider config | `config.json` | Profile |
| Credentials | `.env`, `auth.json` | Profile |
| Memory files | `USER.md`, `SOUL.md`, `MEMORY.md` | Profile |
| Skills | `skills/` | Profile |
| Cron jobs | `cron/` | Profile |
| Gateway state | `gateway/` | Profile |
| Session DB | `sessions.db` | Profile |
| External memory | `external-memory/` | Profile |
| Trust grants | `~/.estacoda/trust.json` | Global (directory-owned, not profile-scoped) |

Workspace trust is global directory-owned state, not profile-scoped. A trusted workspace is trusted across profiles. Config, credentials, and memory are never shared.

---

## Failure Modes

**Wrong active profile:** If you run a command and it uses the wrong provider, model, or credentials, check the active profile with `estacoda profile show`. Switch with `estacoda profile use <name>`.

**Missing env var:** If a provider route reports a missing credential, verify that the env var is set in the profile `.env` file or exported in the shell before launch.

**Missing config:** If `config.json` is missing or unparseable, the runtime falls back to defaults or routes to setup. Run `estacoda verify` to check config health.

**Gateway running against another profile:** The gateway is bound to the profile selected at start time. Changing `active-profile.json` does not affect a running gateway. If you start the gateway against profile `work` and then switch to `personal`, the gateway continues serving `work`. Stop and restart the gateway with the desired profile.

**Profile deletion blocked:** `profile delete` refuses to delete the active profile or a profile with non-empty state unless `--force` is provided. This prevents accidental loss of sessions, cron jobs, or gateway logs.

---

## Inspection and Recovery

```bash
# Show active profile details
estacoda profile show

# List all profiles
estacoda profile list

# Verify config for active profile
estacoda verify

# Live provider check
estacoda doctor --live

# Check gateway is bound to expected profile
estacoda gateway status
```

---

## Related

- [CLI](./cli.md) — interactive session loop and one-shot commands
- [Sessions](./sessions.md) — session lifecycle and profile isolation
- [Channels](./channels.md) — channel configuration per profile
- [Memory](./memory.md) — profile-local memory files
- [Security and Approvals](./security-and-approvals.md) — workspace trust boundaries

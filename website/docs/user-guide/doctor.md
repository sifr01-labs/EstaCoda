---
title: Doctor
description: Setup health checks, repair guidance, JSON output, and safe Doctor repairs.
sidebar_position: 2
---

# Doctor

`estacoda doctor` is the health inspection command for EstaCoda. It checks the selected profile, workspace, provider routes, optional capabilities, runtime state, sessions, security posture, and common operator dependencies, then prints a verdict and concrete next actions.

Run Doctor before adding more surfaces when something feels wrong. It is the recovery command to use between "setup completed" and "the agent is actually ready."

---

## When To Use It

Use Doctor when:

- Setup completed but `estacoda` does not start cleanly
- A model route is configured but the agent cannot answer
- A provider, browser, MCP server, memory file, skill pack, or session store looks stale
- You changed profile config by hand
- You want a JSON health report for automation
- The Setup Editor shows `EstaCoda Doctor`

Do not start by enabling channels, browser, voice, image generation, or MCP when Doctor reports blockers. Fix the first blocker first.

## Fast Path

```bash
estacoda doctor
```

Read the report from top to bottom:

| Area | What to look for |
|---|---|
| Checks | High-level health by subsystem |
| Provider Routes | Primary, fallback, compression, assessor, and other route readiness |
| Verdict | `Ready`, `Ready with warnings`, or `Blocked` |
| Actions | The exact commands or manual changes to run next |
| Notes | Non-blocking details that explain what Doctor saw |

If the report says `Blocked`, fix the first blocked action before adding features. If it says `Ready with warnings`, EstaCoda may run, but the warning is still real operator work.

## What Doctor Checks

Doctor is read-only by default. It inspects:

| Check | What it covers |
|---|---|
| Runtime | Node/runtime visibility and basic command context |
| Installation | EstaCoda state home and backup readiness |
| State | Global state, selected profile state, and expected profile skeleton |
| Configuration | Config syntax, stale root keys, recommended sections, and ghost env vars |
| Providers | Active provider config and credential coverage |
| Provider Routes | Primary, fallback, compression, assessor, and auxiliary route health |
| OAuth | Profile-local `auth.json` provider records without refreshing tokens |
| Models | Active model identity and context-window warnings |
| Capabilities | Browser, Search, Python-backed capabilities, and configured optional surfaces |
| MCP | Configured MCP server shape and security warnings |
| External tools | Local tools such as `git`, `node`, `pnpm`, `rg`, and optional tools |
| Dependencies | Dependency audit status when explicitly requested |
| Advisories | Active security advisories and profile-local acknowledgements |
| Python Environments | Managed Python capability readiness |
| Memory | Profile memory files and shared memory state |
| Sessions | SQLite session DB connection, schema, FTS, WAL, and repair readiness |
| Skills | Installed skill packs and pack registry state |
| Security | Trust, approval, and policy-related warnings |

Doctor does not print raw secrets. API keys, OAuth token values, channel tokens, and private credential values stay out of the report.

## Exit Codes

Standalone `estacoda doctor` uses the report health as its exit code:

| Result | Exit code |
|---|---|
| Ready with no warnings | `0` |
| Warnings or blockers | `1` |

This is useful in scripts, but do not treat exit code `1` as "the command crashed." It often means Doctor completed successfully and found work for you.

For automation, prefer JSON output and read `verdict.status`.

## JSON Output

```bash
estacoda doctor --json
```

JSON output skips the Papyrus terminal renderer and returns the structured `DoctorReport` shape:

```json
{
  "profile": "default",
  "workspace": "/path/to/workspace",
  "verdict": {
    "status": "warning",
    "blockedCount": 0,
    "warningCount": 1,
    "healthyCount": 13
  },
  "actions": []
}
```

Use JSON for CI, monitors, and support tooling. It follows the same no-secret rule as human output.

## Live Checks

Normal Doctor checks avoid live provider inference. Add live checks only when local config looks correct but connectivity or provider behavior is still the suspected failure.

```bash
estacoda doctor --live
```

`--live` runs provider endpoint probes. It may contact configured providers and should be treated as an operator action.

```bash
estacoda doctor --live-tools
```

`--live-tools` is narrower and more expensive: it runs a live tool-call diagnostic. Use it only when tool-call behavior is the thing you are debugging.

## Dependency Audit

Dependency audit is opt-in:

```bash
estacoda doctor --audit
```

Without `--audit`, Doctor reports that dependency audit was not run and suggests the command. This keeps the normal health check bounded and avoids surprising network/package-registry work.

## Safe Repairs

Doctor has repair commands, but they are intentionally narrow.

```bash
estacoda doctor --fix
```

`--fix` applies only safe local state repairs:

- creates missing state/profile directories where the skeleton is expected
- creates missing profile-local files that are safe to initialize
- sets profile `.env` and `auth.json` modes to `0600`

`--fix` does not:

- trust a workspace
- create provider credentials
- enable network providers
- refresh OAuth tokens
- run live provider checks
- migrate config
- repair the session database

After `--fix`, run Doctor again:

```bash
estacoda doctor
```

## Config Repair

When Doctor reports stale config keys or ghost env vars, use the config-specific repair path:

```bash
estacoda doctor --fix-config
```

This backs up profile config and applies reviewed config migrations that Doctor knows how to perform. It does not repair malformed JSON.

To remove unreferenced profile `.env` credential keys after reviewing the report:

```bash
estacoda doctor --fix-config --remove-env-ghosts
```

Use this only after confirming the keys are truly unused by the selected profile.

## Session Store Repair

Doctor may recommend session repair when the SQLite session DB has schema, FTS, or write-probe issues:

```bash
estacoda doctor --repair-sessions
```

This path backs up the session store before rebuilding supported session DB structures. Run it only when Doctor recommends it.

For explicit write-probe diagnostics:

```bash
estacoda doctor --sqlite-write-probe
```

The write probe is opt-in because it performs a bounded database write/read/delete check.

## Security Advisories

When Doctor reports an active advisory, read it first. If you intentionally accept the risk for this profile, acknowledge it by ID:

```bash
estacoda doctor --ack <advisory-id>
```

Acknowledgements are profile-local. They do not remove the advisory from other profiles.

## Setup Editor

The Setup Editor includes `EstaCoda Doctor` as its read-only health action:

```bash
estacoda setup
```

Choose `EstaCoda Doctor` when you want to inspect setup health without changing configuration. The Setup Editor does not duplicate legacy setup diagnostics; Doctor is the single user-facing health report.

## What Doctor Will Not Do

Doctor will not silently cross trust boundaries.

It will not:

- auto-trust a workspace
- print secret values
- create API keys or OAuth credentials
- enable Telegram, WhatsApp, browser, voice, Search, image generation, MCP, or cloud spend
- mutate live skills, memory, approval grants, or provider routes unless you run an explicit repair command
- run live inference unless you ask for live checks

This is by design. Doctor tells you what is wrong and gives the next command. It does not turn warnings into hidden mutation.

## Recovery Order

Use this order before manual debugging:

```bash
estacoda doctor
estacoda doctor --fix
estacoda doctor
estacoda setup
estacoda model status
```

Use `estacoda doctor --live` after that only if provider connectivity is still the suspected failure.

## What Next

- [Quickstart](../getting-started/quickstart.md) — base install and first working session
- [CLI](./cli.md) — setup, sessions, and terminal behavior
- [Providers](./providers.md) — model routes and credential handling
- [State and Files](../reference/state-and-files.md) — where Doctor is looking
- [Troubleshooting](../reference/troubleshooting.md) — symptom-based repair notes

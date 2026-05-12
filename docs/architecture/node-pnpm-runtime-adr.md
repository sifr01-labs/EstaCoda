---
title: "Node and pnpm Runtime Migration ADR"
description: "Decision record and PR 0 baseline for moving EstaCoda from Bun as foundation to Node and pnpm."
---

# Node and pnpm Runtime Migration ADR

Status: implemented

Date: 2026-05-12

This ADR records the public runtime direction for EstaCoda and the PR 0 baseline before implementation work began.

## Decision

EstaCoda uses the following runtime model:

- Runtime floor: Node >= 22.18.0.
- Package manager: pnpm via Corepack as the source and package-manager default.
- Production runtime target: compiled `dist/` running under Node.
- Bun: optional dev-speed lane only, not required for production or normal development.
- MVP Node SQLite adapter: `better-sqlite3`.
- Deferred SQLite adapter: `node:sqlite` may be added later behind the same internal SQLite interface once it is stable and feature-compatible.
- PR 3 gate: the `better-sqlite3` verification gate is blocking before any storage-class rewiring proceeds.

## Current Implementation Status

As of the PR 8 migration cleanup, the Node/pnpm contract is implemented as the default path:

- `package.json` declares Node >= 22.18.0 and pnpm via Corepack.
- Source-mode commands run through pnpm and `tsx`.
- Production execution targets compiled `dist/` under Node via `pnpm run start` or `node dist/index.js`.
- SQLite runtime state uses `better-sqlite3` behind the internal adapter.
- `node:sqlite` remains deferred.
- Bun remains available only through explicitly named optional `*:bun` scripts and adapter compatibility tests.

The PR 0 baseline below is retained as historical evidence from before the migration phases landed.

## Rationale

EstaCoda is intended to be open sourced and adopted broadly across MacBooks, Windows machines, Ubuntu VPSes, Codespaces and devcontainers, Replit-like environments, university or corporate machines, and low-maintenance local setups. Node and pnpm are a more familiar and deployable public runtime contract than Bun as a foundational runtime.

Storage reliability matters more than avoiding one native dependency. EstaCoda's SQLite layer backs sessions, cron history, TaskFlow, gateway/status behavior, and future memory. `better-sqlite3` is a native dependency and therefore carries install and packaging risk, but it better matches the current synchronous SQLite access pattern and avoids relying on `node:sqlite` for core state during MVP migration.

The SQLite adapter boundary must remain narrow so the project can switch drivers later without leaking driver-specific APIs into higher layers.

## PR 3 Verification Gate

The PR 3 SQLite verification gate must pass before PR 4 storage rewiring begins. It must prove:

- FTS5 works.
- `bm25(messages_fts)` works.
- WAL works.
- `vacuum into` works.
- `delete ... returning` works.
- Transaction rollback behavior matches Bun-era behavior.
- Existing Bun-created DB fixture opens and queries correctly.
- Statement return values are normalized correctly.
- Integer and bigint behavior is understood and normalized if needed.
- Busy and locking behavior is acceptable.

If the gate fails, stop and report the exact failed feature. Do not silently fall back to `node:sqlite`.

## PR 0 Baseline Environment

These baseline commands were run on 2026-05-12 from the `node-migration` branch:

| Command | Result | Notes |
|---------|--------|-------|
| `node --version` | Pass | `v24.14.1` observed locally. The ADR still sets the floor at Node >= 22.18.0. |
| `pnpm --version` | Pass | `10.33.0` observed locally. |
| `bun --version` | Pass | `1.3.11` observed locally. |

## PR 0 Validation Baseline

| Command | Result | Baseline observation |
|---------|--------|----------------------|
| `pnpm run typecheck` | Pass | `tsc --noEmit --incremental` completed successfully. |
| `bun run typecheck` | Pass | `tsc --noEmit --incremental` completed successfully. |
| `pnpm run dev -- --help` | Fail, expected | Exits 243. Current `dev` script uses `$npm_execpath src/index.ts`; under pnpm this attempts to spawn `src/index.ts` and fails with `EACCES`. |
| `pnpm run smoke -- --list` | Fail, expected | Exits 243 for the same `$npm_execpath` script boundary, attempting to spawn `src/smoke.ts`. |
| `npm run test:node` | Fail, expected | Node lane ran 101 test files: 91 passed, 10 failed; 2163 tests passed, 1 failed. Known failures include the ESM/CJS `require("./layout.js")` issue and remaining Bun SQLite storage dependencies. |
| `bun run test` | Fail | Bun/Vitest ran 106 test files: 105 passed, 1 failed; 2456 tests passed, 1 failed, with 1 unhandled error. The failed test is `src/cli/gateway-commands.test.ts` spying on `node:fs/promises.rename`; Vitest also reported an unhandled `process.exit(0)` from supervisor shutdown. Snapshot side effects from this failed run were reverted. |
| `bun run smoke` | Pass | 9 smoke cases passed. |
| `pnpm run build` | Fail, expected | No `build` script exists yet. |
| `bun run build` | Fail, expected | No `build` script exists yet. |
| `git diff --check` | Pass | No whitespace errors after PR 0 documentation edits. |

## Expected Baseline Failures

The pnpm `dev` and `smoke` failures are expected before PR 1 because current scripts are Bun-shaped and use `$npm_execpath` as a source runner. The missing build script is expected before PR 2. The Node test lane failures are expected before storage abstraction and the ESM/CJS test fix. The Bun test failure is not caused by this ADR and remains part of the PR 0 baseline.

## Non-Goals For PR 0

- Do not change runtime behavior.
- Do not change package scripts.
- Do not add pnpm metadata, `pnpm-lock.yaml`, `engines`, or `packageManager`.
- Do not add `better-sqlite3`.
- Do not change SQLite storage classes.
- Do not update AGENTS.md or durable install docs as final truth.

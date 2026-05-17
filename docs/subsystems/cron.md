---
title: "Cron & Automation"
description: "Scheduled tasks, cron runner, job storage, execution history, and delivery routing."
---

# Cron & Automation

## Files

| File | Lines | Role |
|------|-------|------|
| `src/cron/cron-store.ts` | ~340 | Persistent job storage |
| `src/cron/cron-tools.ts` | ~280 | Agent-facing `cronjob` tool |
| `src/cron/cron-runner.ts` | ~280 | Scheduler tick execution |
| `src/cron/cron-command.ts` | ~200 | CLI operator commands |
| `src/cron/cron-execution-store.ts` | ~150 | SQLite execution history |
| `src/cron/cron-lock.ts` | ~80 | File-based tick and job locks |

## Cron Store

- Persistent storage at `~/.estacoda/profiles/<id>/cron/jobs.json`
- Atomic writes
- Schedule parsing: relative delays, intervals, cron expressions, ISO timestamps
- Prompt safety scanning
- Optional workspace-local script metadata
- Local output files

## Cron Execution Store

- SQLite table `cron_executions` in `~/.estacoda/sessions.sqlite`
- Records: job ID, session ID, trajectory ID, scheduled/start/completed timestamps, status, output summary, delivery results, failure class, failure message
- Queryable by job ID or across all jobs
- Used by `estacoda cron history` and `estacoda cron show`

## Cron Tool

The agent can manage scheduled tasks via the `cronjob` tool:

| Action | Description |
|--------|-------------|
| `create` | Add a new scheduled task |
| `list` | List all tasks |
| `update` | Modify an existing task |
| `pause` | Pause a task |
| `resume` | Resume a paused task |
| `run` | Execute a task immediately |
| `remove` | Delete a task |

## Cron Runner

`tickCron` in `src/cron/cron-runner.ts`:

- Acquires `.tick.lock` to prevent concurrent ticks.
- Computes due jobs.
- Per-job execution:
  - Acquires job-level lock.
  - Advances `nextRunAt` before execution (prevents duplicate runs on slow jobs).
  - Creates a fresh session (`cron-${job.id}-${randomUUID()}`).
  - Runs script or prompt.
  - Records execution in `CronExecutionStore`.
- PID/stale-lock recovery: on startup, checks for stale locks from crashed processes.
- Recursion guard: `disableCronTools: true` in cron runtime prevents cron jobs from scheduling more cron jobs.
- Delivery: uses `DeliveryRouter` for all channel delivery.

## Failure Classification

| Class | Trigger |
|-------|---------|
| `timeout` | Job exceeded time limit |
| `script-failed` | Script exited with non-zero code |
| `delivery-failed` | DeliveryRouter could not deliver output |
| `unknown` | Unclassified failure |

Failures are persisted in `CronExecutionStore` and visible via:
- `estacoda gateway status` (recent cron failures, last 5)
- `estacoda cron history`
- `estacoda cron show <job-id>`

## Delivery Routing

Cron jobs use `DeliveryRouter` for output delivery. Supported targets:
- `local` — write to the selected profile cron output directory
- `origin` — deliver to the channel that scheduled the job
- `silent` — no delivery
- `telegram:<chatId>` — Telegram DM or channel
- `discord:<channelId>` — Discord channel
- `whatsapp:<number>` — WhatsApp DM
- `email:<address>` — Email address

## Operator Commands

- `estacoda cron list` — all jobs with schedule, status, next run.
- `estacoda cron show <job-id>` — job detail with recent executions.
- `estacoda cron history [job-id]` — execution history.
- `estacoda cron run <job-id>` — request a run (sets `runRequested`).
- `estacoda cron pause <job-id>` — pause job.
- `estacoda cron resume <job-id>` — resume job.
- `estacoda cron remove <job-id>` — delete job.

## Evidence

- Cron create/list/edit/tick flow: `smoke-tested`
- Schedule parsing: `smoke-tested`
- Prompt safety blocking: `smoke-tested`
- Tick locking: `smoke-tested`
- Per-job duplicate prevention: `smoke-tested`
- Execution history: `smoke-tested`
- Failure classification: `smoke-tested`
- Delivery routing: `implemented but not live-proven`
- Cron operator commands: `smoke-tested`

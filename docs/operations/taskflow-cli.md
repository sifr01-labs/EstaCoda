---
title: "TaskFlow CLI"
description: "Command reference for the estacoda flow CLI namespace."
---

# TaskFlow CLI Reference

## Entry Point

```bash
estacoda flow <subcommand> [args...]
```

## Commands

### list

List all active (non-terminal) flows.

```bash
estacoda flow list
```

Output columns: `flowId`, `status`, `age`, `sessionId`

### show

Show flow details including steps.

```bash
estacoda flow show <flowId>
```

### status

Show formatted status view with progress, pending approvals, and available actions.

```bash
estacoda flow status <flowId>
```

### trace

Show chronological event timeline.

```bash
estacoda flow trace <flowId> [limit]
```

- `limit`: optional integer; limits to most recent N events.

### pause

Request pause at next safe boundary.

```bash
estacoda flow pause <flowId> [reason]
```

### resume

Resume a paused, interrupted, or waiting flow.

```bash
estacoda flow resume <flowId>
```

### interrupt

Interrupt immediately. Terminates active processes.

```bash
estacoda flow interrupt <flowId> [reason]
```

### cancel

Cancel flow. Terminal state.

```bash
estacoda flow cancel <flowId> [reason]
```

### steer

Inject operator guidance into a flow.

```bash
estacoda flow steer <flowId> <instruction>
```

Guidance appears in the next turn prefixed as `OPERATOR GUIDANCE`.

### approve

Approve a pending approval gate.

```bash
estacoda flow approve <stepId>
```

### reject

Reject a pending approval gate.

```bash
estacoda flow reject <stepId> [reason]
```

### retry

Retry a failed step.

```bash
estacoda flow retry <stepId>
```

Only works if the step is idempotent or safeToRetry, and under maxRetries.

### skip

Skip a pending skippable step.

```bash
estacoda flow skip <stepId> [reason]
```

Only works if the step has not started and `allowSkipIfSkippable` is true.

### checkpoint

Create a named checkpoint.

```bash
estacoda flow checkpoint <flowId> <name>
```

### compact

Run manual compaction if at a safe boundary.

```bash
estacoda flow compact <flowId>
```

## Requirements

All `estacoda flow` commands require SQLite session persistence. If the runtime uses an in-memory session DB, commands will fail with a message indicating TaskFlow requires SQLite.

## Exit Codes

- `0`: success
- `1`: error (flow not found, invalid arguments, command rejected)

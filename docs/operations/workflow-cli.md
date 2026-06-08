---
title: "Workflow CLI"
description: "Command reference for the estacoda workflow CLI namespace."
---

# Workflow CLI Reference

## Entry Point

```bash
estacoda workflow <subcommand> [args...]
```

## Commands

### begin

Create and start a workflow run for an existing session.

```bash
estacoda workflow begin --session <sessionId> <objective>
```

The standalone CLI path requires a session ID it can resolve in the active profile. It does not create hidden sessions and it does not activate future interactive sessions.

Successful output:

```text
Created workflow: <runId>
Started workflow: <runId>
Not activated. Use /workflow activate <runId> inside an interactive session.
```

The generated plan is deliberately conservative:

- one step,
- `requiresApproval: false`,
- `skippable: false`,
- `maxRetries: 0`,
- `idempotent: false`,
- run metadata records `activationReason: "explicit"` and the objective.

Use this when an operator wants durable tracking before continuing work in an interactive session.

Skill-backed begin is explicit:

```bash
estacoda workflow begin --skill <skillName> --session <sessionId> <objective>
```

This resolves the named skill, compiles its playbook, converts it into a `WorkflowPlan`, creates the workflow run, and starts it. It still does not activate a future interactive session. Unknown skills return a clear error. Plain `begin` does not use playbook conversion.

What does not happen:

- no automatic workflow promotion,
- no complex-request auto-detection,
- no hidden session creation,
- no Agent Evolution behavior,
- no automatic workflow creation from normal AgentLoop skill selection,
- no `--use-selected-playbook` flag.

### list

List all active (non-terminal) workflow runs.

```bash
estacoda workflow list
```

Output columns: `runId`, `status`, `age`, `sessionId`

### show

Show workflow run details including steps.

```bash
estacoda workflow show <runId>
```

### status

Show formatted status view with progress, pending approvals, and available actions.

```bash
estacoda workflow status <runId>
```

### trace

Show chronological event timeline.

```bash
estacoda workflow trace <runId> [limit]
```

- `limit`: optional integer; limits to most recent N events.

### pause

Request pause at next safe boundary.

```bash
estacoda workflow pause <runId> [reason]
```

### resume

Resume a paused, interrupted, or waiting workflow run.

```bash
estacoda workflow resume <runId>
```

### interrupt

Interrupt immediately. Terminates active processes.

```bash
estacoda workflow interrupt <runId> [reason]
```

### cancel

Cancel workflow run. Terminal state.

```bash
estacoda workflow cancel <runId> [reason]
```

### steer

Inject operator guidance into a workflow run.

```bash
estacoda workflow steer <runId> <instruction>
```

Guidance appears in the next turn prefixed as `OPERATOR GUIDANCE`.

### approve

Approve a pending approval gate.

```bash
estacoda workflow approve <stepId>
```

### reject

Reject a pending approval gate.

```bash
estacoda workflow reject <stepId> [reason]
```

### retry

Retry a failed step.

```bash
estacoda workflow retry <stepId>
```

Only works if the step is idempotent or safeToRetry, and under maxRetries.

### skip

Skip a pending skippable step.

```bash
estacoda workflow skip <stepId> [reason]
```

Only works if the step has not started and `allowSkipIfSkippable` is true.

### checkpoint

Create a named checkpoint.

```bash
estacoda workflow checkpoint <runId> <name>
```

### summarize

Summarize workflow events if at a safe boundary.

```bash
estacoda workflow summarize <runId>
```

## Requirements

All `estacoda workflow` commands require SQLite session persistence. If the runtime uses an in-memory session DB, commands will fail with a message indicating Workflow requires SQLite.

For live routing through Workflow, create/start with `estacoda workflow begin ...`, then activate the run inside the interactive session:

```bash
/workflow activate <runId>
```

## Exit Codes

- `0`: success
- `1`: error (workflow run not found, invalid arguments, command rejected)

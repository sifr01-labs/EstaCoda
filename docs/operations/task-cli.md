---
title: "Durable Task CLI"
description: "Command reference for durable Task operator controls."
---

# Durable Task CLI Reference

The `task` namespace is the operator surface for durable work. Task state lives in the selected profile's global SQLite session database and can continue through the background host after the creating CLI turn ends.

```bash
estacoda task begin [--session <session-id>] <objective>
estacoda task list [limit]
estacoda task show <task-id>
estacoda task pause <task-id>
estacoda task resume <task-id>
estacoda task cancel <task-id>
estacoda task retry <task-id> [step-id]
estacoda task result <task-id>
```

`begin` requires a trusted workspace. Without `--session`, it creates an explicit system-owned root Task and does not invent a hidden session. With `--session`, that session must exist in the selected profile and becomes the creator. The initial graph is one conservative agent Step with bounded authority and budget; later planning can extend durable Task capabilities without reviving the retired Workflow engine.

`list` defaults to 20 entries and accepts a limit from 1 to 100. `show` reports status, Step progress, running and waiting counts, estimated cost and usage completeness, result count, workspace trust, and background-host state. `result` lists bounded opaque result handles and summaries; it does not print result bodies.

`pause` stops new work from being claimed at a safe boundary. `resume` requeues a paused Task. `cancel` is terminal and durably requests cancellation for active Attempts. `retry` is available only when a Step is waiting for explicit operator retry and Attempt budget remains; it requeues that Step so the scheduler creates a new Attempt rather than duplicating the Step.

All commands are profile scoped. A global `--profile <id>` or `-p <id>` override applies only to that invocation and never changes `active-profile.json`.

Inside an active session, use the same forms under `/task`. In-session reads require a Task/session link, while mutations require the creator link. `/task begin` automatically links the new Task to the current session.

The status and result surfaces are intentionally bounded. They do not expose workspace paths, prompts, tool inputs, credentials, full results, or raw failure messages. If no background host is active, `begin` still succeeds durably and reports that the Task is queued.

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

`begin` requires a trusted workspace. Without `--session`, it creates a visible profile-owned creator session and prints that session ID with the new Task handle. With `--session`, the named session must already exist in the selected profile and becomes the creator. Every agent Task therefore has a real authorization, approval, and tool-visibility root. The initial graph is one conservative agent Step with bounded authority and budget; later planning can extend durable Task capabilities through immutable PlanRevisions.

`list` defaults to 20 entries and accepts a limit from 1 to 100. `show` reports status, Step progress, running and waiting counts, estimated cost and usage completeness, result count, workspace trust, and background-host state. `result` lists bounded opaque result handles and summaries; it does not print result bodies.

`pause` stops new work from being claimed at a safe boundary. `resume` requeues a paused Task. `cancel` is terminal and durably requests cancellation for active Attempts. `retry` is available only when a Step is waiting for explicit operator retry and Attempt budget remains; it requeues that Step so the scheduler creates a new Attempt rather than duplicating the Step.

All commands are profile scoped. A global `--profile <id>` or `-p <id>` override applies only to that invocation and never changes `active-profile.json`.

Inside an active session, use the same forms under `/task`. In-session reads require a Task/session link, while mutations require the creator link. `/task begin` automatically links the new Task to the current session.

In a supported interactive TTY, linked Tasks also appear as retained cards in the Operator Console, including after settlement. Use `Ctrl+T` or an available `Tab` transition to focus the cards, arrow keys to select, and `Enter` to inspect. The modal view supports arrow scrolling, `Page Up`/`Page Down`, `Home`/`End`, and `Escape` to return. It shows the active plan, Step dependencies and Attempts, elapsed time, safe activity labels, coarse tool category, metering, result handles, and bounded wait/failure information. Plain and non-TTY users use `task list`, `task show`, and `task result` for the same durable state.

The status, card, inspection, and result surfaces are intentionally bounded. They do not expose workspace paths, prompts, worker transcripts, raw Task or SessionEvent payloads, tool inputs or outputs, credentials, lease-owner identities, full results, or raw failure messages. If no background host is active, `begin` still succeeds durably and reports that the Task is queued.

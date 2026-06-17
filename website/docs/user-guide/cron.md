---
title: Scheduled Jobs
description: Cron jobs, isolated scheduled runtimes, no-agent checks, context chaining, and execution evidence.
sidebar_position: 8
---

# Scheduled Jobs

EstaCoda cron runs scheduled automation from the active profile. A cron job can run an agent prompt, run a script before the agent prompt, run a script-only no-agent watchdog, load skill instructions, include output from upstream cron jobs, and constrain the model, tools, and workspace used for the run.

Cron is also an evidence surface for Agent Evolution. Runtime-backed jobs create isolated runtime sessions and trajectories that can be inspected later. Cron does not automatically create or promote skills yet.

## Storage

Cron job storage depends on how the runtime constructs its `CronStore`.

Profile-wired runtimes use profile-local paths:

```text
~/.estacoda/profiles/<id>/cron/jobs.json
~/.estacoda/profiles/<id>/cron/output/
```

Some default/manual paths can use:

```text
~/.estacoda/cron/jobs.json
~/.estacoda/cron/output/
```

Execution history is stored in `~/.estacoda/sessions.sqlite` in the `cron_executions` table. It records status, timestamps, output summary, failure metadata, delivery results, and runtime session/trajectory IDs where a runtime exists.

## Creating Jobs

Use CLI commands, slash commands, or the `cronjob` tool.

```bash
estacoda cron add --schedule "every 1h" --command "Summarize recent project changes"
/cron add --schedule "every 1h" --command "Summarize recent project changes"
```

Useful add/edit flags:

```text
--skill <name>
--script <path>
--script-arg <arg>
--script-timeout-ms <ms>
--no-agent
--agent
--context-from <job-id>
--clear-context-from
--model <model>
--provider <provider>
--clear-model
--toolset <name>
--clear-toolsets
--workdir <absolute-path>
--clear-workdir
```

Supported schedules include relative delays such as `10m`, intervals such as `every 2h`, five-field cron expressions, and date strings accepted by JavaScript date parsing.

## Runtime Isolation

Gateway cron, `/cron tick`, and `estacoda cron tick` all use isolated cron runtimes. Scheduled work does not reuse the current conversation runtime.

Cron runtimes force-disable the `cron`, `messaging`, and `clarify` toolsets, pass a generated cron session ID, and are disposed after execution. If a job has an `enabledToolsets` allow-list, tools outside that allow-list are removed from the scheduled runtime. `cron`, `messaging`, and `clarify` cannot be re-enabled.

The scheduler is sequential today. It runs due jobs one by one under a global tick lock and per-job locks. Non-blocking bounded dispatch is not implemented.

## Scripts And No-Agent Checks

Agent-backed script jobs run the script first, redact the result, and inject it into the scheduled prompt.

No-agent jobs run only the script:

- `--no-agent` requires `--script`.
- Non-empty stdout is delivered.
- Empty stdout is a silent success.
- A final non-empty JSON line `{ "wakeAgent": false }` is a silent success.
- Script failures and timeouts produce classified, redacted alerts.

No-agent jobs do not create runtime sessions or trajectories.

## Skills And Context

Skills attached to cron jobs load actual skill instruction bodies. EstaCoda uses `providerInstructions.content` when present, otherwise `instructions`. Missing skills produce a warning in the scheduled prompt instead of crashing the job. Per-skill injected text is capped and scanned with the assembled prompt.

`contextFrom` injects the latest output from upstream cron jobs. Outputs are loaded from the cron output root, kept in requested order, truncated, redacted, and labeled as data rather than instructions. Malformed persisted job IDs and path escapes are skipped.

## Model, Tools, And Workdir

`--model` and `--provider` set a per-job model route. If `--model` is supplied without `--provider`, EstaCoda pins the current provider before storing the job. Invalid provider/model routes are rejected before persistence.

`--toolset` creates an allow-list validated against actual registered runtime tools. Unknown toolsets and forbidden toolsets are rejected.

`--workdir` selects an effective workspace for the job. It must be an absolute existing path inside an allowed workspace root. EstaCoda canonicalizes paths with `realpath`, rejects symlink escapes, and derives trust from the workspace trust store. Cron does not grant trust to arbitrary absolute directories.

## Safety

Raw prompts are scanned on create/update and again at runtime for legacy persisted jobs. Script output, upstream output, and skill text are redacted before prompt injection. The final assembled prompt is scanned and invisible Unicode is sanitized before `runtime.handle()`.

## Inspect And Repair

```bash
estacoda cron list
estacoda cron show <job-id>
estacoda cron history [job-id]
estacoda cron run <job-id>
estacoda cron pause <job-id>
estacoda cron resume <job-id>
estacoda cron remove <job-id>
estacoda cron tick
```

Clear advanced controls with:

```bash
estacoda cron edit <job-id> --clear-model
estacoda cron edit <job-id> --clear-toolsets
estacoda cron edit <job-id> --clear-workdir
estacoda cron edit <job-id> --agent
```

## Limits

- Scheduler dispatch is sequential.
- There is no cron web dashboard in this stack.
- Cron does not automatically evolve or promote skills.
- No-agent jobs do not create runtime trajectories.
- Workdir support does not trust arbitrary absolute paths.

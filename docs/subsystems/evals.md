---
title: "Evaluations"
description: "Eval runner, deterministic fixtures, regression detection, and scoring substrate."
---

# Evaluations

## Purpose

Create a repeatable substrate for future self-improvement work:

- Fixed evaluation tasks
- Repeatable run folders
- Structured pass/fail capture
- Baseline vs candidate comparison
- Enough discipline to support skill/prompt evolution safely

This is intentionally narrower than full self-evolution. It is a prerequisite, not the full loop.

## What Exists Now

### Automated Eval Runner

Location: `src/eval/eval-runner.ts`

```bash
estacoda eval [fixture-id]
```

Runs deterministic fixtures with pass/fail assertions. The source of truth for the default fixture set is `src/eval/fixtures/index.ts`. Current fixture areas include:

| Area | Scope |
|------|-------|
| Provider/tool baseline | Mock provider text responses, blocked-tool handling, missing-tool failure handling |
| Memory | Promotion provenance, deactivation, selective rendering, protected safety files |
| Knowledge/dependency graph | Forward/reverse dependencies, affected files, graph summaries, cache invalidation |
| Agent Evolution | Manifest creation, proposal/manifest bridge, user-correction records, tool-description and routing-metadata proposal shapes, routing baseline and semantic-routing readiness metrics, export shape |

The routing baseline fixture uses the live `IntentRouter` for governed routing cases. It tracks primary precision/recall, no-skill false positives, forbidden-skill violations, supporting-candidate recall, task-class correctness, semantic-vs-deterministic disagreement, semantic recall improvement, semantic false positives, semantic forbidden-skill violations, ambiguous semantic candidates, and Arabic semantic readiness. These metrics are readiness signals only; semantic and LLM route signals remain shadow telemetry until explicitly promoted by code and policy.

### Eval Substrate Scaffold

```bash
pnpm run eval:substrate
```

Creates under `.estacoda/eval-runs/<timestamp>/`:
- `manifest.json`
- `results.json`
- `notes.md`
- `commands.md`
- `logs/`

### Running All Fixtures

```bash
pnpm run eval:fixtures
```

## Evidence Levels

| Label | Meaning |
|-------|---------|
| `live-proven` | Verified by a real operator run |
| `smoke-tested` | Covered by `src/smoke.ts` |
| `eval-tested` | Covered by deterministic eval fixtures |
| `implemented but not live-proven` | Code exists, no fresh proof assumed |
| `intended but not implemented` | Design target only |

## Future Direction

- Scored automated benchmark, not only pass/fail fixture assertions
- Broader historical regression tracking across runs
- Richer eval-linked skill evolution proposals
- Stronger constraint-gate integration with manifest promotion

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

Runs deterministic fixtures with pass/fail assertions. As of v0.7, **18 fixtures** cover:

| Fixture | Scope |
|---------|-------|
| `provider-text-response` | Mock provider returns text without tool calls |
| `tool-security-block` | Detects blocked `rm -rf /` |
| `missing-tool-failure` | Handles unavailable tool gracefully |
| `memory-promotion-provenance` | Memory carries source metadata |
| `memory-deactivation` | Deactivated memory suppressed from context |
| `memory-selective-renderer` | Selective render with fallback rules |
| `memory-safety-files` | Safety files cannot be deactivated |
| `dependency-forward` | Forward dependency lookup |
| `dependency-reverse` | Reverse dependency lookup |
| `dependency-affected` | Transitive affected-file lookup |
| `dependency-summary` | Graph summary counts |
| `dependency-cache-invalidation` | Cache invalidates on source change |
| `manifest-from-observation` | Observation creates ChangeManifest |
| `skill-proposal-manifest-bridge` | `skill.propose_patch` creates manifest |
| `user-correction-recording` | User corrections recorded as events |
| `tool-description-proposal` | Tool description manifest skeleton |
| `routing-metadata-proposal` | Routing metadata manifest skeleton |
| `evolution-export-shape` | OptimizationDataset schema validation |

### Eval Substrate Scaffold

```bash
bun run eval:substrate
```

Creates under `.estacoda/eval-runs/<timestamp>/`:
- `manifest.json`
- `results.json`
- `notes.md`
- `commands.md`
- `logs/`

### Running All Fixtures

```bash
bun run scripts/run-eval-fixtures.ts
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

- Golden flow comparison for regression detection
- Scored automated benchmark (not just pass/fail)
- Eval-linked skill evolution proposals
- Constraint gate integration with manifest promotion

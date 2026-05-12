# Smoke Decomposition Map

## Status

**v0.6.1 maintenance sprint** — harness decomposed, incremental extraction in progress.

## Architecture

```
src/smoke/
├── _legacy.ts                 # legacy implementation (~14K lines, exportable)
├── smoke.ts                  # thin entrypoint (imports runner + cases)
├── smoke-case.ts             # SmokeCase & SmokeContext interfaces
├── smoke-runner.ts           # runSmokeCases, filtering, structured reporting
├── fixtures/
│   └── shared-setup.ts       # fresh factories per case
├── cases/
│   ├── index.ts              # case registry (allSmokeCases)
│   ├── legacy-monolith.ts    # thin wrapper calling runLegacySmoke from _legacy.ts
│   ├── corrupt-skill-usage.ts
│   └── bundled-skill-sync.ts
└── SMOKE_DECOMPOSITION_MAP.md
```

## Cases

| Case | Tags | Source | Notes |
|------|------|--------|-------|
| `legacy-monolith` | `legacy`, `all` | Original `src/smoke.ts`, now in `_legacy.ts` | Thin wrapper. Preserves all ~1,315 assertions via `runLegacySmoke()`. Comprehensive integration baseline. |
| `corrupt-skill-usage` | `skills`, `evolution`, `resilience` | Extracted from legacy monolith line 305 | Self-contained. Tests SkillEvolutionStore corrupt-file recovery. |
| `bundled-skill-sync` | `skills`, `bundled`, `sync` | Extracted from legacy monolith line 3690 | Self-contained. Tests syncBundledSkills, resetBundledSkill, hashSkillDirectory. |

## Running Cases

```bash
# All cases
pnpm run smoke

# Filter by tag
pnpm run smoke --tag skills
pnpm run smoke --tag bundled
pnpm run smoke --tag legacy

# Filter by case ID
pnpm run smoke --id corrupt-skill-usage

# List available cases
pnpm run smoke --list

# Fail fast (stop on first failure)
pnpm run smoke --fail-fast

# JSON output
pnpm run smoke --json
```

## Legacy Monolith Sections

The legacy implementation lives in `_legacy.ts` (~14,000 lines). The `legacy-monolith` case is a thin wrapper that calls `runLegacySmoke()` from that file. Future sprints should extract subsystems from `_legacy.ts` into focused cases under `cases/`.

The following subsystems are covered inline in `_legacy.ts`:

| Section | Approx Lines | Subsystem |
|---------|-------------|-----------|
| Setup + provider normalization | 150–400 | providers |
| Tool registry + execution | 400–800 | tools |
| Browser backend | 800–1200 | browser |
| Image generation | 1200–1500 | media |
| Voice (TTS/STT) | 1500–1800 | voice |
| Telegram adapter | 1800–2800 | channels |
| CLI sessions + slash menu | 2800–3500 | cli |
| Skill execution + mutation | 3500–4500 | skills |
| Bundled skill sync | 3690–3950 | skills (already extracted) |
| Skill path/mutation regression | 4500–5000 | skills |
| Memory promotion + rendering | 5000–6000 | memory |
| Security policy | 6000–6500 | security |
| Cron | 6500–7000 | cron |
| MCP | 7000–7500 | mcp |
| ACP | 7500–8000 | acp |
| Context + prompt packing | 8000–8500 | context |
| Artifact handling | 8500–9000 | artifacts |
| Onboarding | 9000–9500 | onboarding |
| Trajectory + trace CLI | 9500–10000 | trajectory |
| Eval runner + fixtures | 10000–10500 | eval |
| Code dependency graph | 10500–11000 | code-graph |
| Change manifest | 11000–11500 | skills |
| Corrupt skill usage | ~305 | skills (already extracted) |

## Extraction Guidelines

1. **Start with self-contained sections** — sections that only use temp dirs and pure functions (no shared `ToolExecutor`, `sessionId`, etc.).
2. **Use `createSmokeContext()` for integration-level cases** — it provides fresh registries, stores, and temp dirs.
3. **Do not remove assertions from the legacy monolith until the extracted case is proven** — the monolith is the coverage baseline.
4. **Tag cases by subsystem** — enables targeted runs during development.
5. **Keep assertions as `throw new Error` or `assert()`** — the smoke runner catches all errors and reports them.

## Future Cases to Extract (priority order)

1. `skill-limits` — MAX_SKILL_RESOURCE_BYTES enforcement (self-contained)
2. `memory-promotion` — promotion, provenance, deactivation (needs SmokeContext)
3. `security-policy` — hard floor, command safety (needs SmokeContext)
4. `provider-routing` — fallback chain, model catalog (self-contained with fakes)
5. `trajectory-recorder` — persistence, failure classification (needs SmokeContext)
6. `eval-runner` — fixture execution, golden flow comparison (self-contained)
7. `code-dependency-graph` — forward/reverse/affected lookup, cache (self-contained)

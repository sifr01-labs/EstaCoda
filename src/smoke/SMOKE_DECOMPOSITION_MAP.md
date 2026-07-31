# Smoke Decomposition Map

## Status

**v0.6.1 maintenance sprint** — harness decomposed into focused smoke cases.

## Architecture

```
src/smoke/
├── smoke.ts                  # thin entrypoint (imports runner + cases)
├── smoke-case.ts             # SmokeCase & SmokeContext interfaces
├── smoke-runner.ts           # runSmokeCases, filtering, structured reporting
├── fixtures/
│   └── shared-setup.ts       # fresh factories per case
├── cases/
│   ├── index.ts              # case registry (allSmokeCases)
│   └── *.ts                  # focused smoke cases
└── SMOKE_DECOMPOSITION_MAP.md
```

## Cases

| Case | Tags | Source | Notes |
|------|------|--------|-------|
| `bare-launch` | `lifecycle`, `launch` | Focused smoke case | Verifies a fresh bare interactive launch selects first-run onboarding. |
| `bundled-skill-sync` | `skills`, `bundled`, `sync` | Focused smoke case | Tests syncBundledSkills, resetBundledSkill, and hashSkillDirectory. |
| `corrupt-skill-usage` | `skills`, `evolution`, `resilience` | Focused smoke case | Tests SkillEvolutionStore corrupt-file recovery. |
| `delegation-mvp` | `delegation`, `runtime` | Focused smoke case | Covers the delegation MVP path. |
| `evolution-lifecycle` | `evolution`, `skills` | Focused smoke case | Covers Agent Evolution lifecycle behavior. |
| `evolution-safety` | `evolution`, `security` | Focused smoke case | Covers Agent Evolution safety behavior. |
| `gateway-stop` | `gateway`, `channels` | Focused smoke case | Covers gateway stop behavior. |
| `state-bootstrap` | `lifecycle`, `setup` | Focused smoke case | Covers non-authorizing first-run state bootstrap behavior. |
| `pack-lifecycle` | `packs`, `lifecycle` | Focused smoke case | Covers pack lifecycle behavior. |
| `provider-setup-endpoint-first` | `setup`, `providers` | Focused smoke case | Exercises Local / Custom endpoint-first Setup Editor flow for primary, fallback, and auxiliary routes with mocked `/models`. |
| `update-dry-run` | `lifecycle`, `update` | Focused smoke case | Covers update dry-run behavior. |
| `whatsapp-support` | `channels`, `whatsapp` | Focused smoke case | Covers WhatsApp support behavior. |

## Running Cases

```bash
# All cases
pnpm run smoke

# Filter by tag
pnpm run smoke --tag skills
pnpm run smoke --tag bundled
pnpm run smoke --tag providers

# Filter by case ID
pnpm run smoke --id corrupt-skill-usage

# List available cases
pnpm run smoke --list

# Fail fast (stop on first failure)
pnpm run smoke --fail-fast

# JSON output
pnpm run smoke --json
```

## Extraction Guidelines

1. **Start with self-contained sections** — sections that only use temp dirs and pure functions (no shared `ToolExecutor`, `sessionId`, etc.).
2. **Use `createSmokeContext()` for integration-level cases** — it provides fresh registries, stores, and temp dirs.
3. **Tag cases by subsystem** — enables targeted runs during development.
4. **Keep assertions as `throw new Error` or `assert()`** — the smoke runner catches all errors and reports them.

## Future Cases to Extract (priority order)

1. `skill-limits` — MAX_SKILL_RESOURCE_BYTES enforcement (self-contained)
2. `memory-promotion` — promotion, provenance, deactivation (needs SmokeContext)
3. `security-policy` — hard floor, command safety (needs SmokeContext)
4. `provider-routing` — fallback chain, model catalog (self-contained with fakes)
5. `trajectory-recorder` — persistence, failure classification (needs SmokeContext)
6. `eval-runner` — fixture execution, golden flow comparison (self-contained)
7. `code-dependency-graph` — forward/reverse/affected lookup, cache (self-contained)

# No-Regression Policy (v0.95)

Every change merged during the v0.95 UI/CLI overhaul must pass:

1. `pnpm run test` — authoritative Node/Vitest unit-test gate.
2. `pnpm run typecheck` — TypeScript compilation with zero errors.
3. `pnpm run smoke` — source-mode integration smoke test must not crash.
4. `pnpm run smoke:dist` — built `dist/` smoke test must not crash.

## Test Gates

| Command | Runtime | Tests | Purpose |
|---------|---------|-------|---------|
| `pnpm run test` | Node | Full Vitest suite | Authoritative unit-test gate. |
| `pnpm run typecheck` | Node | N/A | TypeScript type-checking gate. |
| `pnpm run smoke` | Node source mode | Smoke cases | Runtime integration smoke test. |
| `pnpm run build` | Node | N/A | Production `dist/` compilation. |
| `pnpm run smoke:dist` | Node dist mode | Smoke cases | Built-output runtime smoke test. |

## Rules

- Do not merge if `pnpm run test` fails.
- Do not merge if `pnpm run typecheck` fails.
- Do not merge if `pnpm run smoke` or `pnpm run smoke:dist` crashes.
- Existing behavior tests (`expect(output).toContain(...)`) must continue to pass without modification during v0.95.
- New snapshot tests are additive only.
- Backward-compatible wrappers must be preserved until v0.10.

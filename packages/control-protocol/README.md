# Shared control protocol source facade

Private monorepo workspace consumed by Desktop. Canonical v1 request semantics and validation live in [core](../../src/contracts/control-protocol.ts); no Node/Electron transport, authentication token, execution owner or future Desktop method registry is exported.

Core imports the same source relatively so its existing `src` → `dist` release remains self-contained. This package's TypeScript source export intentionally references core outside the package directory: use it through the workspace's TypeScript tooling/bundler, not as a separately packed or published package. Do not copy definitions into this package or add a root CLI runtime dependency on it.

`pnpm run desktop:foundation:check` checks both workspace consumers and their transitive import boundary. PR 2 adds strict Desktop envelopes/projections here via shared pure core modules; v1 host transport compatibility is a separate concern. See the [decision](../../docs/architecture/desktop/decisions.md).

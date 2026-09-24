# Session capability catalog: PR 2 implementation record

Implemented on the existing `ame/reliability-baseline` branch, following PR 1. This record covers PR 2 only; capability discovery/request tools, durable research reconciliation, and packaged desktop release validation remain in subsequent PRs.

## Commit slices

1. `refactor(tools): separate session catalog from bounded provider exposure` — complete filtered session metadata and eligible schema entries; post-selection count/token budgets; unavailable disabled/child-forbidden definitions removed from the final registry.
2. `fix(tools): preserve aliases and enforce active native tool exposure` — deterministic collision allocation, canonical-name reservation, per-iteration native-call admission, nested delegation/Plan alias handling, and fail-closed default admission.
3. `fix(skills): enforce session visibility across skill inspection tools` — session-scoped content and metadata reads, usage/proposal filtering, and indistinguishable hidden/unknown probes before file access or usage side effects.
4. `feat(diagnostics): record capability selection and omission reasons` — policy/counts/bounded omission details persisted through existing inventory events; explicit-request blockers included in provider context; documentation and combined boundary checks.

## Budget evidence and limits

The existing 100-schema count limit now applies after relevance selection. A 24,000-token serialized-schema ceiling uses the existing rough estimator (one token per four characters). The standard `AgentLoopBuilder` fixture measured 79 eligible schemas / 9,880 estimated tokens for the foreground session, and 78 / 9,584 for its child and Task fixtures. These are real registered schema definitions in the test configuration, not measurements of every configured MCP inventory or provider tokenizer. The ceiling leaves headroom above that fixture and bounds larger configured inventories; provider-specific tuning remains empirical work.

Directly requested tools are prioritized during foreground selection. Oversized schemas are omitted with `schema_budget`, without removing their catalog identity. Browser expansion preserves the existing exposure and cannot evict current tools to make room. Missing request tools produce bounded diagnostics and provider context identifying omissions and requiring truthful reporting of any unmet requirement; this is not the PR 4 durable requirement settlement mechanism.

## Security review

Tool exposure remains separate from authority. The provider loop supplies a fixed exposure snapshot for each batch; aliases and canonical-name fallback cannot admit an unexposed native call. The snapshot is reused across provider fallback, and browser expansion applies after the batch. Deterministic internal calls still use normal executor checks. Existing workspace trust, approval, hardline, profile and child-access policies remain authoritative.

The catalog is constructed only from the final session registry. Disabled toolsets remove unavailable definitions too. Child access applies the effective allowlist to the entire registry, preventing unassessed unavailable tools from surviving into metadata. Session-scoped skill inspection never falls back to the profile registry. Profile-level operator and governed mutation paths retain their existing contracts.

## Validation

- Frozen dependency installation passed (Node 24.14.1, pnpm 10.33.0).
- Combined boundary suite: 344 tests passed across 10 files.
- Full repository suite: 11,855 tests passed across 738 files. A subsequently added integrated late-tool selection/admission test passed with the entire 141-test provider-loop suite.
- Tracked-source TypeScript checking and compiled build passed using temporary external configurations selecting the tracked source files.
- Runtime-import and compiled ESM audits passed; `git diff --check` passed.
- Standard typecheck and build remain blocked by three duplicate type declarations in the pre-existing untracked `src/types/bidi-js.d 2.ts`. That unrelated file was left untouched.
- Source smoke: 12/13 passed; the Evolution lifecycle gate invokes ordinary typecheck and fails on the same duplicate declarations.
- Compiled smoke: 12/13 passed; the same Evolution lifecycle typecheck gate fails on the duplicate declarations.

No live-provider performance or rebuilt desktop package acceptance is claimed. Those remain PR 6 release gates.

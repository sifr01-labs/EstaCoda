# Capability grounding and safe read reuse — PR 5

Implementation continues on `ame/reliability-baseline`. This records implemented behavior and validation, separately from the proposed reliability plan.

## Slice 1: durable memory boundary

Automatic extraction and review reject transient tool/provider/browser availability claims, including evidence spans that have been reworded into apparent user facts. The deterministic vocabulary covers English and Arabic examples. User browsing preferences and deliberate configuration choices remain eligible under existing curation rules. Explicit memory tools retain their existing authority and review paths.

At a normal curation checkpoint, existing short bullet entries containing stale capability claims can produce at most eight removal proposals. Proposals use the profile's existing curation store, retain exact reviewable matches, respect content scanning, and are never automatically applied. Mixed preference/state lines are excluded from removal proposals. Stable proposal IDs avoid repeating recently reviewed entries. No memory file is silently rewritten or blanket-cleared.

Review covers provider-supplied facts, evidence laundering, bilingual negatives, preferences, deliberate offline configuration, unchanged memory after cleanup proposals, and proposal deduplication. No credentials, profile boundaries, or approval policy changed.

## Slice 2: current capability evidence

Every provider iteration receives a bounded, noncached runtime projection for at most 12 relevant tools. It distinguishes exposure, provider schema restrictions, catalog readiness and the latest current-turn execution observation. It includes no raw result bodies, private endpoints or historical memory assertions. The prompt explicitly preserves user preferences, provider restrictions and action approvals; an exposed schema does not prove readiness, and a successful status call reporting unavailable does not prove availability.

A narrow final-response guard corrects direct blanket unavailability claims contradicted by owned current-turn tool observations. Newer browser failures/denials and provider restrictions prevent the correction. Scoped failures, quoted text and user instructions such as “do not browse” are preserved. The guard does not execute or authorize anything and does not imply task completion.

The deterministic runtime harness loads contradictory profile memory, executes the real browser status handler against both available and unavailable backends, verifies the provider receives the current evidence and retained user preference, and checks final grounding. Prompt/provider tests passed (213 tests); runtime recovery/acceptance checks passed (37 tests). Slice 1 memory checks passed (66 tests). Isolated tracked-source typechecks and diff checks passed before commits.

## Slice 3: bounded public-read reuse

The built-in guarded fetch provider opts in to turn-local `web.extract` reuse. Other providers must explicitly declare stateless public extraction; individual results can decline reuse. Search, browser state, private URLs, protected/authenticated responses, redirects, errors, secret-bearing URLs and responses with restrictive or short-lived cache headers are excluded. The store admits at most 16 observations and 256,000 serialized bytes, with a maximum observation age of 60 seconds. `refresh: true` discards the old observation before retrieving again under normal policy.

Keys preserve meaningful query parameters and effective extraction limits. The executor scopes observations to profile, session, visible turn, execution target and authority/configuration generation. Handler configuration, provider registration and fetch implementation identities also invalidate reuse. Any intervening non-extract execution, approval request, policy denial, failed dispatched execution or new turn conservatively clears reuse. Late results from invalidated views cannot repopulate a new scope.

Every hit runs through ordinary input validation, approval, dispatch authorization and live execution authority checks, then revalidates DNS/public URL eligibility and current website policy, including shared blocklist files. Reuse grants no execution authority. It retains the original origin URL, retrieval timestamp and truncation metadata, labels the full result as a prior observation, and preserves the original call ID in feedback and persisted tool-result metadata. Executor-owned provenance marks the new call ineligible as fresh completion evidence and prevents progress credit; model-supplied metadata cannot manufacture this status. Research tables retain the observation's original retrieval date even across midnight.

The deterministic runtime acceptance test runs two five-source batches: ten successful tool calls cause five provider extractions, and the next provider iteration receives the full latest batch with prior-observation labels. Additional checks cover explicit refresh, new turns, denial, policy and DNS changes, provider/configuration replacement, byte/entry/age bounds, asynchronous invalidation, protected responses and evidence provenance. General no-progress thresholds are unchanged.

Risk note: this changes memory admission, provider context and network-result reuse in the shared runtime. Reuse is deliberately limited to reviewed public reads and can be bypassed with `refresh`; it does not promise that a live page remains unchanged during the 60-second window. Cleanup proposals still require normal review, and capability summaries do not grant permissions. Packaged desktop and held-out release validation remain PR 6 work.

## Validation

The final full suite passed: **11,958 tests across 744 files**. Node v24.14.1 and pnpm 10.33.0 were used. Frozen-lockfile installation passed without dependency changes. Focused reuse/runtime/security checks passed (296 tests); after reviewing the exact new schema and provenance fields, the two affected snapshot suites passed (67 tests).

The standard typecheck and build both fail on the pre-existing untracked duplicate declarations in `src/types/bidi-js.d 2.ts` (`BidiDirection`, `BidiEmbeddingLevels`, `BidiApi`). Those unrelated files were preserved. A temporary configuration listing tracked sources plus the new PR 5 source files passed typechecking and compilation. Both runtime-import and ESM audits passed against that compiled output. Source and compiled smoke each passed 12/13 cases; their Evolution lifecycle case invokes the standard typecheck and hits the same duplicate declarations. These are workspace validation limitations, not passing standard release gates.

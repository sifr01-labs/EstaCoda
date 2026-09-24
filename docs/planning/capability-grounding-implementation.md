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

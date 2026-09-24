# Capability grounding and safe read reuse — PR 5

Implementation continues on `ame/reliability-baseline`. This records implemented behavior and validation, separately from the proposed reliability plan.

## Slice 1: durable memory boundary

Automatic extraction and review reject transient tool/provider/browser availability claims, including evidence spans that have been reworded into apparent user facts. The deterministic vocabulary covers English and Arabic examples. User browsing preferences and deliberate configuration choices remain eligible under existing curation rules. Explicit memory tools retain their existing authority and review paths.

At a normal curation checkpoint, existing short bullet entries containing stale capability claims can produce at most eight removal proposals. Proposals use the profile's existing curation store, retain exact reviewable matches, respect content scanning, and are never automatically applied. Mixed preference/state lines are excluded from removal proposals. Stable proposal IDs avoid repeating recently reviewed entries. No memory file is silently rewritten or blanket-cleared.

Review covers provider-supplied facts, evidence laundering, bilingual negatives, preferences, deliberate offline configuration, unchanged memory after cleanup proposals, and proposal deduplication. No credentials, profile boundaries, or approval policy changed.

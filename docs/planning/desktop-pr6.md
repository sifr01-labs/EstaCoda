# Desktop PR6 implementation record

PR6 is in progress on `ame/desktop-foundation`, based on `644e49da`. The desktop implementation plan and frozen visual contract remain the acceptance references.

## 1. Provider metadata and offline model catalog

The bridge now serves bounded, cursor-fenced `providers.list` and `models.list` projections from the existing offline model selection catalog. Projections include capabilities, limits, lifecycle, source and price availability; they do not include raw provider configuration, headers or credentials. Catalog visibility does not grant route readiness. Credential and route health projections follow in slice 2.

Review: existing paging enforces response limits and capture/query fencing. Protocol validation rejects extra fields and inconsistent runnable/catalog-only or retired states. Catalog capture performs no provider HTTP request or profile write.

Validation: catalog and protocol validation tests (8 passing); root TypeScript check in the isolated tracked-source checkout; desktop foundation typechecks and protocol boundary check; `git diff --check`. Full release and desktop visual/native validation remain pending until PR6 is integrated.

Risk: this slice exposes read-only metadata; it grants no setup mutation or execution authority. Existing unrelated untracked files are excluded from commits and from the isolated validation checkout.

## 2. Route health and credential presence

Selected-profile credential inspection uses bounded, no-follow reads of `.env` and `auth.json`, without importing values into process environment or refreshing OAuth. Models report configured, missing/expired credential, catalog-only, unsupported, retired, or network-disabled states, and identify primary/fallback roles. A configured runnable route is not described as live-verified.

Review and validation: profile-isolation, secret-omission, OAuth-expiry and linked-file rejection tests; existing catalog tests (62 passing); catalog/protocol tests; root typecheck and desktop foundation checks. Risk: presence is deliberately weaker than validity; live health requires the explicit verification action in slice 3.

## 3. Bounded candidate verification

The bridge negotiates `models.verifyCandidate`. Explicitly approved tests use the staged credential's exact window/generation/provider/endpoint binding and existing provider adapters. One request has a 12-second deadline, 64 output-token cap and 64 KiB response cap. DNS addresses are validated and pinned; redirects are not followed, public endpoints require TLS, and local/private endpoints require explicit approval. The synthetic tool is never executed. Responses report compatibility, safe failure categories, latency and available usage/price estimates without provider content.

Failed or cancelled verification discards the initial candidate. Window closure, expiry and bridge disposal abort credential-backed tests, and concurrent tests of the same candidate are refused. Ordinary RPC carries no credential values.

Validation: all control-service/protocol tests (106 passing), including loopback redirect/size-limit tests, stream compatibility, endpoint rebinding, failed-key disposal and window cancellation; root typecheck; desktop foundation checks. Review caught and fixed a response-limit settlement race. The isolated checkout's dependency files were restored from the frozen local pnpm cache before validation. These are synthetic tests, not live provider-account tests.

## 4. Reviewed primary-route Apply

Primary-route drafts are bound to a bridge-owned profile, requesting window/generation, exact route and staged candidate. Apply reuses core setup manifests and the reviewed executor. Candidate API keys receive a new explicit profile-local environment reference per accepted change, so cached routes cannot accidentally send a replacement key to an earlier endpoint. Older references remain available to settling runtimes. No raw credentials enter ordinary RPC or receipts.

Core profile writers now serialize through a SQLite-backed OS lock. Desktop Apply checks the reviewed file snapshot under that lock, stages through the existing setup executor in a restricted temporary profile, and durably records its authorized commit before replacing `.env`, `auth.json` and config. An interrupted commit blocks runtime configuration loading and is completed on bridge recovery. Receipts distinguish applied, uncertain and unknown; post-save checks are read-only. Recovery files containing secrets use mode 0600. This is recoverable multi-file consistency, not a claim of atomic cross-file rename.

Existing CLI setup retains its transport-field persistence behavior. Desktop explicitly persists its reviewed API/auth mode. OAuth writers reject stale store snapshots, and delayed refresh results cannot overwrite a replacement authorization. An authenticated notification retires supervisor cache entries; borrowed runtimes retain ownership until release.

Risk: persistence, credentials and cache invalidation are security-sensitive. An incomplete commit blocks affected profile activation rather than exposing partial state. Completed credential references are retained for settling runtimes; automated old-reference cleanup is not introduced here.

Validation: full root suite, 660 files / 10,814 tests passing after correcting three regressions; 54 final focused protocol/setup/credential tests, 15 recovery/authority tests, endpoint/header rejection tests, root typecheck and desktop foundation checks. Lock tests include overlapping writers, awaited nested writes and process-death release. Native and visual desktop validation remains pending until the live UI slices are integrated.

## 5. Fallback route management

The bridge supports reviewed fallback setup plus a revision-bound fallback list for reorder/removal. Duplicate routes, duplication of the primary, invalid indices and stale list revisions are rejected. The same reviewed transaction handles Apply and recovery. Fallback credentials and endpoints remain route-local when their provider already exists, preserving the primary provider configuration. Lists are bounded to 32 routes.

Validation: 96 focused setup/protocol tests, including adding two fallbacks, reordering, removing, stale-index rejection, duplicate-primary rejection and primary endpoint/credential preservation; root typecheck and desktop foundation checks. Risk: fallback changes affect execution routing, so review snapshots and canonical configuration checks remain mandatory.

## 6. Reviewed specialist routes

The service exposes assessor, compression, session search, memory compaction and profile context. Each slot supports dedicated, primary, automatic or disabled routing, with an explicit fallback-to-primary choice. Dedicated routes reuse credential candidates and the reviewed transaction; mode changes use the same snapshot and recovery checks. Read-only projections distinguish credential presence from runnable configuration. Vision remains outside this editor.

Validation: 100 setup/protocol tests and 105 specialist resolver/protocol tests passed; root typecheck and desktop foundation checks passed. Review verified that specialist changes preserve primary, fallback and Vision configuration. Risk: specialist routing affects provider execution, so credentials remain profile-local and route changes use the existing resolver and setup executor.

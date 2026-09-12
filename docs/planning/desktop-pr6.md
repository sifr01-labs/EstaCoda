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

## 7. Session and Task model overrides

`models.workOverride` inspects a profile/target-bound selection. Session and Task set/clear controls use authenticated supervisor requests and input-bound durable receipts. A shared Session queues its model change behind the active turn. The supervisor retires idle cache entries and requires canonical ownership before writing the Session override; another live owner remains a refusal. Profile defaults stay unchanged. A Task records an explicit operator selection in its existing event store for future child construction, preserving active workers and immutable step definitions. Clearing restores the original routing policy.

Schema v36 preserves existing Task events while admitting model-selection events. The normal migration backup/recovery path applies. Read-only projections describe next-turn/next-attempt semantics and do not claim the current worker has switched.

Validation: 110 focused protocol, ownership, Session database and Task executor tests; migration/setup tests; root typecheck; desktop foundation checks. Regression coverage includes queued changes, priority cancellation, foreign ownership refusal, ended originating Sessions, profile/target mismatch, set/clear and operation-ID rebinding. Risk: execution routing and persisted state are sensitive; no lease is stolen and no in-flight runtime is edited.

## 8. Service-owned Codex OAuth

Authorization uses the existing Codex device/PKCE flow with fixed OpenAI endpoints, pinned URL-checked requests, 15-second request deadlines, bounded responses, no redirects and a 15-minute operation lifetime. Ordinary RPC returns only the verification URL, user code, state and candidate handle. Tokens remain in the service candidate store until reviewed Apply. Window generation changes, cancellation and disposal abort the flow and discard late token exchanges. Verification extracts only the access token from the validated staged record.

Validation: 93 OAuth, candidate, private-pipe and protocol tests passed; root typecheck and desktop foundation checks passed. Cancellation tests cover late exchange completion after explicit cancel, window closure and service shutdown. These are synthetic endpoint tests; no live account authorization or paid provider call was performed. Risk: OAuth is a credential boundary; browser opening remains a separate explicit Main action in the desktop setup slice.

## 9. Live provider and model dashboard

The approved Models component now has a live data path through narrow Main/preload methods. It shows provider route health, the primary route, and paged offline model metadata: context/output limits, tool/vision support, lifecycle, source and available pricing. Configured routes sort ahead of catalog-only entries. An explicit confirmation fetches public models.dev metadata with a deadline, response-size limit and redirect rejection; credentials and prompts are excluded.

Validation: 63 catalog/health/protocol tests and 24 desktop unit tests passed, plus root typecheck and desktop foundation checks. Refresh tests cover the fixed public destination, credential omission and oversized responses. The frozen fixture layout remains unchanged; integrated visual/native validation follows after setup and route editors are connected.

## 10. Private API-key setup

The live Add Provider dialog now validates the endpoint/API mode, opens the dedicated credential window, offers explicit bounded candidate verification, reviews the primary-route change, and applies through the service transaction. Main owns the setup identity and credential scope. Successful private entry transfers the staged handle to Main; the ordinary renderer has no key-input API. Cancel/profile change discards staging. Apply failures retain a profile-bound receipt pointer for explicit reconciliation, without automatic resubmission.

Validation: 27 desktop unit tests passed, including private-scope binding, cancellation, profile invalidation and uncertain-Apply inspection; focused core setup/credential/protocol tests; root typecheck and desktop foundation checks. The live dialog uses the approved modal components and styles, preserves keyboard focus and keeps setup-only values out of ordinary browser storage. Native credential-window integration remains part of the final PR6 acceptance run.

## 11. Desktop Codex OAuth setup

The live provider dialog supports Codex device authorization, displays the service-issued code, polls bounded status, and opens sign-in only on an explicit click. Main rechecks the service status and permits only the fixed HTTPS Codex verification URL. Authorized candidates enter the same verification/review/Apply flow as API-key routes. Staged token records are validated again at Apply, including when optional verification was skipped.

Validation: 28 desktop tests and 13 focused OAuth/verification/setup tests passed, plus root typecheck and desktop foundation checks. Main tests verify the exact browser destination, candidate handoff, no API-key window for OAuth, and cancellation. Live user-account authorization remains an explicit interactive acceptance step; no account login was performed during these tests.

## 12. Local and custom endpoints

The provider dialog supports the built-in local provider and named OpenAI-compatible endpoints, with reviewed URL, authentication, API mode, network enablement, context override and output cap. No-auth setup never opens the key window. Private/loopback verification requires an explicit choice; disabled provider requests cannot be verified. Verification honors a smaller reviewed output cap. Network/limit changes participate in the exact candidate binding.

Desktop primary Apply now resets omitted limits to defaults instead of silently carrying the previous model's caps forward. Existing CLI partial-update semantics remain unchanged. Fallback transport fields and output caps are preserved by reviewed setup; specialist output-cap editing remains excluded because that core slot has no output-cap field.

Validation: 115 focused core tests and 97 final limit/setup tests passed, 28 desktop tests passed, plus root typecheck and desktop foundation checks. Tests cover no-auth writes, disabled network, Responses transport, context/output persistence and reset, and credential invalidation after a cap change.

## 13. Primary, fallback and specialist editors

The live Models screen supports reviewed primary selection, fallback add/reorder/remove, and dedicated/primary/automatic/disabled choices for the five exposed specialist slots. Configured models reuse their exact existing profile credential reference. Verification of a reviewed configured route stages an ephemeral service-only copy, runs the bounded verifier, and drops that copy without modifying the saved credential. Ambiguous configured endpoint matches are rejected.

Provider setup also offers primary/fallback/specialist roles before staging. The dashboard prioritizes configured providers and keeps the wider provider catalog behind Browse Providers. Local and Codex setup metadata are available even when absent from the offline model snapshot. A development-mode mount cleanup issue was fixed so opening a review does not cancel its draft.

Validation: 105 core catalog/route/credential/protocol tests and 29 desktop tests passed, plus root typecheck and desktop foundation checks. Tests verify existing-key reuse, no process-environment import, read-only failed verification, role dispatch and reviewed ordering. Integrated visual and native journeys remain pending for the acceptance slice.

## 14. Work-scoped model picker

The composer now exposes the live model picker on bound Sessions and Tasks, with profile defaults unchanged. Main resolves the canonical Work/session/target binding and supplies operation identity; renderer input is limited to Work and model IDs. Accepted changes display their next-turn/next-attempt boundary, poll receipts, and block another change while uncertain. Task attempts remain read-only. New Work drafts retain a local selection for the later live-submission milestone.

Validation: 31 desktop tests and 62 protocol tests passed, plus desktop foundation and root typecheck. Tests cover canonical Task binding, reset, pending-operation reconciliation, profile isolation, and refusal of attempt controls. Browser/native journey coverage follows in the acceptance slice.

## 15. Secret and profile isolation acceptance

Added cancellation/profile-switch race tests at Main, rejection tests for renderer-supplied credential/scope fields, and service tests for cross-profile candidate use and closed-window no-auth drafts. Setup creation is serialized, late responses are discarded, uncertain Apply cannot be silently replaced, and every reviewed draft is bound to its owning window lifetime. Credential presence follows the final profile `.env` assignment, including explicit empty values.

Validation: 41 focused core tests, 34 desktop tests, desktop foundation and root typecheck passed. The recoverable Apply tests interrupt each of the three profile-file writes and verify activation blocking, 0600 recovery state, replay, and preserved unrelated settings. These changes tighten credential/configuration boundaries without granting new execution authority.

## 16. Route and execution behavior acceptance

Expanded real Task-executor coverage for step defaults, Task overrides and reset. A resumed worker now restores its saved override instead of accepting a later choice for future attempts. Re-selecting the configured primary preserves its context/output limits. The catalog retains explicitly configured custom models with unknown metadata; known non-chat categories stay excluded. Read-only saved checks account for intentional network disabling and optional automatic specialist slots that have no route.

Validation: 67 focused route/catalog/executor tests passed; root typecheck and desktop foundation passed. The full core suite is running for final acceptance. No provider request was required for these deterministic routing and ownership checks.

## 17. Desktop setup and recovery acceptance

Seven browser journeys cover private staging/cancellation, failed and in-flight verification, Codex authorization, custom no-auth setup, uncertain Apply reconciliation, configured/fallback/specialist review, Work override boundaries, and narrow layouts inside the production shell. Verification shows service-projected streaming/tool observations, safe result, latency, reported tokens and available cost. Completing authorization restores keyboard focus to Review; verification remains cancellable.

The native harness now uses the real Models dialog, Main, private credential window and descriptor 3. It verifies cancellation without writes and one bounded streamed request to a synthetic loopback endpoint, then reviewed Apply, bridge reconnect and full application restart. Last-Apply inspection can resolve the latest selected-profile receipt after a process restart without returning journal contents. Primary selection rejects an identical existing fallback. Migration assertions now follow the intentional v36 Task model-override schema.

Validation: 34 desktop unit tests, 117 browser/visual tests, 109 focused migration/setup/protocol tests and 73 final catalog/setup/protocol tests passed. Desktop foundation and the final macOS package/native suite passed, including strict relocated signature, CSP/fuses, icon and owned-runtime startup. The full release gate passed: 10,851 core tests in 663 files, smoke/build/import/ESM/dist checks, execution budgets, source/dist host–Docker conformance and Docker image validation. The final duplicate guard also passed the focused suite; a final full core rerun is recorded below when settled. Native evidence was regenerated intentionally and visually reviewed; frozen reference assets were not changed.

Acceptance scope: local provider transport is tested live against a deterministic loopback server. Paid provider requests and real-account Codex authorization were not performed. Developer ID signing/notarization remain the later distribution milestone.

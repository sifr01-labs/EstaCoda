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

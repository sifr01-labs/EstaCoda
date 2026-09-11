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

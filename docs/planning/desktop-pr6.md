# Desktop PR6 implementation record

PR6 is in progress on `ame/desktop-foundation`, based on `644e49da`. The desktop implementation plan and frozen visual contract remain the acceptance references.

## 1. Provider metadata and offline model catalog

The bridge now serves bounded, cursor-fenced `providers.list` and `models.list` projections from the existing offline model selection catalog. Projections include capabilities, limits, lifecycle, source and price availability; they do not include raw provider configuration, headers or credentials. Catalog visibility does not grant route readiness. Credential and route health projections follow in slice 2.

Review: existing paging enforces response limits and capture/query fencing. Protocol validation rejects extra fields and inconsistent runnable/catalog-only or retired states. Catalog capture performs no provider HTTP request or profile write.

Validation: catalog and protocol validation tests (8 passing); root TypeScript check in the isolated tracked-source checkout; desktop foundation typechecks and protocol boundary check; `git diff --check`. Full release and desktop visual/native validation remain pending until PR6 is integrated.

Risk: this slice exposes read-only metadata; it grants no setup mutation or execution authority. Existing unrelated untracked files are excluded from commits and from the isolated validation checkout.

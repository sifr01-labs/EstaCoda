# Jev routing configuration — commit 1

Status: configuration foundation implemented. The Jev client and live routing integration are not implemented in this commit. Both saved modes currently execute Standard routing. Desktop and Setup Editor explicitly disclose this limitation; this commit must not be advertised as a working Jev routing release.

## Configuration and setup

The selected profile owns `routing.mode` (`standard`, the default, or `jev-assisted`) and `routing.jev`:

- `provider`: `typesafe`.
- `id`: pinned `jev-1.13.0` by default. Model identifiers beginning with `jev-` are supported for explicit configuration, including TypeSafe aliases.
- `apiKeyEnv`: credential reference, default `TYPESAFE_API_KEY`.
- `timeoutMs`: 5000 by default, integer 100–60000.

Existing profiles need no migration or TypeSafe credential. Selecting Standard preserves the saved Jev settings. Neither mode changes the conversation model, auxiliary voice/vision models, execution permissions, or completion checks.

Desktop: Settings → Runtime → Execution → Intent & capability routing. Select Jev-assisted, then Change → TypeSafe → Jev model. The model card uses the existing protected credential entry, followed by Review changes → Save changes. Credential values stay outside the renderer and are written to the selected profile's private `.env` through the existing recoverable settings transaction. Only credential presence is projected to the UI. Configuration review, cancellation, stale-review rejection and existing settings-change notification remain in force.

CLI: Setup Editor → Intent & capability routing uses the existing centralized selector, secret prompt and reviewed apply executor. Cancelling review writes neither configuration nor credentials. Switching Standard/Jev-assisted is shared profile configuration, so clients using that profile load the same setting. Telegram does not gain an independent settings mutation path.

TypeSafe's decision API is separate from chat/completions. Jev is therefore a specialized model route, similar to specialized media configuration; it is not registered as a conversation provider. The initial picker catalog is pinned from https://docs.typesafe.ai/models, inspected 2026-10-06. Configuration/diagnostics make no Jev request and do not claim successful provider authentication.

## Runtime boundary and decision contract

Routing configuration contributes to the existing runtime definition fingerprint. Cached executions retain their lease; changed definitions are used after the active execution releases it. An attempted concurrent replacement remains busy. This does not implement mid-turn Jev response cancellation: the later async client integration must check configuration/catalog revisions and discard stale responses.

The versioned routing decision contract includes configured mode, actual engine, model, configuration/catalog revisions, independent intent/skill/capability selections, optional primary skill, and fallback reason. Probability is optional because Standard routing must not fabricate Jev probabilities. Selected labels are multi-label, not a single mutually exclusive choice. This contract is a foundation for later routing consumers, not execution authority.

## Validation and risk

Coverage includes config defaults and validation; Desktop protected credential round trips, redaction, cancellation, profile isolation and invalid model rollback; CLI apply/cancel and active-profile selection; runtime fingerprint and lease boundaries; English/Arabic Desktop model selection and review.

This changes security-sensitive configuration and credential entry surfaces. It reuses their existing scope, review and storage boundaries; no credential, approval, tool-exposure or network policy is relaxed. Live Jev decisions, calibrated selection thresholds, expansion recovery, fallback notifications and packaged live verification remain later commits in the implementation plan.

Validated on Node 24.14.1 / pnpm 10.33.0:

- Frozen dependency install in an isolated directory, without changing the checkout's dependencies or lockfile.
- Core typecheck and build; runtime import and ESM audits; source and compiled smoke suites (13/13 each).
- Core tests: 752 files, 12,153 tests passed with `pnpm run test --maxWorkers=4`. Two startup timeouts in the earlier concurrent validation run passed in isolation and in this final full run.
- Desktop protocol/type checks; 180 Desktop unit tests; 12 English/Arabic settings browser tests, including protected credential staging and review. Model picker layouts inspected visually.
- Final strengthened CLI cancellation/redaction assertions passed separately. `git diff --check` passed.

Core validation used an isolated copy of tracked sources plus this change because the working checkout contains unrelated duplicate source files. No packaged application install or live TypeSafe authentication/routing claim is made by these checks.

# Onboarding Baseline Audit

This is the historical audit log for replacing the onboarding proof of concept with the reviewed setup-entry architecture. Sections labeled O0 through O8 describe migration-time behavior at the time those phases were written. The final state on this branch is recorded in the Phase 5 through Phase 9 sections.

## O0 Historical Setup States

- `new or unconfigured`: `getOnboardingStatus()` reports onboarding needed when the effective model provider or id is `unconfigured`.
- `configured-ready`: `getOnboardingStatus()` reports no onboarding needed when a configured model exists and provider diagnostics are not blocked.
- `partial-provider`: a provider/model route can exist while diagnostics are blocked because credentials, network access, adapter support, or model registration are incomplete.
- `untrusted-workspace`: `collectSetupVerificationReport()` reports workspace trust independently from provider readiness.
- `state-not-writable`: setup verification attempts to write `~/.estacoda/.verify` and records a blocker if state cannot be written.
- `secret-permissions`: setup verification reports an existing `.env` secret store as unsafe unless it is mode `0600`.
- `tool-check-skipped`: read-only tool verification is skipped unless a runtime is provided and `package.json` exists.

## Current Entrypoints

- `estacoda setup` is the canonical setup entrypoint. When interactive input is available and setup state is `new-user`, it runs the new first-run setup runner through reviewed manifest approval, apply execution, verification, and launch-handoff end-state handling.
- `estacoda setup` for configured, degraded, repair, missing-secret, broken-config, untrusted-workspace, and state-not-writable states renders the new setup-route decision instead of entering the legacy wizard.
- `estacoda setup --provider <provider> --model <model>` writes provider config through `setupProviderConfig()`.
- bare `estacoda` checks `collectSetupRoute()`. It may offer setup when setup is incomplete, but it points users to `estacoda setup --interactive` instead of running setup inline.
- `estacoda init` bootstraps state directories and writes an unconfigured default config.
- `estacoda verify` renders a structured verification report plus extra CLI diagnostics.
- `estacoda doctor` uses `collectSetupEntryState()` so broken config can be classified and reported before normal config loading.

These paths must keep working through the setup-entry router coverage for first-run, configured-ready, degraded, partial, repair, verify, and launch choices.

## Reusable Pieces

- `collectSetupVerificationReport()` and `renderSetupVerificationReport()` already separate structured verification from rendering.
- `diagnoseProviderConfig()` provides the provider readiness signal and warning text.
- `WorkspaceTrustStore` provides the trust read/write behavior the new architecture should reuse.
- `setupProviderConfig()`, `setupSecurityConfig()`, `setupSkillConfig()`, and optional capability setup helpers provide low-level config writes.
- `setup-copy.ts` and `setup-verification-copy.ts` provide English and Arabic setup-owned copy after the Phase 7 migration.
- `cli-ui-copy.ts` and `bidi.ts` provide the small chrome copy boundary and LTR isolation helpers needed by later Arabic onboarding work.

## Legacy POC Surfaces

Replace rather than extend:

- `interactive-onboarding.ts` as a monolithic wizard controller.
- `onboarding-flow.ts` as the setup state model; it only classifies provider onboarding need.
- `defaultOnboardingSteps()` hardcoded provider options.
- `onboarding-provider-catalog.ts` hardcoded provider/model choices.
- `completeOnboarding()` as a provider-only wrapper.
- `onboarding.status` and `onboarding.complete` runtime tools.

Completed during the migration:

- `Prompt` and `createReadlinePrompt()` now live in neutral CLI modules.
- Live CLI setup, bare launch, and doctor decisions use `collectSetupEntryState()` and `collectSetupRoute()`.

## Removed In O0

- The POC backup-provider setup path was removed from interactive onboarding.
- The no-op `backupForMain` input was removed from provider setup types and tool schema.

The removed backup path did not write `model.fallbacks`, so it was misleading and would conflict with the intended fallback architecture. Future backup setup should use `setupModelFallbackConfig()`.

## O0 Docs Drift

- `docs/subsystems/cli.md` described an optional backup model in first-run onboarding; that is no longer true after O0 cleanup.
- Public docs described current POC first-run behavior during O0. Phase 9 updates active docs to the reviewed setup architecture.

## Security Notes

- Sensitive surfaces touched by O0: onboarding flow, provider config tool schema, smoke coverage.
- Approval/trust impact: none. Workspace trust behavior remains explicit and unchanged.
- Secret-handling impact: positive. The removed backup path no longer invites secret capture for a route that was not actually registered as a fallback.

## O1 Status

`collectSetupEntryState()` now exists as the new read-only setup-entry classifier. It classifies:

- `new-user`
- `configured-ready`
- `configured-degraded`
- `partial-provider`
- `missing-secret`
- `broken-config`
- `untrusted-workspace`
- `state-not-writable`

It reuses structured verification and provider diagnostics, reports exact config paths and loaded sources, extracts missing credential references, and returns a recommended next action without parsing rendered output.

## O2 Status

`collectSetupRoute()` and `routeSetupEntryState()` now exist beside the current POC wizard. The router consumes `collectSetupEntryState()` and decides:

- `new-user` -> first-run onboarding path
- `configured-ready` -> configured setup menu
- `configured-degraded` -> configured/degraded menu
- `partial-provider`, `missing-secret`, `broken-config`, `state-not-writable` -> repair-first menu
- `untrusted-workspace` -> configured menu with explicit trust warning and trust repair action
- selected `verify` -> read-only verification route

The router does not replace `estacoda setup` yet and does not write config. Existing noninteractive setup flags remain on the current CLI path.

## O3 Status

`buildFirstRunOnboardingPlan()` now exists as the first-run onboarding plan/state layer beside the current POC wizard. It models stable step primitives for:

- `welcome`
- `interface-language`
- `workspace-root`
- `workspace-trust`
- `primary-provider`
- `primary-model`
- `primary-credential`
- `security-mode`
- `workflow-learning`
- `optional-capabilities`
- `review`
- `save`
- `verify`
- `launch`

Each step exposes structured metadata only: step id, copy key, required flag, sensitive surface, inputs, outputs, validation rules, skip rules, and next-step behavior. The layer has no terminal rendering and does not write config.

O3 also adds pure state helpers for advancing across active steps. Language selection remains early, Arabic selection changes subsequent onboarding-owned copy context to Arabic, workspace trust remains explicit, local providers skip hosted credential collection, hosted providers require a credential reference, and optional capabilities remain independently skippable without degrading core setup.

Fallback setup is not reintroduced as the removed backup-provider POC path. The only fallback representation in the plan layer is an optional future shared `model.fallbacks` primitive.

## O3.5 Status

The setup router now connects first-run route decisions to the first-run plan through a structured `firstRunPlanSession` seam. New-user routes produce an initial plan session with:

- initial state
- current step
- active steps
- selected locale
- copy locale
- plan metadata

The initial current step is `welcome`. Seeded first-run selections flow into the session, including Arabic copy locale selection and local-provider hosted credential skipping.

Configured, degraded, repair, and verify routes do not include a first-run plan session by default. An explicit internal `run-first-run` selection can request a first-run plan session without cutting over user-facing setup paths.

O3.5 does not change the current wizard, does not add prompt-card rendering, and does not write config.

## O4 Status

`buildSetupEditorPlan()` now exists as the Guided Setup Editor Architecture for existing-user reconfiguration and repair paths. It is the configured-user counterpart to the first-run plan and remains beside the current POC wizard.

The setup editor plan models structured sections for:

- existing config summary
- primary provider/model route review and edit intent
- credential status and credential edit/repair intent
- security mode review/edit intent
- workflow-learning review/edit intent
- workspace trust review/repair intent
- optional capability review/edit placeholders
- read-only verification
- exit/cancel

The setup router now attaches a `setupEditorPlanSession` to configured-ready, configured-degraded, untrusted-workspace, and repair-first routes. First-run routes still use `firstRunPlanSession`, and verify routes remain read-only without setup editor or first-run sessions.

O4 action objects are declarative drafts only. They do not write config, each scoped config patch intent declares `preserveUnrelatedConfig`, and missing credentials are represented as redacted environment-variable references without raw secret values. Broken config routes do not assume normal config editing is safe.

Optional capabilities are represented as independent placeholders, workspace trust remains separate from provider readiness, and fallback setup is not reintroduced as `backupForMain`. If fallback setup is represented later, it should continue to use the shared `model.fallbacks` primitive.

## O4.5 Status

`buildFirstRunDraftBundle()` and `buildSetupEditorDraftBundle()` now define the save/apply boundary for setup drafts. They convert first-run plan sessions and guided setup editor sessions into reviewable setup draft bundles without writing config, trust stores, or state files.

Drafts cover:

- provider/model route changes
- credential reference and repair intents
- security mode changes
- workflow-learning changes
- workspace trust grants/repairs
- optional capability enable/disable/configure intents
- read-only verification requests
- launch handoff preference

Each draft has a stable id, kind, source step or section/action id, risk surface, target path or config scope where applicable, redacted review metadata, dry-run apply intent metadata, review requirement, and blockers/warnings. Scoped config drafts declare `preserveUnrelatedConfig`.

Credential drafts expose environment variable names only and do not include raw secret values. Workspace trust drafts include the exact workspace root and trust store path but do not grant trust. Verification drafts remain read-only. Broken config produces diagnostic blocker drafts instead of unsafe normal config patch drafts.

Fallback setup is still not reintroduced as `backupForMain`; future fallback representation remains limited to a shared `model.fallbacks` intent.

## O5 Status

`setup-modules.ts` now defines modular setup capability contracts that plug into the O4.5 setup draft boundary. Each module exposes structured `detect()`, `configure()`, `review()`, `toDrafts()`, and read-only `verify()` behavior without terminal rendering or direct mutation.

The initial module set covers:

- primary provider/model route
- credential references
- workspace trust
- security mode
- workflow learning
- Telegram
- voice
- vision/image generation
- browser

Modules produce `SetupDraft` objects with a `setup-module` source and can be grouped into a `setup-module-session` draft bundle. Provider setup remains separate from optional capabilities, local providers skip hosted credential drafts, hosted providers require credential environment-variable references, and workspace trust remains separate from provider readiness.

Optional modules are independently skippable. Telegram exposes remote-control identity constraints without printing bot token values. Browser setup records that auto-launch may be requested but does not launch anything during setup planning. Voice and vision/image generation expose provider, model, and environment-variable references without raw hosted secrets. Verification remains read-only.

Broken config contexts produce diagnostic blocker drafts instead of normal config patch drafts. Fallback setup is still not represented as `backupForMain`; future fallback setup remains limited to the shared `model.fallbacks` intent.

## O6 Status

`buildSetupReviewManifest()` now assembles first-run, guided setup editor, and setup-module draft bundles into a structured pre-save review manifest. This is the trust boundary before any future apply/save implementation.

The manifest groups review lines for:

- files to write or update
- secret references to store
- workspace trust grants or repairs
- provider/model/network changes
- enabled optional capabilities
- remote-control surfaces and identity constraints
- security mode
- workflow-learning mode
- read-only verification checks
- launch handoff preference
- blockers
- warnings

Each manifest line has a stable id, section, source draft ids, copy and summary keys, risk surface, target path or config scope where applicable, redacted review metadata, severity, read-only status, blockers, and warnings. Scoped config lines preserve unrelated config by design.

Manifest creation is pure. It does not write config, trust stores, or state files. Environment-variable names may appear, but raw secret values are removed from review metadata. Exact config, workspace, and trust-store paths appear where relevant. Workspace trust grants remain explicit. Telegram remote-control setup surfaces allowed identity constraints without bot token output. Browser setup records intent without auto-launching.

Broken config bundles produce blocker manifest lines and suppress unsafe normal config write lines. Verification remains read-only. Skipped optional capabilities are omitted from the main review unless a later renderer needs explicit skipped items. `backupForMain` remains absent; future fallback setup remains limited to the shared `model.fallbacks` intent.

## O7 Status

`planSetupApply()` now defines the structured post-review save, verify, and launch handoff architecture. It consumes approved, cancelled, or blocked review decisions and produces either a dry-run save/apply plan or a terminal setup end state without parsing rendered text.

The O7 apply plan models:

- scoped config patch operations
- credential-reference operations
- explicit workspace trust grant operations
- post-save verification requests
- launch handoff intents
- apply eligibility blockers and repair intents

The plan layer remains pure. It describes future work but does not write config files, trust stores, secrets, or state files. All operations are marked dry-run, preserve unrelated config where scoped config changes are involved, and keep raw secret values out of review metadata. Workspace trust can only appear as an explicit approved operation.

Apply eligibility now blocks normal apply for broken config or unsafe diagnostic-only states, routes missing credentials to credential repair, and keeps review cancellation from producing any apply plan. Degraded verification remains distinct from ready verification and requires an explicit continue or limited-mode decision before launch. Save failure and blocked verification stop the flow before verify or launch handoff.

The represented end states are:

- `verified-ready`
- `verified-degraded`
- `blocked`
- `cancelled`
- `saved-not-launched`
- `launched`

`executeSetupApplyPlan()` provides a narrow future apply interface for tests and later implementation. It can consume structured verification reports, classify ready/degraded/blocked results, and produce launch handoff only for verified-ready or explicitly accepted degraded setup.

## O8 Status

`setup-copy.ts` now defines an onboarding-owned copy and bidi registry for the new setup architecture. It includes MVP English and Arabic setup copy for first-run setup, Guided Setup Editor, setup modules, review manifest, validation, and save/verify/launch handoff surfaces.

The approved screenshot Arabic is treated as the O8 source of truth wherever it differs from earlier planning copy. Mixed copy key styles and exact placeholders are preserved, and Arabic technical tokens/placeholders are LTR-isolated through the existing bidi helper.

O8 does not add prompt-card rendering, terminal layout changes, user-facing setup cutover, or full CLI localization claims. It only establishes the structured copy boundary needed by later rendering work.

## Phase 5 Status

Live CLI setup and bare-launch setup handling are now cut over to the new setup-entry architecture.

- `estacoda setup --interactive` runs the new first-run setup runner for `new-user` routes and uses reviewed manifest approval before apply.
- The first-run runner can execute the reviewed apply executor, then uses structured verification and setup end states for ready, degraded, blocked, cancelled, saved-not-launched, and launch-handoff outcomes.
- Configured-ready, configured-degraded, partial-provider, missing-secret, broken-config, untrusted-workspace, and state-not-writable setup states render the new setup-route summary and actions instead of entering the legacy wizard.
- bare `estacoda` uses `collectSetupRoute()` for launch gating. It may offer setup when incomplete, but setup itself remains under `estacoda setup --interactive`.
- `estacoda doctor` uses `collectSetupEntryState()` before normal config loading so broken config is diagnostic instead of an uncaught setup failure.
- Direct advanced setup flags such as `estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY` remain supported.

Phase 5 left legacy onboarding files and runtime onboarding tools in place for later removal review. They were not the live CLI setup path after Phase 5.

## Phase 6 Status

Runtime onboarding tools were removed from live registration. The runtime no longer exposes `onboarding.status` or the mutating `onboarding.complete` tool, and no runtime path calls `completeOnboarding()`. Setup mutation remains behind the reviewed CLI setup/apply architecture.

## Phase 7 Status

Verification copy moved off `onboarding-copy.ts` and into setup-owned copy boundaries. `verification.ts` imports `setup-verification-copy.ts`, which resolves labels and actions through `setup-copy.ts`. Verification collection and rendering remain separate, and Arabic technical-token isolation is preserved for paths, commands, env vars, and provider/model identifiers used in onboarding-owned setup surfaces.

## Phase 8 Status

The legacy onboarding POC files were deleted:

- `src/onboarding/interactive-onboarding.ts`
- `src/onboarding/interactive-onboarding.test.ts`
- `src/onboarding/onboarding-flow.ts`
- `src/onboarding/onboarding-provider-catalog.ts`
- `src/onboarding/onboarding-tools.ts`
- `src/onboarding/onboarding-copy.ts`

`verification.ts` now owns its setup verification options type, so setup verification no longer depends on the deleted provider-only flow.

## Phase 9 Status

Active docs now describe the completed cutover:

- `estacoda setup` is the canonical setup entrypoint.
- bare `estacoda` uses setup-route decisions when setup is incomplete.
- direct `estacoda setup --provider ... --model ... --api-key-env ...` flags are advanced/direct setup.
- interactive setup uses reviewed setup, review-before-apply, reviewed apply execution, structured verification, and launch handoff behavior.
- runtime mutating onboarding tools are removed.
- fallback models use the model fallback path and `model.fallbacks`, not `backupForMain`.
- Arabic onboarding copy and technical-token isolation are supported within onboarding-owned setup surfaces.

This does not claim full runtime CLI localization or runtime setup mutation tools.

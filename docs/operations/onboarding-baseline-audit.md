# Onboarding Baseline Audit

This is the O0 audit for replacing the current onboarding proof of concept with the setup-entry architecture. It documents current behavior so the replacement can be built beside the old entrypoints without letting the old implementation shape dictate the new design.

## Current Setup States

- `new or unconfigured`: `getOnboardingStatus()` reports onboarding needed when the effective model provider or id is `unconfigured`.
- `configured-ready`: `getOnboardingStatus()` reports no onboarding needed when a configured model exists and provider diagnostics are not blocked.
- `partial-provider`: a provider/model route can exist while diagnostics are blocked because credentials, credential pools, network access, adapter support, or model registration are incomplete.
- `untrusted-workspace`: `collectSetupVerificationReport()` reports workspace trust independently from provider readiness.
- `state-not-writable`: setup verification attempts to write `~/.estacoda/.verify` and records a blocker if state cannot be written.
- `secret-permissions`: setup verification reports an existing `.env` secret store as unsafe unless it is mode `0600`.
- `tool-check-skipped`: read-only tool verification is skipped unless a runtime is provided and `package.json` exists.

## Current Entrypoints

- `estacoda setup` with no args enters the current interactive onboarding wizard when interactive input is available.
- `estacoda setup --provider <provider> --model <model>` writes provider config through `setupProviderConfig()`.
- bare `estacoda` checks `getOnboardingStatus()` and offers to run the current wizard when setup is missing.
- `estacoda init` bootstraps state directories and writes an unconfigured default config.
- `estacoda verify` renders a structured verification report plus extra CLI diagnostics.
- `estacoda doctor` still uses `getOnboardingStatus()` for provider setup warnings.

These paths must keep working until the setup-entry router has covered first-run, configured-ready, degraded, partial, repair, verify, and launch choices.

## Reusable Pieces

- `collectSetupVerificationReport()` and `renderSetupVerificationReport()` already separate structured verification from rendering.
- `diagnoseProviderConfig()` provides the provider readiness signal and warning text.
- `WorkspaceTrustStore` provides the trust read/write behavior the new architecture should reuse.
- `setupProviderConfig()`, `setupSecurityConfig()`, `setupSkillConfig()`, and optional capability setup helpers provide low-level config writes.
- `onboarding-copy.ts` has useful English and Arabic copy, but the new flow should use it through a structured step/copy boundary.
- `cli-ui-copy.ts` and `bidi.ts` provide the small chrome copy boundary and LTR isolation helpers needed by later Arabic onboarding work.

## Legacy POC Surfaces

Replace rather than extend:

- `interactive-onboarding.ts` as a monolithic wizard controller.
- `onboarding-flow.ts` as the setup state model; it only classifies provider onboarding need.
- `defaultOnboardingSteps()` hardcoded provider options.
- `onboarding-provider-catalog.ts` hardcoded provider/model choices.
- `completeOnboarding()` as a provider-only wrapper.
- `onboarding.status` and `onboarding.complete` runtime tools.

Moved or preserved until replacements exist:

- `Prompt` and `createReadlinePrompt()` are shared CLI utilities today and must move to a neutral CLI module before deleting `interactive-onboarding.ts`.
- `getOnboardingStatus()` is still used by setup, bare launch, doctor, and smoke coverage. Replace it with `collectSetupEntryState()` before removing it.

## Removed In O0

- The POC backup-provider setup path was removed from interactive onboarding.
- The no-op `backupForMain` input was removed from provider setup types and tool schema.

The removed backup path did not write `model.fallbacks`, so it was misleading and would conflict with the intended fallback architecture. Future backup setup should use `setupModelFallbackConfig()`.

## Docs Drift

- `docs/subsystems/cli.md` described an optional backup model in first-run onboarding; that is no longer true after O0 cleanup.
- Public docs still describe current POC first-run behavior, not the future setup-entry architecture. Do not document the new architecture as user-facing behavior until `estacoda setup` is cut over.

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

## Next Step

After review, choose the next phase label and scope. A likely next checkpoint is O5: setup modules for capabilities, or a narrowly scoped dry-run review surface if maintainers want to inspect draft bundles before module work. Defer user-facing cutover until first-run, existing-user, partial-config, repair, verify, and launch behavior are all covered by the new architecture.

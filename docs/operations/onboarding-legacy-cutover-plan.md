# Onboarding Legacy Cutover Plan

Status: historical migration plan. The cutover through Phase 9 is complete on the integration branch. References to deleted legacy files, old live paths, and future-phase work below are retained as migration history, not current architecture.

This plan describes how to move EstaCoda onboarding off the legacy proof-of-concept implementation and onto the structured setup architecture.

The goal is not only to delete files. The goal is to make `estacoda setup`, bare interactive launch, setup diagnostics, review, apply, verification, and launch handoff all use the new setup-entry architecture safely.

## Historical Starting Classification

### Legacy Or POC-Bound

These files belong to the old live onboarding path and should be retired after replacement call sites exist:

- `src/onboarding/interactive-onboarding.ts`
  - Current monolithic wizard.
  - Still live through `estacoda setup` and bare launch.
  - Also currently exports shared CLI prompt utilities, so it cannot be deleted until those move.
- `src/onboarding/onboarding-flow.ts`
  - Old provider-only setup status model.
  - Exports `getOnboardingStatus()`, `completeOnboarding()`, and `defaultOnboardingSteps()`.
  - Should be replaced by `collectSetupEntryState()` and `collectSetupRoute()`.
- `src/onboarding/onboarding-tools.ts`
  - Registers legacy runtime tools `onboarding.status` and `onboarding.complete`.
  - `onboarding.complete` is a mutating provider setup tool and should be removed or replaced with a narrower reviewed setup path.
- `src/onboarding/onboarding-provider-catalog.ts`
  - Current-wizard provider/model picker helper.
  - It now consumes `ModelSelectionCatalog`, so it is no longer hardcoded in the original POC sense, but it still belongs to the old wizard path.
- `src/onboarding/onboarding-copy.ts`
  - Current-wizard onboarding copy.
  - Still used by `verification.ts`; migrate verification copy before deleting.

### Keep

- `src/onboarding/verification.ts`
  - Keep.
  - It has been refactored into structured verification collection and rendering.
  - It is part of the new setup/readiness architecture, though its copy dependency should move off `onboarding-copy.ts`.

### Intended New Architecture

The current intended architecture already has these contracts:

- `src/onboarding/setup-entry-state.ts`
- `src/onboarding/setup-router.ts`
- `src/onboarding/first-run-plan.ts`
- `src/onboarding/setup-editor-plan.ts`
- `src/onboarding/setup-editor-actions.ts`
- `src/onboarding/setup-drafts.ts`
- `src/onboarding/setup-modules.ts`
- `src/onboarding/setup-review-manifest.ts`
- `src/onboarding/setup-apply-plan.ts`
- `src/onboarding/setup-copy.ts`
- `src/ui/bidi.ts`
- `src/ui/cli-ui-copy.ts`
- `src/contracts/view-model.ts`
- `src/ui/view-models/builders.ts`
- `src/ui/renderers/standard-renderer.ts`
- `src/ui/renderers/plain-renderer.ts`

The architecture has most of the setup truth, copy, bidi isolation, ViewModel, theme, token, and rendering substrate. The missing work is the live cutover: interactive setup runner, real reviewed apply execution, CLI routing, runtime tool replacement, and final deletion.

## Target Module Layout

As part of the cutover, move the new architecture into a more human-readable directory structure:

```text
src/onboarding/
  setup-state.ts
  setup-router.ts
  setup-verification.ts
  setup-copy.ts

  first-run/
    flow.ts
    runner.ts

  config-editor/
    flow.ts
    actions.ts

  review/
    change-drafts.ts
    manifest.ts
    apply-plan.ts
    apply-executor.ts

  capabilities/
    modules.ts
```

### Rename Map

Use this map when touching imports during the migration:

| Current file | Target file | Notes |
| --- | --- | --- |
| `src/onboarding/setup-entry-state.ts` | `src/onboarding/setup-state.ts` | Shorter and easier to scan. Keep exported function name `collectSetupEntryState()` unless a later API rename is worth the churn. |
| `src/onboarding/setup-router.ts` | `src/onboarding/setup-router.ts` | Keep name. This is already clear. |
| `src/onboarding/verification.ts` | `src/onboarding/setup-verification.ts` | Makes the file's new role explicit. |
| `src/onboarding/setup-copy.ts` | `src/onboarding/setup-copy.ts` | Keep name. |
| `src/onboarding/first-run-plan.ts` | `src/onboarding/first-run/flow.ts` | This is the first-run flow/state contract. |
| new runner | `src/onboarding/first-run/runner.ts` | Drives the first-run flow interactively. |
| `src/onboarding/setup-editor-plan.ts` | `src/onboarding/config-editor/flow.ts` | Existing-user/reconfiguration flow. |
| `src/onboarding/setup-editor-actions.ts` | `src/onboarding/config-editor/actions.ts` | Existing-user/reconfiguration action drafts. |
| `src/onboarding/setup-drafts.ts` | `src/onboarding/review/change-drafts.ts` | Draft setup changes before review. |
| `src/onboarding/setup-review-manifest.ts` | `src/onboarding/review/manifest.ts` | Review manifest before apply. |
| `src/onboarding/setup-apply-plan.ts` | `src/onboarding/review/apply-plan.ts` | Structured apply planning. |
| new executor | `src/onboarding/review/apply-executor.ts` | Executes approved apply operations. |
| `src/onboarding/setup-modules.ts` | `src/onboarding/capabilities/modules.ts` | Provider/trust/security/optional capability modules. |

### Naming Rules

- Keep exported API names stable during the move unless a rename clearly reduces confusion.
- Prefer import-path churn over API churn in the first pass.
- Update tests alongside each moved file.
- Do not leave compatibility barrel files unless they are temporary and removed before the final deletion phase.
- Keep historical docs clear that old flat paths existed before the cutover.

## Safety Rules

Onboarding is a trust boundary. During this migration:

1. Do not weaken workspace trust checks.
2. Do not write config before explicit review approval.
3. Do not expose raw secret values in review metadata, logs, snapshots, or errors.
4. Keep provider setup separate from optional capability setup.
5. Keep remote-control capabilities explicit and allowlisted.
6. Keep fallback model setup on `model.fallbacks`; do not reintroduce `backupForMain`.
7. Keep Arabic technical tokens LTR-isolated.
8. Do not delete legacy files until every live import has moved.
9. Keep direct setup flags compatible unless intentionally deprecated with docs and tests.
10. Run scoped tests after each phase and full validation before deletion.

## Phase 1: Extract Shared Prompt Utilities

### Problem

`interactive-onboarding.ts` is legacy, but it currently exports shared prompt primitives used outside onboarding.

Known dependents include:

- `src/cli/cli.ts`
- `src/cli/interactive-launcher.ts`
- `src/cli/session-loop.ts`
- `src/cli/pack-commands.ts`
- `src/packs/pack-installer.ts`
- `src/index.ts`
- tests importing `Prompt`

### Implementation

Create a neutral CLI module:

- `src/cli/readline-prompt.ts`

Move these from `interactive-onboarding.ts`:

- `Prompt`
- `createReadlinePrompt()`
- `canRunInteractive()`
- hidden/secret prompt helpers
- readline input/output plumbing

Keep the `Prompt` interface compatible with existing call sites:

```ts
export type Prompt = ((question: string, options?: { secret?: boolean }) => Promise<string>) & {
  select?: <T>(input: SelectPromptInput<T>) => Promise<T>;
  onboardingCard?: (input: BuildOnboardingPromptCardInput) => Promise<void> | void;
  close?: () => void;
};
```

If `onboardingCard` remains useful outside the legacy wizard, keep it in the prompt type. Otherwise, move onboarding-card rendering into the new setup runner in a later phase and keep the prompt type narrower.

Update imports so no non-legacy file imports `Prompt`, `createReadlinePrompt()`, or `canRunInteractive()` from `interactive-onboarding.ts`.

### Tests

Run:

```bash
pnpm exec vitest run src/cli/session-loop.test.ts
pnpm exec vitest run src/cli/interactive-launcher.test.ts
pnpm exec vitest run src/cli/pack-commands.test.ts
pnpm run typecheck
```

### Exit Criteria

- Shared prompt utilities live outside `src/onboarding`.
- `interactive-onboarding.ts` is only imported by legacy onboarding tests or temporary legacy setup paths.

## Phase 2: Replace The Legacy Setup Status Model

### Problem

`getOnboardingStatus()` only answers whether provider setup is ready. It does not model broken config, missing secrets, workspace trust, state writability, degraded provider state, or repair choices with the fidelity required by the new architecture.

### Implementation

Replace live status calls with:

- `collectSetupEntryState()`
- `collectSetupRoute()`
- `routeSetupEntryState()`
- `renderSetupRouteDecision()`

Update:

- `src/cli/cli.ts`
  - `setup()` help/status path should call `collectSetupRoute()` or `collectSetupEntryState()`.
  - `doctor()` should use `collectSetupEntryState()` instead of `getOnboardingStatus()`.
- `src/cli/interactive-launcher.ts`
  - bare launch should use `collectSetupRoute()` to decide whether setup is needed.
- `src/index.ts`
  - remove direct dependency on `getOnboardingStatus()`.

Consider adding:

- `src/onboarding/setup-state-renderer.ts`

This renderer should produce deterministic noninteractive output from `SetupEntryState` or `SetupRouteDecision`. It must not become a source of truth.

### Behavior Requirements

`estacoda setup` with no args in noninteractive mode should report:

- current setup state;
- recommended action;
- blockers and warnings;
- available next commands;
- direct advanced setup examples where appropriate.

`doctor` should report provider setup problems based on structured setup state, not the old provider-only onboarding status.

Bare `estacoda` should:

- launch when setup is ready;
- ask whether to run setup when state requires first-run or repair;
- not silently write config.

### Tests

Run:

```bash
pnpm exec vitest run src/onboarding/setup-state.test.ts
pnpm exec vitest run src/onboarding/setup-router.test.ts
pnpm exec vitest run src/cli/setup-command.test.ts
pnpm exec vitest run src/cli/interactive-launcher.test.ts
pnpm run typecheck
```

### Exit Criteria

- No live CLI path needs `getOnboardingStatus()`.
- `onboarding-flow.ts` is no longer required for setup state decisions.

## Phase 3: Build The New Interactive Setup Runner

### Problem

`first-run/flow.ts` defines the intended setup flow, but there is not yet a live runner that fully replaces `runInteractiveOnboarding()`.

### Implementation

Create:

- `src/onboarding/first-run/runner.ts`
- optionally `src/onboarding/first-run/prompt-renderer.ts`

The runner should:

1. Accept setup options and collect a `SetupRouteDecision`.
2. Drive `firstRunPlanSession` for new-user paths.
3. Drive `setupEditorPlanSession` for configured, degraded, untrusted, and repair paths.
4. Render prompt cards using `OnboardingPromptCardViewModel`.
5. Use `setup-copy.ts` for setup-owned English and Arabic copy.
6. Use `isolateLtr()` for technical tokens in Arabic text.
7. Collect selections into structured state.
8. Produce draft bundles instead of writing directly.
9. Produce a review manifest before any apply operation.
10. Ask for explicit review approval before applying.
11. Run verification after save.
12. Support launch handoff only after verified-ready or explicit degraded-mode acceptance.

Suggested public API:

```ts
export type InteractiveSetupResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly workspaceRoot?: string;
  readonly launched?: boolean;
};

export async function runInteractiveSetup(options: InteractiveSetupOptions): Promise<InteractiveSetupResult>;
```

### First-Run Flow

The first-run flow should use the stable plan steps:

1. `welcome`
2. `interface-language`
3. `workspace-root`
4. `workspace-trust`
5. `primary-provider`
6. `primary-model`
7. `primary-credential`
8. `security-mode`
9. `workflow-learning`
10. `optional-capabilities`
11. `review`
12. `save`
13. `verify`
14. `launch`

Rules:

- Language selection stays early.
- Arabic selection switches later setup copy to Arabic.
- Local providers skip hosted API-key collection.
- Hosted providers require credential references.
- Workspace trust remains explicit.
- Optional capabilities are independently skippable.
- Skipping optional capabilities must not degrade core setup.
- Backup/fallback setup must not reintroduce `backupForMain`.

### Existing User And Repair Flow

For configured or broken states, use the setup editor plan:

- configured-ready: launch, review/edit config, verify, exit;
- configured-degraded: repair, verify, limited-mode launch, review/edit, exit;
- missing-secret: credential repair first;
- partial-provider: provider repair first;
- broken-config: diagnostic/repair path before normal apply;
- untrusted-workspace: explicit trust repair before local file or terminal work;
- state-not-writable: state directory repair instructions before setup continuation.

### Renderer Rules

Prompt rendering should consume ViewModels, not concatenate terminal art in the runner.

Use:

- `buildOnboardingPromptCardViewModel()`
- `createSessionRenderer()`
- `StandardRenderer`
- `PlainRenderer`

Keep no-color and no-Unicode output deterministic.

### Tests

Add tests for:

- English first-run path;
- Arabic first-run path;
- Arabic technical token isolation;
- local provider credential skip;
- hosted provider credential prompt;
- workspace trust accepted;
- workspace trust declined;
- optional capabilities skipped;
- missing secret repair path;
- degraded provider path;
- broken config path;
- review cancellation;
- review approval;
- no mutation before review approval.

Run:

```bash
pnpm exec vitest run src/onboarding/first-run/flow.test.ts
pnpm exec vitest run src/onboarding/setup-router.test.ts
pnpm exec vitest run src/onboarding/review/change-drafts.test.ts
pnpm exec vitest run src/onboarding/review/manifest.test.ts
pnpm exec vitest run src/ui/renderers/standard-renderer.test.ts
pnpm exec vitest run src/ui/renderers/plain-renderer.test.ts
```

### Exit Criteria

- `runInteractiveSetup()` can replace `runInteractiveOnboarding()`.
- The runner uses the new plan/draft/review architecture.
- No setup mutation occurs before explicit review approval.

## Phase 4: Implement Reviewed Apply Execution

### Problem

`review/apply-plan.ts` defines apply planning, but current operations are still dry-run/future-executor oriented.

### Implementation

Create:

- `src/onboarding/review/apply-executor.ts`

The executor should consume approved `SetupApplyPlan` operations and call existing low-level helpers:

- `setupProviderConfig()`
- `setupSecurityConfig()`
- `setupSkillConfig()`
- `setupUiConfig()`
- `setupTelegramConfig()`
- `setupVoiceConfig()`
- `setupImageGenerationConfig()`
- `setupBrowserConfig()`
- `WorkspaceTrustStore.grant()`
- `collectSetupVerificationReport()`

### Operation Mapping

Map setup operation kinds conservatively:

- provider/model route changes -> `setupProviderConfig()`
- credential reference updates -> provider/capability setup helpers with env-var references only
- security mode -> `setupSecurityConfig()`
- workflow learning -> `setupSkillConfig()`
- UI language/style -> `setupUiConfig()`
- workspace trust grant -> `WorkspaceTrustStore.grant()`
- Telegram -> `setupTelegramConfig()`
- voice -> `setupVoiceConfig()`
- vision/image generation -> `setupImageGenerationConfig()`
- browser -> `setupBrowserConfig()` without auto-launching browser runtime
- verification request -> `collectSetupVerificationReport()`
- launch handoff -> returned intent only; do not start agent inside low-level apply helper unless the setup runner explicitly owns launch continuation

### Safety Requirements

- Apply only approved review manifests.
- Preserve unrelated config.
- Stop on first write failure.
- Do not continue to verification if save fails.
- Do not continue to launch if verification blocks setup.
- Require explicit limited-mode acceptance for degraded verification.
- Never include raw secrets in review or apply metadata.
- Do not auto-enable remote-control capabilities without allowlist information.

### Tests

Add tests for:

- config patch apply;
- credential reference apply without raw secret leakage;
- workspace trust grant apply;
- optional capability apply;
- save failure stops verification;
- verification blocked stops launch;
- degraded verification requires explicit acceptance;
- cancellation produces no operations;
- broken config routes to repair intent.

Run:

```bash
pnpm exec vitest run src/onboarding/review/apply-plan.test.ts
pnpm exec vitest run src/onboarding/review/apply-executor.test.ts
pnpm exec vitest run src/config/runtime-config.test.ts
pnpm exec vitest run src/security/workspace-trust-store.test.ts
pnpm run typecheck
```

### Exit Criteria

- New setup runner can actually apply reviewed setup changes.
- The old `completeOnboarding()` wrapper is no longer needed.

## Phase 5: Cut Over CLI Entrypoints

### Problem

The live CLI still sends setup traffic to the legacy wizard and old status model.

### Implementation

Update:

- `src/cli/cli.ts`
  - `estacoda setup`
  - `estacoda setup --interactive`
  - setup help/status output
  - direct setup flag compatibility
  - `doctor`
- `src/cli/interactive-launcher.ts`
  - missing setup prompt
  - setup continuation into interactive session
- `src/index.ts`
  - remove old onboarding imports

Direct advanced setup flags may remain as a compatibility path:

```bash
estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
```

If retained, direct setup should be described as advanced/direct setup and should continue to use the existing low-level config helpers.

### Behavior Requirements

`estacoda setup` should be the canonical setup entrypoint:

- new-user -> first-run setup;
- configured-ready -> launch/review/verify/exit menu;
- configured-degraded -> repair/verify/limited launch/review/exit menu;
- partial-provider -> repair-first menu;
- missing-secret -> credential repair;
- broken-config -> diagnostic repair path;
- untrusted-workspace -> trust repair choice;
- state-not-writable -> state repair guidance.

Bare `estacoda` may ask whether to run setup when setup is incomplete, but the setup product flow should live in `estacoda setup`.

### Tests

Run:

```bash
pnpm exec vitest run src/cli/setup-command.test.ts
pnpm exec vitest run src/cli/init-command.test.ts
pnpm exec vitest run src/cli/interactive-launcher.test.ts
pnpm exec vitest run src/cli/cli-model.test.ts
pnpm run typecheck
```

### Exit Criteria

- Live setup and bare-launch paths use the new setup runner and router.
- Old `runInteractiveOnboarding()` is no longer called from live CLI code.

## Phase 6: Remove Or Replace Runtime Onboarding Tools

### Problem

The runtime still registers `onboarding.status` and `onboarding.complete`.

`onboarding.complete` mutates provider setup from inside the agent runtime, which is a sensitive boundary and does not match the new reviewed setup model.

### Preferred Implementation

Remove legacy onboarding tools:

- delete `createOnboardingTools()` registration from `src/runtime/create-runtime.ts`;
- update smoke fixtures and tests that expect these tools.

### Alternative Implementation

If runtime setup tools are still needed, replace them with read-only diagnostics first:

- `setup.status`
- `setup.route`
- `setup.verify`

These should use:

- `collectSetupEntryState()`
- `collectSetupRoute()`
- `collectSetupVerificationReport()`

Do not add a mutating runtime setup tool unless it uses the new review/apply architecture and requires explicit human approval at the trust boundary.

### Tests

Run:

```bash
pnpm exec vitest run src/runtime
pnpm exec vitest run src/tools
pnpm run smoke
```

### Exit Criteria

- `src/onboarding/onboarding-tools.ts` is no longer registered.
- No runtime tool calls `completeOnboarding()`.

## Phase 7: Move Verification Copy Off Legacy Copy

### Problem

`verification.ts` should stay, but it still imports copy from `onboarding-copy.ts`.

### Implementation

Move verification copy to one of:

- preferred: `src/onboarding/setup-copy.ts`;
- acceptable: `src/onboarding/setup-verification-copy.ts`.

Update:

- `src/onboarding/setup-verification.ts`
- `src/onboarding/setup-verification.test.ts`

If using `setup-copy.ts`, add or reuse keys for:

- state directory not writable;
- secret store permissions unsafe;
- workspace not trusted;
- read-only tool verification warning;
- tool check skipped because no `package.json`;
- report headings and summary labels.

Keep Arabic technical tokens isolated.

### Tests

Run:

```bash
pnpm exec vitest run src/onboarding/setup-verification.test.ts
pnpm exec vitest run src/onboarding/setup-copy.test.ts
```

### Exit Criteria

- `setup-verification.ts` no longer imports `onboarding-copy.ts`.
- `onboarding-copy.ts` is only used by legacy files.

## Phase 8: Delete Legacy Files

### Pre-Deletion Check

Run:

```bash
rg "interactive-onboarding|onboarding-flow|onboarding-tools|onboarding-provider-catalog|onboarding-copy|getOnboardingStatus|runInteractiveOnboarding|completeOnboarding|defaultOnboardingSteps|createOnboardingTools" src scripts docs
```

Before deletion, live source should have no imports of:

- `interactive-onboarding.ts`
- `onboarding-flow.ts`
- `onboarding-tools.ts`
- `onboarding-provider-catalog.ts`
- `onboarding-copy.ts`

Docs may mention these only in historical or migration context.

### Delete

Delete:

- `src/onboarding/interactive-onboarding.ts`
- `src/onboarding/interactive-onboarding.test.ts`
- `src/onboarding/onboarding-flow.ts`
- `src/onboarding/onboarding-provider-catalog.ts`
- `src/onboarding/onboarding-tools.ts`
- `src/onboarding/onboarding-copy.ts`

Replace legacy wizard coverage with tests for:

- `first-run/runner.ts`
- `review/apply-executor.ts`
- setup CLI cutover
- Arabic setup prompt cards
- review/apply safety

### Tests

Run:

```bash
pnpm exec vitest run src/onboarding
pnpm exec vitest run src/cli
pnpm run typecheck
```

### Exit Criteria

- Legacy files are gone.
- No source import points at deleted files.
- New runner and executor tests replace legacy wizard coverage.

## Phase 9: Update Documentation

Update:

- `docs/subsystems/cli.md`
- `docs/operations/onboarding-baseline-audit.md`
- `docs/manual-qa.md`
- `README.md` setup references, if applicable

Document:

- `estacoda setup` is the canonical setup entrypoint.
- direct `--provider` setup flags are advanced/direct setup.
- fallback models use `estacoda model fallback ...`.
- setup uses reviewed apply operations.
- runtime onboarding mutation tools were removed or replaced.
- Arabic onboarding scope and token-isolation behavior.
- verification remains read-only.

Do not document planned behavior as current behavior until the cutover lands.

## Final Validation

Run the standard validation set:

```bash
pnpm run typecheck
pnpm run smoke
git diff --check
```

Run focused area tests:

```bash
pnpm exec vitest run src/onboarding
pnpm exec vitest run src/cli/setup-command.test.ts
pnpm exec vitest run src/cli/interactive-launcher.test.ts
pnpm exec vitest run src/runtime/startup-readiness.test.ts
pnpm exec vitest run src/ui/renderers
pnpm exec vitest run src/ui/cli-ui-copy.test.ts
pnpm exec vitest run src/ui/bidi.test.ts
```

## Manual QA Matrix

Before declaring the migration complete, manually exercise:

- first-run setup in English;
- first-run setup in Arabic;
- Arabic provider/model/env/path rendering;
- local provider path with no hosted key;
- hosted provider path with credential env reference;
- missing secret repair path;
- partial provider repair path;
- broken config path;
- untrusted workspace path;
- degraded provider path;
- optional capability skipped path;
- Telegram setup with allowlist review, if included;
- browser setup review without auto-launch;
- review manifest before apply;
- review cancellation with no mutation;
- review approval and apply;
- verification success;
- verification blocked;
- degraded verification with explicit limited-mode acceptance;
- launch handoff after verified setup.

## Definition Of Done

The migration is complete when:

- no live source imports legacy onboarding files;
- `estacoda setup` uses `collectSetupRoute()` and the new setup runner;
- bare launch uses the new setup route decision;
- `doctor` no longer depends on `getOnboardingStatus()`;
- guided setup writes only through reviewed apply operations;
- runtime no longer exposes legacy mutating onboarding tools;
- `setup-verification.ts` remains and depends on new setup copy;
- Arabic prompt cards and technical token isolation are covered by tests;
- fallback setup remains on `model.fallbacks`;
- onboarding modules use the target human-readable directory layout;
- `pnpm run typecheck`, `pnpm run smoke`, and `git diff --check` pass.

## Suggested Commit Slices

Keep the migration reviewable:

1. `refactor(cli): move readline prompt utilities out of onboarding`
2. `refactor(onboarding): move setup architecture into readable modules`
3. `refactor(onboarding): route setup status through setup state`
4. `feat(onboarding): add structured first-run setup runner`
5. `feat(onboarding): execute reviewed setup apply plans`
6. `refactor(cli): cut setup and launch over to setup runner`
7. `refactor(runtime): remove legacy onboarding tools`
8. `refactor(onboarding): move verification copy to setup copy`
9. `chore(onboarding): delete legacy onboarding POC files`
10. `docs(onboarding): document setup cutover behavior`

The risky slices are the setup runner, apply executor, and CLI cutover. Keep those patches narrow and test-heavy.

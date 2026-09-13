# Desktop PR14C validation record

Recorded 2026-09-13 on macOS 26.5.2 arm64, Node 24.14.1 and pnpm 10.33.0, on `ame/desktop-foundation`. PR14C follows `d4b9b065` in the plan's twelve-commit sequence. This is first-run implementation acceptance, not public-release certification.

## Executed checks

| Check | Result |
| --- | --- |
| `node --version`, `pnpm --version` | Versions above verified |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged |
| `pnpm run typecheck` | Passed |
| `pnpm run test --maxWorkers=2` | **11,567 tests passed**, 705 files |
| `pnpm run smoke` | All smoke cases passed |
| Core build through desktop packaging | Passed |
| `pnpm run audit:runtime-imports` | Passed |
| `pnpm run audit:esm` | Passed |
| `pnpm run smoke:dist` | All compiled smoke cases passed |
| `pnpm run desktop:foundation:check` | Passed, including protocol boundary and Desktop types |
| `pnpm --filter @estacoda/desktop test` | Final run: **94 tests passed**, 23 files |
| `pnpm --filter @estacoda/desktop e2e` | **220 browser tests passed**, including existing visual checks |
| `pnpm --filter @estacoda/desktop package` | Final macOS arm64 local package built and ad-hoc signature verified |
| Packaged onboarding acceptance | English/API-key and Arabic/no-auth first Work and restart |
| `git diff --check` | Passed |

Core checks and packaging ran in `/tmp/ec14c-validation`, a copy of tracked working-tree sources. This excludes pre-existing untracked duplicate source files that make the original directory's TypeScript build fail; those files were preserved. The copy's shared protocol package resolves within that copy. Desktop checks also ran directly in the working repository. Final desktop-only corrections were synchronized into the package source and rechecked with Desktop types/unit tests and packaged acceptance. No dependencies, lockfile, approved prototype or visual baselines were changed.

## Packaged journey and evidence

Run from the repository root after packaging:

```sh
node --import tsx apps/desktop/tests/onboarding-packaged.mts /path/to/packaged/source/apps/desktop
```

The harness extracts the package, verifies its signature, and launches the actual packaged executable. It uses a fresh temporary HOME and desktop data directory for each language. The app's PATH contains only system directories; `node` and `estacoda` are absent there. Electron uses the owned bundled core runtime. Playwright attaches to an explicit local debugging port for the test; no package fuses, sandbox preferences or credential IPC boundaries are weakened. The native folder picker is driven through macOS accessibility using the launched process's PID. Accessibility permission for the test runner is required.

Both journeys use real UI, Main IPC, core profile apply, workspace registration, explicit trust, target verification, Work creation and on-demand execution. A bounded loopback HTTP fixture supplies the model response; these are real runtime turns, not live commercial-provider calls. English stages a synthetic API key through the separate private credential window; Arabic uses a no-auth route. Assertions check that config and credentials are absent before final confirmation, the key is absent from the ordinary renderer, first Work returns the fixture response, the global active-profile pointer is not created, and config, Work history and display language survive restart.

Screenshots of summary, readiness and first Work in each language, plus machine-readable results, are in [PR14C evidence](../../apps/desktop/tests/visual-evidence/pr14c/README.md). The test stops only its isolated app and owned test gateway, then removes its temporary home. It does not install a login service.

## Review findings addressed

- A read-only selected profile beneath writable global state now reports blocked setup without attempting a write.
- The composed first-run transaction has explicit OAuth coverage through the existing profile-local auth store, including redacted review output. Existing API-key/no-auth, cancellation, interrupted-apply, changed-workspace, deferred-trust, existing-install and restart checks remain in place.
- Native restart testing exposed microphone permission cleanup accessing destroyed window contents. Revocation now removes the grant without accessing the destroyed object; a regression checks both revocation and refusal to grant after destruction.
- Arabic visual review exposed a raw setup protocol identifier. Every setup diagnostic now maps through localized product copy, with coverage for all classifier states.

## Boundaries and remaining release gates

These runs use isolated application homes on this developer's macOS account, not a newly provisioned OS account or machine. They do not establish Gatekeeper/notarization behavior, public signing, installation from a downloaded distributable, OS-wide absence of development tools, or commercial-provider availability. Those clean-machine distribution gates remain PR16. OAuth is exercised with controlled core transports, not a live account login. Optional dependency downloads, hosted channel delivery and physical microphone/browser permission journeys are not claimed by this first-run record; the PR14B validation limits still apply. The full Docker/execution-release wrapper was not rerun here.

Before-confirmation drafts survive Back within the open wizard but are not durably resumed after closing it. Private candidates expire and must be staged again after cancellation or a long pause. Durable recovery applies to an already confirmed save. Configuration/credentials commit together; workspace registration and trust have a separate receipt and can require repair after the profile save. This boundary is visible in the UI and [operator guide](desktop-pr14c-onboarding.md).

Security-sensitive changes retain selected-profile scope, separate private credential transport, explicit trust, snapshot-checked reviewed apply, hardline execution policy and runtime ownership. Verification grants no execution authority, sends no provider request and installs no background service. The runtime still validates the target when Work is submitted. Unrelated planning edits and untracked files are outside these commits.

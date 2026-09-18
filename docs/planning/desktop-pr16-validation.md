# PR16 implementation evidence

PR16 is **in progress** on `ame/desktop-foundation`. This is not public-release approval. No Apple Developer signing/notarization setup is available; signed-package and real update acceptance have not run.

## Baseline and setup commits (2026-09-18)

Baseline: `eccfe9aa`, Node 24.14.1, pnpm 10.33.0, macOS arm64. Validation uses `/tmp/ec-pr16-validation`, a clean copy of tracked working-tree files with locked dependencies. Pre-existing duplicate source files and unrelated planning changes were preserved. The running development copy was not replaced or restarted.

1. Installation ownership and update trust contract: reviewed against PR16 A–F; no runtime behavior changed.
2. Local setup inspection: selected-profile status only, authenticated supervisor probe, no startup or credentials in projections. 160 focused core/contract tests and core typecheck passed.
3. Bilingual first-install welcome: a separate non-authoritative acknowledgement, fresh/existing choices, current readiness recheck, Settings entry. Desktop types/protocol boundary, 151 unit tests and two UI journeys passed; screenshot inspected.
4. Multiple discovered profiles and reviewed separate setup: existing core profile action review/confirmation, no credential copying, no global CLI pointer write, existing non-default first-run bootstrap. Ten focused core tests, desktop types and both initial UI journeys passed.
5. Cancellation, compatibility and bilingual regression coverage: CLI active-profile default and linked-profile rejection, narrow IPC payloads, existing healthy setup, incompatible supervisor, profile switching, cancel before creation and explicit separate-profile confirmation. 153 desktop tests, type/protocol checks and four English/Arabic UI journeys passed. UI fixtures are not downloaded-package proof. Arabic screenshot inspection uses the production appearance/language provider.

The baseline full suite passed 11,705 core tests (730 files), 150 desktop tests, frozen install, core/desktop typecheck, source smoke, build, runtime import and ESM audits, and distribution smoke. Focused checks above cover later changes. No live provider calls, account sign-ins or external actions were performed.

## Security and release boundaries

The owned bundled bridge remains the only process launched by Desktop. Profile discovery lists validated local identities, then inspection reads the selected profile. The welcome acknowledgement cannot authorize workspace trust, execution, runtime attachment or migration. Existing setup readiness is revalidated before continuing. Creation uses the existing reviewed profile action; cancelled reviews do not create a profile. Configuration and credentials remain at their existing locations. The CLI active-profile pointer remains unchanged.

Public signed releases, downloaded clean-machine setup, staging N → N+1 updates, live runtime asset retention through replacement, recovery/uninstall and Replit website acceptance remain open. Exact signing identity, supported release architectures/minimum OS and updater selection require release evidence. No updater installation is enabled by these setup commits.

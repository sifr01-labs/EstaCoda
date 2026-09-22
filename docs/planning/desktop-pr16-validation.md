# PR16 implementation evidence

PR16 is **in progress** on `ame/desktop-foundation`. This is not public-release approval. No Apple Developer signing/notarization setup is available; signed-package and real update acceptance have not run.

## Baseline and setup commits (2026-09-18)

Baseline: `eccfe9aa`, Node 24.14.1, pnpm 10.33.0, macOS arm64. Validation uses `/tmp/ec-pr16-validation`, a clean copy of tracked working-tree files with locked dependencies. Pre-existing duplicate source files and unrelated planning changes were preserved. The running development copy was not replaced or restarted.

1. Installation ownership and update trust contract: reviewed against PR16 A–F; no runtime behavior changed.
2. Local setup inspection: selected-profile status only, authenticated supervisor probe, no startup or credentials in projections. 160 focused core/contract tests and core typecheck passed.
3. Bilingual first-install welcome: a separate non-authoritative acknowledgement, fresh/existing choices, current readiness recheck, Settings entry. Desktop types/protocol boundary, 151 unit tests and two UI journeys passed; screenshot inspected.
4. Multiple discovered profiles and reviewed separate setup: existing core profile action review/confirmation, no credential copying, no global CLI pointer write, existing non-default first-run bootstrap. Ten focused core tests, desktop types and both initial UI journeys passed.
5. Cancellation, compatibility and bilingual regression coverage: CLI active-profile default and linked-profile rejection, narrow IPC payloads, existing healthy setup, incompatible supervisor, profile switching, cancel before creation and explicit separate-profile confirmation. 153 desktop tests, type/protocol checks and four English/Arabic UI journeys passed. UI fixtures are not downloaded-package proof. Arabic screenshot inspection uses the production appearance/language provider.

6. Relocatable runtime packaging (completed validation 2026-09-22): native target enforcement, full dependency inventory before bridge launch, standalone Node probes for SQLite and Sharp, and the existing separate Electron PTY path. Final desktop type/protocol checks and 155 tests passed. The final local macOS arm64 package passed complete inventory verification, strict ad-hoc signature verification, SQLite/Sharp probes after relocation to a space/Arabic path, PTY spawning from the relocated asar, production CSP/fuses/icon checks, and unchanged hardened app startup with its owned Node bridge. Package evidence is local development evidence, not signed/notarized release acceptance. Legacy v1 manifests now require restaging through the normal build/start hook.

Final core validation after the setup changes passed 11,709 tests across 731 files and core typecheck. The packaging build passed. Final source/distribution smoke checks, runtime import audit, ESM audit and `git diff --check` also passed. The interrupted approval-review failure was resolved on resumption; no validation was bypassed.

The baseline full suite passed 11,705 core tests (730 files), 150 desktop tests, frozen install, core/desktop typecheck, source smoke, build, runtime import and ESM audits, and distribution smoke. Focused checks above cover later changes. No live provider calls, account sign-ins or external actions were performed.

## Security and release boundaries

The owned bundled bridge remains the only process launched by Desktop. Profile discovery lists validated local identities, then inspection reads the selected profile. The welcome acknowledgement cannot authorize workspace trust, execution, runtime attachment or migration. Existing setup readiness is revalidated before continuing. Creation uses the existing reviewed profile action; cancelled reviews do not create a profile. Configuration and credentials remain at their existing locations. The CLI active-profile pointer remains unchanged.

Public signed releases, downloaded clean-machine setup, staging N → N+1 updates, live runtime asset retention through replacement, recovery/uninstall and Replit website acceptance remain open. Exact signing identity, supported release architectures/minimum OS and updater selection require release evidence. No updater installation is enabled by these setup commits.

## Next required gate

The next ordered commit is 7: production signing, notarization and updater-compatible artifacts. The user confirmed that no Apple Developer setup exists. Developer ID signing/notarization and staging release credentials must be configured before real signed replacement/relaunch can establish the updater choice. The repository is `sifr01-labs/EstaCoda`; no release assets were published. Commits 7–24 and public-release acceptance remain unfinished.

When production signing is added, finalize the runtime inventory **after** signing nested runtime binaries and **before** sealing the outer application bundle. Developer ID signing can change native binary bytes; the local ad-hoc evidence does not waive this ordering requirement. Never disable the inventory check to accommodate signing.

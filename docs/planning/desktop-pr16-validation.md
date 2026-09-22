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

## Original signing gate (superseded by the deferral below)

The next ordered commit is 7: production signing, notarization and updater-compatible artifacts. The user confirmed that no Apple Developer setup exists. Developer ID signing/notarization and staging release credentials must be configured before real signed replacement/relaunch can establish the updater choice. The repository is `sifr01-labs/EstaCoda`; no release assets were published. At that checkpoint, commits 7–24 and public-release acceptance were unfinished. The continuation below records subsequent work.

When production signing is added, finalize the runtime inventory **after** signing nested runtime binaries and **before** sealing the outer application bundle. Developer ID signing can change native binary bytes; the local ad-hoc evidence does not waive this ordering requirement. Never disable the inventory check to accommodate signing.

## Signing deferred by user (2026-09-22)

The user authorized continuing the rest of PR16 while revisiting Apple signing/notarization later. Step 7 and real release acceptance in steps 18–20 remain deferred. Later implementation can proceed with explicit release gates; it must not claim a selected updater or signed acceptance from mocks.

8. Installation ownership and coordination: Main classifies development, unsupported, mounted, translocated, external, read-only and unverified installations. Only a verified, writable application in a supported Applications location can be replaceable. A shared coordinator uses exclusive filesystem locking across windows/processes; interrupted locks require recovery rather than automatic takeover. The read-only status is exposed over exact, authenticated semantic IPC. Release setup remains disabled.

9. Bundled runtime lifetime: packaged launches verify and atomically retain the complete runtime under Desktop's owned `runtime-versions` directory, keyed by its content digest. Existing generations are never automatically removed, including after a bridge or window exits. This avoids replacing files still needed by a shared supervisor. Restart policy rejects incompatible, active or uncertain readers/resources; actual coordinated replacement proof remains deferred. Cache retention consumes disk space until an explicit future safe cleanup can prove no users remain.

Step 8 validation: desktop type/protocol checks and 157 tests passed, plus targeted ownership/IPC checks. Step 9 validation: 159 desktop tests, desktop types, retained-ownership core regression, production package build and relocated hardened app/retained bridge/native-module checks passed. Signed update and multi-process replacement acceptance remain deferred.

10. Release discovery: signed Ed25519 envelopes, pinned publisher/team and immutable repository assets, bounded HTTPS reads/redirects, expiry and compatibility checks, stable-only version comparisons and coalesced/manual check throttling. Automatic checks are opt-in, persisted and disableable: first check after one minute, then six hours, backing off to twelve/twenty-four hours on failure. Checks never start downloads. Missing release pins disable all network checks. Desktop types/protocol checks and 162 tests passed. Real feed publication and signing keys remain deferred.

11. Download staging implementation: exclusive update coordination, owned random partial files, byte/timeout/free-space limits, streamed progress, cancellation cleanup, digest checks before and after mandatory archive publisher verification, then atomic cache promotion. There is no archive extraction or execution. The platform archive verifier is deliberately unavailable until updater/signing acceptance; production downloads cannot become ready without it. Tests exercise the verifier boundary with synthetic archives, not actual platform signatures. Desktop types and 163 tests passed.

12. Restart/recovery implementation: persist signed metadata with staged/replacement-requested/installed/uncertain receipts. Download receipts are written under the update lock before ready is reported. Restore reauthenticates metadata and cached bytes, refuses malformed/uncertain records, and only records installed after a matching version plus native running-app verification. Restart rechecks ownership, compatibility, readers/resources, signature and bytes; no automatic restart occurs on download or restore. The platform installer and reader-coordination adapter remain deferred and unavailable, so production replacement cannot be invoked. Desktop types and 165 tests passed, including synthetic Later, active-resource, concurrent install and relaunch cases. These are not real signed replacement evidence.

13. Update presentation: compact accent sidebar indicator and Settings entry, bilingual modal with versions/notes/progress, explicit download/restart, Later, cancel and automatic-check preference. Keyboard focus returns to the trigger; version order is isolated in RTL. Desktop type/protocol checks, 165 unit tests and four English/Arabic light/dark UI journeys passed. Inspected English and narrow Arabic screenshots. UI uses synthetic update states; production signing gates remain closed.

14. Hostile update regression coverage: rejected redirect destinations are never contacted, redirect loops and streamed metadata are bounded, older/incompatible releases are not offered, and truncated/oversized/changed archives are never promoted. Two independent download owners serialize; cancellation during verification cleans the partial file. Expanded exact IPC payload rejection across update actions. Desktop typecheck and 169 tests passed. Native wrong-signer and interrupted replacement acceptance still require the deferred platform adapter.

15. Lifecycle regression coverage: retained dependencies can be loaded by a new Node process after removal of the original app bundle. Missing, negative, nonnumeric and active resource counts fail closed. Synthetic restart/recovery leaves separate CLI, profile configuration/auth, active pointer, sessions, trust and workspace fixtures byte-identical. Desktop typecheck, 170 desktop tests and the retained Desktop ownership core regression passed. This does not establish real concurrent reader coordination; production installation stays disabled.

16 (preparation only). Added a read-only macOS release preflight workflow and offline metadata-candidate builder. It binds stable tags/source/Desktop/core versions to final regular installer/updater bytes and signs the validated envelope with an explicitly supplied Ed25519 key. No publication, signing secrets, or write token are enabled. Protected native signing/publishing jobs remain deferred until the updater is selected and demonstrated. Desktop typecheck and 171 tests passed; workflow execution on GitHub and production candidate generation have not run.

17. Prepared the separate Replit handoff with reserved feed/asset paths, authenticated single-record consumption, architecture/expiry limitations, source licensing and publication order. No URLs are claimed published and no website was changed. Reviewed against the feed validator and candidate builder. Third-party packaged notice inventory is checked in step 21.

18–20 are deferred by the user’s signing decision: actual published endpoint/signature completeness, downloaded clean-machine bilingual setup, and real signed N → N+1/failure recovery. Existing synthetic tests cannot satisfy these steps. No placeholder passing tests or fabricated release commits were added.

21 (local regression evidence). Built and relocated the hardened local arm64 app with a complete renderer dependency notice inventory, Electron/Chromium licenses and the bundled Node license (also retained with its runtime generation). Missing required renderer notices now fail packaging. Native settings and real Chromium workspace/sign-in/history/cleanup fixtures passed. Updated the older native integration harness for the current first-launch/profile flow, semantic provider setup, sidebar behavior and existing API/receipt contracts; its full credential isolation, attachments, approvals, task controls, bridge recovery, profile switching and supervisor ownership regressions passed. No paid provider or external account was used. Recovery review also added anti-downgrade checks and separated expired discovery offers from authenticated installed receipts; only native verification can confirm an old installed receipt. Final desktop types and 172 tests passed, as did the final package/inventory/native-module/CSP/fuse/notice/relocation check. Actual signed installed-app settings/media/gateway and clean-machine uninstall/recovery acceptance remain deferred.

22. Added Settings/update-panel diagnostic export through an exact empty IPC action and native save dialog. The explicit field allowlist includes only bounded versions, platform/architecture, install classification, update phase/problem and release-gate booleans. Unknown fields/values cannot introduce paths, receipts, profile identifiers, URLs, credentials or chat content. Native cancellation writes nothing; explicit save produced only the reviewed fields. Desktop type/protocol checks, 172 tests and all eight PR16 UI journeys passed.

23. Added operator documentation for development builds, fresh/existing setup, current release-disabled update behavior, polling, diagnostic export, installation ownership, state-preserving removal and recovery. Updated the Replit handoff to name the implemented notice inventory. Reviewed commands and claims against current scripts; public signed distribution remains explicitly unavailable.

## Final continuation review (2026-09-22)

24. Evidence/handoff record updated. This records local implementation and test evidence; it does **not** record signed-release acceptance as complete.

| Planned steps | Current result |
| --- | --- |
| 1–6 | Setup, onboarding and relocatable development packaging implemented and locally validated |
| 7 | Deferred: Developer ID signing, notarization and accepted updater artifacts |
| 8–15 | Main-owned policy, discovery, staging/recovery contracts, UI and tests implemented; platform verification/installation and real reader lifecycle adapter deliberately unavailable |
| 16 | Read-only CI preflight and offline immutable metadata preparation implemented; protected signing/publication remains deferred |
| 17 | Replit contract and source/notices handoff prepared; no website deployment or live download URL claimed |
| 18–20 | Deferred: published signatures/URLs, clean-machine bilingual installation, signed N → N+1 and interrupted replacement recovery |
| 21 | Local package, native settings/browser/credential/attachment/ownership regressions passed; signed clean-machine and uninstall acceptance remain open |
| 22–23 | Redacted diagnostic export and operator documentation implemented and validated |
| 24 | Local evidence and outstanding release/website gates recorded here |

Final checks performed in the clean validation copy:

- Node 24.14.1, pnpm 10.33.0, frozen-lockfile install and core typecheck passed.
- Core suite: **11,710 tests / 732 files** passed.
- Desktop typecheck/protocol boundary and **172 tests / 46 files** passed.
- Eight PR16 first-launch/update UI journeys passed. Four update journeys were repeated after the final diagnostic-error copy adjustment and passed; diagnostic failures use localized copy without exposing the underlying error.
- Core build, source smoke, distribution smoke, runtime import audit and ESM audit passed.
- Local native package, full runtime inventory, retained Node/dependencies, required notices, strict ad-hoc signature, relocated SQLite/Sharp/PTY, CSP/fuses and hardened launch passed.
- Native settings and loopback Chromium workspace/control/sign-in regression passed. Final native integration passed against rebuilt Main/preload: credential isolation, private input cancellation, retained artifact preview, attachments, approvals, task controls, profile/CLI pointer preservation, bridge reconnect, app relaunch and incompatible-supervisor rejection.
- Native diagnostic save/cancel passed with an exact bounded export-field list and no private paths.
- Workflow YAML parsed and changed JavaScript configuration/scripts passed syntax checks. The new workflow has **not** been run by GitHub Actions.
- `git diff --check` passed. No live provider calls, paid requests, real account sign-ins, release publication or Replit edits were performed.

Security review: no renderer update URL/path/identity inputs; release discovery pins remain absent; no platform installer/verifier is enabled; checks do not download; download does not install; staged bytes and publisher verification are required at restart; older offers/restored candidates are rejected; uncertain readers/resources block replacement; retained runtime generations are not automatically deleted; user/CLI/shared state is not restored or removed. Expired metadata cannot authorize staging/install, while an authenticated old receipt can confirm an already-installed matching version only through native running-app verification.

Remaining release risks are explicit: the native verifier/installer and reader coordination need real signed acceptance; supported platform/minimum OS, metadata key and Apple identity are not selected; no protected publishing environment or actual release feed exists; native updater cancellation/Later/quit/relaunch behavior is unproven; signed uninstall/recovery and the final website journey remain open. No claim of public-alpha readiness or approval to begin PR17's release-dependent work is made.

The running development copy and real user state were not restarted or migrated. Pre-existing planning edits, duplicate files and other untracked content remain untouched. Implementation commits stay on `ame/desktop-foundation`; no push or publication was performed.

The final local development archive is `/tmp/ec-pr16-validation/apps/desktop/out/EstaCoda-darwin-arm64/EstaCoda.app.zip`. It is an ad-hoc development artifact, not an official installer. The final rebuild includes the localized diagnostic-error copy; artifact checks were repeated and passed. Temporary validation logs/artifacts are local and are not committed or published.

The preflight runner label was checked against [GitHub’s runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); `macos-15` is the arm64 standard runner. This documentation check does not substitute for an actual CI run.

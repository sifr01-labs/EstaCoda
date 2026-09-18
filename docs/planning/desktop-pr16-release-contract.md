# PR16 installation and update contract

Status: implementation contract, not release certification. This record follows the 24 ordered commits in `desktop-implementation-plan.md`. The release repository is `sifr01-labs/EstaCoda`. No Apple Developer signing identity or notarization setup is available as of 2026-09-18; signed distribution and N → N+1 acceptance remain blocked until those prerequisites exist.

## Ownership and compatibility

Desktop owns its application bundle, disposable bridge, verified bundled runtime and update cache. It does not own a separately installed CLI, the shared supervisor's lifecycle, profiles, credentials, sessions, trust, or workspace contents. Setup selection changes this window's profile only. It neither copies credentials nor writes the global CLI active-profile pointer. Foreground CLI execution cannot be adopted through profile selection.

The first Desktop launch presents fresh or existing setup even when the selected CLI profile is healthy. A presentation acknowledgement suppresses this welcome on subsequent launches; it never proves readiness or grants trust. Inspection distinguishes configuration, database/bridge compatibility, and authenticated supervisor readiness. Existing setup remains reachable from Settings. Fresh setup cannot erase or overwrite an existing profile: the user reviews a separate setup before any profile configuration is written.

App replacement must recheck ownership, writeability, compatibility, active resources and verified bytes at the restart boundary. Mounted, translocated, read-only or externally managed copies receive installation guidance. A running supervisor keeps its original owner and version. Its verified versioned runtime assets must outlive the app bundle or replacement must wait for an explicit safe lifecycle transition. A live PID alone does not prove asset independence.

Schema migration uses existing core migration and backup owners, coordinates all readers/writers and rejects incompatible older writers. Rollback requires schema compatibility and never restores stale user state over newer work. Uninstall preserves shared state, workspaces and independently installed CLI/services.

## Release trust and publication

Official assets belong to immutable versioned GitHub Releases pinned to a source commit/tag. A single versioned record supplies channel, Desktop/core versions, protocol/schema compatibility, OS/architecture/minimum OS, notes, installer/updater URLs, byte lengths, digests and publisher verification metadata. The separately maintained Replit website consumes this record; this repository does not build a replacement website. Website integration and click-to-install evidence are tracked separately.

Release jobs validate source/version, build, sign, notarize, verify and upload assets before publishing discovery metadata. Publication is serialized. Stable is the default channel; prereleases require opt-in. Withdrawal stops future offers and never silently downgrades clients. Checksums establish integrity, not publisher identity. Package acceptance requires the expected Developer ID identity, platform signature and authenticated release metadata under the selected updater's trust model.

Updater selection remains an explicit gate: prove signed download, replacement and relaunch on macOS before enabling installation. Do not substitute homegrown shell replacement or a notification-only link for this gate. No unsigned development build may masquerade as a signed production release.

## Update behavior and authority

Main owns discovery, cache, verification and installation. The renderer receives bounded state and semantic actions, never executable paths, arbitrary URLs or installation instructions. Polling is bounded, backed off and disableable; checks include only necessary release/platform metadata. Download and restart each require an explicit user action. Closing update details or choosing Later preserves staged state without marking it installed.

States distinguish checking, up-to-date, available, downloading, verifying, ready, replacement requested, verified relaunch, incompatible and failure. A failed check cannot become up-to-date. Downloads have size/time/retry limits, strict destination and redirect policy, and integrity/publisher checks before staging and again before installation. Cross-window/process serialization and durable receipts prevent duplicate replacement. Restart impact covers human PTYs/browser takeover, staged secrets and nonsecret drafts without replaying uncertain external effects.

## Evidence required to close PR16

- Both English/Arabic setup paths, multiple profiles, repair states and byte-preserved existing configuration/credentials/history/CLI pointer.
- Downloaded signed/notarized packages on a clean supported account/machine for each declared architecture; developer-HOME fixtures alone do not qualify.
- Real staging N → N+1 update: notification, explicit download, verified staging, Later, explicit restart and verified new version.
- Active compatible work, incompatible runtime, separate CLI, disk/network interruption, corrupt/wrong-signer package, concurrent windows, interrupted replacement and startup failure.
- Packaged settings/media/browser/gateway and state-preserving uninstall regressions; V34–V36 and applicable V01–V29 checks.
- Published asset endpoints verified against released bytes, source-build notices and an explicit Replit handoff status.

Security review focus: profile isolation, non-authoritative presentation state, trust preservation, authenticated owner attachment, publisher authentication and live runtime asset lifetime. Record executed checks and outstanding gates per commit; never mark synthetic or unavailable signed checks as passed.

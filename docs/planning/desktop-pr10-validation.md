# Desktop PR10 implementation and validation

PR10 connects Files and Changes to core target leases and adds an ephemeral Main-owned terminal. The approved fixture's appearance remains the visual reference; live inspection never substitutes fixture data.

Files and Git inspection borrow the selected target, recheck profile/generation/root/trust, and use its configured host or Docker environment. Files exclude private runtime/profile state, protected paths, traversal, Git internals and symlink traversal. Text previews and patches are limited to 16 KiB, directory/changed-file responses to 32 entries, and all responses disclose truncation. Binary preview is metadata only. Git uses fixed argument arrays with external diff/textconv/filter execution disabled. A worktree whose common Git metadata is outside the Docker mount reports unavailable rather than reading it through the host. Changes show current repository state, not proof of agent authorship.

Terminal open requires a Main-owned native confirmation. Core issues a private target capability with a three-second renewable deadline. Main owns one PTY per window, its output buffer and ordinary job groups. Docker terminals additionally own a dedicated verified container. Renderer APIs accept only target references or Main handles and bounded input/size values; neither capability tokens nor executable/environment selection are exposed. Terminal input grants no agent approval. xterm has no link/clipboard addons and consumes clipboard/hyperlink escape requests.

Closing the terminal, switching profile, closing the window, losing the verified connection, or failing a capability refresh closes the owned terminal. Output is bounded and transient, never appended to model transcripts. Shell history persistence is disabled. Host shells are explicitly not filesystem confinement: normal shell jobs are stopped across the verified controlling PTY, and a Main-owned shell exit hook kills background job groups, but deliberately daemonized/detached programs can escape that group. Docker teardown additionally removes its owned container. A crashed/disconnected host owner leaves its durable target borrower as a cleanup blocker when settlement cannot be proven; there is no automatic PID-only reclamation.

The checks below cover PR10 regression and release behavior. No live model-provider or Telegram request was made for this feature.

## Validation on 2026-09-12

- Node 24.14.1 and pnpm 10.33.0; frozen-lockfile installation passed.
- Core typecheck and full core suite: 10,950 tests across 682 files. Final file/target fences also passed focused regression checks.
- Desktop/protocol typechecks and import-boundary audit passed. Desktop suite: 64 tests across 17 files, including real native PTYs, ordinary background-job shutdown, delayed settlement labels, and bounded draining after shell exit.
- Full browser/approved visual suite: 146 cases passed. Final Files, Changes, and Terminal browser checks passed, and their captured screens were visually reviewed. Approved golden images were not changed.
- Clean macOS arm64 package built and locally signed. Packaged contents, CSP, hardened Electron fuses, supplied app icon, relocation, and actual PTY spawning from the relocated asar assets passed.
- Native Main/preload/bridge integration passed. Real Work execution verified managed-worktree file/diff/terminal alignment and borrower settlement before Session completion and Task restart/no-replay checks. Provider responses in this harness are scripted local HTTP responses.
- Real local Docker inspection and terminal checks passed, including writes to the selected workspace, ordinary background-job teardown, and borrower release.
- Final smoke, runtime-import and ESM audits, distribution smoke, execution budgets, source/distribution Docker execution checks, and Docker image validation passed. Execution conformance confirmed all 40 required files. Final diff whitespace checks passed.

Core and packaging validation use an isolated copy of tracked sources to avoid the checkout's pre-existing untracked duplicate TypeScript files. The full core suite uses four workers because this machine previously showed Bun-startup timeout contention with nine. Native tests exercise the actual Electron and PTY binaries; native confirmation is programmatically accepted only inside the test harness, and no confirmation bypass is shipped.

## PR10/PR11 review correction

Diff filter discovery now reads the effective Git configuration, including conditional includes and worktree configuration, before disabling configured helpers. Regression cases verify that list and patch inspection do not execute clean helpers from any of those scopes. Fixed commands, output/process bounds, target checks and existing command approval rules remain in place.

Security review: this closes a read-only inspection path that could invoke an included clean helper. Artifact provenance is display metadata; recording an intended application destination does not broaden the existing exact-path/mutation grant or confirm successful application.

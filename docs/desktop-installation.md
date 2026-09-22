# EstaCoda Desktop: installation and recovery

## Current availability

Desktop is under release hardening. Local macOS arm64 development packages work, but no public signed/notarized installer or real automatic upgrade has been accepted. In-app updates therefore say **Updates are not enabled for this build**. That is intentional. A local ad-hoc signature is not Developer ID signing or notarization. Windows, Linux and Intel Mac release support is not established by the current evidence.

## Run or package from source

Use a supported native macOS arm64 development machine, Node 24.14.1 with its distribution `LICENSE` alongside `bin/`, and pnpm 10.33.0 through Corepack. From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run desktop:foundation:check
pnpm run desktop:test
pnpm run desktop:dev
```

For a local app bundle:

```sh
pnpm run desktop:package
node apps/desktop/tests/package-check.mjs
```

The arm64 bundle is under `apps/desktop/out/EstaCoda-darwin-arm64/EstaCoda.app`. Packaging builds core, stages its own Node and dependency closure, rebuilds the distinct Electron PTY path, includes licenses/notices, and checks the complete runtime inventory before launching its bridge. It never selects a runtime executable from a renderer-provided path. Build separately on each architecture; cross-target packaging is rejected. Do not distribute this development bundle as the official signed release.

The artifact check launches a relocated copy using an isolated temporary home and tests SQLite, Sharp, PTY, inventory, notices, CSP and fuses. It is local packaging evidence, not a clean-machine downloaded-install certificate. Additional native regression scripts under `apps/desktop/tests/` use explicit test harnesses and isolated fixtures.

## Fresh or existing setup

First Desktop launch offers **Set up EstaCoda** and **Use existing EstaCoda** in English and Arabic. The choice remains accessible through Settings. A welcome acknowledgement only remembers presentation; configuration and runtime readiness are inspected again.

Use existing setup to choose a discovered local profile. Desktop defaults to the CLI's selected profile and reuses its configuration, credentials and history in place. It does not copy credentials, change the CLI active-profile pointer, install a service, replace a separately installed CLI, or adopt a foreground CLI session. Desktop launches its own bridge and attaches only to a compatible authenticated shared supervisor. When no supervisor is running, starting work uses the established on-demand path.

If existing configuration is present and you want a fresh setup, review creation of a separate profile. Cancelling does not erase or overwrite existing setup. Missing, locked, malformed or incompatible state must be repaired through its owning setup/lifecycle flow; do not delete the state directory to get past a readiness error. Remote VPS connections are outside this local setup path.

## Updates

Settings → **App updates** provides status, automatic-check preference and **Export update diagnostics**. The export uses a native save dialog and contains only bounded installation/update status, versions, platform/architecture and release-gate booleans. It excludes credentials, chats, profile names, private paths, URLs, raw errors and receipts. Nothing is uploaded automatically.

The implemented update controls are release-gated. Once signed release acceptance enables them:

- Checking only discovers an offer. Automatic checks are opt-in: one minute after enabling, then every six hours, with twelve/twenty-four-hour failure backoff. Manual checks are throttled to thirty seconds and concurrent checks coalesce. Disable automatic checking in the panel.
- **Download update** is a separate action. Downloads have bounded size/time, available-space checks and mandatory integrity/publisher verification. Cancellation removes partial data.
- **Later** dismisses the panel and preserves staged data. It never restarts or marks an update installed.
- **Restart to update** rechecks ownership, compatibility, readers, active resources and verified bytes. Only a matching verified subsequent launch can report installation complete.

Those controls and their synthetic tests do not establish that a native updater is installed. The current production build has no accepted platform verifier/installer and no release pins; it cannot download or replace itself.

## Ownership and recovery

A separately installed CLI remains managed by its own source/npm/pnpm/Homebrew installation. A Desktop update cannot rewrite it. Mounted disk images, translocated, read-only and externally managed app copies cannot self-replace. A future signed installer will guide users to a supported Applications location and recheck publisher identity there.

Closing Desktop is not permission to terminate shared work. Retained, verified runtime generations live in Desktop's own application-data `runtime-versions` directory so a supervisor can load dependencies after its original app is moved. They are not automatically deleted. Do not manually clear this cache while any runtime may still use it.

If a check fails, use **Check for updates** when connectivity returns. A failed check does not mean up to date. If download verification fails, the file cannot be installed; retry discovery/download rather than bypassing checks. An interrupted coordinator lock or uncertain replacement requires inspection, not automatic stale-lock deletion or repeating external work. Export diagnostics and preserve the existing installation and state. Signed manual reinstall/recovery remains an acceptance item; do not use an unsigned downgrade or restore an old database backup over newer chats and credentials.

Database/schema changes remain the responsibility of the existing migration and backup owners and must coordinate all affected readers/writers. The update policy currently blocks active or uncertain resources. Real shared-reader coordination and compatibility-safe replacement remain release gates.

To remove a local Desktop app, quit its windows and remove only its app bundle. Preserve EstaCoda state, workspaces, separately installed CLI/services and retained runtime generations. Do not recursively delete `~/.estacoda` or Desktop's runtime cache. No automated destructive uninstall or rollback is provided by this work.

## Release status and website

See [PR16 evidence](planning/desktop-pr16-validation.md) for checks actually run and deferred gates. [Replit handoff](planning/desktop-replit-release-handoff.md) defines the reserved download endpoints and separate website work. Actual published downloads, Gatekeeper/notarization, both clean-machine setup paths, signed N → N+1 and website click-to-install must be verified before public release approval.

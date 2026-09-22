# Desktop download handoff to estacoda.com

Status (2026-09-22): **contract prepared; no public signed Desktop release or Replit deployment verified**. Do not enable a production download button yet. The website is maintained separately; no placeholder website is included here.

## One release record

Source repository: https://github.com/sifr01-labs/EstaCoda

Reserved stable discovery endpoint:
`https://github.com/sifr01-labs/EstaCoda/releases/download/desktop-stable/latest.json`

Immutable release tag: `desktop-v<version>`, pinned to the record's full source commit. Asset names:

```
https://github.com/sifr01-labs/EstaCoda/releases/download/desktop-v<version>/EstaCoda-<version>-darwin-<arch>.dmg
https://github.com/sifr01-labs/EstaCoda/releases/download/desktop-v<version>/EstaCoda-<version>-darwin-<arch>.zip
https://github.com/sifr01-labs/EstaCoda/releases/tag/desktop-v<version>
```

These are reserved locations, not verified live links. The DMG is the user installer; the ZIP is reserved for the eventual accepted updater. Format 1 carries one architecture per record. Initial development evidence is macOS arm64 only. Do not advertise Intel, Windows, Linux or a universal build from it. Multi-architecture discovery must be versioned and implemented before advertising multiple architectures.

`latest.json` is an Ed25519 envelope with exactly `payload` and `signature`, both base64. Signature verification covers the decoded payload bytes before JSON parsing. Use a reviewed pinned public key; never take the key from the downloaded envelope. The payload contract and validation are in `apps/desktop/src/main/updates/release-feed.ts`: Desktop/core versions, stable channel, source commit, OS/architecture/minimum OS, protocol and schema ranges, issue/expiry timestamps, Apple Team ID, release notes and both asset URLs/byte counts/SHA-256 digests. Timestamps are milliseconds since epoch. Metadata expires within seven days; a protected release owner must renew the signed discovery envelope while leaving versioned assets immutable.

The website must consume this same authenticated record, validate the installer destination and freshness, and show the supported architecture and minimum macOS version before download. Never maintain a second hand-edited latest-version list. On fetch, validation or compatibility failure, show that the download is unavailable; do not fall back to an unsigned or stale installer. A direct installer link may download bytes from GitHub without navigating the user to GitHub. Browser detection can suggest a platform but must not invent support.

## Release preparation and publication boundary

The offline builder can prepare an envelope from final artifact bytes:

```
node --import tsx apps/desktop/scripts/prepare-release.mts record.json installer.dmg updater.zip /private/key-file candidate.json
```

Use the exact versioned filenames above, not the illustrative short names. Run from a clean tracked checkout at the matching source tag with matching package versions. The key file must be outside the repository. No secrets appear in command arguments or output. Candidate generation is not notarization, platform-signature verification, publication, or release approval.

Publication remains deferred: choose the native updater after signed replacement/relaunch proof, configure a protected GitHub environment and private signing/publishing secrets, build/sign/notarize/verify artifacts, then upload immutable version assets and verify their actual downloaded bytes. Publish the discovery envelope **last** under serialized publication. Re-check uploaded bytes before making the feed visible. Never overwrite an existing version's binaries or silently downgrade clients. Withdrawal removes the offer; it does not restore old user state.

## Public source and notices

Source build instructions are in `docs/desktop-installation.md`. EstaCoda's `LICENSE` is Apache-2.0 and `NOTICE` identifies SIFR01 Labs. Retain those files and every bundled dependency's required license/notices, including Electron/Chromium, the separately bundled Node runtime, React, Lucide, xterm, node-pty, SQLite and Sharp and their dependency closures. The core staging process copies runtime dependency package files; bundled renderer dependencies require a separate notice inventory. A signed release must include and review that inventory against its final artifact rather than assuming source notices are sufficient.

## Handoff acceptance still required

- Select and configure production identity, metadata key, updater and supported minimum OS/architectures.
- Record actual published installer and updater download, checksum, Team ID, Gatekeeper and notarization results.
- Run both fresh/existing setup in English and Arabic on a clean supported account.
- Demonstrate signed N → N+1, Later/relaunch, explicit restart and failure recovery with preserved state.
- Replit owner implements buttons and unsupported states from the authenticated record; record final estacoda.com click-to-install evidence separately.

No Replit access or website modification is required to prepare this handoff. No website-to-install acceptance is claimed here.

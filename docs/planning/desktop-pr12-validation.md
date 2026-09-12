# Desktop PR12: browser inspection

PR12 adds a view-only Browser dialog to Session and worker Attempt Work. It uses the approved desktop components and theme tokens. Task roots expose their browser work through the canonical worker Attempt. Browser inspection does not create a second browser owner or state database.

## Recorded state and retained captures

`browser.list` projects the latest recorded browser observations for the selected Work from existing Session tool-result events. It shows the observed URL, title, readiness, action and timestamp. These are historical observations, not a live browser inventory or a claim about the page currently on screen. Refresh rereads recorded observations; it does not navigate, start a browser, capture a new image, or acquire human control. An old observation remains explicitly timestamped even if the original browser process has exited.

The list scans at most 64 recent browser events and displays at most eight distinct browser IDs. Oversized events are omitted and truncation is reported. Work artifact references remain separately identified as Work outputs, rather than implying that every output originated in the browser.

Successful `browser.screenshot` executions may retain an image through the existing profile-owned ArtifactStore when the backend supplies sanitized observation provenance. Retention uses a separate staging copy and preserves the original tool-visible screenshot. A retention failure does not replay the browser operation. Capture files are at most 8 MiB; Desktop decoding is limited to 16 million input pixels. The preview is re-encoded as JPEG, at most 960 × 640 pixels and 45,000 bytes (60,000 base64 characters). Metadata and image content travel through bounded protocol DTOs.

A preview requires matching Session, browser, target generation, recorded event, document epoch, action revision, tab and retained artifact provenance. Reads verify profile ownership, a non-aliased content root, regular-file content, byte count, MIME and SHA-256. Missing, changed or incompatible captures show an unavailable state. Existing captures without sanitized provenance are not upgraded by inference. Browser backends that do not provide that provenance can supply recorded state but cannot supply images to this view.

## Security and ownership

Core rechecks the selected profile, canonical Session or worker ownership, execution target and workspace trust. Each observation passes the existing URL safety and website blocklist policy, including the non-overridable cloud-metadata denial. Explicit private-URL policy may permit a private host; it cannot permit metadata endpoints, credential-bearing URLs or protected-input observations. Bounded URL checks run concurrently so unavailable DNS hosts cannot serially exhaust the desktop IPC deadline.

The renderer receives allowlisted observation fields and an inert JPEG preview. It receives no CDP address, browser credentials, raw DOM, backing file paths, navigation authority or input-forwarding methods. Window and connection generations fence semantic requests. Disconnects and profile changes clear displayed content and discard late replies. Artifact previews use the existing verified, escaped text surface. No remote webview, iframe or external opener is introduced.

This is a security-sensitive change because it exposes retained browser content and extends artifact retention. Its safety depends on the existing backend's sanitized-capture contract; it does not promise that arbitrary visible page content contains no sensitive information. Human takeover and control leases remain PR13 work. No new cloud session or cloud spend is initiated by inspection.

## Validation

Checks on 2026-09-12:

- Node 24.14.1 and pnpm 10.33.0; frozen offline installation passed.
- Full core suite: 10,974 tests across 687 files passed. The final URL-check concurrency change also passed 127 focused browser, artifact, download and protocol tests and a fresh core typecheck.
- All 65 desktop unit tests and 152 browser/visual tests passed. Focused browser cases cover inert rendering, refresh, disconnect/profile invalidation, late responses, narrow containment and focus restoration. The new dialog was visually inspected; approved golden images were not changed.
- Core and desktop/protocol typechecks, import-boundary check, source smoke, build, runtime-import audit, ESM audit and distribution smoke passed.
- Security regressions cover URL credentials, unsafe schemes, private hosts, cloud metadata even with private access enabled, configured blocklists, revoked trust, foreign profiles, bounded history, mismatched browser/tab/document/action identity, stale target/reference, tampered retained bytes and protocol frame bounds.
- Final whitespace/diff checks passed. No dependencies or lockfiles changed.

The checkout contains pre-existing untracked duplicate TypeScript files, so broad validation used an isolated copy of tracked sources; those unrelated files were preserved. The full core suite used two workers to avoid previously observed process-startup contention. Tests use temporary profiles, local browser fixtures and a scripted screenshot backend. This PR did not rebuild or rerun the packaged native application, or exercise a live model provider or cloud browser.

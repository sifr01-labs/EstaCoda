---
title: Browser
description: Local CDP browser automation, URL safety, and operational boundaries.
sidebar_position: 11
---

# Browser

EstaCoda automates browsers through the Chrome DevTools Protocol (CDP). Local CDP is implemented, supervised local CDP can auto-launch Chrome/Chromium, and Browserbase is implemented behind explicit cloud spend approval. The browser is a supervised tool with explicit safety boundaries.

---

## What Is Implemented

| Backend | Status | Notes |
|---|---|---|
| **local-cdp** | `live-proven` | Connects to a local Chrome/Chromium instance over CDP. Supervised mode can auto-launch Chrome/Chromium. |
| **mock** | `implemented` | Test backend for smoke tests. No real browser. |
| **Browserbase** | `implemented` | Requires credentials and explicit cloud spend approval before billable session creation. |
| **browser-use** | `unsupported` | Registered stub. Not implemented. |
| **Firecrawl (browser)** | `unsupported` | Registered stub. Not implemented. |
| **Camofox** | `unsupported` | Registered stub. Not implemented. |

Browserbase sessions are created only through the browser backend so `browser.cloudSpendApproved` can be enforced. browser-use, Firecrawl, and Camofox remain deferred provider stubs.

---

## Local CDP Operations

When local CDP is configured and connected, the following operations are supported:

- `status` — check browser connection state
- `navigate` — load a URL
- `snapshot` — capture an accessibility-tree snapshot with DOM fallback
- `click` — click an element by ref
- `type` — type text into an input
- `scroll` — scroll the page
- `key press` — send a keyboard key
- `back` — navigate back
- `image listing` — list images on the page
- `console capture` — read browser console output
- `raw CDP method call` — execute arbitrary CDP method
- `screenshot` — capture page screenshot
- `dialog handling` — accept/dismiss dialogs

All operations except `status` require a browser session. Browser tools derive browser session keys from the current runtime session, so parent and delegated runtime sessions get isolated browser state by default. Passing an explicit `sessionId` intentionally shares that named browser session.

Supervised sessions use isolated CDP Browser Contexts. EstaCoda creates a Browser Context for each browser session key, opens the page target inside that context, and disposes the context during cleanup so cookies and browser-context state do not leak across parent/delegated sessions.

Supervised local CDP can auto-launch Chrome/Chromium when `browser.autoLaunch === true`. Discovery checks structured config, environment variables, local binaries, and platform defaults. Launch uses structured argument arrays, does not shell-parse `browser.launchCommand`, never calls `exec`, creates an isolated user data directory, and kills only Chrome processes launched by EstaCoda during cleanup.

## Snapshots

Browser snapshots prefer the accessibility tree from `Accessibility.getFullAXTree`. Snapshot elements expose deterministic refs such as `@e1` and may include `role`, `name`, `value`, `disabled`, and `checked`. Ignored and unhelpful AX nodes are skipped.

The DOM snapshot path remains as fallback when AX is unavailable, empty, malformed, or cannot bind actionable refs. Refs are actionable where exposed.

`browser.snapshot` defaults to a compact snapshot. Compact snapshots are a bounded actionable AX subset, not true viewport-visible filtering yet. Passing `full: true` requests the full snapshot path. Rendered tool output labels compact vs full snapshots, truncates large results, and may summarize oversized snapshots when configured.

Snapshot summarization is controlled by:

- `browser.summarizeSnapshots`: `false`, `true`, or `"auto"`
- `browser.snapshotSummarizeThreshold`: character threshold before summarization is considered

In `"auto"` mode, summarization runs only when an auxiliary model route is available and the rendered snapshot exceeds the threshold. Secret-bearing URLs and sensitive values are redacted before provider calls.

---

## URL Safety

Browser navigation enforces URL safety rules. The system does not trust URLs implicitly.

### Allowed Protocols

Only `http:` and `https:` are permitted. Other protocols are rejected before navigation.

### Blocked by Default

Private and internal URLs are blocked unless `security.allowPrivateUrls` is explicitly enabled:

- `localhost`
- `127.0.0.1`
- `*.local`
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`

### Always Blocked

Cloud metadata endpoints are always blocked, regardless of `security.allowPrivateUrls`:

- `metadata.google.internal`
- `metadata.goog`
- `169.254.169.254`
- `169.254.170.2`
- `169.254.169.253`
- `fd00:ec2::254`
- `100.100.100.200`

### Secret Detection

URLs containing secret-like markers (API keys, tokens, passwords) are redacted or blocked by guarded tool paths.

### Website Blocklists

Blocklists support exact domains, wildcard domains, and shared files. The blocklist is checked before navigation.

Hybrid routing uses the same classifier. Public HTTP(S) URLs route to Browserbase/cloud when Browserbase is configured and cloud spend is approved. Private/internal URLs route to local only when `security.allowPrivateUrls === true`. Metadata endpoints remain blocked. Cloud spend approval failure does not fall back to local. Browserbase failures may fall back to local when `browser.cloudFallback === true`. Unsafe redirects are blanked to `about:blank` when possible; otherwise the unsafe session is closed.

---

## Approval Gating

`browser.cdp` is approval-gated by default. The raw CDP method call can execute arbitrary browser commands, so it requires explicit approval unless the security mode is `open` and the command passes the hardline floor.

Standard browser operations (`navigate`, `click`, `type`, `scroll`) follow the normal tool approval policy. They are not gated as heavily as raw CDP.

---

## Configuration

Browser configuration lives under `browser` in profile config:

The setup editor supports four browser modes and writes the same flat config shape:

- **Local supervised browser** writes `backend: "local-cdp"`, `supervised: true`, reviewed `autoLaunch`, optional `cdpUrl`, and reviewed launch settings.
- **Existing CDP browser** writes `backend: "local-cdp"`, `supervised: true`, `autoLaunch: false`, and the reviewed `cdpUrl`.
- **Browserbase cloud browser** writes `backend: "browserbase"`, `cloudProvider: "browserbase"`, `hybridRouting: true`, `cloudFallback: true`, and `cloudSpendApproved: false`.
- **Disabled / unconfigured browser tools** writes `backend: "unconfigured"`.

Static setup verification does not open pages, connect to CDP, call Browserbase, or create cloud sessions. Existing CDP mode blocks missing CDP URLs and non-local CDP URLs; accepted CDP hosts are `localhost`, `127.0.0.1`, and `::1`.

Browser setup is optional during onboarding. First-run onboarding uses the same browser mode flow as the setup editor, but browser setup failure or incompletion does not block core onboarding. If the browser step is incomplete, onboarding records that status in the summary, drops the incomplete browser draft and any partial Browserbase secret writes, and lets the user proceed. The user can configure browser tools later from the setup editor.

This split is deliberate:

- Setup editor remains strict. Invalid browser configuration blocks the reviewed browser change.
- Onboarding remains tolerant. Incomplete optional browser setup does not make first-run setup fail.

Choosing disabled browser tools is intentional. It writes `backend: "unconfigured"` and appears as disabled, not as a browser setup failure.

```json
{
  "browser": {
    "backend": "local-cdp",
    "cdpUrl": "http://localhost:9222",
    "supervised": true,
    "autoLaunch": true,
    "launchExecutable": "/path/to/chrome",
    "launchArgs": ["--headless=new"],
    "chromeFlags": ["--no-first-run"],
    "summarizeSnapshots": "auto",
    "snapshotSummarizeThreshold": 8000
  }
}
```

| Key | Default | Description |
|---|---|---|
| `backend` | `unconfigured` | Browser backend to use. |
| `cdpUrl` | unset | CDP endpoint for a manually running browser. |
| `supervised` | `true` | Use the supervised local CDP backend when `backend` is `local-cdp`. |
| `autoLaunch` | `false` | Whether supervised local CDP may auto-launch Chrome/Chromium. |
| `launchExecutable` | unset | Preferred explicit Chrome/Chromium executable path. |
| `launchArgs` | unset | Structured launch argument array. |
| `chromeFlags` | unset | Structured Chrome flag array. |
| `launchCommand` | unset | Deprecated compatibility data only. It is not split or shell-parsed. |
| `summarizeSnapshots` | `"auto"` | Whether oversized rendered snapshots may be summarized. |
| `snapshotSummarizeThreshold` | `8000` | Rendered snapshot character threshold for summarization. |

Use the structured setup command for local auto-launch configuration:

```bash
estacoda browser setup --backend local-cdp --auto-launch --launch-executable /path/to/chrome
estacoda browser setup --backend local-cdp --launch-executable /path/to/chrome --launch-arg --headless=new --chrome-flag --no-first-run --auto-launch
```

`launchCommand` remains accepted for older configs but should not be used as the normal setup path.

The short form records the executable and enables supervised auto-launch. Add repeated `--launch-arg` and `--chrome-flag` entries when the operator needs deterministic launch options such as headless mode or `--no-first-run`.

Browserbase configuration:

```json
{
  "browser": {
    "backend": "browserbase",
    "cloudProvider": "browserbase",
    "cloudSpendApproved": false,
    "cloudFallback": true,
    "hybridRouting": true
  }
}
```

Browserbase requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`. Credentials alone do not approve spend. Setup writes pending/unapproved cloud spend as `cloudSpendApproved: false`; legacy configs with `cloudSpendApproved: "pending"` still load safely and remain blocked. Run `estacoda browser approve-cloud` to allow cloud browser session creation, and `estacoda browser revoke-cloud` to block it again. Browserbase sessions may incur charges. Config alone does not create sessions; creation is lazy when a browser operation needs the cloud backend. EstaCoda uses the verified API shape recorded in `docs/browserbase-api-notes.md`.

```bash
estacoda browser setup --backend browserbase --cloud-provider browserbase
estacoda browser setup --backend browserbase --cloud-provider browserbase --hybrid-routing
estacoda browser approve-cloud
estacoda browser revoke-cloud
```

The first command configures Browserbase as the browser backend without enabling hybrid routing. The second enables hybrid routing so public URLs can use cloud and allowed private/internal URLs can use local. `approve-cloud` is required before billable sessions can be created. `revoke-cloud` blocks future cloud session creation without removing credentials.

`backend: "unconfigured"` is a hard runtime disable. Browser tools stay disabled even if stale CDP URLs, Browserbase settings, launch settings, or Browserbase credentials remain in the profile or environment.

---

## State and Files

Browser configuration is profile-local. Browser session state is runtime-local:

- CDP session state lives in memory during the runtime lifetime
- Screenshots and artifacts are written to the active profile's temp directory
- Browser console logs are captured per session and included in artifact recording

Supervised auto-launch uses an isolated temporary Chrome user data directory and removes it during cleanup. There is no persistent browser profile or cookie jar across sessions unless an external browser is used outside EstaCoda's launcher.

---

## Failure Modes

**CDP connection refused:** Chrome is not running on the configured `cdpUrl`. Start Chrome with `--remote-debugging-port=9222` or enable `autoLaunch`.

**Navigation blocked:** The URL violated safety rules. Check the blocklist, private URL policy, or metadata endpoint list.

**Raw CDP approval required:** The command needs approval. Approve it, or change the security mode if the hardline floor permits.

**Screenshot fails:** The page may not have finished loading. The snapshot tool captures the DOM; screenshots capture the rendered surface. Timing matters.

**Auto-launch fails:** Chrome binary not found, or insufficient permissions to launch. Check `which google-chrome` or `which chromium-browser`.

**Browserbase spend approval missing:** The backend reports that cloud sessions may incur charges and remain blocked until `estacoda browser approve-cloud` is run.

**Browserbase session creation fails:** With `browser.cloudFallback: true`, eligible cloud failures can fall back to local. Spend approval failures do not fall back to local.

**Hybrid redirect blocked:** The final URL violated the route safety policy. EstaCoda attempts to blank the session to `about:blank`; if blanking fails, the unsafe session is closed.

## Current Limits

- `engine: "agent-browser"` is accepted by config but not implemented.
- Lightpanda support is not implemented.
- browser-use, Firecrawl browser, and Camofox remain deferred providers.
- Compact AX snapshots are a bounded actionable subset, not viewport-visible filtering.

---

## Related

- [Tools](./tools.md) — tool overview
- [Security and Approvals](./security-and-approvals.md) — approval behavior
- [Provider Reference](../reference/provider-reference.md) — provider maturity matrix

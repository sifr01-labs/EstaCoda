---
title: "Browser Automation"
description: "Browser backend, CDP integration, and structured browser tools."
---

# Browser Automation

## Files

| File | Lines | Role |
|------|-------|------|
| `src/browser/browser-backend.ts` | current | Backend abstraction with mock, local CDP, Browserbase, and hybrid routing |
| `src/browser/supervised-local-cdp-backend.ts` | current | Supervised local CDP backend, auto-launch, and session-stack ownership |
| `src/browser/cdp-supervisor.ts` | current | CDP page supervisor, AX snapshots, dialogs, console history, screenshots |
| `src/tools/web-tools.ts` | current | Browser tool schemas, session-key derivation, snapshot rendering, and summarization |

## Backends

| Backend | Status | Evidence |
|---------|--------|----------|
| Local Chrome CDP | Implemented | Manual CDP and supervised CDP paths |
| Mock | Implemented | `smoke-tested` |
| Browserbase | Implemented | Requires credentials and explicit cloud spend approval |
| browser-use | Recognized in config | `intended but not implemented` |
| Firecrawl | Recognized in config | `intended but not implemented` |
| Camofox | Recognized in config | `intended but not implemented` |

Browserbase has a real backend path. Direct provider-registry `createSession()` calls are still blocked because Browserbase sessions must be created through the browser backend so `browser.cloudSpendApproved` is enforced. browser-use, Firecrawl, and Camofox remain deferred provider stubs. Legacy `browser.backend` values `firecrawl` and `camofox` remain config-valid and report unavailable status.

## Setup Editor Modes

The setup editor writes the existing flat `browser` config shape. It does not migrate browser settings into a nested mode object.

The browser setup flow supports four modes:

- Local supervised browser: writes `backend: "local-cdp"`, `supervised: true`, reviewed `autoLaunch`, optional `cdpUrl`, and reviewed launch settings.
- Existing CDP browser: writes `backend: "local-cdp"`, `supervised: true`, `autoLaunch: false`, and the reviewed `cdpUrl`.
- Browserbase cloud browser: writes `backend: "browserbase"`, `cloudProvider: "browserbase"`, `hybridRouting: true`, `cloudFallback: true`, and `cloudSpendApproved: false`.
- Disabled / unconfigured browser tools: writes `backend: "unconfigured"`.

Setup validation is static. It does not open pages, connect to CDP, call Browserbase, or create cloud sessions. Existing CDP mode blocks missing CDP URLs and non-local CDP URLs; accepted CDP hosts are `localhost`, `127.0.0.1`, and `::1`. Local supervised mode requires either auto-launch or a local CDP URL.

Browserbase setup collects references for `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`, but credentials do not approve spend. Pending or unapproved spend is written as `cloudSpendApproved: false` by setup. At runtime, Browserbase session creation is blocked unless `browser.cloudSpendApproved === true`.

`backend: "unconfigured"` is a hard disable. Browser tools remain disabled even when stale `cloudProvider`, `cdpUrl`, launch settings, Browserbase settings, or Browserbase credentials are still present in old config or the environment.

## Onboarding Behavior

Browser setup is optional during first-run onboarding. Onboarding offers the same shared browser mode flow as the setup editor, but incomplete browser setup does not block core onboarding. If Browserbase credentials are skipped, an existing CDP URL is missing, or browser setup otherwise produces browser-specific blockers, onboarding marks the browser capability incomplete, drops the blocked browser draft, drops any partial Browserbase deferred secret writes, and lets the user finish onboarding.

Users can proceed through onboarding and configure browser tools later in the setup editor. The split is intentional:

- Setup editor remains strict: invalid browser configuration blocks the reviewed browser change.
- Onboarding remains tolerant: incomplete browser configuration is visible in the onboarding summary but does not make first-run setup fail.

Disabled browser tools are an intentional onboarding outcome. Selecting disabled writes `backend: "unconfigured"` and appears as disabled in the onboarding summary, not as a failed browser setup.

Local CDP has two paths:

- Unsupervised local CDP keeps the compatibility behavior: users provide `browser.cdpUrl`, and EstaCoda connects to an already-running browser.
- Supervised local CDP can auto-launch Chrome/Chromium when `browser.autoLaunch === true`. Discovery checks `browser.launchExecutable`, deprecated `browser.launchCommand` raw data, `CHROME_PATH`, `CHROMIUM_PATH`, local binaries, platform defaults, Homebrew paths, and conservative bundled/Docker paths. The launcher uses structured arguments, never shell-parses `launchCommand`, never calls `exec`, creates an isolated `--user-data-dir`, reads `DevToolsActivePort`, health-checks `/json/version`, and kills only the Chrome process EstaCoda launched during backend cleanup.

## CDP Capabilities

| Capability | Status |
|------------|--------|
| Navigation | `smoke-tested` |
| Snapshot with `@eN` element refs | `smoke-tested` |
| Click | `smoke-tested` |
| Type | `smoke-tested` |
| Scroll | `smoke-tested` |
| Press key | `smoke-tested` |
| Back | `smoke-tested` |
| Image listing | `smoke-tested` |
| Page-local console capture | `smoke-tested` |
| Raw CDP passthrough | `smoke-tested` |
| Screenshot | `smoke-tested` |
| Screenshot vision analysis | `smoke-tested` |
| JavaScript dialog response | `smoke-tested` |

The supervised local CDP backend tracks pending dialogs, recent console history, frame navigation data, and isolated browser sessions. It also enables supervised request interception for subresource requests and aborts metadata, private/internal, website-policy-blocked, and secret-bearing URLs before response bodies are read. This is not complete browser automation parity and does not provide socket-level DNS rebinding or TOCTOU protection.

## Session Ownership

Browser tools derive browser session keys from the runtime session context. A normal tool call without an explicit `sessionId` uses:

```text
<runtime-session-id>:main
```

Delegated or child runtime sessions therefore get isolated browser state by default. Passing an explicit `sessionId` remains supported and intentionally shares the named browser session across parent/child contexts. Direct backend calls that omit session IDs are compatibility paths, not the intended browser tool path.

Supervised local CDP owns one session manager per endpoint stack. Configured CDP and auto-launched fallback stacks can coexist, and each browser session key is mapped to the stack that created it. Closing a session closes the owning stack session only; configured/manual CDP sessions do not keep an EstaCoda-launched Chrome process alive.

Each supervised session is created in its own CDP Browser Context through `Target.createBrowserContext`, then a page target is created with that `browserContextId`. Cleanup closes the target and disposes the Browser Context, so cookies and other browser-context state are isolated per browser session key.

## Snapshots

Snapshots prefer `Accessibility.getFullAXTree`. AX nodes are converted into compact `BrowserSnapshot.elements` with deterministic refs such as `@e1`, preserving useful `role`, `name`, `value`, `disabled`, and `checked` fields. Unhelpful and ignored AX nodes are skipped. If the AX command fails, returns an empty/malformed tree, or refs cannot be bound to DOM nodes, EstaCoda falls back to the DOM-query snapshot path.

The default snapshot is a bounded actionable AX subset. It is not true viewport-visible filtering yet. `browser.snapshot` with `full: true` requests a larger full-page snapshot. Snapshot rendering marks compact and full snapshots with headers, truncates oversized text, and can summarize large snapshots when configured.

Snapshot summarization settings:

```json
{
  "browser": {
    "summarizeSnapshots": "auto",
    "snapshotSummarizeThreshold": 8000
  }
}
```

`browser.summarizeSnapshots` accepts `true`, `false`, or `"auto"`. In `"auto"` mode, summarization uses an auxiliary model route only when one is available. Summarization runs only after the rendered snapshot exceeds `browser.snapshotSummarizeThreshold`. Secret-bearing URLs and sensitive values are redacted before any provider call.

## Web Research Tools

`web.search` and `web.crawl` are available as infrastructure tools backed by the web research provider registry. Hosted provider stubs exist for Firecrawl, Parallel, Tavily, Exa, SearXNG, Brave, and DDGS, but those hosted API integrations are not implemented and cannot appear available in this release. `web.extract` can use the registry, and falls back to the guarded raw fetch extractor only when no explicit unavailable extract provider was configured.

## Tools

Browser tools exposed to the agent:

| Tool | Description |
|------|-------------|
| `browser.status` | Show browser state |
| `browser.navigate` | Navigate to URL |
| `browser.snapshot` | Get accessible page snapshot |
| `browser.click` | Click element by ref |
| `browser.type` | Type text into element |
| `browser.scroll` | Scroll page |
| `browser.press` | Press keyboard key |
| `browser.back` | Navigate back |
| `browser.get_images` | List page images |
| `browser.console` | Get console output |
| `browser.cdp` | Raw CDP command |
| `browser.screenshot` | Capture screenshot |
| `browser.vision` | Analyze screenshot with vision |
| `browser.dialog` | Respond to JS dialog |

## URL Safety And Website Policy

Browser and web tools share the URL-safety foundation in `src/browser/url-safety.ts` and website blocklist policy in `src/browser/website-policy.ts`.

Default behavior:

- `web.extract`, `browser.navigate`, and URL-capable `browser.cdp` methods block private, internal, loopback, link-local, multicast, unspecified, reserved, and CGNAT targets by default.
- Cloud metadata endpoints are always blocked, including `metadata.google.internal`, `metadata.goog`, `169.254.169.254`, `169.254.170.2`, `169.254.169.253`, `fd00:ec2::254`, `100.100.100.200`, and IPv4-mapped forms.
- `security.allowPrivateUrls: true` allows ordinary private URLs but does not bypass the metadata block floor.
- Secret-bearing URLs are rejected and redacted before being returned in tool metadata.

Current coverage:

- `web.extract` checks the initial URL before fetch.
- `web.extract` uses manual redirects and checks each redirect target before reading the response body.
- `browser.navigate` checks the initial URL before backend availability and navigation.
- `browser.navigate` checks the final post-navigation URL and best-effort navigates the same session to `about:blank` when the final URL violates the safety floor or website policy.
- `browser.cdp` is classified as `external-side-effect`; URL-capable methods such as `Page.navigate`, `Target.createTarget`, `Runtime.evaluate`, and `Runtime.callFunctionOn` are guarded for explicit URLs and obvious network/navigation literal URL usage.

## Configuration

```bash
pnpm run dev -- browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222 --launch-executable /path/to/chrome --launch-arg --headless=new --chrome-flag --no-first-run
pnpm run dev -- browser test
```

Structured launch fields are the supported configuration surface:

```json
{
  "browser": {
    "backend": "local-cdp",
    "supervised": true,
    "autoLaunch": true,
    "launchExecutable": "/path/to/chrome",
    "launchArgs": ["--headless=new"],
    "chromeFlags": ["--no-first-run"]
  }
}
```

`browser.launchExecutable` is the preferred executable path. `browser.launchArgs` and `browser.chromeFlags` are structured string arrays. `browser.launchCommand` remains accepted as deprecated compatibility data only. It is never split, guessed, or shell-parsed and should not be used as the normal setup path.

Browserbase configuration:

```json
{
  "browser": {
    "backend": "browserbase",
    "cloudProvider": "browserbase",
    "cloudSpendApproved": false,
    "cloudFallback": true
  }
}
```

Browserbase requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`. Credentials alone do not approve spend. Setup writes pending/unapproved cloud spend as `cloudSpendApproved: false`; legacy configs with `cloudSpendApproved: "pending"` still load safely and remain blocked. Operators must run `estacoda browser approve-cloud` before EstaCoda may create Browserbase sessions; `estacoda browser revoke-cloud` disables creation again. Configuration and status checks do not create cloud sessions. Session creation is lazy and happens only when a browser operation needs the cloud backend.

The Browserbase REST client uses the verified current API shape documented in `docs/browserbase-api-notes.md`: `POST https://api.browserbase.com/v1/sessions`, `X-BB-API-Key`, `connectUrl`, `GET /v1/sessions/{id}`, and `POST /v1/sessions/{id}` with `status: "REQUEST_RELEASE"` for release.

Hybrid routing uses `browser.hybridRouting` with Browserbase/cloud configuration:

- Public HTTP(S) URLs route to cloud when Browserbase is configured and cloud spend is approved.
- Private/internal URLs route to local only when `security.allowPrivateUrls === true`.
- Metadata endpoints remain blocked.
- Cloud spend approval failure does not fall back to local.
- Browserbase failures may fall back to local when `browser.cloudFallback === true`.
- Unsafe redirects are blanked to `about:blank` when possible; otherwise the unsafe session is closed.

Status and tool metadata can expose hybrid routing state, last served backend kind, fallback provider/reason metadata, and Browserbase availability/approval status. Secrets and raw Browserbase response bodies are not printed.

`security.allowPrivateUrls` is the canonical setting for private URL access:

```json
{
  "security": {
    "allowPrivateUrls": false,
    "websiteBlocklist": {
      "domains": ["example.com", "*.blocked.example"],
      "sharedFiles": ["/path/to/blocklist.txt"]
    }
  }
}
```

`browser.allowPrivateUrls` remains a deprecated alias only. `ESTACODA_ALLOW_PRIVATE_URLS` overrides config; accepted true values are `1`, `true`, `yes`, and `on`, and accepted false values are `0`, `false`, `no`, and `off`. Invalid values fail runtime config loading.

Website blocklist rules are normalized to lowercase hosts, strip a trailing dot, and strip a leading `www.`. Rules can be exact domains such as `example.com` or wildcard suffixes such as `*.example.com`. Shared files use one rule per line; blank lines and `#` comments are ignored, and missing shared files warn and are skipped.

## Debug Telemetry

Browser/web debug metadata is disabled by default. It is enabled only when `ESTACODA_BROWSER_DEBUG=true` or `ESTACODA_WEB_TOOLS_DEBUG=true`.

When enabled, debug data is attached to individual tool results only. It is redacted and bounded: secret-bearing URLs, auth headers, cookies, request/response bodies, raw Runtime expressions, full page text, and large nested payloads are not stored verbatim. There is no persistent debug log, video capture, session recording, or dashboard in this release.

## Limitations

- Real hosted web research provider API calls are not implemented.
- browser-use, Firecrawl browser, and Camofox browser providers remain deferred/stubbed.
- Optional `agent-browser` engine support is not implemented.
- Lightpanda support is not implemented.
- Compact AX snapshots are a bounded actionable subset, not true viewport-visible filtering.
- Browser can be selected as an optional reviewed setup capability, but setup records configuration intent and does not auto-launch the browser runtime.
- Socket-level DNS rebinding and TOCTOU protection is not implemented.
- `Runtime.evaluate` and `Runtime.callFunctionOn` guards detect obvious literal URL usage but do not perform full JavaScript static analysis.
- Debug telemetry is per-tool-run metadata only; there is no video, session recording, or visual dashboard.

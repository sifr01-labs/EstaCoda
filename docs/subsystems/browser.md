---
title: "Browser Automation"
description: "Browser backend, CDP integration, and structured browser tools."
---

# Browser Automation

## Files

| File | Role |
|------|------|
| `src/browser/browser-backend.ts` | Backend abstraction with mock, local CDP, Browserbase, and hybrid routing |
| `src/browser/supervised-local-cdp-backend.ts` | Supervised local CDP backend, auto-launch, and session-stack ownership |
| `src/browser/cdp-supervisor.ts` | CDP page supervisor, AX snapshots, dialogs, console history, screenshots |
| `src/tools/web-tools.ts` | Browser tool schemas, session-key derivation, snapshot rendering, and summarization |

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

- Local supervised browser: writes `backend: "local-cdp"`, `supervised: true`, reviewed `autoLaunch`, reviewed `headless`, optional `cdpUrl`, and reviewed launch settings.
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
- Supervised local CDP can auto-launch Chrome/Chromium when `browser.autoLaunch === true`. `browser.headless` defaults to `true`; setting it to `false` or using CLI `--headed` opens a visible managed browser window. Discovery checks `browser.launchExecutable`, deprecated `browser.launchCommand` raw data, `CHROME_PATH`, `CHROMIUM_PATH`, local binaries, platform defaults, Homebrew paths, and conservative bundled/Docker paths. The launcher uses structured arguments, never shell-parses `launchCommand`, never calls `exec`, creates an isolated `--user-data-dir`, reads `DevToolsActivePort`, health-checks `/json/version`, and kills only the Chrome process EstaCoda launched during backend cleanup.

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

CDP commands are bounded by a 15-second default deadline and accept cancellation from the owning tool call. Browser-state projection for provider prompts uses one 5-second refresh deadline across availability, tab, and snapshot reads; on cancellation or timeout it preserves a stale prior projection when one exists instead of blocking the turn lifecycle.

## Session Ownership

Browser tools derive browser session keys from the runtime session context. A normal tool call without an explicit `sessionId` uses:

```text
<runtime-session-id>:main
```

Delegated or child runtime sessions therefore get isolated browser state by default. Passing an explicit `sessionId` remains supported and intentionally shares the named browser session across parent/child contexts. An explicit ID equal to the current runtime session ID is canonicalized to that runtime's `:main` browser session so later implicit calls cannot silently fork the browser. Direct backend calls that omit session IDs are compatibility paths, not the intended browser tool path.

Supervised local CDP owns one session manager per endpoint stack. Configured CDP and auto-launched fallback stacks can coexist, and each browser session key is mapped to the stack that created it. Closing a session closes the owning stack session only; configured/manual CDP sessions do not keep an EstaCoda-launched Chrome process alive.

Each supervised session is created in its own CDP Browser Context through `Target.createBrowserContext`, then a page target is created with that `browserContextId`. Cleanup closes the target and disposes the Browser Context, so cookies and other browser-context state are isolated per browser session key.

Tab discovery is also scoped to that Browser Context. `browser.tabs` returns stable opaque refs such as `@t1`, and `browser.switch_tab` changes the page EstaCoda controls without exposing raw CDP target IDs. Discovery joins `Target.getTargets` context metadata with the page connection data from `/json/list`; tabs from other contexts and tabs rejected by URL, website, metadata, or secret policy are not exposed. After `browser.click`, EstaCoda automatically follows the new tab only when exactly one new safe page tab appeared. When zero or multiple safe tabs appear, it keeps the current tab controlled and reports the new refs for an explicit switch.

Browser-related provider turns receive a bounded, redacted projection of the live session: session status, the controlled tab, up to eight safe tabs, canonical snapshot identity/readiness, and the last browser action. This protected mutable state supersedes historical browser observations, so the model does not need to poll `browser.tabs` or reconstruct the current tab from old tool results. The runtime refreshes an existing projection at the next relevant turn boundary, detects manual URL, document/action identity, tab-list, or controlled-tab changes, and marks state stale if a safe refresh cannot complete. Tab-changing action deltas retain and report both the source and destination tabs.

The provider turn loop guards demonstrated browser loops without treating every unchanged page as intellectual failure. Trusted results are fingerprinted in memory: a different find result, candidate set, region, tab inventory, or structural snapshot is new evidence even when the URL and document do not change. Repeating a whole-state observation produces one local corrective instruction and temporarily removes only that exhausted schema from the next request. A failed target means no action was dispatched and permits one different retarget; a dispatched action that returns `no-change`, timeout, or unverified settlement is tracked separately. Repeated equivalent evidence, repeated targets, or multiple ineffective dispatched actions stop before the broad provider budgets. State-changing actions reset the guard. Page content, inputs, tab data, and fingerprints are not added to budget events or traces.

## Snapshots

Snapshots prefer `Accessibility.getFullAXTree`. AX nodes are converted into compact `BrowserSnapshot.elements` with refs such as `@e1`, preserving useful `role`, `name`, `label`, surrounding text, compact semantic region text, `value`, `disabled`, and `checked` fields. The region is the smallest bounded visible ancestor that adds meaningful context and contains a manageable set of actionable descendants. This lets a card such as `TikTok Connect` expose its related `Callback URL`, `Edit`, and `Delete` controls without conflating notification text elsewhere on the page. Unhelpful and ignored AX nodes are skipped. If the AX command fails, returns an empty/malformed tree, or refs cannot be bound to DOM nodes, EstaCoda falls back to the DOM-query snapshot path.

One shared page-side interactability evaluator controls which elements receive actionable refs, appear in semantic find/extract results, pass structural preflight, and may be activated. It rejects detached, hidden, inert, disabled, zero-geometry, and modal-blocked controls, including states inherited from ancestors and disabled fieldsets. Controls inside the active modal remain usable, as do valid offscreen controls. Page text and diagnostics remain visible even when a control is excluded. EstaCoda repeats this check immediately before dispatch so a DOM change between observation and action fails safely without weakening canonical identity or target-binding checks.

Element refs are intentionally scoped by session, tab, `documentEpoch`, and `actionRevision`. A ref action must include the source snapshot's canonical `identity` and `tabRef`; stale, cross-document, or cross-tab refs fail with structured current-state metadata before an action is dispatched. `observationId` identifies a capture but does not invalidate refs by itself. `browser.find`, `browser.click`, `browser.type`, `browser.select`, and `browser.extract` also accept semantic locators using `role`, `name`, `text`, `label`, `withinText`, and optional exact matching. Semantic resolution uses a fresh policy-checked snapshot, ignores hidden and disabled matches, and returns bounded candidates instead of guessing when a locator is ambiguous.

Consequential browser controls use a read-only structural preflight before security policy is assessed. The supervised backend resolves the current target without activating it and reports bounded tag/role, link or control kind, form/submit association, canonical identity, and a redacted label. Only an ordinary HTTP(S) anchor with structural link evidence remains `read-only-network`; buttons, submit/form controls, scripted or unknown elements, Enter and other ambiguous keys, and dialog acceptance become `external-side-effect`. Escape and navigation-only keys remain read-only, as does dialog dismissal. Page labels improve the approval description but cannot lower risk. Missing, stale, ambiguous, or uninspectable targets fail closed.

After approval, EstaCoda repeats the preflight and compares the exact session, tab, document/action identity, ref, structural kind, and action. A changed control is not activated, so a one-time approval for one button cannot authorize another. Protected sign-in and MFA submission keep using the separate field-bound protected-delivery path described below.

Protected sign-in fields use a separate field-bound path. `browser.fill_protected_form` accepts one current canonical identity and a bounded set of related refs (for example, account identifier and password), verifies every destination before collection, collects the values through one operator flow, re-verifies the complete form, and delivers without exposing values to the model or tool result. With `submitRef`, it also invokes the prebound authentication control inside the same local transaction. A later protected `browser.type` call can use the same identity-bound submission path.

Authentication then follows an explicit runtime lifecycle: credentials requested/submitted, challenge required/submitted, verification pending, authenticated, or blocked. A visible challenge always outranks authenticated-looking controls from the same page, so credentials may be complete while the overall sign-in remains pending. Challenges are detected generically and may include a one-time code, passkey, security key, biometric step, CAPTCHA, push approval, device confirmation, or another verification method. Resend and retry actions keep the existing challenge item pending rather than creating duplicate Mission work. Challenge departure plus a causal document/action transition and authenticated-only destination evidence can verify success; submission alone cannot. Failed and no-change browser actions preserve pending evidence, while an unrelated consequential state change invalidates its causal chain. Completed authentication remains complete unless a later trusted snapshot explicitly shows an authentication error or signed-out page. Screenshots, vision, extraction, and descriptive snapshots remain suppressed while protected input is active; URL transitions and verified challenge departure clear that state. Human input time inside this flow is excluded from the autonomous provider wall-clock budget.

The default snapshot is a bounded actionable AX subset. It is not true viewport-visible filtering yet. Before returning it to the provider, EstaCoda deterministically compacts the structured snapshot into a stable character budget. Identity, URL/title, active dialogs and alerts, actionable refs, protected-input guidance, authentication context, headings, frames, and browser errors take priority; repeated navigation, duplicate labels, and inert boilerplate are deduplicated. The complete structured snapshot remains available in internal tool metadata. A `... [deterministically compacted]` suffix makes omitted output visible. `browser.snapshot` with `full: true` retains the larger diagnostic path.

Every snapshot carries canonical `identity`, `observedAt`, and document `readiness`. `documentEpoch` advances for document or controlled-tab replacement, `actionRevision` advances when refs can change, and `observationId` advances on every capture. After navigation and ordinary browser actions, the supervised backend waits for an explicit `waitFor` condition or bounded DOM stability. The result contains the action delta, resulting identity, a bounded safe current-state summary, and current actionable refs when observation is safe. Supported conditions are URL text, page text, an element role/name, a dialog, and DOM stability. `waitTimeoutMs` is capped at 10 seconds; a timeout returns the latest safe state with an explicit timeout outcome and does not claim that the requested condition succeeded. Delta labels, titles, URLs, and ref summaries are bounded and redacted.

Snapshot summarization settings:

```json
{
  "browser": {
    "summarizeSnapshots": "auto",
    "snapshotSummarizeThreshold": 8000
  }
}
```

`browser.summarizeSnapshots` accepts `true`, `false`, or `"auto"`. Deterministic compaction runs first for normal snapshots. In `"auto"` mode, an auxiliary model is a final fallback only when the compacted result still exceeds `browser.snapshotSummarizeThreshold` and an auxiliary route is available. `true` explicitly permits provider summarization when the original rendered snapshot exceeds the threshold. `false` never invokes a summarization provider. Secret-bearing URLs and sensitive values are redacted before any provider call.

## Web Research Tools

`web.search`, `web.extract`, and `web.crawl` are infrastructure tools backed by the web research provider registry, but they are not browser backends. Brave Search and DDGS are implemented search providers. `fetch` is the implemented guarded extraction fallback. Firecrawl, Parallel, Tavily, Exa, and SearXNG remain registered unavailable stubs, and no live crawl provider is implemented in this release.

Brave uses the normal credential reference flow through `web.brave.apiKeyEnv`, defaulting to `BRAVE_SEARCH_API_KEY`. DDGS uses the managed Python capability `ddgs` and is available only after `estacoda python-env setup ddgs` and verification. Runtime `web.search` does not install Python packages automatically.

## Tools

Browser tools exposed to the agent:

| Tool | Description |
|------|-------------|
| `browser.status` | Show browser state |
| `browser.navigate` | Navigate to URL |
| `browser.snapshot` | Get accessible page snapshot |
| `browser.find` | Find visible, enabled elements by semantic locator |
| `browser.click` | Click by semantic locator, identity-scoped ref/region, or one-use governed visual target |
| `browser.type` | Type by semantic locator or identity-scoped ref; optionally bind and immediately submit a one-time-code challenge |
| `browser.fill_protected_form` | Fill related protected fields in one verified operator flow, optionally with a prebound submit control |
| `browser.select` | Select an option by semantic locator or identity-scoped ref |
| `browser.extract` | Extract one semantically resolved element |
| `browser.scroll` | Scroll page |
| `browser.press` | Press keyboard key |
| `browser.back` | Navigate back |
| `browser.get_images` | List page images |
| `browser.console` | Get console output |
| `browser.tabs` | List safe tabs in the current isolated browser session |
| `browser.switch_tab` | Focus and control a safe tab by opaque ref |
| `browser.cdp` | Raw CDP command |
| `browser.screenshot` | Capture a sanitized current-viewport screenshot |
| `browser.vision` | Analyze a sanitized current-viewport screenshot through the governed vision route |
| `browser.dialog` | Respond to JS dialog |

## Governed Visual Escalation

Semantic snapshots remain the default browser observation. Ambiguous matching, visible text without a grounded action, target-resolution failure, native action without change, or an explicit agent request can recommend one `browser.vision` fallback. Repeated visual observations are fingerprinted and bounded by the same browser supervision path; vision does not disable loop detection or restore plan-driven continuation.

The screenshot boundary captures only the current controlled tab and viewport. Before bytes leave the browser backend, the runtime locates password, token, key, secret, one-time-code, and credential value regions and composites opaque masks into the image. A capture is discarded when DOM mutation, scroll, or viewport signals change between inspection and capture. Protected-input transactions continue to block visual observation completely.

When vision reports a pixel candidate, `browser.click.visualTarget` accepts the screenshot ID and viewport-image coordinate only once. The runtime verifies the same session, tab, document generation, action revision, viewport, scroll offset, and DOM mutation revision; hit-tests the point; and accepts it only if it resolves to a current runtime-grounded element or visible region. Normal action preflight, approval classification, native pointer hit-testing, URL policy, and settlement still run. Navigation, scrolling, resizing, DOM change, another screenshot, or the first resolution attempt expires the visual target. Raw coordinate dispatch, page JavaScript clicking, and reconstruction of masked values are not available through this path.

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
pnpm run dev -- browser setup --backend local-cdp --auto-launch --headed --launch-executable /path/to/chrome --chrome-flag --no-first-run
pnpm run dev -- browser test
```

Structured launch fields are the supported configuration surface:

```json
{
  "browser": {
    "backend": "local-cdp",
    "supervised": true,
    "autoLaunch": true,
    "headless": false,
    "launchExecutable": "/path/to/chrome",
    "launchArgs": [],
    "chromeFlags": ["--no-first-run"]
  }
}
```

`browser.launchExecutable` is the preferred executable path. `browser.headless` owns browser-window visibility and defaults to `true`; in visible mode, legacy `--headless` values in structured arguments are ignored. `browser.launchArgs` and `browser.chromeFlags` are structured string arrays. `browser.launchCommand` remains accepted as deprecated compatibility data only. It is never split, guessed, or shell-parsed and should not be used as the normal setup path.

CLI and model-tool updates that specify only browser window behavior preserve the other reviewed browser settings. The Setup Editor continues to apply its complete reviewed browser selection, including intentional field removal when switching modes.

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

- Web research beyond Brave Search, DDGS search, and guarded fetch extraction remains registered but unavailable.
- No live `web.crawl` provider is implemented.
- browser-use, Firecrawl browser, and Camofox browser providers remain deferred/stubbed.
- Optional `agent-browser` engine support is not implemented.
- Lightpanda support is not implemented.
- Compact AX snapshots are a bounded actionable subset, not true viewport-visible filtering.
- Browser can be selected as an optional reviewed setup capability, but setup records configuration intent and does not auto-launch the browser runtime.
- Socket-level DNS rebinding and TOCTOU protection is not implemented.
- `Runtime.evaluate` and `Runtime.callFunctionOn` guards detect obvious literal URL usage but do not perform full JavaScript static analysis.
- Debug telemetry is per-tool-run metadata only; there is no video, session recording, or visual dashboard.

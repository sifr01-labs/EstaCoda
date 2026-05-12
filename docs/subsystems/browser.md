---
title: "Browser Automation"
description: "Browser backend, CDP integration, and structured browser tools."
---

# Browser Automation

## Files

| File | Lines | Role |
|------|-------|------|
| `src/browser/browser-backend.ts` | 766 | Backend abstraction with mock and CDP |
| `src/tools/web-tools.ts` | 731 | Browser tool schemas and execution |

## Backends

| Backend | Status | Evidence |
|---------|--------|----------|
| Local Chrome CDP | Implemented | `smoke-tested` |
| Mock | Implemented | `smoke-tested` |
| Browserbase | Recognized in config | `intended but not implemented` |
| Browser Use | Recognized in config | `intended but not implemented` |
| Firecrawl | Recognized in config | `intended but not implemented` |
| Camofox | Recognized in config | `intended but not implemented` |

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

## Configuration

```bash
pnpm run dev -- browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222
pnpm run dev -- browser test
```

## Limitations

- Cloud backends are not implemented.
- Persistent dialog supervisor is missing.
- Browser can be selected as an optional reviewed setup capability, but setup records configuration intent and does not auto-launch the browser runtime.

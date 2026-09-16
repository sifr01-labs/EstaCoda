---
title: "Web Research"
description: "Search, extraction, crawl provider selection, credential handling, and managed DDGS setup."
---

# Web Research

Web research providers are separate from browser automation and separate from LLM providers. The web research registry backs `web.search`, `web.extract`, and `web.crawl`; browser tools still use the browser backend and CDP/Browserbase policy.

## Live provider state

| Provider | Capabilities | Status | Setup |
|----------|--------------|--------|-------|
| Brave Search | search | Implemented live provider | Configure `web.searchBackend: "brave"` and a Brave API key env reference |
| DDGS | search | Implemented managed Python provider | Install and verify the registered `ddgs` Python capability |
| fetch | extract | Implemented guarded extraction fallback | No API key required |
| Firecrawl | search, extract, crawl | Registered stub | Reports unavailable |
| Parallel | search | Registered stub | Reports unavailable |
| Tavily | search, extract | Registered stub | Reports unavailable |
| Exa | search | Registered stub | Reports unavailable |
| SearXNG | search | Registered stub | Reports unavailable |

`web.crawl` exists as tool infrastructure, but no live crawl provider is implemented in this release.

## Selection rules

Selection is capability-specific:

```text
web.searchBackend / web.extractBackend / web.crawlBackend
-> web.backend
-> auto-detect available providers
-> unavailable
```

Explicit config wins. If `web.searchBackend` is `brave` and the Brave credential is missing, `web.search` reports Brave as unavailable instead of silently falling back to DDGS. Auto-detect only chooses providers whose availability check succeeds.

For extraction, `fetch` is the guarded fallback only when no explicit unavailable extract provider was configured and no available extract provider was auto-detected.

## Brave Search

Brave is a credentialed external provider. Config stores an environment-variable reference, not a raw key:

```json
{
  "web": {
    "searchBackend": "brave",
    "brave": {
      "apiKeyEnv": "BRAVE_SEARCH_API_KEY"
    }
  }
}
```

`BRAVE_SEARCH_API_KEY` is the default env var name. Setup flows should handle it the same way provider credentials are handled elsewhere: env reference first, optional deferred secret value, redacted review, and write only through the reviewed apply path.

The runtime resolves the credential through the shared runtime credential resolver. Brave provider code must not read `process.env` directly outside that resolver path, must not log the token, and must not return it in errors.

## DDGS

DDGS uses the managed Python capability registry:

```bash
estacoda python-env status ddgs
estacoda python-env setup ddgs
estacoda python-env verify ddgs
```

The runtime provider is available only when the registered `ddgs` capability is installed and verified. Search execution uses the managed capability Python path and a subprocess with JSON passed over stdin. It must not interpolate the query into Python source, run through a shell, install packages at runtime, or accept arbitrary package names from users, skills, or provider output.

If DDGS is unavailable, the repair hint is `estacoda python-env setup ddgs`. Setup Editor and onboarding may offer that reviewed install action, but normal `web.search` execution does not repair or install dependencies automatically.

## URL safety

Search providers return result URLs and snippets. They do not bypass browser or extraction URL policy. `web.extract` still checks URL safety before fetch and again across redirects before reading response bodies.

## Debugging

Useful checks:

```bash
estacoda python-env status ddgs
estacoda python-env verify ddgs
estacoda setup
```

For Brave, confirm that the selected profile config names the expected env reference and that the selected profile `.env` or process environment contains that variable. For DDGS, confirm the managed capability status is installed or verified.

## Desktop selection and setup

Browser & Search settings show the selected search service and the currently resolved service for Automatic. Brave Search and DDGS are selectable implemented search services; registered providers without a search implementation remain browse-only. Availability is setup evidence, not a successful network test. Brave credentials are staged privately. DDGS uses the registered dependency installer with explicit download review and durable receipt reconciliation; downloading software is separate from saving search settings.

Choosing Automatic clears the explicit search selection and the legacy shared backend. When extraction or crawling inherited that shared backend, the reviewed change preserves their existing selection explicitly. Advanced controls retain extraction/crawling and legacy provider settings.

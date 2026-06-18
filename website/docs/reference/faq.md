---
title: FAQ
description: Short operational answers.
sidebar_position: 9
---

# FAQ

## Is EstaCoda a hosted service?

No. EstaCoda runs on your machine. You provide the providers, the credentials, and the channels. There is no SaaS backend, no centralized message broker, and no remote agent farm.

## Where does state live?

Global state lives in `~/.estacoda/`. Profile-local state lives in `~/.estacoda/profiles/<profile-id>/`. The active profile pointer is global; everything else is scoped to the selected profile.

## Are profiles cosmetic?

No. Profiles own their config, secrets, memory, skills, gateway state, sessions, and logs. Switching profiles switches the entire runtime context. Sessions do not leak between profiles.

## Where do credentials go?

In the selected profile `.env` file. Setup flows write secrets there with `0600` permissions. Do not put raw keys in `config.json`.

## Which providers are live-proven?

Kimi, OpenAI, DeepSeek, and OpenRouter are live-proven for v0.1.0. Codex is a public setup path but not live-proven. Google is configurable but not live-proven. Anthropic, MiniMax, and Nous are catalog-known but not runnable as primary LLM routes in the current build.

## Which channels are live-proven?

Telegram is the strongest live-proven first-party remote channel for v0.1.0. Discord and Email are present but require deployment-specific operator validation. WhatsApp is setup-backed and operational, but it uses an unofficial Baileys bridge, so account risk remains outside EstaCoda's control.

## Is WhatsApp stable?

WhatsApp is operationally supported through an isolated bridge, but it is not risk-free. It is gated behind `experimental: true` and uses an unofficial library. Meta may suspend accounts that use it. Use a dedicated number and do not enable it in a production profile without understanding the risk.

## Are cloud browsers live-supported?

Browserbase is implemented behind explicit cloud spend approval. It requires `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and `estacoda browser approve-cloud` before billable cloud sessions can be created. `local-cdp` remains the local backend. browser-use, Firecrawl, and Camofox remain registered stubs.

## Are web research providers live-supported?

Partly. Brave Search and DDGS are implemented for `web.search`, and guarded built-in `fetch` extraction is live for `web.extract`. Firecrawl, Parallel, Tavily, Exa, and SearXNG remain registered stubs.

Brave needs `web.brave.apiKeyEnv`, defaulting to `BRAVE_SEARCH_API_KEY`. DDGS needs the managed Python capability installed with `estacoda python-env setup ddgs`; runtime search does not install packages automatically.

## Is session compression stable?

No. Session compression is experimental-only in v0.1.0. It requires both `compression.enabled` and `compression.experimental` to be `true`.

## How do install and update work?

Install and update behavior is implemented, but method-routed. The source installer creates a managed-source install that `estacoda update` can update in place after safety checks. Manual source, Homebrew, Docker, npm, and pnpm installs are routed to the appropriate external command instead of being mutated by EstaCoda. See [Installation](../getting-started/installation.md) and [Updating](../getting-started/updating.md).

## Related docs

- [Troubleshooting](./troubleshooting.md) — concrete problems and repairs
- [Configuration](./configuration.md) — config families
- [State and Files](./state-and-files.md) — state paths

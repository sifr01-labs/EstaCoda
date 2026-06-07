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

Kimi, OpenAI, DeepSeek, and OpenRouter are live-proven for v0.1.0. Codex is a public setup path but not live-proven. Google and Anthropic are configurable/catalog-known. MiniMax and Nous are catalog-known but not runnable in the current build.

## Which channels are live-proven?

Telegram is the only live-proven first-party remote channel for v0.1.0. Discord and Email are present but not live-proven. WhatsApp is experimental-only.

## Is WhatsApp stable?

No. WhatsApp is gated behind `experimental: true` and uses an unofficial library. Meta may suspend accounts that use it. Do not enable it in a production profile without understanding the risk.

## Are cloud browsers live-supported?

Browserbase is implemented behind explicit cloud spend approval. It requires `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and `estacoda browser approve-cloud` before billable cloud sessions can be created. `local-cdp` remains the local backend. browser-use, Firecrawl, and Camofox remain registered stubs.

## Are web research providers live-supported?

No. Only guarded built-in `fetch` extraction is live. Firecrawl, Parallel, Tavily, Exa, SearXNG, Brave, and DDGS are registered stubs and report unavailable even when configured.

## Is session compression stable?

No. Session compression is experimental-only in v0.1.0. It requires both `compression.enabled` and `compression.experimental` to be `true`.

## Can the docs claim final install/update behavior yet?

No. Install and update docs remain blocked until the implementation PRs land. The docs site includes stubs with source-of-truth links and safety rules, but does not claim final curl, Homebrew, Docker, npm, or source-update behavior before that code is merged.

## Related docs

- [Troubleshooting](./troubleshooting.md) — concrete problems and repairs
- [Configuration](./configuration.md) — config families
- [State and Files](./state-and-files.md) — state paths

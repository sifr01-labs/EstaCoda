---
title: Known Issues
description: Blunt accounting of current limitations and unsupported surfaces.
sidebar_position: 5
---

# Known Issues

This page is intentionally blunt. It is for engineering continuity, not marketing. Every limitation listed here is a boundary, not a promise.

## Unsupported in v0.1.0

These surfaces exist in code or registry but are not live for users.

| Surface | Status | Detail |
|---------|--------|--------|
| Native Windows installer | Unsupported | No Windows-native install path. WSL is best-effort. |
| Binary artifact-only update via `ESTACODA_UPDATE_ARTIFACT` | Reachable, not recommended | The artifact path exists in code but is not the public v0.1.0 update mechanism. Use `estacoda update` or package-manager routing. |
| Cloud browser providers except Browserbase | Registered, not live | browser-use, Firecrawl, and Camofox are registered but cannot create live sessions. Browserbase is implemented behind explicit spend approval. |
| Web research providers beyond Brave, DDGS, and fetch | Registered, not live | Firecrawl, Parallel, Tavily, Exa, and SearXNG are registered stubs. Brave and DDGS provide live search; guarded built-in `fetch` extraction is live. |
| Anthropic Messages API adapter | Catalog-known, not runnable | Code exists but is not runnable in the current build. |
| MiniMax LLM adapter | Catalog-known, not runnable | Appears in metadata but is not a live inference route. |
| Nous LLM adapter | Catalog-known, not runnable | Appears in metadata but is not a live inference route. |
| Arbitrary external memory providers | Unsupported | Only the built-in `file` provider constructs a live provider. Named providers without code implementation are rejected. |

## Experimental in v0.1.0

These features are code-gated or maturity-marked. Enable them only if you understand the risk.

| Feature | Gate | Risk |
|---------|------|------|
| Session compression | `compression.enabled` and `compression.experimental` both `true` | Experimental-only. Disabled by default. |
| Agent Evolution autonomy above `suggest` | `skills.autonomy` modes above `suggest` | Records reviewable evidence/proposals and shadow-only decisions. Real auto-promotion, auto-rollback, and automatic local skill creation are not active. |
| Skill evolution/proposal/promotion workflows | `skill.propose_patch`, `skill.rollback` | Governed but not fully autonomous. Promotion runs eval gates. |
| Workflow runtime integration | SQLite session DB required | Best-effort. Wires only when the session database is SQLite. |
| Local TTS | Deferred | No local TTS provider is implemented. |
| Mistral TTS/STT | Deferred | Not implemented. |
| Gateway auto-TTS | `voice.autoTts: true` | Per-reply and per-hour caps apply. |
| Deferred browser cloud providers | `browser.backend` accepts legacy names | Firecrawl and Camofox browser backends report unavailable status. browser-use remains a deferred cloud provider. |
| Deferred web research providers | `web.backend` accepts stub names | Firecrawl, Parallel, Tavily, Exa, and SearXNG report unavailable even when configured. DDGS requires explicit managed Python setup and does not auto-install during runtime search. |

## Present but not live-proven

These channels and providers exist in code but lack live validation evidence for v0.1.0.

| Surface | Evidence | Note |
|---------|----------|------|
| Discord channel | Experimental | Adapter is present; live validation is incomplete. |
| Google LLM provider | Configurable/catalog-known | Config path exists but not live-proven in this build. |
| Anthropic LLM provider | Catalog-known | Metadata and catalog entries exist, but it is not exposed as a setup/model-picker route and is not runnable in this build. |

## Known runtime limitations

- `doctor --live` can succeed with `[empty]` response text for some providers.
- OpenRouter works at runtime but can miss exact-content fidelity checks.
- Ollama/local support is architecturally present but unproven in this environment.
- MCP stdio is live-proven; HTTP and broader third-party coverage need operator validation.
- MCP workspace-trust ergonomics are coarse-grained.
- Memory rendering is selective but not ranked. No freshness/staleness handling.
- On non-vision providers, image analysis degrades to metadata-only.
- Gateway status reports readiness, not real background-process liveness.
- Full runtime CLI localization is incomplete. Arabic terminal rendering supports shaped, bidirectional Arabic, but not every CLI string is localized.
- Evaluation substrate exists but is not a scored automated benchmark.
- Internal alpha harness is manual and not yet a strict release gate.
- Provider message content support was widened for vision, but many places still assume string content conceptually.
- Product logic mixed with formatting/delivery concerns in some channel paths.
- Live provider capability detection deserves an explicit operator signal.
- Session recall works, but richer lineage/history management is missing.
- Profile effects beyond prompt guidance remain incomplete.
- npm global install requires the package to be published to npm. Package metadata is publish-ready, but publication happens through the release process.
- Homebrew install depends on an external tap (`KemetResearch/homebrew-tap`) that is not part of this repository.
- Docker install depends on GHCR image availability and tag publishing.
- Auto-stash on dirty worktree is not implemented.

## OS support

- macOS 11 Big Sur and later is the stated floor.
- Linux: any modern distribution with systemd and glibc. Validated on Ubuntu 22.04+ and Debian 12+.
- WSL2 is best-effort. Voice/microphone paths and systemd user services have known edge cases.
- Termux is best-effort. The installer resolves a Termux layout but it is not a primary validation target.
- Native Windows is unsupported.

## What this means

A registered provider is not a working provider. A present channel is not a validated channel. An experimental feature is not a launch guarantee. Check this page before reporting a bug; the bug may be a documented limitation.

## Related docs

- [Testing](./testing.md) — validation layers and evidence levels
- [FAQ](../reference/faq.md) — short answers on provider and channel maturity

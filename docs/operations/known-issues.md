---
title: "Known Issues"
description: "Blunt accounting of current limitations and unresolved edges."
---

# Known Issues

This file is intentionally blunt. It is for engineering continuity, not marketing.

## Runtime / Provider

- `doctor --live` can succeed with `[empty]` response text for some providers. `live-proven`
- Catalog-only providers are discovery adapters, not true inference adapters. `implemented`
- `openrouter/auto` is not acceptance-grade for tool workflows. `live-proven`
- OpenRouter can miss exact-content fidelity checks. `live-proven`
- Local/Ollama support is architecturally present but unproven in this environment. `live-proven`
- MCP stdio is live-proven; HTTP and broader third-party coverage need operator validation. `live-proven` / `smoke-tested`
- MCP workspace-trust ergonomics are coarse-grained. `implemented but not live-proven`
- ACP editor integration is live-proven for basic chat and file reads, but terminal/process polish is missing.

## Memory

- Autonomous workflow learning creates new project skills but does not intelligently patch existing ones. `implemented but not live-proven`
- Memory rendering is selective but not ranked.
- No freshness/staleness handling.

## Telegram / Channels

- Telegram is the most mature launch channel; CLI now uses SQLite-backed persistence.
- On non-vision providers, image analysis degrades to metadata-only. `live-proven`
- Native-vision routing is preferred for simple image prompts, but broader multi-provider proof is missing. `smoke-tested`
- Telegram final formatting is improved but not full parity. `smoke-tested`
- Profile/UI control exists globally, but channel-specific overrides are missing. `smoke-tested`
- Gateway status reports readiness, not real background-process liveness. `live-proven`
- CLI session resume works, but richer lineage/history management is missing. `smoke-tested`

## CLI / UX

- Full runtime CLI localization is incomplete. Arabic support is limited to setup labels and select surfaces. `live-proven`
- Mixed Arabic + English technical tokens can show terminal bidi artifacts. `live-proven`
- Interactive multiline paste ergonomics are rough. `live-proven`
- Some answers remain too "assistant-ish" depending on surface. `live-proven`

## Testing

- Smoke coverage is broad but some behaviors are only smoke-verified, not repeatedly operator-verified.
- Internal alpha harness is manual and not yet a strict release gate.
- Evaluation substrate exists but is not a scored automated benchmark. `implemented but not live-proven`

## Architecture Debt

- Provider message content support was widened for vision, but many places still assume string content conceptually. `implemented`
- Product logic mixed with formatting/delivery concerns in some channel paths. `implemented`
- Live provider capability detection deserves an explicit operator signal. `intended but not implemented`
- MCP trust policy is coarse-grained. `implemented but not live-proven`

## Product Open Edges

- Skills Hub / distribution layer is not implemented.
- Non-Telegram launch channels are not product-ready.
- Packaging/distribution path is not decided.
- Legacy agent framework migration path is not designed.
- Voice/TTS/STT foundation exists but full TUI voice input is follow-up work.
- Profile effects beyond prompt guidance remain incomplete.
- Update/install lifecycle for end users is not finalized.

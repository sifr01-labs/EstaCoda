---
title: "Known Issues"
description: "Blunt accounting of current limitations and unresolved edges."
---

# Known Issues

This file is intentionally blunt. It is for engineering continuity, not marketing.

## Unsupported in v0.1.0

These surfaces are unavailable, unsupported, or retained only as non-user-facing scaffolding.

| Surface | Status | Detail |
|---------|--------|--------|
| Native Windows installer | Unsupported | No Windows-native install path. WSL is best-effort. |
| Binary artifact-only update via `ESTACODA_UPDATE_ARTIFACT` | Legacy helper, not routed | Artifact-copy helpers remain in code, but normal install-method detection does not route a user update through them. Use `estacoda update` or the detected package-manager command. |
| Cloud browser providers except Browserbase | Registered, not live | browser-use, Firecrawl, and Camofox are registered but cannot create live sessions. Browserbase is implemented behind explicit spend approval. |
| Web research providers beyond Brave, DDGS, and fetch | Registered, not live | Firecrawl, Parallel, Tavily, Exa, and SearXNG are registered stubs. Brave and DDGS provide live search; guarded built-in `fetch` extraction is live. |
| Anthropic Messages API route | Catalog-known, not runnable | Metadata and API-mode scaffolding exist, but there is no native Anthropic adapter in the current build. |
| Arbitrary external memory providers | Unsupported | Only the built-in `file` provider constructs a live provider. Unknown provider names currently construct no provider and are ignored rather than rejected. |

## Experimental in v0.1.0

These features are code-gated or maturity-marked. Enable them only if you understand the risk.

| Feature | Gate | Risk |
|---------|------|------|
| Session compression | `compression.enabled` and `compression.experimental` both `true` | Experimental-only. Disabled by default. |
| Agent Evolution autonomy above `suggest` | `skills.autonomy` modes above `suggest` | Proactive mode prepares patches and runs evals; autonomous mode additionally records shadow autonomous decisions. Real auto-promotion, auto-rollback, and automatic learned-skill creation are not active. |
| Skill evolution/proposal/promotion workflows | `skill.propose_patch`, `skill.approve_patch`, `skill.promote_patch`, `skill.rollback` | Governed but not fully autonomous. Promotion runs the current declarative skill eval gate; it does not execute full task fixtures. |
| Gateway auto-TTS | `voice.autoTts: true` | Provider text caps always apply. Optional per-reply and per-hour caps apply only when configured. |
| Deferred browser cloud providers | `browser.backend` accepts legacy names | Firecrawl and Camofox browser backends report unavailable status. browser-use remains a deferred cloud provider. |
| Deferred web research providers | `web.backend` accepts stub names | Firecrawl, Parallel, Tavily, Exa, and SearXNG report unavailable even when configured. DDGS is available and is not part of this deferred set. |

## Present But Not Live-Proven

These channels and providers exist in code but lack live validation evidence for v0.1.0.

| Surface | Evidence | Note |
|---------|----------|------|
| Discord channel | Experimental | Adapter is present; live validation is incomplete. |
| Anthropic LLM provider | Catalog-known | Metadata and catalog entries exist, but it is not exposed as a setup/model-picker route and is not runnable in this build. |

## Runtime Limitations

- `doctor --live` can succeed with `[empty]` response text for some providers.
- Local / Custom OpenAI-compatible endpoint support is implemented but not live-proven in this environment.
- MCP stdio is live-proven; HTTP and broader third-party coverage need operator validation.
- MCP workspace-trust ergonomics are coarse-grained.
- Query-selective memory rendering and lexical memory retrieval are ranked. Freshness/staleness handling remains narrow: stale derived indexes can be detected, but there is no general age- or TTL-based memory policy.
- Image turns require a configured vision-capable route. Text-only primary or fallback routes are skipped for image-bearing provider requests, and `vision.analyze` fails loudly when no usable vision route is available.
- Live vision quality is provider-dependent. The opt-in scored lane covers OCR, chart, screenshot, dense-document, rotation, injection, comparison, resource limits, and fallback observation with stored regression thresholds. A normal successful primary call cannot force a safe deterministic provider failure, so fallback is labeled `not-exercised` unless it is actually observed.
- Gateway status probes PID and service-manager liveness and suppresses untrustworthy runtime/cache state. Its persisted supervisor summary can still reflect stale lifecycle state.
- Full runtime CLI localization is incomplete. Arabic terminal rendering supports shaped, bidirectional Arabic, including mixed-direction Papyrus prompt and steer editing, but not every CLI string is localized.
- Deterministic automated benchmark lanes collect metrics, evidence, and history. Vision now has a scored threshold gate; other capability areas do not yet share one repository-wide release score.
- Internal alpha harness is manual and not yet a strict release gate.
- Provider message content supports structured image/text parts on the tested vision paths. New provider adapters and prompt-processing paths still need explicit coverage before they are treated as image-safe.
- Some channel adapters still combine transport behavior, attachment processing, response formatting, and delivery orchestration.
- Session recall and verified compression lineage work, but there is no dedicated operator surface for lineage browsing, history export, or history deletion.
- Public npm installation remains unavailable until `estacoda` is published. Package metadata is publish-ready, but publication is a separate release action.
- Homebrew installation depends on the external `KemetResearch/homebrew-tap`, which is not part of this repository and was not publicly reachable as of 2026-08-03.
- Docker installation depends on GHCR image availability and tag publishing. The `v0.1.0` workflow targeted `ghcr.io/kemetresearch/estacoda`, while current install routing targets `ghcr.io/sifr01-labs/estacoda`; the current path must be publication-verified before it is claimed as live.
- Auto-stash on dirty worktree is not implemented.

## OS Support

- macOS 11 Big Sur and later is the stated floor.
- Linux: the manual installer requires glibc. systemd is required only for systemd-managed gateway service installation. Ubuntu 22.04+ and Debian 12+ are stated validation targets, but are not both covered by the current CI matrix.
- WSL2 is best-effort. Voice/microphone paths and systemd user services have known edge cases.
- Termux is best-effort. The installer resolves a Termux layout but it is not a primary validation target.
- Native Windows is unsupported.

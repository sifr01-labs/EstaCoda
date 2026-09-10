# EstaCoda Desktop visual and interaction contract

Status: approved design direction, version 1 · 10 September 2026. Implementation and production accessibility verification remain pending.

This contract makes the [approved branded prototype](desktop-design/README.md) the visual acceptance target for **Desktop PR 5** in the [implementation plan](desktop-implementation-plan.md). It supersedes the earlier concept specification under `exports/desktop-design-concept/`. Desktop PR numbers are distinct from workspace-execution PR numbers.

The [shared ownership decisions](workspace-execution-ownership-decisions.md) remain authoritative for execution, targets, approvals, credentials, and profile isolation. The prototype supplies appearance and interaction examples; its mock data and timers supply no runtime authority. Where demo behavior differs from a real backend contract, preserve the visual structure and use truthful backend behavior.

## 1. What PR 5 must deliver

PR 5 delivers the secure Electron shell **and the complete approved visual experience**, with a deterministic development/test fixture mode covering the screens below. Later PRs connect those same React components to live functionality. A generic shell with visual polish deferred to later PRs does not satisfy PR 5.

Use one set of production components and validated view models with separate live and fixture adapters. The fixture entry point is explicitly labeled and isolated from credentials, profile state, IPC mutations, and network operations; it is excluded from release entry points. Never ship the HTML prototype in an iframe, copy its fake apply operations into live handlers, or start a second execution owner. Release UI exposes only supported functionality and explains unavailable actions where useful. Unknown or stale state must never appear as zero, healthy, connected, or completed.

## 2. Locked composition

| Surface | Required result |
| --- | --- |
| Sidebar | One continuous neutral surface, including its top section. Official eye icon and EstaCoda identity at top; Settings icon alongside. Search and New chat directly below. |
| Primary navigation | Work, Inbox, Library, Connections, in that order. Models and Appearance live inside Settings; model selection is also reachable from the composer. |
| Work navigation | Pinned Work above workspace-grouped chats. Pin/unpin is available in context; selection is a restrained blue tint. No saturated blue sidebar block or green decorative selection accent. |
| Main surface | Neutral canvas, measured whitespace, readable conversation column. Active Work retains Activity / Changes / Results tabs, compact approval cards, collapsible routine tool activity, and inline file-change review. |
| Inspector | Collapsed by default. Details, target, and safety context reveal Plan / Execution / Usage without permanently crowding the conversation. |
| Composer | Attachment `+` on the left, safety context beside it, model control on the right, send control at the far right. Attachment chips are removable; long names fit without shifting actions out of view. |
| New chat | Official eye mark and blue ESTACODA wordmark with the approved proportions, restrained introductory copy, workspace context, and composer. This is a working empty state, not a marketing page. |
| Library | Artifacts and Skills & tools views. Artifact preview links back to its source Work. Capability visibility does not imply configuration or execution permission. |
| Connections | Quiet connection rows with expandable readiness and access scope. Telegram first in production. The Email sample does not expand alpha scope. |
| Bottom status strip | Runtime connection, active runs, needs-attention count, and scheduling access. Counts and health are projections with explicit disconnected/unknown states. Background work details open from here; Scheduled is not an additional primary navigation item. |

All controls shown in the approved fixture journeys must work locally in fixture mode. Unsupported live actions must not silently fall back to a demo. Extra backend features added later use this component vocabulary and hierarchy rather than introducing a separate visual language.

## 3. Tokens, geometry, and themes

Default: **Kemet + System appearance**, comfortable density, 224 px sidebar, collapsed inspector. Light, Dark, and System are independent of the Kemet, Graphite, and Sand theme families. Match the final effective values in the frozen source, not an earlier concept or the first CSS declaration encountered. Extract a single semantic token layer in React; do not reproduce the prototype's accumulated overrides.

The effective default Kemet palette is:

| Semantic token | Light | Dark |
| --- | --- | --- |
| Canvas | `#fcfcfa` | `#131313` |
| Panel | `#f1f2f0` | `#222222` |
| Inset | `#e9eceb` | `#1b1b1b` |
| Border | `#dcdedc` | `#373737` |
| Text | `#202422` | `#f2f2ed` |
| Secondary text | `#636a67` | `#b0b3ae` |
| Ocean accent | `#007fae` | `#35bdef` |
| Accent tint | `#dff2f8` | `#153d4b` |
| On accent | `#ffffff` | `#042a37` |
| Sidebar surface | `#efefef` | `#212121` |
| Sidebar text | `#292929` | `#ededed` |
| Sidebar secondary text | `#62676a` | `#b7bec2` |
| Sidebar blue mixer | `#077cac` | `#0878a7` |

Sidebar hover/inset, panel, and selected backgrounds mix that sidebar blue at 9%, 14%, and 23% respectively into the neutral sidebar surface in sRGB. These are small-area treatments. Ocean blue identifies brand, selection, and active execution; amber identifies attention, and semantic success/error colors remain valid inside outcomes. Keep the send button neutral as in the reference. Do not turn the entire interface into blue panels.

Reference geometry: 38 px title bar, 49 px main top line, 224 px sidebar, conversation maximum width 800 px with 32 px horizontal padding at wide sizes, 216 px inspector, 12 px default window radius, 15 px composer radius. Use the reference's remaining spacing and component radii. System UI typography, 14 px base, 23 px Work heading, 12 px code, and 11–13 px secondary labels establish the hierarchy. Normal and medium weights carry most of the interface.

At 850 px the inspector moves below Work; below 590 px navigation becomes compact. Verify 1024, 736, and 360 px product widths and a 320 px overflow check. Also verify a 1440 px desktop window. Narrow layouts are resilience checks, not a mobile-product commitment. Native Electron content must fit its viewport with deliberate scrolling; do not copy the fragment's content-driven height into a window and strand the composer below the fold.

Appearance changes apply immediately and preserve drafts, attachments, focus, selected Work, and inspector state. Persist appearance as local presentation preferences through a narrow Main-owned path; it grants no runtime authority. Generate theme preview cards from the same tokens as the real views so small differences in the prototype thumbnails do not become a second palette. Theme, density, and geometry tuning controls used during design are not automatically product settings.

## 4. Brand assets

Use the supplied [eye icon](desktop-design/assets/estacoda-icon.svg), with unchanged paths and proportions. The prototype's tighter display viewBox is `20 130 475 255`; the original vector retains `0 0 512 512`. Use the icon in the sidebar, assistant identity, and New chat. Never substitute a generic letter tile.

The [official wordmark reference](desktop-design/assets/estacoda-wordmark-reference.png) determines letterforms, tracking, and proportions. Apply ocean blue where the reference does. Do not retype ESTACODA in an approximate serif font. The embedded raster mask is sufficient to freeze the reference; a clean transparent or vector production asset, visually matched at 1× and 2× in both appearances, is a PR 5 asset-quality gate. An original wordmark vector has not been supplied. Do not label a traced/recreated asset as the official original.

Bundle production fonts/icons/brand assets under the app's CSP. CDN helpers in the inspection export and browser-host dependencies are not a production asset strategy.

## 5. Interaction and truthful state

- New chat creates a draft. Work selection, search, pinning, and theme changes preserve that draft and its attachments. Scope draft/pin state by profile and canonical Work identity; bind attachment capabilities to the correct target. Switching profile clears the previous profile's visible state and handles. Presentation preferences must not become a second Work database.
- The attachment picker must use a Main-owned, validated workflow in production. A renderer filename or path grants no read/upload authority. Unsupported attachment kinds and unreadable, removed, or stale files need explicit errors. The fixture's filename-only attachment behavior is not a completed upload implementation.
- Approval cards identify the action, profile, workspace/target, isolation, and scope. Approve once and Reject send canonical requests. A click or elapsed timer does not prove execution success. Cancellation remains requested until acknowledged, and partial/unverified results stay distinct from verified completion.
- Runtime strip counts derive from canonical projections. Waiting for approval is not an actively running command. Bridge connection alone does not prove supervisor/gateway health. Reconnect restores canonical state without replaying mutations or duplicating Work.
- Artifacts retain provenance; opening source Work respects profile/target scope. Skill and connection detail views communicate configuration and authorization accurately.
- Provider setup keeps the planned credential transaction, review, apply, and verification boundaries. Prototype sample models, fake credential controls, schedules, counts, timestamps, and sample completion claims are fixture data only.
- Keyboard access, named icon controls, Escape handling, dialog focus containment/restoration, reduced motion, readable contrast, zoom, and Arabic/mixed-direction text are production acceptance requirements. The prototype's Arabic specimen is not proof of full accessibility or RTL support.

Native title-bar controls, safe scrolling, accessibility repairs, and canonical status wording may differ where the reference is only illustrative. Record the concrete difference, reason, and comparison in the PR; do not hide a redesign under those exceptions. Composition, navigation, brand, palette, and major density changes need explicit product approval.

## 6. Visual delivery versus live delivery

Every row below has its approved visual fixture in PR 5. Live functionality follows the existing architecture sequence:

| Surface | Live delivery owner |
| --- | --- |
| Secure shell, profile bootstrap/recovery, runtime connection state, inspect existing Work | PR 5, consuming PRs 2–4; richer supervisor health only when advertised |
| Appearance preferences | PR 5; local presentation only |
| Models / provider setup / composer model selection | PR 6 |
| New Work, streaming, Inbox, approvals, cancellation, bounded Work search, pin references, attachment submission, active/attention counts | PR 7; include any missing narrow attachment/search contract extensions and their boundary tests |
| Connections / Telegram operations | PR 8; other channels only when separately implemented and advertised |
| Target creation/selection | PR 9 |
| Live files, Changes, diff, and terminal | PR 10 |
| Library artifact browse/preview/source links, Results evidence | PR 11 |
| Skills & tools, governed settings, memory and Evolution | PR 14 |
| Live schedules and background schedule detail | PR 15 |

PR 5's live application may therefore expose fewer enabled destinations than its complete fixture showcase. This is an explicit delivery distinction. Later PRs replace fixture inputs with live adapters, extend necessary states, and rerun the visual gate; they do not reimplement approved screens or delay matching their appearance until beta.

## 7. Acceptance and change control

PR 5 cannot close until the [acceptance matrix](desktop-design/acceptance-matrix.md) has evidence, the frozen source/assets match their [manifest](desktop-design/manifest.json), and deviations have been resolved or explicitly approved. Security tests and visual tests are independent gates; neither substitutes for the other.

Capture reference and React views under the same product viewport, OS/font stack, Chromium version, device scale, appearance, and deterministic state. Keep fixture clocks stable, animations disabled for captures, and assets loaded. Store the first reviewed screenshots and capture metadata with the desktop visual tests in PR 5. No golden screenshot suite is claimed to exist yet.

Review side-by-side images and overlays against version 1. No unexplained layout, brand, palette, or interaction differences may pass. Limit numeric diff tolerances to measured rendering noise; do not blanket-mask text, controls, approvals, or the composer. Baseline updates must include before/after evidence and a reason. Extend the same regression suite in PRs 6–15 as live integrations arrive.

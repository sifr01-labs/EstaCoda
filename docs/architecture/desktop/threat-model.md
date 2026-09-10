# Desktop threat model

Status: required design controls, Desktop PR 1. Electron and bridge mitigations are not implemented or security-certified in this PR. Existing core controls are identified separately.

## Assets and adversaries

Protect profile credentials, auth tokens, user files/transcripts, trust/grants, owner fences, control authentication, approvals, artifacts and install/service ownership. Assume model/tool output, messages, attachments, filenames, URLs and provider errors are attacker-controlled. Treat the ordinary renderer as compromised, not just buggy.

The local OS account is the operator trust boundary. This is not isolation against malware with that account's filesystem/process privileges, administrators or a compromised OS, and not a multi-tenant API. Never expose private IPC to the network or renderer. Host commands and worktrees are not OS sandboxes.

## Boundary and verification matrix

| ID | Attack / crossing | Required enforcement | Verification and delivery |
| --- | --- | --- | --- |
| D01 | Transcript/tool content obtains Node or filesystem access | Inert text/sanitized markup; Node disabled, context isolation and sandbox enabled; deny unexpected navigation/windows/permissions; production CSP and bundled assets | PR 5: malicious HTML, file/remote navigation, iframe, window-open, permission and preload-exposure tests |
| D02 | Renderer invokes generic IPC or claims another profile/window | Semantic methods only; Main validates sender/frame/window and bounded payload, derives profile/window context, rejects unknown/stale actions; bridge repeats validation | PRs 2–5: forged frames/windows, caller-supplied authority fields, malformed requests and post-switch handles |
| D03 | Approval ID becomes a grant | Owner validates current action/session/target/authority; approve-once never broadens scope; hardline remains non-overridable; channel controls route to ChannelGateway | PRs 4–7: forged, expired, duplicate and cross-profile/session approvals; hardline denial and revocation |
| D04 | Renderer reads credentials or discovery tokens | Dedicated local credential window and non-logged Main→bridge pipe; no secrets in generic preload/RPC, state stores, URLs, argv, logs or events | PRs 3/5/6/8: canary credentials across output/persistence, ordinary renderer access denied, sender-bound submission |
| D05 | Fake supervisor or duplicate host | Reuse private-control/singleton lifecycle: private profile files, symlink/ownership checks, instance authentication and compatible version; timeout is not owner death | Existing [private control](../../../src/gateway/private-control.ts); PRs 3/5: wrong token/profile/version, unsafe discovery, concurrent launch, stale live lock, reconnect; Windows gated |
| D06 | Lost response or late result duplicates side effects | Stable operation identity, canonical receipts and owner fences; reconcile uncertain outcomes | Existing [receipts](../../../src/gateway/control-receipts.ts); PRs 2–5/7: lost acknowledgement, same ID/different payload, expired receipt, stale result, bridge crash |
| D07 | Output flood blocks stop/deny or exhausts memory | Bound frames, payloads, subscriptions, queues and replay buffers; controls bypass normal prompt queue; overflow forces snapshot/resync | PRs 2–4/7: saturation with responsive cancel/reject; stream restart and cursor gaps |
| D08 | File/attachment/PTY escapes target or survives profile change | Main-owned picker, scoped opaque handles, core target generation/lease verification, bounded reads and symlink checks; separately owned human PTYs | PRs 7/9/10: traversal, changed root/symlink, stale generation, forged picker handle, oversize input and revoked PTY |
| D09 | Provider verification leaks a key or incurs unexpected spend | Candidate bound to reviewed provider/auth/endpoint; redact errors; URL/private-network and explicit local-provider policy; bounded verification budgets and visible cost implications | PR 6: endpoint substitution, redirect, metadata URL, no-auth route, timeout/cancel, provider-controlled errors and cost limits |
| D10 | OAuth writes early or targets another profile | Service owns flow/state/expiry; Main validates verification URL before external open; tokens staged until reviewed apply | PR 6: wrong flow, expiry/replay, cancellation, profile switch, unexpected URL and persistence before Apply |
| D11 | Unauthorized Telegram sender controls Work | ChannelGateway authenticates/scopes allowlist, pairing and session before dispatch; no adapter writes to approval queue/grants | PR 8: unauthorized chat, forged/replayed handoff, wrong profile/session, stop/deny during approval wait |
| D12 | Setup silently installs a daemon or sends a message | Setup, service lifecycle and outbound test are separate explicit actions under current authority; Work start does not enable channels | PR 8: cancellation/blocked setup has no writes/messages; distinct install/start/test; preserve service ownership |
| D13 | Browser view bypasses URL/cloud policy or acquires control | Core URL policy and safe snapshots; no raw CDP/preload; view-only until fenced human-control lease; cloud spend remains gated | PRs 12/13: metadata/private URL, secret fields, unleased/stale input and concurrent control |
| D14 | Artifact/Evolution content becomes authority | Bounded inert preview with provenance; no executable auto-open; reuse integrity/retention and governed promotion | PRs 11/14: wrong source/profile, poisoned content, missing/tampered artifact and rejected promotion |
| D15 | Packaged app launches arbitrary binary or breaks CLI | Resolve owned compatible runtime assets in Main; no renderer executable selector; preserve signing and native-module ABI; independent CLI packaging | PRs 5/16: relocation, spaces/Unicode, installed CLI coexistence, compatible binary and quit/relaunch |
| D16 | Demo code impersonates healthy runtime | Isolated fixture entry point excluded from release; no real credentials/service access; unavailable live state never falls back to demo success | PR 5: fixture isolation and release-entry checks; visual tests are not live security tests |

## Authority routing

Main authenticates the window and reduces requests to allowed operations; it does not manufacture grants. The bridge binds profile/client context and uses core services. The supervisor remains the shared executor owner. Channel approvals and continuation stay in ChannelGateway; local Task/Session controls use their existing owner paths. Database rows, subscriptions, method visibility and model catalogs are not authorization boundaries.

Human terminal/browser actions remain powerful renderer capabilities even when labeled manual. They need sender checks, scoped resources and explicit acquisition; an agent cannot bypass approval by asking the renderer to impersonate a human action.

## Projection and diagnostic policy

Use explicit safe projection schemas, not generic recursive redaction of raw runtime objects. Do not forward tool/provider bodies or channel payloads wholesale. Secret-looking text can occur in ordinary output, so both safe sourcing and bounded/redacted presentation are required. Diagnostic export is explicit and scoped; omit credentials, transcript content and unnecessary private paths. Errors are bounded operator guidance, not object/stack dumps.

Candidate IDs are sensitive capabilities: bind them to profile, purpose, window and lifetime; exclude them from ordinary diagnostic logs. Persist no secret-derived hashes or token prefixes. The dedicated credential renderer can observe text typed into it; its compromise and OS-account compromise remain limits. Separate windows reduce exposure, not guarantee memory secrecy.

## Review gate

Each implementing PR cites relevant D-cases, actual tests and limitations. Mock UI tests and open approval mode do not waive controls. Review security independently from the [visual gate](../../planning/desktop-design/acceptance-matrix.md).

PR 1 risk: architectural wording can overstate protections that do not yet exist. This document separates proposed enforcement from existing anchors; it changes no policy or credential store.

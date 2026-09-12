# Desktop PR8 — Connections and Telegram

Branch: `ame/desktop-foundation`. Fifteen planned commits; implementation in progress.

## 1. Channel readiness and gateway liveness

Added selected-profile Telegram metadata through the existing Connections protocol.
Configuration, token presence, authorization, authenticated gateway liveness and
fresh owner-matched adapter observations are separate. Expired pairing is denied;
raw tokens, pairing codes and adapter error text never enter projections. Email and
other channels are not advertised as implemented. Verification remains unknown
until an explicit check is performed.

Validation: focused connection/profile and protocol tests; Desktop foundation and
core typechecks. Review confirmed read-only behavior and no capability grants.

## 2. Reviewed Telegram setup

Added bounded, window-bound Telegram drafts and selected-profile Apply/cancel/
receipt inspection. The token remains a candidate until the existing recoverable
profile transaction commits. Setup requires an allowlist or explicitly reviewed
short-lived pairing, defaults to protected handoff and queued streaming behavior,
and requires acknowledgement for direct-DM secret capture. Applying new access
settings clears old pairing authority. Persisted verification is read-only.

Validation: setup, transaction, executor and protocol regressions (122 tests), plus
core/Desktop typechecks. Review checked profile staging, expiry/cancellation,
existing credential references and unchanged CLI allowlist requirements.

## 3. Candidate verification

Added an explicit fixed-endpoint `getMe` verifier with an eight-second deadline,
64 KiB response bound, four-request concurrency limit, denied redirects, candidate
scope checks and window/disposal cancellation. Results contain only bounded bot
identity, status, latency and verification time. A failed recheck clears prior
candidate acceptance; enabling a newly staged token requires successful verification.
No polling, message delivery, profile write, transcript or memory entry occurs.

Validation: candidate cancellation, endpoint/error redaction, oversized-response,
reviewed-Apply and protocol tests, plus core/Desktop typechecks. Network tests use
synthetic responses and do not access a Telegram account.

## Step 4 — Gateway lifecycle and diagnostics

Added selected-profile gateway lifecycle controls through the existing service manager,
with durable reference-only operation receipts and redacted status diagnostics. Installation
uses the backend's runtime package location. Existing service installation also starts the
service; Desktop must label that action **Install and start**. Stop/restart explicitly
acknowledge their effect on shared Work. No service actions run during inspection or Apply.
Repeated operation IDs reconcile without redispatch, including after bridge restart;
exceptions remain uncertain. Configuration Apply now notifies the authenticated gateway.

Validation: focused lifecycle replay/concurrency/profile tests and protocol conformance;
core and desktop type checks. Risk: lifecycle actions affect all shared Work in the profile.

## Step 5 — Pairing, command sync and delivery tests

Added explicit one-use pairing creation/cancellation using the shared core configuration
path, and bounded command synchronization using the gateway command registry. Delivery
tests accept only a selected-profile allowlisted user/chat ID and fixed test text. Network
responses and errors are redacted; timeout/lost-response receipts remain uncertain and
are not resent. Pairing codes are available only through an explicit operator read.
Tests use a synthetic Telegram transport; no real account receives messages.

Validation: authorization, profile isolation, pairing cancellation and no-replay tests,
protocol conformance and core/Desktop type checks.

## Step 6 — Canonical channel sessions and handoff

Telegram conversation rows reference existing canonical Work; no transcript is copied.
Session-scoped handoff inspection, short-lived code creation/revocation and conditional
attachment removal use the shared core stores. Creation validates profile, target and
workspace trust; redemption still runs ChannelGateway's existing owner checks. A code
never transfers a live foreground CLI/editor runtime. Detach changes access only and
preserves canonical Work. Explicit code reads stay out of ordinary connection projections.

Validation: cross-profile projection/lookup, revoke/detach preservation, untrusted creation,
shared pointer tests, protocol conformance and core/Desktop type checks.

## Step 7 — Live Connections dashboard

Connected production Telegram rows to negotiated, selected-profile metadata through a
narrow Main/preload API. Configuration, authorization, gateway and polling remain separate.
Loading/disconnected states clear previous data; the Email row remains fixture-only.
The approved neutral surfaces and existing row/detail classes are retained.

Validation: Desktop foundation/boundary check and all 44 desktop unit tests passed.

## Step 8 — Bot and authorization setup

Added Main-owned Telegram setup identities and the existing private credential window.
The normal renderer receives only stage/verification metadata. Setup offers BotFather
guidance, bounded allowlists or pairing, protected-handoff defaults, streaming/poll controls,
and an explicit warning/acknowledgement for direct-DM secret entry. Profile changes,
window invalidation and cancellation dispose staged credentials. Modal keyboard focus
is contained and restored to its invoking control.

Validation: Desktop foundation/boundary check and desktop unit suite.

## Step 9 — Review, Apply and recovery

Connected the redacted review to the shared transactional profile Apply path. Enabling a
new token requires successful candidate verification. Applied configuration, gateway state
and bot verification are labelled separately. A profile-local Telegram operation reference
supports save inspection after restart without mistaking a provider save for Telegram.
Cancellation after the durable Apply boundary directs the user to inspect the outcome.

Validation: Desktop foundation/unit suite, Telegram transaction tests and core type check.

## Step 10 — Gateway status and controls

Added explicit review/confirmation for install-and-start, start, stop and restart, with
redacted diagnostics and operation inspection. Main creates and persists the latest
profile-scoped operation reference before dispatch. An uncertain operation cannot be
silently repeated under a new identity for the same action. The UI explains that gateway
lifecycle affects shared Work and is independent of the Desktop window.

Validation: Desktop foundation/boundary check and desktop unit suite.

## Step 11 — Telegram operations and Work handoff

Added reviewed pairing, command-menu sync, authorized delivery testing, canonical
conversation navigation and Work-scoped handoff create/inspect/revoke/detach controls.
Main resolves Work references to canonical selected-profile Sessions and creates operation
IDs. The renderer cannot supply credentials, raw commands, filesystem paths or execution
ownership. Profile switching remounts Connections to clear prior-profile details immediately.

Validation: Desktop foundation/boundary check and desktop unit suite. External delivery
remains an explicit operator action; automated checks use synthetic transports.

## Step 12 — Credential and profile boundary coverage

Added regression coverage for cancellation byte preservation, unverified/foreign-window
candidates, redacted projections, uncertain action recovery across app restart, and profile
isolation. Completed reviewed disconnect choices: disable keeps setup; removal preserves
other channels; deleting the current credential is separately selected and refuses a key
shared by another route. Saved bot verification records only a timestamp/reference and
file identity; credential changes invalidate the displayed verification.

Validation: focused credential/profile tests, Desktop unit suite, core/Desktop type checks.
Risk review: no token enters ordinary IPC/events or operation receipts; no service starts
or messages send during setup Apply. Deletion does not revoke the token at Telegram.

## Step 13 — Authorization, pairing, approvals and restart coverage

Regression tests found and fixed core pairing gaps: redemption now explicitly uses the
gateway profile, fails closed at/after expiry, and removes the code after the merged config
is built. Concurrent/restarted redemption succeeds once. Telegram authorization and secure
input policy are read for each newly received message; disabling denies prior identities
and pairing immediately. Adapter transport changes still require an explicit restart.
The UI now gives the actual pairing instruction: send the code itself, without a command.

Added read-only profile-scoped queued/uncertain turn counts and bounded recent delivery
failure counts. Diagnostics return counts only, never message bodies or raw errors.
Validation includes the existing ChannelGateway, canonical Desktop approval, configuration,
attachment and new pairing/restart tests, plus protocol and core/Desktop type checks.

## Step 14 — Desktop setup and operation journeys

Added Main scope/cancellation tests, hostile semantic payload tests, and browser journeys
for review, multiple allowlist IDs, candidate verification, uncertain Apply inspection,
explicit gateway/delivery/handoff confirmation, disconnection and narrow layouts. Browser
review fixed focus after the form-to-review transition and preserved commas while typing
multiple IDs. Setup initialization is safe under React effect replay. Review displays exact
authorized IDs and response defaults; new controls use existing neutral/ocean theme tokens.
The native integration test now exercises Telegram capability negotiation and private fd3
token staging/cancellation through real Main, preload and bridge without any network call.

Validation passed: 48 Desktop unit tests; all 137 browser/visual cases, with final
Telegram and Connections reference reruns; native Electron credential/approval/restart
integration; packaged contents/CSP/fuses/icon/relocation checks; and real Session/Task
execution across application restart without replay. The required host/Docker release
wrapper passed all 10,896 core tests, smoke/build/import/ESM/distribution checks, execution
budgets, source/distribution Docker conformance and Docker image validation. One initial
existing Bun/SQLite compatibility test timed out under concurrent load; its isolated
rerun and the complete release rerun passed. No test contacted a real Telegram account.

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

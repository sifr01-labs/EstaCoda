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

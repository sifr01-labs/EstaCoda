# Desktop Connections

Connections separates profile-owned messaging channels, chat-specific tool connectors, and the background gateway. It uses the same capability cards and progressively disclosed controls as Models & providers and media settings.

Telegram distinguishes absent configuration from an intentionally disabled channel. A configured channel is labeled Connected only when the gateway is running and fresh polling evidence is healthy. Bot verification, allowlists, pairing, protected credentials, and review/apply retain their existing controls. No setup action sends a message without its separate explicit action.

Connector inspection remains bound to the selected chat. Manage reveals the existing chat-wide reconnect action; it does not imply individual connector reconnection. Status reasons are bounded categories, never raw connector errors, commands, or credentials. Disabled connectors remain distinct from unavailable connectors.

The gateway checks service/runtime metadata on entry and exposes one state-dependent lifecycle action in Manage. Restart and operation inspection are in Advanced & diagnostics. Install/start/stop/restart still require explicit review, and the interface reconciles the last durable operation before mutation. Unknown or uncertain outcomes block another lifecycle action; status checks do not repeat commands. Closing Desktop does not stop the gateway.

Security note: these are presentation and read-only metadata changes over the existing profile-bound, reviewed setup and lifecycle paths. They do not broaden messaging authorization, install authority, workspace trust, private-site access, or cloud-spend permission. Installation metadata does not prove a user service's current auto-start configuration, so the interface makes no auto-start claim.

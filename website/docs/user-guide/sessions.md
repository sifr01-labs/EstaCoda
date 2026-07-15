---
title: Sessions
description: Session lifecycle, state ownership, attach/detach, and handoff for v0.1.0.
sidebar_position: 2
---

# Sessions

A session is a bounded conversation context. It owns the message history, the selected profile, model route state, session-scoped approvals, and any active surface pointers. Sessions are not global context blobs; they are isolated per profile and must be attached explicitly if you want channels to share them.

This page explains what a session owns, how to move between sessions, and what goes wrong when sessions drift.

---

## What a Session Owns

| State | Owner | Notes |
|---|---|---|
| Conversation history | Session | Stored in the session DB under the active profile |
| Selected profile | Session | The profile active when the session was created |
| Model route override | Session | Set via `/model <provider>/<model>` |
| Session-scoped approvals | Session | Granted with `session` scope expire when the session ends |
| Surface pointers | Session | Links from channels (Telegram, Discord, etc.) to this session |

Sessions do not own persistent memory files. `USER.md`, `MEMORY.md`, and `SOUL.md` belong to the profile. Sessions do not own workspace trust or cron state. Those are also profile-scoped.

---

## Session Isolation

Sessions are separate by default. A CLI session and a Telegram session for the same user do not share context automatically. If you want a Telegram chat to continue a CLI session, you must attach it explicitly.

Profile isolation is strict. A session created under profile `work` cannot see sessions created under profile `personal`, even if both are on the same machine. Sessions share the global `sessions.sqlite` file, but every access is scoped by `profile_id`.

---

## Session Commands

```bash
# List recent sessions with attached surfaces
estacoda sessions list

# Show session detail and surface pointers
estacoda sessions show <session-id>

# Current runtime session
estacoda sessions current

# Attach a surface to a session
estacoda sessions attach <surface> <id> <session-id>

# Detach a surface from a session
estacoda sessions detach <surface> <id>

# Summarize historical session matches
estacoda sessions recall <query>

# Compact session history manually
estacoda sessions compact <session-id> [--topic <topic>]
```

Valid surfaces: `cli`, `telegram`, `discord`, `whatsapp`, `email`.

`sessions recall` is bounded historical recall. It is profile-scoped and workspace-scoped when workspace metadata is available. Recalled content is labeled as untrusted context and cannot override current instructions.

`sessions compact` is semantic session compression. It compacts older history for the target session. It is non-rotating in this implementation; it does not create or adopt a compacted child session. Gateway `/compact` has separate rotation logic.

---

## Interactive Session Controls

Inside an active CLI session:

| Command | Purpose |
|---------|---------|
| `/sessions` | List active sessions |
| `/switch <session-id>` | Switch to another session |
| `/new` | Start a fresh session |
| `/reset` | Start a fresh session |

Gateway channels support a subset of session commands:

| Command | Purpose |
|---------|---------|
| `/sessions` | List recent sessions |
| `/switch <session-id>` | Switch to a different session |
| `/attach <code>` | Attach to a CLI session via handoff code |
| `/detach` | Detach from current session and create a new one |
| `/new` | Create a new session |
| `/reset` | Reset current session |

`/attach <code>` uses a short-lived, single-use handoff code generated in the CLI. The code is Crockford base-32, 6 characters, TTL 10 minutes. Failed redemption returns a generic message; no session ID is leaked.

`/detach` creates a new independent session for that surface. It does not merge histories or messages.

## Background Finalization

Starting a new session should feel immediate. For CLI `/new` and `/reset`, EstaCoda creates the fresh runtime first, then durably queues the old session for memory curation. `/exit`, idle `Ctrl+C`, authorized channel `/new` or `/reset`, and successful one-shot prompts use the same queue. Active-turn `Ctrl+C` only cancels the current turn and does not finalize the session.

The user waits only for the queue row to be committed, not for extraction or memory writes. A failed enqueue prints one bounded warning but does not delay the new session or exit. A managed gateway service for the selected profile processes the job in the background; first-run setup offers this service even when no channel is configured. If the service is not running, the job remains in global `~/.estacoda/sessions.sqlite` until the gateway runs again.

Finalization captures an immutable last-message cutoff and uses the workspace recorded on the originating session. It cannot include messages later appended to a resumed session or inherit another workspace from the gateway service, and its queue metadata does not duplicate transcript content. Check `estacoda memory status` or `estacoda gateway status` for counts; use `estacoda memory finalization list`, `retry`, and `prune` for local operator recovery.

---

## State and Files

Session persistence is global but profile-scoped:

```
~/.estacoda/
  sessions.sqlite      # SQLite sessions, messages, events, and finalization queue
  cli-sessions.json    # Active CLI session pointers keyed by workspace
```

The session DB is SQLite. Session and finalization rows carry `profile_id` scope; the global location does not permit cross-profile reads. It stores messages, events, compression state, and durable background-finalization metadata. Surface pointers remain in profile-local gateway state. If the session DB is missing or corrupted, sessions cannot be listed, recalled, or resumed.

---

## Failure Modes

**Stale session:** A session resumed from `cli-sessions.json` may reference an old profile or workspace. If the profile has changed, the session may load with stale context. Use `/reset` or `estacoda sessions current` to inspect.

**Wrong profile:** Sessions are profile-scoped. If you switch profiles with `estacoda profile use <name>`, existing sessions from the previous profile are no longer visible. They are not deleted; they belong to the other profile.

**Missing session:** If a session ID does not exist in the current profile's session DB, commands return `session not found`. Check `estacoda sessions list` and verify the active profile.

**Session DB issues:** If `sessions.sqlite` is corrupted or locked, session commands fail. The CLI may fall back to an in-memory session. In that case, persistence, recall, attach/detach, and queued finalization are unavailable. Restart the CLI and check file permissions.

**Attach/detach mismatch:** Attaching a surface to a session does not merge histories. It only means future messages from that surface go to that session. If you expected merged context, you will not get it.

---

## Inspection and Recovery

```bash
# Verify the active profile
estacoda profile show

# List sessions for this profile
estacoda sessions list

# Inspect current session
estacoda sessions current

# Switch to a known good session
/switch <session-id>

# Start fresh if context is corrupted
/reset
```

---

## Related

- [CLI](./cli.md) — interactive session loop and slash commands
- [Profiles](./profiles.md) — profile boundaries and switching
- [Memory](./memory.md) — persistent memory files vs. session context
- [Channels](./channels.md) — channel configuration and surface pointers

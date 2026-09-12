# Desktop Connections and Telegram

Status: Desktop PR8 is implemented on `ame/desktop-foundation`. Telegram is the
production Connections surface. Email remains an isolated design fixture; the desktop
does not advertise it as a working integration.

## Set up a bot

1. Select the intended profile, open **Connections**, expand **Telegram**, then choose
   **Configure Telegram**. The dialog names the selected profile.
2. Create a bot through Telegram’s verified **@BotFather** using `/newbot`.
3. Choose **Add or rotate bot token**. Enter the value in the separate private credential
   window. Normal Desktop content receives only an opaque staging result.
4. Choose **Verify bot**. A newly staged token must pass verification before an enabled
   configuration can be applied. This calls Telegram `getMe`; it does not start polling
   or send a chat message. To verify an already saved token, open configuration and use
   **Verify bot** without staging another token, then close the dialog.
5. Choose **Enable** and configure an allowlist, or explicitly choose one-use pairing.
   Enter numeric user/chat IDs separated by commas. A chat allowlist entry authorizes
   that chat’s participants; an allowed user can be authorized independently of the
   chat allowlist. No open-access mode is offered.
6. Review the exact identities, credential state, secure-input mode and response defaults.
   Choose **Apply Telegram changes** to commit the selected profile transaction.
7. If needed, separately review **Install and start** or **Start gateway**. Existing core
   installation starts the user service, which is why Desktop labels both effects.
8. Inspect gateway/polling state. An optional **Send test message** sends one fixed message
   to an already allowlisted destination. The user must first have contacted the bot for
   Telegram to permit a private reply.

Defaults are protected-handoff secret input, streamed responses, and queued busy messages.
Existing group/thread, attachment and debounce settings are preserved. Advanced setup
exposes streaming and poll timeout. Direct-DM secret input requires acknowledgement that
Telegram receives the value before EstaCoda can attempt deletion; deletion is best effort.

Closing or cancelling before Apply discards staged credentials and writes no token or
configuration. Once a profile transaction is durably authorized, cancellation cannot
promise that nothing was saved. Use **Inspect last Telegram save** after a lost reply.

## Read state accurately

| Display | Meaning |
| --- | --- |
| Configuration | Disabled, missing credential, missing authorization, pairing pending, ready, or repair required |
| Authorization | Selected-profile allowlist or unexpired pairing; never execution permission |
| Gateway | Authenticated existing supervisor liveness, separately from OS service installation |
| Polling | Fresh adapter observation matched to the gateway owner; unavailable/stale evidence stays unknown |
| Last saved-bot verification | Explicit saved-token verification time; changes to the credential file invalidate it |
| Queued or claimed / uncertain turns | Canonical, profile-scoped Telegram turn counts; unavailable storage stays unavailable |
| Recent delivery failures | Telegram failures in the last 100 bounded log records within 24 hours; no raw error text |

A configured bot is not proof of a running gateway. A successful `getMe` is not proof of
message delivery. A lifecycle command receipt is not proof of completed Work.

Authorization and secure-input policy are read for newly received Telegram messages.
Disabling/removing Telegram denies new input without waiting for restart. Previously
accepted Work retains its canonical lifecycle. Restart explicitly after changing the
bot token, streaming or polling settings, or adding the adapter to an existing gateway.
Stopping/restarting the gateway affects shared Work in the profile, including work that
was not started from Desktop. Closing Desktop does not stop that gateway.

## Pairing and canonical Work

**Create pairing code** creates a one-use code valid for ten minutes. Share it only with
the intended operator. Send the code itself to the bot; do not prefix it with `/pair`.
Redemption adds that Telegram user and chat to the selected gateway profile’s allowlist.
Consumption is serialized, removes the code, and fails closed at expiry. **Cancel pairing**
removes the pending code; it does not revoke identities already added to the allowlist.
Edit the allowlist through reviewed configuration to remove those identities.

After authorization, select an established trusted workspace in Telegram with
`/workspace list` and `/workspace use <alias>`. Dedicated desktop target management is
PR9. Telegram conversations appear under **Load conversations** and open their existing
canonical Work. Tasks, activity, usage and approvals use the same Work/Inbox surfaces;
there is no desktop-owned Telegram transcript.

For an existing Session, select it under **Work for handoff**, then review **Create handoff**.
Send `/attach <code>` to the bot before expiry. Codes are profile/session scoped and
one-use. **Inspect handoff** shows active codes and attached conversations. **Revoke unused
codes** prevents future redemption; **Detach** conditionally removes the selected surface
pointer without deleting Work or other attachments.

A surface attachment does not transfer execution ownership. A live foreground CLI/editor
owner must finish and release its runtime before shared continuation can be accepted.
The gateway revalidates profile, trusted workspace, target and owner at redemption.

Telegram approval buttons and Desktop Inbox cards resolve the same durable approval
through `ChannelGateway`. Approving a decision never broadens the allowlist, workspace
trust, target scope or non-overridable command floor.

## Change or disconnect

- **Disable, keep configuration** preserves the bot credential and access settings.
- **Remove Telegram configuration** removes this channel’s configuration while retaining
  other channels. Credential deletion is an additional explicit checkbox shown in review.
- Deletion clears the currently configured credential from this profile and refuses to
  delete a key referenced by another route. It does not revoke a token at Telegram or
  promise removal of historical, unreferenced credentials. Use BotFather for revocation.
- Rotation uses private staging, verification and reviewed Apply; restart the adapter
  explicitly to use the new token.
- **Sync commands** explicitly updates the bot menu from the existing gateway command
  registry. **Send test message** requires confirmation and an allowlisted destination.

## Recovery and boundaries

**Diagnose gateway** and **Inspect last connection operation** are read-only. Main creates
operation IDs and stores reference metadata before dispatch. The bridge retains bounded,
profile-local receipts before external effects. Reusing an ID inspects the outcome rather
than repeating the action, including after process restart. Interrupted effects remain
uncertain; Desktop never guesses success or silently resends a message.

Same-action retries remain blocked while the latest referenced receipt is uncertain or
unknown. Inspect the real state first. For unresolved lifecycle recovery, existing CLI
controls remain available with the same explicit profile, for example:

```bash
estacoda --profile <id> gateway status
estacoda --profile <id> gateway diagnose
```

Service repair/reinstallation continues to use the existing governed CLI lifecycle paths;
Desktop does not expose force installation. The operator receipt store is bounded to 1,000
records and fails closed if full. Inspection history does not grant execution authority.

Candidate verification uses a fixed Telegram endpoint, an eight-second deadline, a 64 KiB
response bound and at most four in-flight requests. Redirects and raw error propagation
are denied. The desktop bridge does not put tokens, candidate values, pairing codes or handoff codes
into ordinary Work events or connection summaries. Codes are returned only by explicit operator reads.
Profile changes invalidate setup identities and clear displayed connection details.

## Validation and remaining live check

PR8 passed the required host/Docker release wrapper, all 10,896 core tests, 48 Desktop
unit tests, all 137 browser/visual checks, native Electron credential/approval/restart
integration, package/CSP/fuse/icon/relocation checks, and real Session/Task execution across
application restart without replay. The approved design references were unchanged.

Telegram HTTP tests used synthetic responses. Native credential tests used a synthetic
token and cancelled it without saving. No real Telegram account was contacted or messaged.
Before deployment, an operator should use an authorized bot to confirm `getMe`, allowlist
or pairing, one test delivery, workspace selection, approval resolution, and handoff after
a gateway restart. This remains a live-account acceptance check, not a claim established
by fixture screenshots.

See the [PR8 implementation record](../../planning/desktop-pr8.md),
[Desktop Work guide](work.md), [credential transaction contract](credential-transactions.md),
and [shared ownership decisions](../../planning/workspace-execution-ownership-decisions.md).

# Desktop workspace and conversation controls

The desktop uses a shared window toolbar, a collapsible navigation sidebar, and a compact runtime status strip. Kemet light mode uses a white working canvas and neutral navigation surfaces. Nonzero running, approval, and scheduled counts link to their associated views. Unknown counts remain unavailable, rather than appearing as zero.

The sidebar toggle and `Cmd/Ctrl+Shift+B` show or hide navigation. The divider supports pointer resizing and arrow keys; Home/End choose the minimum/maximum width. Width and visibility are presentation preferences on this device. In narrow windows, selecting a destination closes the navigation overlay. Settings breadcrumbs return to Settings. Voice, Vision & Images, and Browser & Search expose grouped controls; additional options and diagnostics remain available. Runtime/configuration edits continue through review and apply, and cancelling discards staged credentials.

## Messages

Copy and timestamps appear beneath messages on hover or keyboard focus. Reduced motion disables the Working shimmer. The microphone remains an explicit recording action beside the send controls.

While a conversation runs, Enter queues one follow-up in the desktop. The queued message can be edited, removed, or sent immediately. **Send now interrupts the current turn and starts a new turn with the follow-up after the old turn has settled. It does not inject text into an in-flight provider request.** The same host serializes both turns; trust, target generation, approval policy, and execution ownership are validated again.

A queued follow-up sends after the previous send receipt confirms completion while that conversation is open. Stop preserves it as a saved follow-up. Navigating away pauses desktop dispatch; queued text is included in existing profile-local draft persistence. Reopening the app restores it as an unsent draft, without attachments or permission overrides. Background Tasks retain their separate safe-boundary guidance action.

Each submission has a distinct draft identity. Main stores operation references for both new and existing conversations. If an acknowledgment is lost, Main inspects that same operation. Check status is read-only and does not create a new send. Uncertain or unknown receipts preserve the draft and block a second send. This does not assert that an accepted operation has completed successfully.

## Conversation permissions

The composer offers Profile default, Strict, Adaptive, and Open. Open requires an explicit selection and review in the permissions popover. The choice is kept in this window's conversation draft and applied to subsequent messages here; it is not persisted as a profile configuration or restored after restarting the app. Running work keeps its current mode. Background Task authority is unchanged.

The host applies the requested mode at the next turn boundary and restores the prior runtime mode during cleanup. Open retains the command hardline floor, workspace trust, spending limits, and other execution policy. Conversation controls are capability-negotiated: older hosts that cannot enforce them must be restarted and cannot silently ignore the requested options.

## Review risk

The sensitive changes are optional, validated send parameters for interruption and per-turn security mode, and recovery references keyed by submission identity. Neither parameter authorizes a different profile, target generation, Session owner, or background Task. Interruption requests cancellation; it never claims to reverse completed tool effects or to have killed an external process. UI polish does not change configuration apply, protected credential entry, remote authorization, or download/install gates.

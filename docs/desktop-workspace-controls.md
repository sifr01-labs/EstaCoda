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

## Details panel

Details opens Overview, with workspace, runtime, model, profile approval mode,
any conversation override for the next message, reported usage, and chat-scoped
connector status. Manage connections reveals the existing reconnect action;
connector problems expose it directly. The composer no longer has a floating
Connectors button. `/reload-mcp` still invokes the same scoped reconnect action
and opens Overview without sending the command to a model.

Plan shows the latest loaded recorded plan, its completed-step count, and
expandable step titles. A recorded running step is labelled “Last recorded: in
progress” unless the Work itself is running. This is presentation only; it does
not rewrite the stored plan or infer completion from an ended turn.

Activity contains execution receipt inspection and recovery controls plus the
copyable Work ID. Full tool history remains in Conversation. Unknown or
unavailable receipt state remains explicit; switching tabs never retries work.

The panel keeps its header and keyboard-navigable tabs visible while its content
scrolls independently. Its width defaults to 340 px and can be resized from 320
to 440 px with the divider or arrow/Home/End keys. Width is a device presentation
preference. Narrow windows use an overlay. Close or Escape dismisses the panel
and restores focus to Details. Each newly opened panel starts on Overview.

### Navigation and activity polish

The sidebar collapse button sits beside Settings on the brand row. When closed, a persistent Show sidebar button remains beside the window controls, outside the toolbar drag region. Two-line entries use compact padding and a quiet selection background. The default profile is displayed as **Default**; its stored identifier and permission policy do not change. The footer identifies this local desktop host, with platform-specific wording.

Activity separates **Current status** (the canonical Work projection) from **Latest request** (the recorded control operation). A completed request does not imply completed Work. Stop acknowledgments remain distinct from confirmed cancellation; when Work has ended, its final outcome remains authoritative. Technical identifiers are disclosed below these summaries. Status refresh is read-only; this change adds no execution authority or automatic retries.

Context menus use a translucent, blurred surface and theme-accent highlights for hover and keyboard focus, with an opaque reduced-transparency fallback. Scrollbars use lighter neutral thumbs, and working text uses a restrained theme-accent shimmer with a static reduced-motion fallback.

## Work, Inbox, and Library

Work groups loaded conversations and Tasks by date. Status filters, text search,
and workspace selection apply to loaded results; Load more remains available
when further pages exist. Counts beside filters describe that same loaded set.
Inbox uses the source Work title when available and keeps the actual question,
approval summary, or issue underneath. Respond, Review approval, and View issue
open the existing scoped review flow; they do not approve or retry anything.

Library artifacts display their source, format, size, and date. Identically named
outputs remain separate records. Preview and source navigation retain profile
and integrity checks. Skills use the shared collection layout with searchable
loaded entries and expandable instructions. Memory presents USER.md, SOUL.md,
and MEMORY.md as read-only Preferences, Personality, and Project knowledge.
Rendered Markdown blocks HTML, remote images, and automatic link navigation;
View source preserves access to the original text. Evidence and Agent Evolution
continue to show the existing proposal records and review controls.

## Files, Terminal, and Browser panels

Workspace tools open beside the conversation. Their shared header supports
expansion and closing; the divider supports pointer and keyboard resizing.
Narrow windows show the selected panel across the work area. Escape closes the
focused panel. Files show workspace-relative breadcrumbs and read-only previews;
protected paths, symlinks, and disconnected state retain their existing gates.

Terminal starts only through Open terminal and the existing native confirmation.
Switching to another tool panel keeps that terminal mounted; its toolbar action
indicates that it remains open. Closing Terminal, leaving Work, or changing its
target releases the terminal through the existing scoped shutdown path. Output
is ephemeral and does not become saved conversation content.

Browser separates current sanitized observations from recorded views. Watching
never grants control. Take control and Return to agent keep the existing runtime
lease, protected-entry, profile, target, and URL checks. Closing or switching away
from browser control abandons its lease without resuming agent browser actions;
return control explicitly when finished. Disconnection clears observations.

These changes are renderer presentation and navigation only. No new permission,
execution, browser navigation, memory mutation, or approval API is introduced.

# Desktop first chat

The prompt is editable before a workspace is selected. Enter sends; Shift+Enter inserts a newline. Input-method composition and held Enter keys do not submit. Text remains a local draft; sending and adding attachments require a current trusted execution target.

Choose **Choose a workspace** above the composer to search registered, trusted workspaces. **Add folder…** opens the native folder chooser. The app then asks for a workspace name and explicit trust, shows the canonical folder in a review, and registers it only after **Trust and use workspace**. Registration uses the existing setup operation; it does not merge project configuration into the profile. Local host execution is not sandboxed, and the profile's approval policy remains in force.

A lost save response exposes **Check workspace**, which reads saved state without repeating the mutation. Selection requires a launch-ready target whose inspected working directory matches the reviewed folder. Changing targets clears attachments scoped to the old target and preserves text. Re-selecting the same target preserves attachments.

New Work defaults to a conversation. **Chat options → Run in background** requests a supervised Task and exposes its existing limits and authority review. No automatic conversion into a Task or expansion of execution authority occurs.

Unattached local drafts appear under **Drafts**. Historical Work with no target appears under **Previous conversations**. Existing history remains readable; the app explains that a new chat with a selected workspace is required for further execution. It does not silently attach old history to a folder.

The live welcome screen uses the official icon and wordmark with a bounded wordmark width and tighter spacing. CSS trims the wordmark's transparent display padding; the source artwork is unchanged. New controls and messages support English and Arabic.

## Validation and trust boundaries

`workspace-composer.spec.ts` covers editable drafts, gated sending and attachments, explicit trust review, cancellation, late results after profile changes, uncertain outcomes, canonical folder verification, attachment scoping, and English/Arabic layouts. `work-continuity.spec.ts` retains coverage for Task limit review, guidance, and draft navigation. Existing core onboarding tests verify that review is inert, cancellation grants no trust, replaced directories are rejected, and revoked trust prevents launch.

The change is limited to renderer presentation and orchestration through existing Main and core APIs. It grants no workspace trust during migration or discovery and changes no execution-owner policy.

## Conversation presentation

The composer displays the configured model for the next message (or an explicit override), not the profile name. Background Tasks retain step-default semantics rather than presenting an inferred model as certain. The model picker lists configured runnable routes; adding a provider opens the existing reviewed setup dialog in place and preserves the draft. Active turns retain their current model; recorded usage in Details can identify the model used by settled calls.

The **+** menu contains attachments and media prompt actions. The microphone reveals recording controls and its processing disclosure only when opened. Audio still requires Send, and capture permissions and target scoping are unchanged. The textarea uses the rounded composer's neutral focus treatment instead of an inner blue rectangle.

Assistant messages support Markdown paragraphs, lists, tables, and copyable code blocks through pinned `react-markdown` and `remark-gfm` dependencies. Raw HTML and remote images are disabled. HTTP(S) references offer **Copy link**; this pass does not grant provider-written links permission to navigate the privileged desktop window or launch the host browser. Retained media remains available through the existing artifact surfaces.

Adjacent tool events appear in an expandable activity group. The current protocol supplies redacted event summaries, not complete arguments/output or call identities; the UI counts updates and does not infer file counts, timings, or verified effects. Failures remain expanded and partial/failed/cancelled outcomes retain visible notices. Ordinary completion receipts, unavailable token fields, and generic evidence warnings no longer interrupt conversation text. Detailed evidence remains in Results; usage, copyable Work ID, and operation inspection are in Details. Urgent operation recovery remains visible beside Work controls.

New activity follows the bottom of the conversation only while the reader is already near it. Scrolling back preserves the reading position. The sidebar uses **Recent work** above workspace/history groups.

`work-presentation.spec.ts` exercises Markdown safety, copy actions, routine diagnostic placement, Enter/composition/repeat handling, resolved-model and provider-return behavior, scroll preservation, and English/Arabic menu layouts. Voice capture and model-operation reconciliation retain their existing focused journeys.


## Compact conversation layout

The desktop target is a 52px toolbar with a 15px title, a 36px tab row, a reading/composer width capped at 760px, and a 10px lower gutter. Narrow windows may wrap controls instead of hiding execution actions.

Existing Work uses one toolbar for its title, canonical outcome, workspace, and tool panels; the duplicate profile/workspace breadcrumb is removed. Conversation, Changes, and Results share a compact row. Pin, resume, retry, and operation inspection are available under **More actions**. Enabled stop, pause, and cancel controls remain directly visible.

Operation errors, uncertain outcomes, and pending requests retain a visible disclosure beside the tabs. Opening it shows the original explanation and **Check operation**; the same information is available in Details. A connection warning does not change the saved Work outcome or imply recovery. Model loading errors remain explicit in the model picker.

The composer sits just above the runtime bar without the permanent keyboard shortcut hint. The Send tooltip retains the shortcut; Enter, Shift+Enter, and input-method composition behavior are unchanged. Input grows with the draft up to 140 pixels, then scrolls internally. Missing workspace and Task guidance constraints still appear when applicable. The conversation scrolls independently, and Details overlays it in narrow windows so the composer remains in the window.

This applies the approved compact layout to the live app while retaining the official artwork and theme tokens. Historical concept fixtures remain unchanged. No execution authority, trust, model routing, or receipt semantics change. Presentation and continuity journeys cover the compact layout, warning recovery, direct stop, overflow actions, and English/Arabic narrow windows.

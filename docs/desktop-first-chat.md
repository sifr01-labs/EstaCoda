# Desktop first chat

The prompt is editable before a workspace is selected. Text remains a local draft; sending and adding attachments require a current trusted execution target.

Choose **Choose a workspace** above the composer to search registered, trusted workspaces. **Add folder…** opens the native folder chooser. The app then asks for a workspace name and explicit trust, shows the canonical folder in a review, and registers it only after **Trust and use workspace**. Registration uses the existing setup operation; it does not merge project configuration into the profile. Local host execution is not sandboxed, and the profile's approval policy remains in force.

A lost save response exposes **Check workspace**, which reads saved state without repeating the mutation. Selection requires a launch-ready target whose inspected working directory matches the reviewed folder. Changing targets clears attachments scoped to the old target and preserves text. Re-selecting the same target preserves attachments.

New Work defaults to a conversation. **Chat options → Run in background** requests a supervised Task and exposes its existing limits and authority review. No automatic conversion into a Task or expansion of execution authority occurs.

Unattached local drafts appear under **Drafts**. Historical Work with no target appears under **Previous conversations**. Existing history remains readable; the app explains that a new chat with a selected workspace is required for further execution. It does not silently attach old history to a folder.

The live welcome screen uses the official icon and wordmark with a bounded wordmark width and tighter spacing. CSS trims the wordmark's transparent display padding; the source artwork is unchanged. New controls and messages support English and Arabic.

## Validation and trust boundaries

`workspace-composer.spec.ts` covers editable drafts, gated sending and attachments, explicit trust review, cancellation, late results after profile changes, uncertain outcomes, canonical folder verification, attachment scoping, and English/Arabic layouts. `work-continuity.spec.ts` retains coverage for Task limit review, guidance, and draft navigation. Existing core onboarding tests verify that review is inert, cancellation grants no trust, replaced directories are rejected, and revoked trust prevents launch.

The change is limited to renderer presentation and orchestration through existing Main and core APIs. It grants no workspace trust during migration or discovery and changes no execution-owner policy.

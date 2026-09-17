# Desktop composer

The composer accepts native file selection and file drops into the same draft. The + menu offers Photos & files and a file picker starting in the selected workspace, plus image and speech creation modes. The writing area grows with its content up to a bounded height, then scrolls internally. Enter sends; Shift+Enter inserts a line; IME composition does not send.

Typing `/` opens a keyboard-navigable list of applicable desktop actions. Image and speech choices become removable draft chips; their instructions are added on submission through the existing provider/tool execution path. Model, permissions, and connections commands open existing controls and do not change settings themselves. `/reload-mcp` retains its existing reconnect behavior. These suggestions are desktop actions, not a claim that all CLI commands are supported.

During an active conversation, follow-ups use Queue. Stop is labeled beside the current work state and is available only when the canonical work projection allows cancellation. Stopping pauses queued delivery; the saved follow-up remains editable. New queued drafts have separate staging IDs, so their attachment references remain bound to the correct submission. Restart restores unsent text and creation intent, never attachment handles, image previews, or permission grants.

## Attachment boundary

- Preload resolves genuine native `File` objects through Electron `webUtils.getPathForFile`; the renderer cannot supply a path string through the exposed drop API. Synthetic files with no native path are rejected.
- Main validates a maximum of four absolute paths and requires a currently available trusted target. The existing staging store validates text/media types, sizes, profile, target generation, draft scope, and expiry. Unsupported files are reported without sending a message.
- Text remains limited to 8 KB per file; supported images to 8 MB per file. Attaching content does not grant execution authority. Files are not sent to a model until submission.
- Optional local image thumbnails are bounded PNG previews, generated after media staging. Thumbnail failure does not discard a staged file; previews are not persisted in chat presentation state.
- Profile/connection changes invalidate staging. Late picker/drop responses cannot overwrite a different draft or workspace.

The sidebar contains recent work and Archived. Older work remains available through the Work page's pagination and Search; pagination was removed only from the sidebar.

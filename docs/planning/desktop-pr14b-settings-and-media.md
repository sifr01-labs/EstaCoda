# Desktop settings and media: implemented behavior

This guide describes the PR14B branch implementation. The [parity inventory](desktop-pr14b-parity.md) records remaining delivery and acceptance gaps; this guide does not declare full CLI parity or release readiness.

## Editing settings

Open Settings, then Advanced, Vision & Images, Voice, or Browser & Search. Choose a section, load the current value and edit a typed field. Named provider/server/alias entries require their exact identifier. Advanced fallback options use the existing route’s zero-based index (0–99); add or reorder routes in Models first. Technical configuration identifiers remain untranslated; navigation, review actions and owned errors support English and Arabic.

Review shows previous and proposed values. Apply writes only the selected profile using the existing setup transaction. Cancel before Apply discards the draft. If Apply reports an uncertain outcome or the window reconnects, inspect its receipt before submitting another change. Read-only verification checks configuration structure; it does not validate paid provider access, launch a browser or install dependencies. Existing provider setup retains explicit candidate verification where supported.

Credentials are entered in a separate protected window. General settings display only configured/staged state. Configuration stores a secret reference and the selected profile owns the credential. A missing profile credential is not filled from another profile. Existing OAuth and Telegram setup remain separate reviewed flows.

Prompt-affecting changes take effect at the runtime's supported reconstruction boundary. Saving a setting does not transfer execution ownership or authorize a tool call.

## Profiles, workspaces and dependencies

Profile creation produces a credential-free profile. Copy explicitly selects profile memory files. Selecting a profile in Desktop and changing the CLI default are separate actions; existing Work stays with its owner. Rename/delete is limited to an unused inactive profile with no retained history and no pending apply or running gateway. Switch away, change the CLI default if needed and stop all other consumers first. Review deletion carefully: it removes that profile’s configuration, credentials and local files. Used-profile history migration is not implemented.

Registering a workspace does not trust it. Review directory trust separately. Trust applies globally to the directory and its children. Removing registration preserves files. Existing target management handles supported worktree operations. Editing a Docker policy does not provision its image. In Runtime → Local dependencies, explicitly review `docker-execution` to build the fixed bundled image using an available local Docker engine. Inspect completion for the immutable image ID, then review execution policy separately. The form cannot supply arbitrary build commands or install the engine.

Dependency inspection reports registered capabilities. Review a specific download before installation. An accepted installation may continue after the window closes; inspect the durable operation receipt before retrying. Cancellation before dispatch is supported. Mid-install cancellation and rollback are not promised.

Gateway controls are available from Settings without configuring Telegram. Service installation, authenticated runtime liveness and channel state are distinct. Stop/restart retain the existing shared-Work acknowledgement.

Installation status in Runtime reports the detected installation owner and version. Update and uninstall remain owner-required; Desktop does not mutate a separate CLI installation or remove its running bundle. Packaged delivery acceptance remains PR16.

## Using media

For a Conversation, the attachment button accepts supported PNG, JPEG, GIF and WebP images up to 8 MB each, alongside the existing bounded text-file path. At most four attachments are submitted. Attachments remain tied to the current profile, target, target generation and draft; reattach after those change or the staging handle expires. Durable Task media submission is not supported by this path.

Media actions place a request in the draft for configured image analysis, image generation or speech generation. Review and Send use the normal agent runtime and its tool, processing-location, approval and spending policies. Clicking a media action does not itself call a provider.

Record audio explicitly requests microphone permission and captures at most 60 seconds. Stop ends the capture and adds a WAV attachment with a transcription request to the draft. Cancel discards capture. Audio is sent for configured STT only after Send; a hosted provider may process it under the existing runtime policy. The transcript appears in Work. This is batch transcription, not realtime dictation or a continuous voice conversation.

Retained generated images and supported speech outputs up to 8 MB can be loaded from Results. Load retrieves verified bytes; Save uses the native save dialog. Speech playback starts only with Play and stops with Stop or when the view closes. It does not synthesize speech again. MPEG, WAV, Ogg, AAC and FLAC are accepted retained audio formats; decoding depends on the Electron build. Raw PCM and larger outputs currently lack this retained preview path. SVG/HTML are never rendered as media previews.

## Current acceptance limits

The browser tests exercise synthetic audio through the actual AudioWorklet, image previews and audio playback in English and Arabic. They do not record a real microphone, grant packaged macOS permission or call live hosted image/STT/TTS providers. Those native and live journeys remain acceptance work. All 479 registered fields have persistence round-trip coverage. Used-profile rename/delete and update/uninstall remain explicit action-parity limits detailed in the inventory. See the [validation record](desktop-pr14b-validation.md) for the exact automated checks.

Schedule editor and delivery acceptance remain explicitly **PR15 pending**. Video remains PR21. Configuration visibility does not grant execution authority or imply an integration marketplace.

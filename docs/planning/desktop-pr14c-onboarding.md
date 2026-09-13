# Desktop first-run setup

The desktop app uses the same setup detection, profile configuration, credential owners and reviewed apply transaction as the CLI. A packaged build carries its own Node runtime; starting setup does not require installing Node, pnpm or the EstaCoda CLI separately.

## First Work

1. Choose **Begin setup**, then display language and response style. English and Arabic are available. The desktop display preference changes immediately; the reviewed setup also records the corresponding agent language choice.
2. Choose an existing workspace with the native folder picker. Review its name and explicitly select whether to trust that folder and its children. Workspace trust permits governed actions; it does not load project files as profile configuration. Trust can be deferred when saving, but Work remains blocked.
3. Choose the primary provider, model and authentication method. API keys are entered in a separate private window. Supported OAuth routes use the existing protected sign-in flow. Routes supporting no authentication do not require a credential. Keep the reviewed route in the setup draft.
4. Choose an approval mode and Agent Evolution behavior. Every approval mode retains the hardline safety floor. Evolution promotion remains gated; autonomous mode is shadow-only.
5. Optionally configure Channels, Voice and Browser, or skip them. One optional settings editor can collect all three sections in the same draft. Vision and image generation are available later in Settings.
6. Review the complete setup, then explicitly confirm saving. Configuration and staged credentials share one profile apply transaction. Workspace registration and trust are a separate confirmed operation covered by the same visible setup review; a failure between these operations does not erase the successful profile save.
7. Verify saved setup, then choose **Start first Work**. This opens a draft bound to the verified workspace target. Sending its prompt starts the normal on-demand runtime.

The default profile is created silently for first-run setup. Setup does not change the CLI's global active-profile pointer. Existing selected profiles remain selected and are routed to repair instead of being overwritten.

## Drafts and cancellation

Back preserves choices within the open wizard. Cancel discards staged model and optional-setting credentials and returns to a paused setup. Resuming retains nonsecret choices in that window but requires staging credentials again. Closing or leaving the wizard discards private drafts; prereview drafts are not persisted across application restarts. Reviews and private candidates expire, so restage and review again after a long pause.

Before final confirmation, setup writes no runtime configuration or provider credentials. The silent bootstrap may create empty state directories, and changing the display language saves a desktop preference. Explicitly accepted dependency downloads are separate operations and are not undone by cancelling setup.

## Dependencies and background availability

Optional capabilities do not block core setup when skipped. Downloads of managed Python dependencies, browser components or local models require their own explicit operator action through the existing settings controls. Registering a capability does not grant permission to execute it or bypass network, workspace, approval or spending policy.

First-run setup does not install a login service. On-demand Work can run without one. For login/reboot availability, review **Install-and-start** separately in Gateway. Use existing operation receipts to inspect accepted dependency or gateway actions before retrying an interrupted action.

## Repair and interrupted saves

- Existing or degraded installations open repair guidance. Use **Open repair** to review changes in Settings, then **Review existing setup** to verify readiness again. Repairs preserve configuration until a separately reviewed change is applied.
- For an interrupted save, inspect its outcome. **Recover approved save** finishes recovery through the existing durable profile transaction; it does not approve a new change or grant workspace trust automatically.
- If configuration saved but workspace registration or trust did not complete, choose the folder again, review workspace and trust, and explicitly confirm them. Then verify again.
- Read-only state, missing credentials, broken configuration, a missing target or deferred workspace trust prevents first-Work launch. Correct the reported condition and verify again. Verification is read-only and makes no model request.
- Verification runs again when starting first Work, so a stale successful screen does not authorize a changed or untrusted target.

The [validation record](desktop-pr14c-validation.md) distinguishes automated implementation evidence from the later signed/notarized clean-machine release gate.

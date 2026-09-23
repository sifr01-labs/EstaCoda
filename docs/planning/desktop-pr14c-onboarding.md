# Desktop first-run setup

The desktop app uses the same setup detection, profile configuration, credential owners and reviewed apply transaction as the CLI. A packaged build carries its own Node runtime; starting setup does not require installing Node, pnpm or the EstaCoda CLI separately.

## Desktop setup

The focused setup view hides chat navigation and runtime status. The large blue EstaCoda wordmark appears on welcome and completion; intermediate steps use a compact mark and progress indicator. English and Arabic share the same flow, with mirrored layout and isolated model names and paths.

1. Choose **Start fresh** or **Use an existing setup**. Select the display language here. An existing healthy setup opens directly; Settings is offered only when attention is needed. If another setup exists, name a separate setup. Continue creates only its empty directory through the existing reviewed profile action; it does not change the CLI default.
2. **Choose your model.** Connect a provider using its private API-key window or supported sign-in flow. Alternatively, explicitly select another local setup and a primary or fallback model connection to copy. Copying is off by default and requires its own consent checkbox. Only the selected connection's profile-saved API key is staged; other keys, OAuth tokens, history, memory and approvals are not imported. OAuth connections require a new sign-in. Environment-only credentials and connections depending on custom headers are not imported.
3. **Choose your workspace.** Use the native folder picker, name the workspace, and explicitly allow access to the folder and its children. Choose whether to approve most actions or use risk-based approval. Safety checks remain enabled. Response style and improvement suggestions are in **Make it yours**. Voice, browser, messaging and more advanced choices remain available in Settings.
4. The concise summary is editable. **Finish setup** is the only configuration-save action. Backend review and apply are retained; no separate Review/Apply clicks are required. Configuration and staged credentials share one profile transaction. Workspace registration and trust remain a separate confirmed operation covered by the visible summary.
5. Verification runs automatically after saving and again when **Open EstaCoda** is clicked. A verified workspace opens a new draft. A deferred or unsuccessful folder grant prevents launch and can be completed on this screen without repeating the profile save.

The default profile is bootstrapped silently. Existing configuration cannot be overwritten by the fresh-setup import path. Import reads only the explicitly selected source, rejects linked profile files and directories, never consults process-environment credentials, and stages the key in the existing memory-only candidate store. The source is unchanged; the destination gets its own credential reference only after confirmed apply. Import metadata and IPC never contain credential values. This is an explicit one-time copy, not shared credential resolution.

## Drafts and cancellation

Back preserves choices between model, workspace and summary. Back from the model screen returns to welcome and discards staged credentials. An empty setup directory created earlier may remain. Closing or leaving the wizard discards private drafts; prereview drafts are not persisted across application restarts. Reviews and private candidates expire, so restage and review again after a long pause.

Before final confirmation, setup writes no runtime configuration or provider credentials. The silent bootstrap may create empty state directories, and changing the display language saves a desktop preference. Explicitly accepted dependency downloads are separate operations and are not undone by cancelling setup.

## Dependencies and background availability

Optional capabilities do not block core setup when skipped. Downloads of managed Python dependencies, browser components or local models require their own explicit operator action through the existing settings controls. Registering a capability does not grant permission to execute it or bypass network, workspace, approval or spending policy.

First-run setup does not install a login service. On-demand Work can run without one. For login/reboot availability, review **Install-and-start** separately in Gateway. Use existing operation receipts to inspect accepted dependency or gateway actions before retrying an interrupted action.

## Repair and interrupted saves

- Existing or degraded installations show contextual guidance and **Open Settings** only when needed. Use **Check again** after correcting a problem. Repairs preserve configuration until a separately reviewed change is applied.
- For an interrupted save, inspect its outcome. **Complete interrupted save** finishes recovery through the existing durable profile transaction; it does not approve a new change or grant workspace trust automatically.
- If configuration saved but workspace registration or trust did not complete, choose the folder again and explicitly allow access, then select **Save folder access**. Verification runs again automatically.
- Read-only state, missing credentials, broken configuration, a missing target or deferred workspace trust prevents first-Work launch. Correct the reported condition and verify again. Verification is read-only and makes no model request.
- Verification runs again when starting first Work, so a stale successful screen does not authorize a changed or untrusted target.

The [validation record](desktop-pr14c-validation.md) distinguishes automated implementation evidence from the later signed/notarized clean-machine release gate.

## Redesign validation (2026-09-23)

Validated the focused flow with the full core and desktop unit suites, focused import/protocol regressions, seven browser interaction tests, typechecks, source and distribution smoke suites, build, runtime-import/ESM audits, and desktop protocol boundary checks. Core validation used a tracked-file copy with frozen dependencies because unrelated untracked duplicate TypeScript declarations in the working checkout break its root typecheck.

The updated `apps/desktop/tests/onboarding-packaged.mts` completed English/API-key and Arabic/no-auth setup, native folder selection, first model response and restart preservation using the ad-hoc signed macOS app, an owned Node runtime and synthetic loopback provider. It uses unique test profile names: launchd service names are per user, so changing HOME alone does not isolate a `default` service. Its optional fourth argument selects an evidence directory.

The earlier Choose model failure did not reproduce in either the direct bridge catalog check or the packaged first-run flows. Provider loading now has a bounded retry path and contextual feedback; the original screenshot alone does not establish its historical cause. Signing/notarization and real provider OAuth remain separate release/integration checks.

Security review: copying remains opt-in, source-selected and limited to one connection; ordinary IPC never carries its key. The import is staged until final confirmation, revoking consent discards it, and existing destination configuration is protected by the same snapshot checks used by reviewed setup. Workspace access remains a separate explicit grant.

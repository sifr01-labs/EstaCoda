# Desktop Models and Providers

Desktop PR6 connects **Settings → Models & providers** and the composer model picker to the selected profile's core services. It retains the approved desktop shell and themes. Live prompt submission, attachments and general Work controls follow in PR7; changing a model does not start execution.

## Configure a provider

1. Open Settings → Models & providers → Add provider.
2. Choose a configurable provider and enter its model ID. Choose Primary, Fallback, or one of the five exposed specialist roles.
3. Enter an API key in the separate private credential window. The ordinary app receives only confirmation that a credential was staged.
4. Optionally choose **Verify candidate · may incur cost**. This sends one synthetic request to the displayed endpoint. It may incur provider charges.
5. Review the provider, endpoint, API mode, role, limits and credential status, then choose **Apply configuration**.
6. Read the saved result. A successful read-only configuration check is distinct from a successful live request.

Before Apply, Cancel discards the staged credential and leaves saved configuration unchanged. Verification remains cancellable while a request is in flight. Failed verification discards a newly staged credential; use Start over to collect a fresh candidate. Closing the window, switching profile, expiry and bridge shutdown also invalidate staged candidates.

Connection settings belong to a provider within the selected profile. Other routes that inherit that provider's endpoint/authentication use those settings too. Explicit fallback endpoint and credential references remain route-local. Config stores references; API-key values are saved only in the selected profile `.env`. Older generated references may remain for runtimes settling on their previous configuration; this milestone does not automatically prune those secrets.

### Codex authorization

Choose OpenAI Codex, pick a model from the catalog, then Authorize Codex. The list includes current GPT-6 and GPT-5.6 choices; availability depends on the signed-in account and workspace. For an existing connection, choose another model and Review selection to reuse its authorization. Retired models are omitted from new Codex choices; existing saved selections are not migrated automatically. The service requests a device code and polls authorization status. Click **Open Codex sign-in** to open the fixed provider URL and enter the displayed code. Successful authorization stages tokens; it does not save them. Review and Apply persist the authorization in the selected profile `auth.json`.

Cancellation, profile changes, service shutdown and the authorization deadline discard pending authorization. Late browser/exchange results cannot revive a cancelled setup. Desktop does not expose access or refresh tokens to the ordinary renderer.

### Local and custom endpoints

Choose Local / Custom or Custom OpenAI-compatible endpoint. Review the provider ID, model ID, URL, authentication (`none` or API key), API mode, network enablement, context override and output cap. The supported transports are Chat Completions, Responses and OpenAI-compatible chat. No-auth setup does not open the credential window or create a key.

Private/loopback verification requires the explicit checkbox. Public endpoints require HTTPS; embedded credentials, URL queries/fragments, unsafe redirects and cloud metadata destinations are rejected. There is no arbitrary-header editor. Disabling provider requests saves that choice but prevents verification/execution. Clearing primary limits uses catalog/model defaults; re-selecting the current configured primary preserves its existing caps. Specialist output caps are not editable because the core specialist slot has no output-cap field.

## Catalog and route management

The dashboard uses offline metadata by default. Configured providers are shown first; Browse providers opens the wider catalog. Catalog visibility does not grant execution authority. Unsupported/catalog-only providers cannot be configured through this flow, and non-runnable models cannot be selected for Work. Unknown custom-model metadata remains explicitly unknown.

Model rows show provider/model identity, configuration status, context/output limits, tools/vision, lifecycle, source and available pricing. **Refresh** fetches public model metadata from models.dev in one click, with inline progress, completion, and retry feedback. It does not send credentials, verify a provider, submit a prompt, or change saved model selections. The button is disabled while the refresh is in progress; a failed refresh leaves the existing catalog available. Lists load in bounded pages, with a 2,000-row desktop browsing limit.

Use **Use a configured model** to propose a primary, fallback or specialist route with its existing credential reference. A fresh review is required if the profile changed. The same provider/model at ambiguous configured endpoints is rejected rather than choosing an endpoint silently.

Fallbacks are ordered. Add, remove and reorder them through review and Apply. Duplicate fallback routes and a fallback identical to primary are rejected. Remove an identical fallback before promoting that route to primary. To test a saved route, review its configured model and run the optional verification before Apply; cancelling this review leaves its saved credential intact.

The five specialist slots are assessor, compression, session search, memory compaction and profile context. Each supports primary, automatic, dedicated or disabled routing through the reviewed controls, with fallback-to-primary where applicable. Vision remains in capability settings. An automatic slot with no eligible route is optional; it does not make otherwise valid primary configuration broken.

## First-run model selection

Onboarding uses the same provider search, model list, pricing, model details, and connection dialog as Settings. **Connect a provider** opens that browser directly; neither starting choice is preselected. **Copy an existing connection** opens the explicitly selected source setup and retains the separate consent to copy its saved API key. Choosing a model stages the connection; only **Finish setup** saves it. Returning or cancelling does not apply a model configuration.

## Model selection for one Work

The composer picker selects a model for the current Session or Task without changing profile defaults. Main resolves the canonical Work, profile and target generation; renderer-supplied IDs do not grant authority.

- Session changes queue at a turn boundary. Active turns keep their current model. A live foreign owner is never taken over to apply a selection.
- Task changes affect future child attempts. Already constructed workers keep their model, including their saved override when the same attempt resumes after a handoff.
- Reset uses the profile default for a Session or the declared step/default routing for a Task.
- New Work drafts retain a local model choice; PR7 connects draft submission to execution.

Accepted/dispatched receipts mean the change is queued, not completed. The picker polls the saved operation and blocks another change while the outcome is unresolved. **Check change result** reconciles after reconnecting; it does not resend the mutation. Profile changes clear the visible Work and drafts.

## Verification and recovery

The candidate verifier sends one synthetic streaming/tool request, with a 12-second deadline, at most 64 requested output tokens (or a smaller configured cap) and a bounded response. It never executes the suggested tool or writes a transcript, memory or Evolution record. The UI reports the safe result, observed streaming/tool compatibility, latency, reported input/output tokens and available estimated cost. Missing usage/pricing is shown as unavailable.

Apply uses the existing reviewed setup executor inside a profile-writer lock. It checks the reviewed snapshot, stages restricted files, then records a durable commit decision before replacing profile files. Files containing credentials use 0600 permissions. A pending recovery journal blocks route activation until recovery succeeds. This is a recoverable multi-file commit, not a claim that several filesystem renames are one atomic write.

Before the durable commit point, cancellation leaves saved files unchanged. After it, an interruption can mean **saved or uncertain**; cancellation cannot promise that nothing was written. Reconnect and use **Check saved result** on Models. The selected profile's latest safe receipt is available even after a full application restart. Inspection returns operation identity/state, never the journal's configuration or credentials. A later Apply replaces the last receipt; older operation IDs can therefore be unknown.

A committed configuration notifies the existing supervisor. Idle cached runtimes refresh; an actively borrowed runtime is retained until its owner releases it. Desktop does not edit an executing prompt, steal Session ownership, start a second supervisor or change the global active-profile pointer.

## Validation and scope

See the [PR6 implementation record](../../planning/desktop-pr6.md), [credential transaction contract](credential-transactions.md), [desktop test commands](../../../apps/desktop/README.md) and [native evidence](../../../apps/desktop/tests/native-evidence/README.md).

Automated acceptance covers API-key isolation/cancellation, OAuth lifecycle with synthetic responses, real local no-auth verification, reviewed persistence, interruption recovery, route/override behavior, the frozen visual gate and the hardened macOS package. Real-account Codex login and paid provider requests remain manual acceptance checks. Developer ID signing and notarization belong to the later distribution milestone.

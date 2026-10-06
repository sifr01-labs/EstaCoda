# Jev routing configuration and decision client — commits 1–2

Status: configuration and validated decision client implemented. Live routing integration is not implemented yet. Both saved modes currently execute Standard routing. Desktop and Setup Editor explicitly disclose this limitation; these foundations must not be advertised as a working Jev routing release.

## Configuration and setup

The selected profile owns `routing.mode` (`standard`, the default, or `jev-assisted`) and `routing.jev`:

- `provider`: `typesafe`.
- `id`: pinned `jev-1.13.0` by default. Model identifiers beginning with `jev-` are supported for explicit configuration, including TypeSafe aliases.
- `apiKeyEnv`: credential reference, default `TYPESAFE_API_KEY`.
- `timeoutMs`: 5000 by default, integer 100–60000.

Existing profiles need no migration or TypeSafe credential. Selecting Standard preserves the saved Jev settings. Neither mode changes the conversation model, auxiliary voice/vision models, execution permissions, or completion checks.

Desktop: Settings → Runtime → Execution → Intent & capability routing. Select Jev-assisted, then Change → TypeSafe → Jev model. The model card uses the existing protected credential entry, followed by Review changes → Save changes. Credential values stay outside the renderer and are written to the selected profile's private `.env` through the existing recoverable settings transaction. Only credential presence is projected to the UI. Configuration review, cancellation, stale-review rejection and existing settings-change notification remain in force.

CLI: Setup Editor → Intent & capability routing uses the existing centralized selector, secret prompt and reviewed apply executor. Cancelling review writes neither configuration nor credentials. Switching Standard/Jev-assisted is shared profile configuration, so clients using that profile load the same setting. Telegram does not gain an independent settings mutation path.

TypeSafe's decision API is separate from chat/completions. Jev is therefore a specialized model route, similar to specialized media configuration; it is not registered as a conversation provider. The initial picker catalog is pinned from https://docs.typesafe.ai/models, inspected 2026-10-06. Configuration/diagnostics make no Jev request and do not claim successful provider authentication.

## Runtime boundary and decision contract

Routing configuration contributes to the existing runtime definition fingerprint. Cached executions retain their lease; changed definitions are used after the active execution releases it. An attempted concurrent replacement remains busy. The decision client now checks configuration/catalog revisions before dispatch and acceptance, discarding stale answers. Later live integration must supply current revisions and connect cancellation at routing boundaries; in-flight tool execution remains unchanged.

The versioned routing decision contract includes configured mode, actual engine, model, configuration/catalog revisions, independent intent/skill/capability selections, optional primary skill, and fallback reason. Probability is optional because Standard routing must not fabricate Jev probabilities. Selected labels are multi-label, not a single mutually exclusive choice. This contract is a foundation for later routing consumers, not execution authority.

## Validated TypeSafe client (commit 2)

`src/runtime/jev/decision-client.ts` provides the transport for later routing consumers. It uses TypeSafe's fixed HTTPS decision endpoint with redirects disabled and no automatic retries. It does not register Jev as a conversation model or expose a new agent tool. Standard mode and empty candidate sets make no provider request.

The adapter supports independent Noul applicability questions, exclusive Choice questions, and Score rubrics. Every question includes its instructions and subject description: TypeSafe does not present the question ID to its model. Responses must match the requested question types and IDs; Choice/Score probabilities must cover exactly the declared options and sum to one. Choice must select a maximum-probability option; Score must match its declared rubric and probability-weighted value. Unknown IDs reject the batch. Missing, malformed, uncertain and explicitly rejected answers remain distinct. Selection thresholds are supplied by the consumer; calibration remains commit 6.

Requests carry only the current user request, optional relevant continuity and explicitly marked untrusted quoted/retrieved material. Full history/config objects and extra properties are excluded. Recognizable credentials and known values from the selected profile's `.env` are redacted from content; credential-bearing IDs are rejected rather than silently remapped. Credentials resolve through the shared runtime resolver using an explicit selected-profile environment snapshot, with no process-global or other-profile fallback. The client emits no raw request, response, exception or credential logs.

Local ceilings are 2,048 questions per evaluation, 64 questions per batch, 16,384 UTF-8 bytes of state, 8,192 bytes per question, 48,000 bytes per serialized request and 524,288 bytes per response. Choice supports 2–255 options; Score supports 2–10 levels. Overlarge context/questions are rejected rather than truncated, preserving user restrictions for Standard fallback. Independent capabilities are not normalized against one another.

The configured timeout covers credential lookup and all sequential batches, including response streaming. Cancellation or changed configuration/catalog revisions discard all decisions; later batches cannot dispatch under an obsolete snapshot. Mandatory local usage settlement is awaited even after cancellation. Every dispatched attempt uses the existing auxiliary/routing usage ledger, including failures with explicitly incomplete usage; unique attempt keys allow idempotent persistence without hiding separate requests. If accounting fails, answers are withheld and canonical usage entries are retained for settlement without another API call. Valid earlier batches may accompany a later service failure, but unanswered capabilities are never converted into rejection. Consumers must handle the structured failure/partial result through centralized Standard fallback in subsequent commits.

Release validation remains pinned to `jev-1.13.0`. Explicit aliases record the actual returned release; unknown releases stay unpriced. The pinned estimate is $0.042 per million input tokens and no output charge. API and model contracts were checked against [TypeSafe API](https://docs.typesafe.ai/api) and [TypeSafe models](https://docs.typesafe.ai/models) on 2026-10-06. Fixtures establish adapter behavior; live authentication and packaged routing verification remain commits 5 and 7.

## Commit 1 validation and risk

Coverage includes config defaults and validation; Desktop protected credential round trips, redaction, cancellation, profile isolation and invalid model rollback; CLI apply/cancel and active-profile selection; runtime fingerprint and lease boundaries; English/Arabic Desktop model selection and review.

This changes security-sensitive configuration and credential entry surfaces. It reuses their existing scope, review and storage boundaries; no credential, approval, tool-exposure or network policy is relaxed. Live Jev decisions, calibrated selection thresholds, expansion recovery, fallback notifications and packaged live verification remain later commits in the implementation plan.

Validated on Node 24.14.1 / pnpm 10.33.0:

- Frozen dependency install in an isolated directory, without changing the checkout's dependencies or lockfile.
- Core typecheck and build; runtime import and ESM audits; source and compiled smoke suites (13/13 each).
- Core tests: 752 files, 12,153 tests passed with `pnpm run test --maxWorkers=4`. Two startup timeouts in the earlier concurrent validation run passed in isolation and in this final full run.
- Desktop protocol/type checks; 180 Desktop unit tests; 12 English/Arabic settings browser tests, including protected credential staging and review. Model picker layouts inspected visually.
- Final strengthened CLI cancellation/redaction assertions passed separately. `git diff --check` passed.

Core validation used an isolated copy of tracked sources plus this change because the working checkout contains unrelated duplicate source files. No packaged application install or live TypeSafe authentication/routing claim is made by these checks.

## Commit 2 validation and security review

The 66-test fixture suite covers transport and ledger integration, bounded multi-label batching, typed answers, malformed distributions, missing/uncertain responses, authentication/rate/service failures, cancellation, stalled bodies, stale configuration/catalogs, redaction, profile isolation and Arabic context. No actual TypeSafe credential or live service call is used.

Security review: this adds a fixed-endpoint network adapter and a read-only selected-profile credential lookup. Its answers are relevance evidence only; the client grants no execution authority and changes no tool, approval, workspace, task-completion or file-verification behavior. Runtime consumers, fallback presentation and packaged verification are deliberately still pending in the subsequent commits.

Commit 2 checks passed on Node 24.14.1 / pnpm 10.33.0 using the isolated tracked-source validation copy: frozen dependency install, core typecheck, build, 753 test files / 12,219 tests, runtime import audit, ESM audit, source smoke (13/13), compiled smoke (13/13), and final diff checks. The new client adds no dependency or lockfile change. Existing unrelated working-tree changes are outside this commit.

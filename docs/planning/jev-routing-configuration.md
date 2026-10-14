# Jev routing configuration and decision client — commits 1–5

Status: configuration, validated decision client, live intent/skill routing, and capability selection/discovery implemented. Jev-assisted controls relevance decisions in the shared runtime. Existing execution permissions and completion checks remain authoritative. The settings connection check and actual-engine/fallback presentation are implemented. Calibration and packaged live acceptance remain pending.

The [14 October runtime repair](jev-routing-reliability-fix.md) preserves explicit browser/file actions, cancelled-objective boundaries, Standard task-class fallback, and specific read-only inspection prerequisites. Researcher/wiki-builder no longer require the entire core toolset; research retains authorized task-status/result reads. A fresh selection-only evaluation passed all required tool choices. Jev's production questions and thresholds remain unchanged, and intent accuracy, excess selections and packaged acceptance remain open work.

## Configuration and setup

The selected profile owns `routing.mode` (`standard`, the default, or `jev-assisted`) and `routing.jev`:

- `provider`: `typesafe`.
- `id`: pinned `jev-1.13.0` by default. Model identifiers beginning with `jev-` are supported for explicit configuration, including TypeSafe aliases.
- `apiKeyEnv`: credential reference, default `TYPESAFE_API_KEY`.
- `timeoutMs`: 5000 by default, integer 100–60000.

Existing profiles need no migration or TypeSafe credential. Selecting Standard preserves the saved Jev settings. Neither mode changes the conversation model, auxiliary voice/vision models, execution permissions, or completion checks.

Desktop: Settings → Runtime → Execution → Intent & capability routing. Select Jev-assisted, then Change → TypeSafe → Jev model. The model card uses the existing protected credential entry, followed by Review changes → Save changes. Credential values stay outside the renderer and are written to the selected profile's private `.env` through the existing recoverable settings transaction. Only credential presence is projected to the UI. Configuration review, cancellation, stale-review rejection and existing settings-change notification remain in force.

CLI: Setup Editor → Intent & capability routing uses the existing centralized selector, secret prompt and reviewed apply executor. Cancelling review writes neither configuration nor credentials. Switching Standard/Jev-assisted is shared profile configuration, so clients using that profile load the same setting. Telegram does not gain an independent settings mutation path.

TypeSafe's decision API is separate from chat/completions. Jev is therefore a specialized model route, similar to specialized media configuration; it is not registered as a conversation provider. The initial picker catalog is pinned from https://docs.typesafe.ai/models, inspected 2026-10-06. Ordinary configuration review and offline verification make no Jev request. The explicit saved-connection check described below is the only settings action that contacts TypeSafe.

## Runtime boundary and decision contract

Routing configuration contributes to the existing runtime definition fingerprint. Cached executions retain their lease; changed definitions are used after the active execution releases it. An attempted concurrent replacement remains busy. The decision client now checks configuration/catalog revisions before dispatch and acceptance, discarding stale answers. The session builder now supplies current profile configuration/catalog revisions and the turn cancellation signal; in-flight tool execution remains unchanged.

The versioned routing decision contract includes configured mode, actual engine, model, configuration/catalog revisions, independent intent/skill/capability selections, optional primary skill, and fallback reason. Probability is optional because Standard routing must not fabricate Jev probabilities. Selected labels are multi-label, not a single mutually exclusive choice. This contract is a foundation for later routing consumers, not execution authority.

## Validated TypeSafe client (commit 2)

`src/runtime/jev/decision-client.ts` provides the transport for later routing consumers. It uses TypeSafe's fixed HTTPS decision endpoint with redirects disabled and no automatic retries. It does not register Jev as a conversation model or expose a new agent tool. Standard mode and empty candidate sets make no provider request.

The adapter supports independent Noul applicability questions, exclusive Choice questions, and Score rubrics. Every question includes its instructions and subject description: TypeSafe does not present the question ID to its model. Responses must match the requested question types and IDs; Choice/Score probabilities must cover exactly the declared options and sum to one. Choice must select a maximum-probability option; Score must match its declared rubric and probability-weighted value. Unknown IDs reject the batch. Missing, malformed, uncertain and explicitly rejected answers remain distinct. Selection thresholds are supplied by the consumer; calibration remains commit 6.

Requests carry only the current user request, optional relevant continuity and explicitly marked untrusted quoted/retrieved material. Full history/config objects and extra properties are excluded. Recognizable credentials and known values from the selected profile's `.env` are redacted from content; credential-bearing IDs are rejected rather than silently remapped. Credentials resolve through the shared runtime resolver using an explicit selected-profile environment snapshot, with no process-global or other-profile fallback. The client emits no raw request, response, exception or credential logs.

Local ceilings are 2,048 questions per evaluation, 64 questions per batch, 16,384 UTF-8 bytes of state, 8,192 bytes per question, 48,000 bytes per serialized request and 524,288 bytes per response. Choice supports 2–255 options; Score supports 2–10 levels. Overlarge context/questions are rejected rather than truncated, preserving user restrictions for Standard fallback. Independent capabilities are not normalized against one another.

The configured timeout covers credential lookup and all sequential batches, including response streaming. Cancellation or changed configuration/catalog revisions discard all decisions; later batches cannot dispatch under an obsolete snapshot. Mandatory local usage settlement is awaited even after cancellation. Every dispatched attempt uses the existing auxiliary/routing usage ledger, including failures with explicitly incomplete usage; unique attempt keys allow idempotent persistence without hiding separate requests. If accounting fails, answers are withheld and canonical usage entries are retained for settlement without another API call. Valid earlier batches may accompany a later service failure, but unanswered capabilities are never converted into rejection. Consumers merge unresolved candidates with Standard and retain precise batch failure evidence.

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

## Live intent and skill selection (commit 3)

The shared `AgentLoopBuilder` wires the client for Desktop, CLI, gateway channels and task workers. `AgentLoop` persists the user turn before awaiting routing so auxiliary usage has a valid turn owner. It supplies the original user request or worker assignment, bounded continuity, and separately marked quoted/retrieved material. Expanded project text and dependency prose cannot become a worker's assignment. Existing request requirements, checkpoint continuation and Step completion contracts remain deterministic.

The asynchronous router reads only the selected profile configuration at routing/acceptance boundaries, including while a runtime is leased. Switching to Standard prevents subsequent Jev requests; changed configuration or skill catalogs invalidate outstanding decisions. Both local semantic shadow selection and the optional LLM shadow reranker are skipped for Jev-assisted decisions, including fallback.

Jev evaluates independent Noul questions for the built-in intent taxonomy and every session-visible skill, using skill names and descriptions rather than a keyword shortlist. The initial conservative thresholds accept at 0.8 and reject at 0.2; intermediate, missing or invalid answers use Standard only for the affected candidates; confident valid answers remain in use. These thresholds are provisional, not a claim of calibration; held-out measurement remains commit 6. Fallback re-resolves the current registry and records configured/actual engine, model, revisions, probabilities and the fallback reason in route events and skill telemetry. Commit 5 adds the cross-surface engine/fallback presentation described below.

Explicit named skills, aliases, unresolved references, declared negative/defer rules, ready-attachment constraints, save-only continuity and confirmation policies stay authoritative. Several skills or no skill may be selected. For compatibility with existing execution metadata, explicit/checkpoint skills sort first, then applicability probability and stable name order; the first is the primary. No extra exclusive Choice call is needed in this implementation. All selected complementary instruction bodies or existing large-skill contracts travel through the normal protected skill prompt layer, with setup state. Combinations over 32,000 instruction characters fall back instead of silently dropping a selected skill. Only delivered, ready supporting skills count toward instruction receipts. Execution approval and completion evidence remain unchanged.

Security review covers the fixed TypeSafe transport, profile-local credentials/config, current session visibility, declared negative/defer constraints, quoted/retrieved context, worker scope, cancellation and stale selections. Semantic selection changes relevance and instruction loading, never execution authority. No dependency or lockfile changes; no live API or installed-app success is claimed from fixture verification.

Commit 3 validation on Node 24.14.1 / pnpm 10.33.0:

- Final core suite: 754 files / 12,249 tests passed, including 27 routing regressions and shared builder, agent-loop and prompt-assembly integration coverage.
- Frozen dependency check, core typecheck/build, runtime import and ESM audits passed.
- Source and compiled smoke suites: 13/13 each.
- Desktop protocol/type checks, 180 unit tests and 12 English/Arabic runtime-settings browser tests passed. The initial sandboxed Desktop PTY tests were blocked by process permissions; the normal process-enabled run passed.
- Final diff checks passed. Validation used an isolated copy of tracked sources plus these changes because unrelated duplicate source files remain in the working checkout. Unrelated documentation changes were not included.

No installed application/gateway update or live TypeSafe quality measurement was performed in this commit. Capability selection and recovery remain commit 4; live API calibration and packaged acceptance remain commits 6–7.


## Multi-label capability selection and recovery (commit 4)

The shared builder connects Jev to initial provider-tool selection, including child and Task worker runtimes, and query-based `capability.discover`. Each tool in the complete session-visible inventory gets an independent question with its registered description, including unavailable or provider-restricted entries. Discovery also considers every visible skill when requested. It reuses the client's bounded batching, timeout, cancellation and usage ledger. Oversized catalogs or context fail explicitly into Standard selection; no keyword shortlist permanently removes candidates.

Capability questions use the original user request or assigned worker objective, with bounded continuity and untrusted material kept separate. Recovery treats the agent's search query as a current-need hint within that objective, including save-only restrictions. Exact-ID discovery remains deterministic and makes no Jev call. Standard query matching retains its full-description and skill-trigger behavior. Independent relevance can select complementary capabilities together; configured implementations behind a registered tool (for example the chosen web-search backend) remain runtime configuration, not an exclusive vote over unrelated tools.

The runtime unions relevance with explicit request tools and required toolsets from every selected skill. Optional toolsets do not become obligations. Explicit prohibitions and existing evidence-gated expansion remain binding. Recovery tools remain reachable for actionable requests even when Jev initially misses all tools. Unavailable/restricted matches remain metadata-only, with readiness and bounded setup guidance. Required tools absent from the catalog produce an explicit conflict; selection never creates schemas or installs dependencies.

Exposure retains the existing 100-tool and 24,000 estimated schema-token limits. Recovery controls and explicit request tools precede skill dependencies and optional matches. Required schemas that do not fit are recorded as conflicts and staged by canonical ID. An authenticated `capability.request` can exchange existing exposure for staged requirements only at the next provider iteration, retaining recovery controls, stable catalog aliases and tools already added in that recovery round. Removed exposure is recorded as deferred and can be requested again. Existing limits remain eight additions per round and two successful rounds; schemas too large to fit are reported as budget rejections. No silent overflow or same-batch execution is allowed.

Catalog fingerprints now include session-filtered metadata, schemas, aliases, registered handler identities and execution binding. Initial selection, discovery and recovery application reject stale asynchronous decisions. Availability is checked again before initial exposure or expansion; recovery applies its state changes together after validation. Existing executor policy, workspace trust, approvals, session/profile scope, skill confirmation and completion evidence are unchanged. Semantic selection and exposure do not authorize actions.

Initial inventory events record the versioned capability decision, model, configured/actual engine, revisions, probabilities and conflicts. Discovery returns bounded engine/fallback metadata alongside its matches. The provider receives bounded conflict/readiness context; commit 5 adds user-facing engine status and connection checks. Desktop and CLI setup copy now accurately states that Jev selects intents, skills and capabilities.

Security review covers fixed-endpoint routing egress, selected-profile credential resolution, quoted/context boundaries, catalog and execution-scope changes, receipt authenticity, schema limits, next-iteration exposure and preserved approval denials. No dependencies or lockfiles changed. These fixture checks do not establish live model quality or a rebuilt application release; those remain commits 6–7.

Commit 4 validation on Node 24.14.1 / pnpm 10.33.0:

- Core suite: 755 files / 12,276 tests passed. Focused coverage includes 25 capability-selection regressions and real runtime Jev discovery, next-iteration exposure, same-batch rejection, provider fallback and approval denial.
- Final review strengthened session-rotation invalidation; the 31-test builder suite passed after that change. Final typecheck, build and import/ESM audits passed again.
- Frozen dependency verification, source smoke (13/13), compiled smoke (13/13), Desktop protocol/type checks, 180 Desktop unit tests and 12 English/Arabic settings browser tests passed.
- Diff checks passed. Checks used the isolated tracked-source copy; the working checkout's unrelated duplicate `bidi-js` declaration still prevents direct typechecking there. Unrelated documents and duplicate files were left untouched.

No live TypeSafe request or installed Desktop/gateway update was performed. The checks establish deterministic integration and governance behavior, not model calibration or packaged acceptance.


## Routing status and saved connection checks (commit 5)

Desktop runtime routing settings disclose routing context egress and when saved changes take effect. After saving, **Check saved connection** sends one fixed synthetic greeting question to TypeSafe using the saved model and selected-profile credential. The control names the potential charge before the operator clicks it. It is disabled while changes are unsaved; it never saves configuration or changes routing mode. Setup Editor offers the same saved check with explicit confirmation. Offline verification remains offline. Standard mode sends no check request, and remains selectable after missing credentials or a service failure.

A check uses the existing fixed-endpoint Jev client, deadline, profile credential resolver and canonical auxiliary usage ledger. It rejects cancellation and configuration/credential changes during the check, rejects parallel checks on the same settings owner, and aborts when that owner is disposed. Results contain only bounded status/reason/model fields. Authentication, missing credentials, throttling, timeout, malformed response and stale settings have actionable English/Arabic copy; no provider error body is returned. A successful check establishes connectivity, not calibrated routing quality.

The shared runtime persists and emits `routing-status` facts for intent/skill decisions, initial capability decisions and query-based recovery. Each records the configured mode, actual engine, stage, safe model identifier and fallback reason. Desktop projects only these allowlisted fields through bounded SQL, separately from conversation-model events. Response details retain each decision; a compact attribution row replaces routine fallback banners. Details → Activity shows the latest recorded decision per stage in the loaded activity window. CLI displays the same diagnostic copy. Telegram shows routing progress and keeps a fallback explanation in its own message so later progress cannot overwrite it. Model pickers and provider fallback controls remain independent.

Settings use the existing reviewed profile apply and gateway configuration-change notification. Runtime cache definitions refresh after active leases settle, while subsequent routing decisions re-read saved mode/configuration and reject stale Jev answers. Already executing actions retain their permissions; turning routing off does not cancel them.

Security review: no change to execution authority, workspace trust, approvals, catalog visibility or credential boundaries. Connection checks require explicit request/consent fields, use synthetic context only, and do not accept caller-supplied endpoints or prompts. Credentials and raw provider diagnostics never enter activity projections. Recovery scope is revalidated after asynchronous status recording. No dependency changes. Live TypeSafe calibration and rebuilt Desktop/gateway acceptance remain commits 6–7.

Commit 5 validation on Node 24.14.1 / pnpm 10.33.0:

- Core suite: 758 files / 12,297 tests passed, including connection-check consent, accounting, redaction, profile isolation, saved credential repair, cancellation, stale results, actionable fallback reasons and historic status projection.
- Desktop unit suite: 48 files / 183 tests passed, including IPC consent checks, routing/conversation-model separation and the full configured Jev timeout without premature disconnection.
- Browser suite: 26 tests passed for English/Arabic settings, enable/disable, failed/successful checks, fallback history, narrow layouts and Details. English and Arabic connection-check screens were visually inspected.
- Reviewed routing apply notification coverage passed, together with existing cache-lease refresh and live mode-switch regressions.
- Frozen dependency verification, core and Desktop type checks, build, protocol boundary, runtime import and ESM audits passed. Source and compiled smoke: 13/13 each. Final diff checks passed.
- Validation used an isolated copy of tracked sources plus this change because unrelated duplicate source files in the working checkout prevent direct typechecking. Unrelated documentation and duplicate files are excluded from this commit.

No live TypeSafe request or installed Desktop/gateway update was performed. This commit completes the settings and diagnostic surfaces; release acceptance remains the work of commits 6–7.


## Candidate recovery and runtime inspection correction

A single uncertain candidate no longer invalidates an otherwise useful Jev evaluation. Each confident yes/no remains authoritative for relevance; unresolved candidates use that candidate's existing Standard selection. Explicit requirements, negative policies, skill readiness, exposure budgets and execution authorization still apply after this merge. A partial result is described as “Jev-assisted, with partial Standard fallback” in Desktop response details and in CLI/Telegram diagnostics. Thresholds remain 0.8/0.2 pending calibration.

Routing events retain bounded candidate IDs, question IDs, probabilities, accepted/rejected/uncertain/missing/invalid outcomes, decision source, dispatched batch states and structured failure category/HTTP status. HTTP 402 is recorded as billing rejection; this does not claim an account balance or reinterpret an ambiguous HTTP response. Later service failures retain their original category rather than becoming uncertainty. Timeout, cancellation, stale snapshots and accounting failure invalidate selections. Raw payloads, exception bodies, credentials and user request text are not logged in this evidence.

The existing `config.provider.execution_status` tool reports saved routing mode and the current turn's actual routing stages separately from the last recorded conversation-model execution. Optional `routingTurnId` selects an earlier turn within the same session; `routingDetails` and `routingOffset` page candidate evidence in groups of 20. Missing old diagnostics are explicitly unknown. This read-only inspection tool is retained in initial provider exposure independently of semantic selection, subject to availability and provider schema constraints. It does not grant new execution authority.

Only a brief current-turn fallback notice is added to model context. Full diagnostics stay behind inspection; workspace files do not establish the installed runtime's configuration. The UI and agent consume the same recorded routing facts. Source revision inspection remains separate future work.

`file.grep` ignores blank optional type filters and gives actionable guidance for unsupported nonblank file types. Existing filesystem boundaries remain unchanged.

Security review: selected-profile credential resolution, scoped session inspection, stale-result invalidation, explicit requirements, prohibitions, approval enforcement and native exposure boundaries remain in place. This correction changes relevance recovery and diagnostics only; no new dependency, network endpoint, install permission or write authority is introduced. Live calibration and rebuilt-package acceptance remain commits 6–7.

Correction validation (Node 24.14.1 / pnpm 10.33.0): the complete core suite passed 760 files / 12,316 tests, with subsequent focused review regressions also passing; Desktop passed 48 files / 183 tests. Core and Desktop protocol/type checks, build, runtime-import/ESM audits, source smoke (13/13), final rebuilt compiled smoke (13/13), offline frozen-lockfile verification and diff checks passed. Validation used a clean tracked-source copy plus the exact patch because unrelated duplicate declaration files in the working checkout prevent a clean typecheck there. The source copy was compared byte-for-byte with the patch. Local-process tests were run with their required loopback/process permissions. No live TypeSafe requests or installed Desktop/gateway update were performed for this correction.


## Request interpretation and quiet response details

Standard and Jev-assisted routes carry the same bounded request interpretation into the answering prompt and completion handling. This uses the existing routing pass, with no additional model call. A question about the agent's abilities can complete as an explanation; a polite action request ("Can you review this code?") still requires action evidence. Mixed requests retain explicit file delivery requirements. Selecting an intent or exposing a tool does not establish an obligation to use it. Unknown wording remains unspecified, and existing execution checks still apply. These heuristics do not establish that workspace files exist or that a requested action succeeded.

Jev's independent intent, skill and capability questions now include explicit positive and negative criteria that distinguish requested work from discussion of an ability. Thresholds are unchanged. These criteria are not a claim of measured live calibration; held-out live evaluation remains necessary.

Desktop uses one expandable response-details row for actual model attribution and routing history. Full Standard fallback is visible in the row; partial candidate recovery stays inside it. While execution is active the existing model picker shows the actual model, and after settlement it returns to the preferred next-turn model without changing the preference. Permission and incomplete-outcome surfaces remain; a settled result supersedes stale status notices. Arabic copy and bidirectional model isolation are retained.

Security scope: no authorization, tool execution, credential handling or file verification gates change. Request interpretation is derived from the user request and never grants authority. Explicit file outputs still require execution evidence. Detailed routing records and runtime inspection remain available. This change does not update the installed app or gateway.

Validation for this correction (Node 24.14.1 / pnpm 10.33.0): 761 core test files / 12,347 tests, 48 Desktop files / 185 tests, and all 14 conversation browser checks passed. Browser checks cover narrow and desktop widths, light/dark layouts, Arabic, keyboard disclosure, and retained diagnostics. Core/Desktop type checks, protocol boundary, build, runtime-import and ESM audits, source and compiled smoke (13/13 each), offline frozen-lockfile verification, and diff checks passed. Validation used an isolated tracked-source copy plus this exact patch; unrelated local changes and duplicate source files were excluded. No live Jev calibration or installed app/gateway update is claimed.


## Desktop request status recovery and response details

A failed request-status lookup no longer strands the last pending receipt. Desktop retries read-only inspection up to three times with delays of 1.5, 3 and 6 seconds. Settlement, manual refresh, window focus, network restoration and a ready connection for the same profile trigger a fresh observation. Ordinary snapshots do not trigger extra polling. Late results are discarded after changing Work/profile, disconnecting, unmounting or starting a newer request. A lost action acknowledgment prompts inspection; the action is never automatically replayed.

Lookup failure is labeled **Request status unavailable**, with copy distinguishing the unavailable observation from the recorded Work outcome. A stale pending notice is suppressed while that lookup error is present. Uncertain receipts, denied actions and unresolved work outcomes retain their existing recovery controls and authorization boundaries.

Response details uses the conversation's disclosure styling: a compact model attribution row, a short expanded summary of the answering model/model change/routing, and nested Technical details. Recorded calls are grouped by provider and model; timestamps and routing records remain inspectable. A successful provider call is labeled **Call completed** because it may have requested a tool rather than delivered the answer. Answer attribution requires response prose, a settled turn and the latest model record being successful. The renderer does not invent rate-limit or credit explanations from a generic failed event. English/Arabic copy, bidirectional model isolation, keyboard disclosure and narrow layouts are supported.

Security scope: renderer observation and presentation only. No new gateway methods, credentials, provider requests, execution permissions or persisted preferences. Backend receipts and Work outcomes remain authoritative; recovery never resends a mutation. Jev thresholds and calibration are unchanged. This source change does not install or update the Desktop application or gateway.

Validation (Node 24.14.1 / pnpm 10.33.0): the core suite ran all 761 files / 12,347 cases; eight files requiring local sockets were rerun with the required permissions and all 16 cases passed. Desktop passed 48 files / 186 tests, including the final attribution regression. Browser coverage passed 41 distinct checks across conversation activity, refinement and response details, with the final affected suites rerun after review. Core/Desktop/protocol type checks, the renderer and core builds, protocol-boundary/runtime-import/ESM audits, source and compiled smoke (13/13 each), offline frozen-lockfile verification and diff checks passed. English/Arabic, light/dark and narrow rendered views were inspected. Validation used a tracked-source copy plus the exact focused patch; unrelated local changes and duplicate source files were excluded. No installed-package acceptance or Jev calibration is claimed.


## Response information action

Response details now opens from an info icon beside Copy under each assistant response, replacing the full-width row described above. The action appears on response hover or keyboard focus and stays available on touch. A compact native popover presents the recorded answering/current model, model-switch explanation and routing summary; Technical details retains the grouped call history and routing records. Earlier responses do not acquire later responses' model attribution. Runs without response prose retain a standalone information action when metadata exists.

The panel uses the existing theme, text and icon styles, stays within the viewport, and sits above conversation scroll clipping without moving the answer. Escape, the close button or an outside click dismiss it; keyboard dismissal restores focus to the trigger. English/Arabic, light/dark, narrow windows and touch targets are covered. Actionable failure and permission notices remain visible outside the panel.

Security scope: presentation only; no changes to runtime routing, Jev calibration, permissions, preferences, gateway calls or stored diagnostics. This source change does not rebuild or install the app or gateway.

Validation (Node 24.14.1 / pnpm 10.33.0): 45 distinct browser checks passed across conversation activity, response information and Desktop refinement; the final affected suites passed 28/28 after review fixes. Desktop passed 48 files / 186 unit tests and type checking; the renderer production build passed. The core suite passed 761 files / 12,347 tests, source and compiled smoke passed 13/13 each, and core/protocol type checks, core build, protocol-boundary/runtime-import/ESM audits, offline frozen-lockfile verification and diff checks passed. Native terminal tests required an unrestricted rerun after sandbox process permissions blocked them. English/Arabic light/dark and narrow views were visually inspected. Checks used a tracked-source validation copy containing only this focused patch; unrelated local edits were excluded. No installed-package acceptance or Jev calibration is claimed.

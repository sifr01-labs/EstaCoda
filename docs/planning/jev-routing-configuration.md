# Jev routing configuration and decision client — commits 1–3

Status: configuration, validated decision client, and live intent/skill routing implemented. Jev-assisted now controls intent labels and skill selection before prompt assembly. Capability selection/recovery still use the existing runtime path; full Jev capability routing and packaged live acceptance remain pending. Desktop and Setup Editor disclose this scope.

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

Routing configuration contributes to the existing runtime definition fingerprint. Cached executions retain their lease; changed definitions are used after the active execution releases it. An attempted concurrent replacement remains busy. The decision client now checks configuration/catalog revisions before dispatch and acceptance, discarding stale answers. The session builder now supplies current profile configuration/catalog revisions and the turn cancellation signal; in-flight tool execution remains unchanged.

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

## Live intent and skill selection (commit 3)

The shared `AgentLoopBuilder` wires the client for Desktop, CLI, gateway channels and task workers. `AgentLoop` persists the user turn before awaiting routing so auxiliary usage has a valid turn owner. It supplies the original user request or worker assignment, bounded continuity, and separately marked quoted/retrieved material. Expanded project text and dependency prose cannot become a worker's assignment. Existing request requirements, checkpoint continuation and Step completion contracts remain deterministic.

The asynchronous router reads only the selected profile configuration at routing/acceptance boundaries, including while a runtime is leased. Switching to Standard prevents subsequent Jev requests; changed configuration or skill catalogs invalidate outstanding decisions. Both local semantic shadow selection and the optional LLM shadow reranker are skipped for Jev-assisted decisions, including fallback.

Jev evaluates independent Noul questions for the built-in intent taxonomy and every session-visible skill, using skill names and descriptions rather than a keyword shortlist. The initial conservative thresholds accept at 0.8 and reject at 0.2; intermediate, missing or invalid answers fall back to Standard for the entire routing decision. These thresholds are provisional, not a claim of calibration; held-out measurement remains commit 6. Fallback re-resolves the current registry and records configured/actual engine, model, revisions, probabilities and the fallback reason in route events and skill telemetry. Rich cross-surface engine/fallback presentation remains commit 5.

Explicit named skills, aliases, unresolved references, declared negative/defer rules, ready-attachment constraints, save-only continuity and confirmation policies stay authoritative. Several skills or no skill may be selected. For compatibility with existing execution metadata, explicit/checkpoint skills sort first, then applicability probability and stable name order; the first is the primary. No extra exclusive Choice call is needed in this implementation. All selected complementary instruction bodies or existing large-skill contracts travel through the normal protected skill prompt layer, with setup state. Combinations over 32,000 instruction characters fall back instead of silently dropping a selected skill. Only delivered, ready supporting skills count toward instruction receipts. Execution approval and completion evidence remain unchanged.

Security review covers the fixed TypeSafe transport, profile-local credentials/config, current session visibility, declared negative/defer constraints, quoted/retrieved context, worker scope, cancellation and stale selections. Semantic selection changes relevance and instruction loading, never execution authority. No dependency or lockfile changes; no live API or installed-app success is claimed from fixture verification.

Commit 3 validation on Node 24.14.1 / pnpm 10.33.0:

- Final core suite: 754 files / 12,249 tests passed, including 27 routing regressions and shared builder, agent-loop and prompt-assembly integration coverage.
- Frozen dependency check, core typecheck/build, runtime import and ESM audits passed.
- Source and compiled smoke suites: 13/13 each.
- Desktop protocol/type checks, 180 unit tests and 12 English/Arabic runtime-settings browser tests passed. The initial sandboxed Desktop PTY tests were blocked by process permissions; the normal process-enabled run passed.
- Final diff checks passed. Validation used an isolated copy of tracked sources plus these changes because unrelated duplicate source files remain in the working checkout. Unrelated documentation changes were not included.

No installed application/gateway update or live TypeSafe quality measurement was performed in this commit. Capability selection and recovery remain commit 4; live API calibration and packaged acceptance remain commits 6–7.

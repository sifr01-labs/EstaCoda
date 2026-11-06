The pinned Superagent is a policy-gated, durable DSH application, not a standalone runtime or official DeepSeek product. All 456 selected tests passed; repository URL provenance remains unresolved.

## Scope and provenance

- **Assigned scope:** `superagent-application-source-and-tests`.
- **Pinned revision:** `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, recorded in `UPSTREAM.json:2`.
- **Package identity:** `dsh-superagent`, version `0.1.0`, MIT, marked `private: true`; author is **DeepSeek Harness Team <team@dsh.dev>** (`upstream/superagent/package.json:2–7`).
- **Product status:** the README explicitly says **“Research prototype for reference only, not an official DeepSeek product”**, warns that it is not production-ready, and says publication changes mean it is not identical to the internal implementation or article (`upstream/superagent/README.md:3–5`).
- **Authoritative repository URL: unresolved.** The inspected package metadata contains no `repository` field. The README links to a Harness website, not an authoritative Superagent repository. A Markdown search for `github.com/` returned only a parameterized deployment example targeting the operator’s repository (`upstream/superagent/docs/006-deployment.md:152`), which does **not** establish this project’s origin URL. Do not substitute a guessed GitHub address.
- The inspected snapshot lacks `upstream/superagent/.git`: an attempted inspection returned `ENOENT`. Therefore, the revision here is **manifest-attested**, not independently authenticated against a local upstream Git checkout.
- No network extraction was performed; no live-source claims are made.

## Implementation findings

### 1. Authorization is application logic, not merely a prompt

**Primary evidence:** `upstream/superagent/src/policy.ts:167–251`, `settingsPolicy`.

The gate distinguishes explicit requests from inferred candidates:

- An allowed human addressing the agent is admitted explicitly.
- Other human messages are evaluated using admission cells and whether the source actually receives/observes that scope.
- Explicit table admissions are checked before thread follow-ups.
- Participation in an existing thread can admit a follow-up, with different strength for allowed versus other senders.
- Inferred admissions require evaluation mode other than `off`.
- Non-human events take a separate path: identified bots must be on the configured bot list; senderless events need the appropriate observed scope and inferred admission cell.
- `admitsInferred` requires **`auto` mode, at least one matched rule, and all matched rules enabled**.

`revalidate` checks mandates against current source scope, sender/bot membership, admission strength, mode, and enabled rules. An explicit follow-up and an inferred follow-up do not have identical revalidation conditions (`src/policy.ts:213–251`).

**Important qualification:** authorization determines which work may enter or continue through the application. It should not be described as a complete filesystem or operating-system security boundary.

### 2. Proactive handling is configured event observation, not unrestricted autonomous task invention

**Primary evidence:** `upstream/superagent/src/sources/github.ts:24–42`, `GithubConfigSchema`, `scopeOf`, `githubKind`; `:125–180`, `apply`, `watch`, repository stream definitions.

GitHub observation switches exist for issues, PRs, comments, and default-branch CI, and default to **false**. Those switches describe what the source observes; the policy gate still controls admission.

The GitHub plugin:

1. Registers its source kind.
2. Waits for readiness and configuration.
3. Polls in a loop.
4. Reports source health rather than letting an escaped polling rejection terminate the process.
5. Applies configurable failure thresholds and honors a longer configured/server-driven polling interval.

Repository streams include issues, issue comments, and inline review comments. Their comments specify that observation starts when enabled rather than importing the entire prior history (`src/sources/github.ts`, `STREAMS`, `pollRepository`).

GitHub retry handling distinguishes deletion (`410`) from `404`, which may reflect revoked private-repository access; thread read retry state has a 24-hour window (`src/sources/github.ts`, `Retry`, `RETRY_WINDOW_MS`, `deleted`, `failed`).

Optional Feishu is a separately registered source, disabled in the shipped bundle patch (`upstream/superagent/cordis.patch.yml:9–12`). Its detailed transport behavior was **not fully audited** in this bounded selection.

### 3. Durable work lifecycle is distinct from the model session

**Evidence:**

- `upstream/superagent/src/core/evals.ts`, `due`, `delivered`, `expire`, `start`, `policyChanged`, `reassess`.
- `upstream/superagent/src/core/tickets.ts`, `restart`, `end`, `unfinished`, `newAssignment`, `letGo`, `refuse`.
- `upstream/superagent/src/executor/dsh.ts:173–210`, `WorkerSlots`, `DshExecutor`.
- `upstream/superagent/src/app/store.ts:49–78`, `Store`; `:183–210`, settings and trigger persistence.
- `upstream/superagent/src/app/effects.ts:46–147`, `Effects`.

The inspected path separates incoming triggers, policy/evaluation decisions, accepted tickets, assignments, and executor input delivery.

Evaluations have delivery-aware deadlines: an assessment candidate that has not reached the assessor session does not expire merely because wall-clock time passed. Expired evaluations are requeued a bounded number of times and then recorded as unavailable. Pause handling adjusts evaluation timing (`src/core/evals.ts:18–65`).

Ticket lifecycle code explicitly handles interrupted assignments, unread/untaken follow-ups, resumed work, and returning messages for reassessment instead of silently losing them (`src/core/tickets.ts`, symbols above).

Persistence is SQLite-backed:

- `node:sqlite` `DatabaseSync`.
- Database file permission set to `0600`.
- `journal_mode=WAL` and `synchronous=FULL`.
- Tables include triggers, dispositions, threads, tickets, decisions, and outbox entries (`src/app/store.ts:60–78`).
- Settings revisions and per-block optimistic-concurrency revisions are persisted (`src/app/store.ts:183–201`).

`Effects` is a durable execution queue for assessment, launch, delivery, relay, notice, and reply work. It supports concurrency limits, optional ordering, exponential retry delay, and a `Later` condition for deferral without treating resource unavailability as an ordinary failed attempt. Running rows remain for retry on the next start when shutdown interrupts processing (`src/app/effects.ts:11–37, 61–147`).

**Qualification:** these mechanisms support crash/retry recovery; the evidence does not establish universal exactly-once execution of arbitrary shell commands or external side effects.

### 4. Session/workspace separation is real, but is not a strong sandbox claim

**Primary evidence:**

- `upstream/superagent/src/executor/dsh.ts:1–31`, `workerSessionId`, preparation/retry constants.
- `upstream/superagent/src/executor/dsh.ts:173–210`, `WorkerSlots`, `DshExecutor`.
- `upstream/superagent/src/app/sessions.ts:137–153`, `ensure`.
- `upstream/superagent/src/app/sessions.ts:261–303`, worker restrictions and `limitSubagent`.
- `upstream/superagent/cordis.patch.yml:13–79`.

Each ticket has a persistent worker session named `worker-<ticketId>` and its own workspace directory. Worker slots account for startup reservations as well as running work; a human follow-up may use one extra slot beyond the ordinary limit.

`Sessions.ensure` creates/resolves a Harness workspace and session, selects the application preset, and explicitly sets **`danger-full-access`** permissions (`src/app/sessions.ts:137–153`).

Workers and worker subagents are subject to tool restrictions and ticket-liveness checks. The application narrows the tools inherited from a Harness preset; that narrowing must not be confused with proving OS-level isolation.

The bundle’s worker preset shortens shell foreground waits to five seconds and supplies filesystem, search, job, and skill tooling through Harness plugins. Its comments identify tools intentionally omitted from that preset (`cordis.patch.yml:13–79`).

### 5. Recovery has explicit boundaries

**Primary evidence:** `upstream/superagent/src/executor/dsh.ts:27–59`.

Observed recovery choices include:

- Three transient retry attempts for launch or worker turns, with initial 15-second backoff.
- Classification of transient network/provider failures, including relevant HTTP and connection errors.
- A ten-minute workspace preparation timeout.
- A thirty-minute limit for worker background work after its turn ends.
- A ten-second shutdown wait for background work.

A failed workspace preparation is deliberately **not automatically retried**: an existing directory counts as prepared, so retrying blindly could use a partially prepared workspace. The dedicated `PrepareFailed` error documents this limitation (`src/executor/dsh.ts:38–43`).

These are concrete recovery policies, not evidence that all deployment or model failures recover successfully.

### 6. Delivery is retry-aware; code review quality was not demonstrated

**Primary evidence:**

- `upstream/superagent/src/app/delivery.ts:28–84`, `AgentDelivery`, `history`, `send`.
- `upstream/superagent/src/sources/github-channel.ts:17–52`, `sendGithub`.

Agent-session delivery checks persisted history and pending inboxes for delivery identity. It flushes Harness session persistence before acknowledging successful delivery. This is a durability barrier, not just an in-memory “sent” flag.

GitHub replies use a stable HTML marker derived from message identity. Before posting, the implementation searches existing comments by the agent account for that marker. It supports inline review-thread replies and falls back to a top-level PR comment when the original inline target has disappeared. Permanently deleted or locked destinations can be marked gone; other failures remain retryable.

**Review limitation:** the inspected implementation demonstrates delivery into review conversations. It does **not**, by itself, demonstrate an independent reviewer, mandatory human approval before merge, or the quality of generated patches. Those claims remain unverified.

### 7. Harness supplies the underlying runtime capabilities

**Primary evidence:** `upstream/superagent/package.json:28–47, 58–91`; `upstream/superagent/src/app/sessions.ts:137–153, 261–303`; `upstream/superagent/cordis.patch.yml:20–79`.

This package is a **DSH bundle**, with a bundle patch and web client entry. It declares Harness/Cordis peers for agents, sessions, session persistence, workspaces, tools, permission presets, LLM services, subprocesses, system prompts, skills, attachments, and web/UI integration.

The source actually uses Harness session/workspace resolution and creation, permission presets, inherited tool registries, and session-persistence flushes. Thus, persistent worker execution and tool access are **composed from Harness services**, while this application implements policy, source ingestion, tickets, coordination, and delivery.

Package metadata requires Node `^22.19.0 || >=24.0.0` and DSH `^0.2.1-alpha.2` (`package.json:58–61`). This audit did not independently audit Harness internals.

## Test execution

### Configuration reviewed before the reported run

- `upstream/superagent/package.json:52–57`: `test` is `vitest run`; `check` includes typecheck, tests, and build.
- `upstream/superagent/vitest.config.ts:1–3`: tests match `tests/**/*.spec.{ts,tsx}`; React and React DOM are deduplicated.

No dependency installation or setup/deployment script was run for this selection. Prepared dependencies were used.

### Exact completed command

Executed through `terminal_run` with **`waitMs=1000`**, then followed with `process_logs` until termination:

```sh
cd upstream/superagent && node --version && ../../node_modules/.bin/vitest run tests/policy.spec.ts tests/core-engine.spec.ts tests/delivery.spec.ts --reporter=verbose
```

Observed:

```text
Node: v24.14.1
Vitest: v4.1.6
Test Files: 3 passed (3)
Tests: 456 passed (456)
Duration: 1.45s
Exit code: 0
```

The prepared Vitest binary was **4.1.6**, whereas the package declares **4.1.8** in dev dependencies. This is an environment qualification, not a test failure.

### Relevant existing cases observed

Authorization/negative cases in `tests/policy.spec.ts` included:

- “refuses an explicit cell for messages that do not address the agent, in the settings and in a submitted Policy”
- “accepts an inferred candidate on its matched rules in auto mode only, and the Policy admits only enabled matched rules”
- “refuses an assessment that judges one enabled rule twice and leaves another unjudged”
- “revokes an inferred ticket whose cell weakens or whose candidates no longer become work, and reports a deleted rule disabled”
- “admits a bot on its Source's list as an inferred candidate where the Source observes its scope, and no other bot”
- “admits the default branch's CI through its row once observed and set, and never a PR's CI”

Recovery/lifecycle cases in `tests/core-engine.spec.ts` included:

- “starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it”
- “lets no Eval expire while processing is paused, and moves its deadline on by the pause's length”
- “hands the follow-ups on a thread a worker found unrelated back to Eval, with its reason”

Delivery/recovery cases in `tests/delivery.spec.ts` included:

- “retries a failed durability barrier without another delivery and permits concurrent retries”
- “retries history failures and reads past the first page”
- “keeps consumption that happens during the initial history read”
- “does not dispatch when cancelled or disposed during history loading”
- Legacy message-identity compatibility and pending/consumed-message deduplication cases.

**Failed tests in this completed selection: none.**

## Limitations and outstanding obligations

1. The authoritative upstream repository URL remains unverified.
2. Revision identity is grounded in `UPSTREAM.json`; the subject directory has no local `.git` metadata.
3. This was a bounded selection, not the full suite, typecheck, build, deployment, or end-to-end GitHub/Feishu exercise.
4. No live model, real credential, real PR, merge, or production crash-recovery test was performed. Unit-test success is **not evidence of live-model coding performance**.
5. Harness internals, detailed Feishu transport behavior, independent review enforcement, and merge-approval guarantees remain outside verified scope.
6. Some broad exploratory output was truncated, and an attempted `file.grep` call inside `execute_code` was unsupported; subsequent direct file observations supplied the findings above. The failed `.git` inspection was disclosed rather than treated as revision verification.
7. No subject source edits were made. This worker did **not** write `reports/superagent-estacoda-comparison.md`: the parent’s accepted synthesis and verified file write remain outstanding.

Exploration limitations: 1 settled exploratory attempt(s) failed (terminal.inspect). These attempts are not evidence and remain recorded in the worker history. Acceptance of this report does not establish that every requested source was inspected. Use only successful observations and preserve any unresolved coverage gaps in synthesis.

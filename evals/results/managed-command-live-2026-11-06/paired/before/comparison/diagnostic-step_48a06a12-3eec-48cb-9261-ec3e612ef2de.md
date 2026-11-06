Superagent is a Harness application, not an independent runtime. The selected 674 tests passed, but repository evidence acceptance and upstream provenance remain incomplete.

## Evidence status and correction

The earlier draft overstated completion of the repository-evidence requirement.

- **Accepted file-tool observations:** `upstream/superagent/src/policy.ts` and `upstream/superagent/src/executor/dsh.ts` were read with `file.read`.
- **Other repository observations:** the README, manifest, configuration, architecture, source adapters and tests were inspected through terminal commands. Those observations support the technical investigation, but **do not satisfy the explicit requirement that repository citations be observed through file tools**.
- No further tools are available in this request. Below, those findings are explicitly marked **terminal-observed, file-tool confirmation outstanding** rather than presented as fully accepted repository evidence.
- Test execution is independently supported by the completed terminal result; it need not be rerun merely to correct citation provenance.

## Identification and revision

**Terminal-observed; file-tool confirmation outstanding:**

- `UPSTREAM.json:2` declares Superagent revision **`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`**.
- `upstream/superagent/README.md:3–5` explicitly describes it as a **research prototype, not an official DeepSeek product**, warns against treating it as production-ready, and states that some article designs are future work.
- `upstream/superagent/README.md:7` describes a coding application for **one GitHub repository**, packaged as a **DeepSeek Harness bundle**, with optional Feishu intake and a web panel.

**Independent commit verification failed:** the fixture’s upstream directory resolved to the enclosing workspace Git repository. The observed HEAD, `8d664f7bee049bc2ff2c39d9a5bcd8f6617a4148`, was therefore not an authenticated upstream revision. This command failed:

```sh
git cat-file -t 8c32a9dc5d72c033816c6a8110b37f40cf94fba4
```

Output: `fatal: git cat-file: could not get object info`.

The source must be described as **fixture content declared pinned by `UPSTREAM.json`**, not an independently verified checkout.

**Canonical project URL remains unresolved.** Searches did not establish a canonical repository URL from the inspected material. Deployment documentation uses `git clone <this repository>` (`upstream/superagent/docs/006-deployment.md:77`, terminal-observed). The README’s Harness website link is not a Superagent repository URL. No fresh launch, live availability or canonical GitHub URL was verified.

## Findings grounded in file-tool observations

### Authorization is a substantive application layer

`upstream/superagent/src/policy.ts`, symbols `settingsPolicy`, `assessmentOutcome`, `directionAllowed`:

- Authorization uses source-specific identities; it does not map a person’s Feishu authority onto GitHub.
- Human requests are distinguished by allowed sender, addressed status, source scope, admission-table cells and thread participation.
- Nonhuman events use a separate machine gate. Listed bots can become inferred candidates under suitable settings; arbitrary bots do not receive equivalent authority.
- Configurable admission cells matter: “only allowlisted people can ever originate work” would be an overstatement.
- Assessment acceptance validates enabled-rule coverage, settled implementation direction, a matched enabled rule and intent evidence.
- An inferred candidate outside `auto` mode becomes an observation, not an accepted work item.
- `revalidate` checks whether an existing Mandate still holds under current policy.

Precise assessment references: `upstream/superagent/src/policy.ts:26–63`. Other policy references use the observed symbols above.

### Execution is per Ticket, with configuration-driven workspace preparation

`upstream/superagent/src/executor/dsh.ts`:

- Worker Session IDs follow `worker-<ticketId>` (`:24–26`, `workerSessionId`).
- `ticketExecution` assigns execution metadata and a per-Ticket directory.
- `WorkerSlots` synchronously reserves startup capacity before asynchronous launch/wake operations. It accounts for running work and permits one additional slot for human follow-ups.
- `prepareDirectory` runs the configured workspace preparation command with ticket environment variables, then verifies the directory.
- Preparation has a ten-minute timeout (`PREPARE_TIMEOUT_MS`, `:27–28`).
- Failed preparation is deliberately not retried automatically: a partially populated directory could otherwise be mistaken for successful preparation (`PrepareFailed`, `:40–43`).
- The application integrates with host Session management through its `Sessions` dependency; this does not establish an independently implemented general-purpose runtime.

**Boundary:** a separate directory is not inherently a Git worktree or an OS/container security sandbox. Worktree creation depends on the configured prepare command.

## End-to-end implementation paths

The following paths were **observed through terminal inspection; file-tool confirmation remains outstanding**.

### GitHub → authorization → work item

1. `pollRound`, `pollNotifications` and `readNotified` ingest repository/notification activity; subscribed threads and PR/CI state have dedicated polling paths.
   `upstream/superagent/src/sources/github.ts:280–344`, `:384–440`.
2. `Intake.receive` normalizes timestamps, deduplicates IDs, checks Source scope, stores dispositions and fans events out to subscribed Tickets.
   `upstream/superagent/src/core/intake.ts:19–43`.
3. Evaluation invokes the policy gate.
   `upstream/superagent/src/core/evals.ts:96`, `:273`.
4. Acceptance records a Decision and creates a Ticket under a Mandate.
   `upstream/superagent/src/core/evals.ts:306–314`.
5. `Tickets.create` captures originating channels, creates the first Assignment, subscribes threads, optionally acknowledges, and starts execution.
   `upstream/superagent/src/core/tickets.ts:37–55`.

### Feishu → the same domain pipeline

- Live CLI consumption invokes `event consume im.message.receive_v1 --as bot`.
  `upstream/superagent/src/sources/feishu-loops.ts:70–72`.
- Enabled-state checks and consumer restart/backoff are implemented.
  Same file, `:42–69`.
- Normalized Triggers enter `ctx.receive`.
  Same file, `:26–32`.
- History recovery and subscribed-thread polling are implemented by `backfillChat` and `pollThreads`.
  Same file, `:166`, `:218`.

These feed the same Intake → Policy → Eval → Decision → Ticket machinery.

### Ticket → Session/worktree

- `Sessions.ensure` resolves an agent or creates a workspace and Session through Harness services.
  `upstream/superagent/src/app/sessions.ts:138–146`.
- Worker launch ensures the Session at the Ticket’s execution directory.
  `upstream/superagent/src/executor/dsh.ts:424–441`.
- The deployment guide supplies a configurable `git fetch`/`git worktree add` preparation example.
  `upstream/superagent/docs/006-deployment.md:152–153`.

### Reply/PR lifecycle

- Persistent receipts and reply effects are recorded atomically. Delivery handles disabled Sources, conversation ordering, channel authorization and permanently unavailable targets.
  `upstream/superagent/src/app/outbox.ts:26–50`.
- GitHub outbound delivery uses message-ID HTML markers to suppress duplicate comments and supports inline review replies.
  `upstream/superagent/src/sources/github-channel.ts:18–43`.
- Feishu replies use threaded delivery with an idempotency key.
  `upstream/superagent/src/sources/feishu-channel.ts:19–29`.
- PR creation is **worker-driven**, not a demonstrated deterministic host `createPullRequest` operation. Worker instructions require reporting `pr_number` after creating/adopting a PR; the host claims, binds and observes PR lifecycle.
  `upstream/superagent/skills/dsh-superagent-github/SKILL.md:14`; `upstream/superagent/src/sources/github-pull.ts:35–80`.

## Negative, recovery and concurrency coverage inspected

**Terminal-observed test references; file-tool confirmation outstanding:**

| Area | Existing coverage |
|---|---|
| Negative authorization | Disabled/unloaded Sources, source-specific identities, unlisted DMs, nonhuman senders: `upstream/superagent/tests/policy.spec.ts:32–84` |
| Mandate revalidation | Authorization/rule/admission changes: same file, `:208–222`, `:391`, `:435–440` |
| Policy changes during work | Active workers receive constraints rather than universally being killed: `upstream/superagent/tests/runtime.spec.ts:408` |
| Restart recovery | Running Assignments relaunch with recovery notes: same file, `:523–535` |
| Stop/delivery races | No delivery after a human stop while waiting: `upstream/superagent/tests/runtime-concurrency.spec.ts:51–83` |
| Crash/input recovery | Waiting and claimed Inputs across restarts: same file, `:597`, `:681`, `:693`, `:710` |
| Source recovery | Invalid history pages, retained cursors, restarted consumers and failed streams: `upstream/superagent/tests/sources.spec.ts:217`, `:1112`, `:1176`, `:1269` |
| Outbox recovery | Pause/resume and delayed Source registration: `upstream/superagent/tests/outbox.spec.ts:17–30` |

## Executed bounded regression run

Package scripts and Vitest configuration were inspected before execution. The script is `test: vitest run`; `check` additionally runs typecheck and build. Configuration includes `tests/**/*.spec.{ts,tsx}` with React deduplication (`upstream/superagent/vitest.config.ts:1–3`, terminal-observed).

Actual command:

```sh
cd upstream/superagent && ./node_modules/.bin/vitest run tests/policy.spec.ts tests/core-engine.spec.ts tests/sources.spec.ts tests/runtime-concurrency.spec.ts tests/runtime.spec.ts tests/outbox.spec.ts tests/environment.spec.ts
```

Tool parameters:

```text
verification = 'superagent-regressions'
verificationInputs = ['.']
```

**Completed exit code: 0.**

| Test file | Passed |
|---|---:|
| `policy.spec.ts` | 328 |
| `core-engine.spec.ts` | 113 |
| `sources.spec.ts` | 71 |
| `runtime-concurrency.spec.ts` | 56 |
| `runtime.spec.ts` | 91 |
| `outbox.spec.ts` | 2 |
| `environment.spec.ts` | 13 |
| **Total** | **674** |

- **7/7 files passed; 674/674 tests passed.**
- **Failed tests: 0 in this selected run.**
- Reported duration: **9.79 seconds**.
- Observed environment: Node **v24.14.1**, Vitest **v4.1.8**.
- Node emitted an experimental SQLite warning, not a test failure.
- **Missing prerequisites for this subset: none observed.**
- No dependencies were installed and no setup/lifecycle scripts were invoked.
- No source edits were made; the observed final tracked-file status was clean.

## Outstanding obligations and interpretation limits

1. **Repository evidence acceptance remains incomplete:** obtain file-tool observations for the terminal-only references before treating the entire audit as evidence-compliant.
2. **Canonical repository URL and upstream commit authentication remain unresolved.**
3. Full suite, typecheck and build were **not run**.
4. The tests use substituted agents, CLI responses and delivery operations. They do not establish a live authenticated deployment or live-model coding quality.
5. No live-model performance comparison or winner is supported by these test counts.
6. Harness and EstaCoda implementation comparison belongs to the other assigned scopes.
7. **`reports/superagent-vs-estacoda.md` was not written by this worker.** The accepted synthesis, verified write and readback remain the parent synthesizer’s obligation.

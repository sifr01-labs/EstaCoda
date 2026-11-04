The pinned bundle is a research prototype, not an official DeepSeek product. Its authorization, recovery and concurrency tests passed; live launch claims remain unverified.

## Scope and provenance

- **Assigned scope:** `superagent-bundle`; no full investigation of EstaCoda or the separate Harness source.
- **Comparison date:** **2026-11-04 UTC**, obtained with `date -u +%Y-%m-%d`.
- **Snapshot pin:** `UPSTREAM.json:2` records superagent revision **`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`**. This is snapshot provenance, **not verification of a git checkout at that revision**.
- **Package identity:** `dsh-superagent`, package version `0.1.0`, MIT license, author field `DeepSeek Harness Team <team@dsh.dev>` (`upstream/superagent/package.json`, symbols `name`, `version`, `license`, `author`).
- No dependencies installed, setup scripts executed, or source/configuration/network changes intentionally made.

## 1. Identity: important correction to the premise

The repository README explicitly says:

> “Research prototype for reference only, not an official DeepSeek product.”

It also says the published code differs from the internal implementation and the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*, and that some article designs remain future directions (`upstream/superagent/README.md:3–5`).

Consequently, describe this comparison as **the pinned published research prototype**, not a benchmark of all ideas in the article or an official production DeepSeek product.

**Authoritative URL evidence found:** the README links DeepSeek Harness to `https://www.deepseek.com/en/harness/` (`upstream/superagent/README.md:7`). This is a **repository-observed link**, not a fetched or independently verified live page.

**Project repository URL gap:** I did not obtain source proof identifying the authoritative superagent repository URL. The previously guessed `https://github.com/deepseek-ai/dsh-superagent` must remain unverified. Network access was not attempted or bypassed. No launch date, current/latest release, or live availability claim is established here.

## 2. Bundle versus host: what should receive credit

| Capability | Bundle evidence | Attribution / qualification |
|---|---|---|
| Proactive repository intake | README describes one GitHub repository with optional Feishu input (`README.md:7`) | Bundle application, not a general-purpose multi-repository platform claim |
| Authorized admission | `src/policy.ts`, `settingsPolicy`, `gate`, `revalidate`; `tests/policy.spec.ts:61,82–86,205–222` | Bundle policy gates and mandate checks |
| Ticket-oriented work | `tests/core-engine.spec.ts:115–146` covers ticket creation, mandate, subscription, acknowledgment, assignment and transactional acceptance | Bundle domain/workflow |
| Durable side effects | `src/app/effects.ts`, `Effects.enqueue`, `dispatch`, `attempt`, `drain` | Bundle SQLite queue with retries, ordering and concurrency |
| Worker sessions and tools | `src/app/sessions.ts:61,137–152,292`, `WORK_TOOLS`, session creation and tool filtering | Bundle selects/decorates sessions; underlying session/tool execution is a Harness interface |
| Web/file/shell/skill/subagent access | `docs/007-architecture.md:532`; package peer dependencies | Harness facilities exposed and restricted by the bundle—not independent bundle implementations of every tool |
| Operational web panel | README (`README.md:7`); panel and API source paths present under `src/client/` and `src/app/` | Source-present; not exercised in my selected tests |
| Execution isolation | `docs/006-deployment.md:13–19`; `src/app/sessions.ts:152` | **Not OS isolation:** sessions use `danger-full-access` as the operator’s OS user |

The package declares DSH bundle metadata and numerous Harness peer dependencies, including sessions, tools, workspace, permission presets, subprocess and persistence (`upstream/superagent/package.json`, fields `dsh`, `peerDependencies`). It requires Node `^22.19.0 || >=24.0.0` and DSH `^0.2.1-alpha.2` (`engines`).

**Inference:** the meaningful comparison unit is “superagent workflow bundle + required Harness host,” rather than treating the bundle as a standalone replacement for an entire agent runtime.

## 3. Security boundary: authorization is not sandboxing

### Implemented and tested admission controls

- Per-source identity lists: a Feishu identity grants nothing on GitHub (`tests/policy.spec.ts:61`).
- Rejection of unauthorized addressed/direct messages in applicable configurations (`tests/policy.spec.ts:82–86,104–105`).
- Mandate revalidation when allowed members, source settings, evaluation mode or rule state change (`tests/policy.spec.ts:205–222`).
- Rejection/reassessment when policy version changes during assessment (`tests/core-engine.spec.ts:146`).
- Ended-ticket mandate checks in `src/core/tickets.ts:113,257`.

**Nuance:** do not summarize this as “all nonmembers are always ignored.” Configured inferred-admission and follow-up paths exist. Policy tests explicitly distinguish explicit authority, inferred admission and follow-up/context handling (`tests/policy.spec.ts`, describes `gate`, `revalidate and version`).

### Execution exposure

The deployment documentation says both presets run with `danger-full-access`, workers can execute programs by path and read the operator’s home directory, and account wrappers do not isolate processes. It recommends a dedicated OS account (`docs/006-deployment.md:19`). Session creation explicitly sets this preset (`src/app/sessions.ts:152`).

**Practical implication:** passing authorization tests does not establish containment against malicious tool output, prompt injection, secret exfiltration, or destructive shell commands. Those require separate adversarial/OS-boundary evaluation.

## 4. Recovery and concurrency evidence

`src/app/effects.ts`, class `Effects`, implements:

- SQLite-backed effect rows and transaction-aware dispatch.
- Coalescing by kind/key while retaining queue position.
- Per-kind concurrency and optional strict ordering.
- Exponential retry backoff.
- `Later` deferral without incrementing failure count.
- Sequence/generation checks preventing a completed stale attempt from deleting a newer payload.
- Shutdown drain preserving pending work.

Selected tests directly cover:

- Commit versus rollback effects (`tests/effects.spec.ts:29`).
- Concurrency limits and zero-limit holding (`:51`).
- Retry backoff/health threshold (`:85`).
- Drain/restart persistence (`:105,174`).
- Cancellation/requeue during an active attempt (`:160`).
- Interrupted assignments restarting with recovery notes (`tests/core-engine.spec.ts:701–723`).
- Stop-versus-delivery races, parallel prepare operations and pause/resume launch races (`tests/runtime-concurrency.spec.ts`, corresponding test names).

The execution documentation further describes preserving sessions/directories/subscriptions and replaying unread inputs during restart (`docs/003-execution.md`, sections **Restart** and **Stored work**).

**Qualification:** deterministic tests establish modeled recovery behavior, not exactly-once external side effects. A worker is instructed to inspect git/GitHub before repeating outside actions after restart; that is not proof that arbitrary external actions are idempotent.

## 5. Executed checks and receipts

Package scripts were inspected **before execution**:

```json
"build": "tsdown",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"check": "pnpm typecheck && pnpm test && pnpm build"
```

Source: `upstream/superagent/package.json`, `scripts`. `vitest.config.ts` includes `tests/**/*.spec.{ts,tsx}` and React deduplication; no setup script is declared there.

### Actual test command

```sh
cd upstream/superagent && ./node_modules/.bin/vitest run tests/policy.spec.ts tests/core-engine.spec.ts tests/effects.spec.ts tests/runtime-concurrency.spec.ts
```

**Exit code: 0. Vitest 4.1.8.**

| Existing suite | Result | Count | Reported suite time |
|---|---:|---:|---:|
| `tests/policy.spec.ts` | Passed | 328 | 32 ms |
| `tests/core-engine.spec.ts` | Passed | 113 | 106 ms |
| `tests/effects.spec.ts` | Passed | 13 | 335 ms |
| `tests/runtime-concurrency.spec.ts` | Passed | 56 | 7,679 ms |
| **Total** | **4 files passed** | **510 passed** | **8.28 s overall duration** |

Node emitted an experimental SQLite warning; no test failures or prerequisite failures occurred for this command.

**Do not use these counts or timings as a capability or performance ranking.** The tests have different scopes and mocks; they are not comparative coding tasks or production throughput measurements.

### Other commands / failures

Exploration command:

```sh
pwd; date -u +%Y-%m-%d; ls -d node_modules upstream/superagent/node_modules 2>/dev/null; find . -name UPSTREAM.json -not -path '*/node_modules/*' -maxdepth 4; cat upstream/superagent/vitest.config.ts; command -v node; command -v pnpm; command -v vitest
```

**Exit code: 1**, because the final global `command -v vitest` found no executable. The local Vitest binary existed and subsequently ran successfully. Both dependency directories were observed; no installation was needed.

A file inspection of `upstream/superagent/tests/fixtures/runtime.ts` returned **ENOENT**. This was an incorrect inspection path, not a test prerequisite failure. A broad globbed text search returned no matches and provided no evidence.

**Not run:** full suite, typecheck, build, production setup, credentials-dependent integration, live GitHub/Feishu operations, real model execution, OS isolation/security attack tests.

## 6. Workload implications for synthesis

- **Strong evidenced fit:** persistent, team-facing, single-repository issue/chat intake with policy-controlled admission, ticket lifecycles, worker recovery and concurrency coordination.
- **Operational caution:** prototype disclaimer plus unrestricted operator-user execution makes deployment security materially different from application-level admission correctness.
- **No established win against EstaCoda:** this scope supplies positive bundle evidence, not a controlled comparative coding result. Absence of another capability from these inspected files must not become an unsupported “missing” feature claim.
- **Fair next benchmark:** same model/version, token and cost budget, task corpus, repository state and host resources; measure independently graded task success, valid changes, human interventions, unauthorized-action rate, duplicates/losses after injected failures, recovery latency and total cost. Include unauthorized senders, policy changes mid-assessment, stop during launch/delivery, crash during unread-input delivery and worker-slot saturation. Run repeated trials and distinguish bundle configuration from host behavior.

No report file was written by this worker; this text is the complete delegated scope result for the synthesizer.

Exploration limitations: 2 settled exploratory attempt(s) failed (file.read, terminal.run). These attempts are not evidence and remain recorded in the worker history. Acceptance of this report does not establish that every requested source was inspected. Use only successful observations and preserve any unresolved coverage gaps in synthesis.

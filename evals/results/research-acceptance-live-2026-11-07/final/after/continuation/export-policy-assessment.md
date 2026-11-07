Superagent’s source shows scoped work admission. The recorded test attempt failed to load zod; no policy behavior was verified. Findings are partial.

# DeepSeek Superagent Policy Assessment

## Evidence basis and scope

The assigned scope, `superagent-policy-source-and-single-test`, **failed to complete successfully**. No accepted worker result was available. This assessment therefore uses the retained runtime source excerpts and terminal receipt, not the worker’s unaccepted conclusions.

The source excerpts support narrow static findings and observations about authored tests. Several reads were truncated, including important portions of `src/policy.ts` and `tests/policy.spec.ts`. They do not support a complete implementation audit or repository-wide claims about absent safeguards.

`UPSTREAM.json:2` records Superagent revision `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. This is a recorded pin, not independently verified checkout integrity. The manifest identifies private ESM package `dsh-superagent`, version `0.1.0`, described as evaluating incoming GitHub and optional Feishu requests under a policy, creating tickets, and executing them in DSH sessions (`upstream/superagent/package.json:2-9`). This assessment concerns that recorded source snapshot, not an independently checked latest release.

## Static implementation findings

### 1. The policy concerns admission of incoming work

The policy module describes its responsibilities as runtime settings schemas, assessment validation, and policy-gate evaluation. It explicitly states that authorization to originate work is configured per source using that source’s identities, without mapping a person across sources (`upstream/superagent/src/policy.ts:1-4`).

This is evidence of a source-scoped work-admission design. It is **not evidence of a comprehensive filesystem, shell, network, or execution-sandbox permission system**.

### 2. Admission distinguishes explicit requests, inferred candidates, and ignored messages

The complete retained admission module defines the following defaults and permitted classifications (`upstream/superagent/src/admission.ts:1-13`):

| Sender/message relationship | Declared admission semantics |
|---|---|
| Listed sender addressing the agent | Explicit request, outside the admission table |
| Listed sender not addressing the agent | Inferred by default; configurable to ignore |
| Unlisted sender addressing the agent | Ignore by default; configurable to explicit or inferred |
| Unlisted sender not addressing the agent | Ignore by default; configurable to inferred |

Only the **unlisted-addressed** table cell permits `explicit`; unaddressed cells permit only `inferred` or `ignore`. The runtime schema repeats these restrictions (`upstream/superagent/src/policy.ts:74-77`).

Consequently, a sender allowlist is not the only possible basis for admission: the schema expressly permits an addressed message from an unlisted sender to receive explicit classification through configuration. “Unlisted” should not be interpreted as an unconditional denial.

### 3. Configuration defaults are conservative about membership and autonomous evaluation

Source-policy settings default to an empty allowed list and empty admission table. The policy-source map defaults to `{}`. Evaluation mode defaults to `observe`, with `off`, `observe`, and `auto` as the permitted values (`upstream/superagent/src/policy.ts:74-87`).

These are **schema defaults**, not verified operational behavior. The retained excerpts do not establish the complete downstream consequences of each evaluation mode.

### 4. Direction validation requires implementation intent and a settled target

`AdmissionDirectionSchema` requires:

- An `implementation_requested` boolean.
- A target basis of `specified`, `existing-standard`, or `undetermined`.
- A `requires_design_decision` boolean.
- Nonempty, length-bounded evidence.

`directionAllowed` returns true only when schema validation succeeds, implementation was requested, the target is not undetermined, and no design decision remains (`upstream/superagent/src/policy.ts:18-29`).

This validates the **structure and supplied values** of an assessment. It does not independently establish that the evidence is truthful or that the target is actually settled.

The retained `assessmentOutcome` documentation also describes acceptance as requiring settled direction, at least one matched enabled rule, and `intent_evidence`. However, the corresponding function body was not retained completely; its full enforcement cannot be established from that excerpt alone.

### 5. Reviewer approval can be expressed in rule instructions

The rule schema stores an identifier, name, enabled flag, and instruction text. Its documentation says instructions may specify PR reviewers and whether to wait for approval (`upstream/superagent/src/policy.ts:66-69`).

That supports **instruction-level expression of approval requirements**. It does not demonstrate an enforced reviewer-signoff state machine, confirmation-token exchange, or human approval queue. Conversely, incomplete source coverage does not justify claiming that no such mechanism exists elsewhere.

### 6. The visible machine gate filters named nonhuman actors and receiving scope

The retained beginning of `machineGate`:

- Looks up named actors on a bot list.
- Rejects named actors not found there with `not_human`.
- Requires a listened scope.
- Requires the trigger to be addressed or its scope observed.

Its documentation describes listed bots as inferred candidates and also mentions senderless system/CI events (`upstream/superagent/src/policy.ts:172-178`).

The excerpt ends before the complete machine-admission decision. Final strength assignment, evaluation-mode effects, and senderless-event handling therefore remain only partially inspected.

## Authored tests: intentions, not verified behavior

The retained test excerpts show assertions intended to exercise the following cases. **None of these assertions executed in the recorded attempt.**

| Area | Visible authored expectations |
|---|---|
| Follow-ups and thread participation | Listed-sender follow-ups are explicit; guest follow-ups are inferred; context-only ticket subscriptions do not confer the same follow-up admission. |
| Observation and evaluation | Observed unaddressed messages from allowed senders become inferred candidates; turning evaluation off rejects the illustrated candidate. |
| Direct messages | An unlisted direct-message sender is rejected under the illustrated default configuration, even on a thread with a ticket. |
| Admission-table precedence | Explicit table admission retains explicit classification; an `ignore` cell does not necessarily veto a participating-thread follow-up. |
| Mandate revalidation | Weakening an admission cell can invalidate a mandate; source removal, loss of listening, evaluation-mode changes, and rule disablement affect illustrated cases. |
| Assessment judgments | Duplicating one enabled-rule judgment while leaving another unjudged is expected to throw; judging both once permits the illustrated matched-rule acceptance. |
| Policy-change effects | Authored assertions distinguish requester-authorization loss from cessation of inferred work. |
| Source scopes | GitHub issue, pull, comment, and CI receiving scopes have distinct observation and admission-row expectations. |

Relevant source locations: `upstream/superagent/tests/policy.spec.ts:31-87`, `:89-166`, `:205-231`, `:277-345`, `:347-409`, and `:410-487`. These ranges locate the relevant test sections; the retained excerpts do **not** expose every assertion within those ranges.

The follow-up expectations are particularly important for configuration review: an admission-table `ignore` value should not be assumed to be a global deny-overrides-allow rule. This is supported as **authored intent**, not demonstrated runtime behavior.

## Single-test attempt and loading failure

### Command provenance and working directory

The unaccepted diagnostic draft records this exact single command:

```sh
ROOT="$(pwd -P)"; VITEST="$ROOT/node_modules/.bin/vitest"; cd upstream/superagent && "$VITEST" run tests/policy.spec.ts
```

It records the starting workspace as:

```text
/private/tmp/estacoda-research-acceptance-final-20261107/after/continuation/workspace
```

**Provenance limitation:** the retained terminal receipt contains process output, not the submitted command or initial working-directory arguments. The command above is preserved as diagnostic metadata, not independently authenticated command-input evidence. The receipt directly corroborates the runner’s test directory:

```text
/private/tmp/estacoda-research-acceptance-final-20261107/after/continuation/workspace/upstream/superagent
```

One terminal-attempt receipt is retained under verification label **`prototype-policy-tests`**. It establishes the following:

| Field | Recorded observation |
|---|---|
| Runner | Vitest `4.1.6` |
| Target suite | `tests/policy.spec.ts` |
| Process PID | `41509` |
| Exit | Code `1`, signal `null` |
| Test-file result | `1 failed (1)` |
| Test execution | `0 test`; final summary: `no tests` |
| Duration | `215ms` |
| Failure stage | Suite loading/import |

### Loading diagnostics

```text
FAIL tests/policy.spec.ts [ tests/policy.spec.ts ]

Error: Cannot find package 'zod' imported from /private/tmp/estacoda-research-acceptance-final-20261107/after/continuation/workspace/upstream/superagent/src/policy.ts

❯ src/policy.ts:6:1
❯ tests/policy.spec.ts:2:1

Test Files  1 failed (1)
     Tests  no tests

Duration  215ms (transform 69ms, setup 0ms, import 0ms, tests 0ms, environment 0ms)

closed with code 1 signal null
```

The manifest declares `zod: "4.4.3"` (`upstream/superagent/package.json:60-63`), and the policy module imports it at `upstream/superagent/src/policy.ts:6`. The observed missing prerequisite was **a resolvable `zod` package in the test environment**. The receipt does not establish whether other prerequisites would also be missing after that import issue.

**Verification outcome: unsuccessful. No policy behavior was verified.** This was a loading failure, not a failed policy assertion, and it must not be described as passing. No dependency installation, test retry, or source modification was performed for this synthesis.

## Material limitations and conclusion

The failed delegated scope leaves these questions unresolved:

- Complete human-gate branch order and integration with upstream trigger filtering.
- Full assessment-outcome enforcement and evaluation-mode behavior.
- Complete mandate-revalidation logic and the effect of policy changes on active execution.
- Enforced reviewer approval, executor isolation, and consumer-side safeguards.
- Checkout integrity and behavior beyond the recorded snapshot.

The diagnostic draft makes broader claims about these areas, but truncated runtime excerpts do not independently establish them. Those claims are not adopted here.

The supported conclusion is narrow but useful: Superagent’s visible policy design separates source-scoped explicit requests from inferred candidates, exposes configurable admission for unlisted addressed senders, and validates supplied implementation direction. Authored tests describe nuanced follow-up and revalidation semantics. Operational confidence remains limited because the sole retained test attempt stopped during loading, before any policy assertion ran.

Runtime evidence limits: Some source findings use captured observations from incomplete workers; those workers did not complete successfully. Unresolved checks: prototype-policy-tests. 0 observations omitted; excerpts may be truncated.
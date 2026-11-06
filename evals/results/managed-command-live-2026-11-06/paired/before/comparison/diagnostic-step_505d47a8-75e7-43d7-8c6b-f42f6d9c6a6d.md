EstaCoda implements durable delegation and guarded execution. Tests yielded 837 passes and one missing-document failure; baseline and manifest integrity remain unverified.

## Audit disposition

**Source audit completed with qualifications; verification is not wholly passing.**

- Assigned scope: EstaCoda runtime source, not the external-project audit or final comparative synthesis.
- **`estacoda-regressions` remains unresolved/failed:** the second regression command exited 1.
- No source edits or dependency installations were performed.
- This worker did **not** save `reports/superagent-vs-estacoda.md`; saving and verifying the accepted synthesis remains the parent workflow’s obligation.
- No live-model coding benchmark, live service validation, or fresh launch verification was performed. Test counts are not comparative coding performance.

All environment and source-state observations below refer to the executed audit, not a newly rechecked deployment.

## 1. Revision and integrity evidence

| Item | Observed result |
|---|---|
| Audit timestamp | `2026-11-06T10:14:55Z`, from `date -u` |
| Workspace HEAD | `8d664f7bee049bc2ff2c39d9a5bcd8f6617a4148` |
| Declared baseline | `62246ec5afb60cde7d1a9cb4d57b0bcfb421f1b2` (`MANIFEST.json:2`) |
| Baseline reconstruction | Blocked: `git cat-file -t` returned exit 128, “could not get object info” |
| Manifest source hashes | **All nine mismatched** computed workspace SHA-256 values |
| Runtime used for tests | Node `v24.14.1`, Vitest `4.1.6`, Darwin arm64 |
| Tracked modifications | None reported by `git status --short`; prepared `UPSTREAM.json`, `node_modules`, and `upstream/` were untracked |

`package.json` declares Node `>=22.18.0` and Vitest `^4.1.5`. Root `AGENTS.md` describes a prepared source fixture, not deployed services.

### Manifest discrepancy

The following are the **computed workspace hashes**, not the differing declared values in `MANIFEST.json:4–12`.

| File | Computed SHA-256 |
|---|---|
| `src/process/managed-command.test.ts` | `5031a05df3d2c9568d65b0d23ad49411595d834acb1519dc23a7c5b0bfefe2a8` |
| `src/process/process-manager.ts` | `9cb8543a574ed8127c752f0707e93512825d5ed1333fba1b0b4811be0f51ce4a` |
| `src/runtime/recoverable-draft.test.ts` | `d5fa8734013eb13d280feb42aefc28caa55e89d6ec9a7d216310e451ddeb779d` |
| `src/runtime/recoverable-draft.ts` | `cc47c5263031e0bff3e09cae8a78b6b5d841f127063044d152c7efbcc427c12a` |
| `src/tasks/agent-step-executor.test.ts` | `13146ea810ad12c0d3475eef240a6835bbd10052916e733ec18c92ed6ab3eb77` |
| `src/tasks/agent-step-executor.ts` | `dc8a1a5399f9ddfe77fe3ce0b2330afa3c208db44105bbe0354438ca5acc4e2b` |
| `src/tasks/task-scheduler.test.ts` | `00088c998f3b3e7cb17a7f8947f9f4faa6b63ff9b2b54f409f340d4f11ce0119` |
| `src/tasks/task-scheduler.ts` | `ad7a9bdb8205f20fe8e46c6b8ebf42e64b22be61412c983e8a23531f0a367e4b` |
| `src/tools/workspace-tools.ts` | `b7e6730ef73178ec9f16c6ccec48a7ce586745a6bfdea6a4e8b31a0aad08489d` |

**Implication:** tests establish behavior of the observed workspace. They do not authenticate correspondence to the declared baseline or updated-source hashes. The cause of the mismatch was not established, and the manifest was not changed.

## 2. Concrete implementation findings

### Durable delegation and scheduling

EstaCoda has an end-to-end implementation beyond a delegation prompt:

1. **Admission:** `createDelegationTools` registers `delegate_task` and requires a stable provider tool-call ID for idempotent creation (`src/tools/delegation-tools.ts:48–56`, `:169–176`). Batch validation covers authority fields, roles, model overrides, and research scopes (`:491–565`).
2. **Persistence:** `SQLiteTaskStore` provides transactional Task storage, with transaction lifetime checks (`src/tasks/sqlite-task-store.ts:103`, `:1581–1599`, `:1754–1767`).
3. **Dispatch:** `TaskScheduler.#dispatchEligibleTasks` reconciles current host grants, approvals, and abandoned work; selects ready Steps; applies capacity, retry-delay, and execution-limit checks; claims and leases Attempts; then installs abort, heartbeat, and deadline guards (`src/tasks/task-scheduler.ts:263–337`).
4. **Worker construction:** `AgentStepExecutor.execute` checks workspace matching and live trust, parent session/profile, execution target, lineage, and Attempt lease before constructing a child (`src/tasks/agent-step-executor.ts:131–181`). Child authority is narrowed by Step policy and parent-visible tools (`:162–215`).

**Repo-agent relevance:** useful infrastructure for independent repository investigations, dependency-aware work, controlled parallelism, and durable continuation. It does not establish that decomposition or generated patches are good.

### Recovery and uncertain side effects

- Checkpoints require the current owner/fence and renew leases (`src/tasks/task-scheduler.ts:467–541`).
- Lease guards abort stale/lost execution and bound renewal after local abort (`:547–613`).
- Reconciliation detects abandoned/expired Attempts (`:793–836`).
- Retry decisions consider limits, failure classes, idempotency, and uncertain side effects (`:2271–2302`).
- Acceptance is distinct from execution: result validation and execution limits precede completed publication (`:1418–1466`, completion transition at `:1542`).

`recoverableDraft` explicitly treats recovery as **disclosure of unaccepted text**, not evidence acceptance. It blocks uncertain effects and privileged activity outside narrowly settled workspace writes, then strips reasoning and redacts credentials/sensitive text (`src/runtime/recoverable-draft.ts:6–18`). Worker recovery context likewise instructs independent verification of previous drafts (`src/tasks/agent-step-executor.ts:556–558`).

Executed scheduler cases included uncertain non-idempotent work requiring review, cancellation rejecting late success, lease renewal, bounded accounting recovery, publication rollback, and approval resumption with a higher fence. Specific test anchors include `src/tasks/task-scheduler.test.ts:599`, `:713`, `:858`, and `:913`.

**Limit:** this is not an exactly-once guarantee for arbitrary external effects. Uncertain work can require operator review.

### Tool policy and exact approval

The execution path distinguishes tool visibility from authority:

- Policy assesses the actual request (`src/tools/tool-executor.ts:400–411`).
- After operator approval, policy is assessed again; approval that does not authorize the exact call becomes denial (`:418–451`).
- `terminal.run` is classified `workspace-write`; its verification label expressly grants no execution authority (`src/tools/workspace-tools.ts:689–696`).
- Invalid verification scope/label and timeout values are rejected before command dispatch (`:709–723`).

**Repo-agent relevance:** supports controlled repository operations rather than unrestricted execution merely because a tool is exposed. Actual deployment policies still determine which operations are allowed.

### Verification and file delivery

- Managed process records carry verification names and input scopes; starting a check does not mean passing it (`src/process/process-manager.ts:15–18`).
- Command results retain verification metadata and command-file observations (`src/tools/workspace-tools.ts:727–740`).
- File-output validation uses executor-owned call identities and receipts, not prose or artifact handles (`src/runtime/file-output-evidence.ts:16–22`).
- Readback repair is restricted to receipt-backed writes; denied file operations remain a boundary (`:46–62`).
- Digest-backed evidence is invalidated by later mutations and can be tied to accepted Task-result content (`:83–165`).
- Deterministic report delivery uses accepted dependency Results and governed tools instead of another model transcription (`src/tasks/agent-step-executor.ts:499–544`).

**Repo-agent relevance:** directly addresses requirements such as saving exact accepted output and validating current files. It does not replace real task-level correctness evaluation.

### Process lifecycle

- Explicit states: prepared, running, exited, stopped, failed (`src/process/process-manager.ts:13`).
- Bounded waiting supports cancellation and process stopping (`:108–131`).
- Service checkpoints observe file changes without declaring command completion or passing checks (`:134–151`).
- Protected environment/input paths suppress sensitive logs (`:155–195`, `:292–317`).
- Retained logs are bounded (`:353–365`).
- Without an explicit hard timeout, configured managed execution permits bounded initial observation and continuation; explicit timeout follows a hard-limited path (`src/tools/workspace-tools.ts:721–740`, `runManagedCommand` at `:1820`).

**Limit:** the inspected process records are local in-memory records. Durable reattachment to arbitrary OS processes after host restart was not established. Durable Task recovery is not the same as durable subprocess survival.

### Skills, memory, channels, and MCP

| Area | Observed implementation | Qualification |
|---|---|---|
| Skills | Bounded skill-file loading, parsing, resource hydration, and per-file errors (`src/skills/skill-loader.ts:51–85`); lifecycle helpers (`src/skills/skill-lifecycle.ts:10–14`) | Does not prove any particular skill is installed or selected in a deployment |
| Memory | Extraction/review/mutation/persistence/index integration; auto-applied and pending-review candidate states (`src/memory/memory-curation-service.ts:1–27`, `:57–112`) | Configuration determines behavior; current-session persistence was not established |
| Channels | Gateway accepts scoped approval, session, and durable-queue dependencies; persistence failure must not silently fall back to memory (`src/channels/channel-gateway.ts:226–277`, particularly `:256`) | Recovery tests are not live transport validation |
| MCP | Tool/resource/prompt calls, stop, stdio lifecycle, request timeout and HTTP request paths (`src/mcp/mcp-client.ts`, `callTool :170`, `stop :198`, `#startStdio :224`, `#request :290`); wrapper risk classification (`src/mcp/mcp-tools.ts:240–257`, `:957–965`) | Does not prove a server or credentials are configured; one documentation-dependent regression failed |

These findings establish source capabilities—not current model, credential, service, isolation, channel, memory, or MCP configuration.

## 3. Executed regression evidence

Configuration was reviewed before testing:

- `vitest.node.config.ts`: Node environment, `src/**/*.test.ts`, isolated-state setup, verbose reporting.
- `src/test/vitest-setup.ts`: installs isolated state home.
- An initial attempt to read `vitest.config.ts` failed because that filename was absent; the correct configuration was subsequently read.

Both test commands declared:

```text
verification = "estacoda-regressions"
verificationInputs = ["."]
```

### Check A — core orchestration, execution, and recovery

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts src/tasks/task-scheduler.test.ts src/tasks/agent-step-executor.test.ts src/runtime/recoverable-draft.test.ts src/process/managed-command.test.ts src/process/process-tools.test.ts src/tools/workspace-tools.test.ts src/tools/delegation-tools.test.ts src/tasks/task-approval-service.test.ts src/tasks/sqlite-task-store.test.ts src/tasks/task-vertical-slice.test.ts src/tools/tool-executor.test.ts
```

**Exit status: 0. Files: 11 passed. Tests: 420 passed.**

Observed negative/recovery coverage included:

- Tampered and denied deterministic report export.
- Missing accepted report source.
- Missing live workspace trust or Attempt lease.
- Child-construction cancellation and checkpointed host handoff.
- Suppression of denied/mutating diagnostic output.
- Inaccessible research sources, exact read retries, and bounded passage recovery.
- Scheduler cancellation, stale leases, approval continuation, and uncertain effects.

### Check B — security, evidence, channels, skills, memory, and MCP

```sh
node node_modules/vitest/vitest.mjs run --config vitest.node.config.ts --reporter=dot src/security/command-safety.test.ts src/security/dispatch-authorization.test.ts src/runtime/file-output-evidence.test.ts src/channels/channel-state-recovery.test.ts src/mcp/mcp-client.test.ts src/mcp/mcp-tools.test.ts src/skills/skill-loader.test.ts src/memory/memory-curation-service.test.ts
```

**Exit status: 1. Files: 7 passed, 1 failed. Tests: 417 passed, 1 failed; 418 total.**

Failure:

```text
src/mcp/mcp-tools.test.ts:17:27
MCP per-tool risk classification
> keeps the documented Postman generation toolbox complete and preserves job handles

ENOENT: docs/subsystems/mcp.md
```

The missing prerequisite is **`docs/subsystems/mcp.md`**. This prevents the documentation-dependent test from running successfully; it does not, by itself, demonstrate a broken MCP transport.

No document was fabricated, no test was excluded, and no rerun was used to conceal the failure.

### Combined result

**19 selected files: 18 passed, 1 failed.
838 tests: 837 passed, 1 failed.**

The requirement **`estacoda-regressions` is not passing**. No further tool work was available to resolve the missing fixture, and source modification was outside scope.

## 4. Unverified scope and outstanding obligations

1. **Baseline authentication:** the declared baseline object was unavailable; no reliable baseline diff was produced.
2. **Manifest authentication:** all nine declared updated-source hashes mismatched observed bytes; cause unresolved.
3. **Regression prerequisite:** restore or otherwise legitimately supply the missing `docs/subsystems/mcp.md` before the failed test can be settled. Do not count the current result as green.
4. **Deployment validation:** actual configured providers, credentials, isolation, MCP servers, memory persistence, and channel transports were not verified.
5. **Comparative performance:** no matched live-model repository task experiment was run. There is no supported performance winner.
6. **External-project and launch claims:** outside this worker’s assigned scope; no fresh web verification was obtained here.
7. **Final artifact:** `reports/superagent-vs-estacoda.md` remains for the parent synthesis workflow to write and read back. This worker’s text is not a saved report.

## Conclusion

The observed EstaCoda source provides substantial operational infrastructure for repository-agent work: persistent delegation, fenced scheduling and recovery, narrowed authority, exact approvals, evidence-backed completion, and managed command continuation.

That supports a substantive **architecture and capability comparison**. It does not justify claiming superior coding performance, deployed readiness, authenticated baseline equivalence, or fully passing regressions.

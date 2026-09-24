# PR 0 implementation record

Branch: `ame/reliability-baseline`, based on `ame/desktop-foundation`.

This series establishes a baseline; it does not fix routing or enable Jev.
Known-gap assertions intentionally pass on current behavior. Replace them with
desired-behavior assertions in the owning implementation PR, rather than skipping
them or treating baseline success as product acceptance.

## Commit 1 — Routing and completion characterization

`src/runtime/research-routing.characterization.test.ts` loads the two real bundled
research skills through the source loader and executes the source router, tool
selection, schema catalog, and outcome functions. Its six-tool catalog is a
controlled inventory, not a claim about the full runtime inventory.

The synthetic requests reproduce missed delegation, generic skill recovery,
noncontiguous paper discovery, English file completion without a write, Arabic
classification/exposure gaps, and pre-selection catalog truncation. Healthy
controls cover exact/slash skill selection, greeting, documentation writing and
negated saving. These tests contain no private conversation transcript or live
profile state.

Validation: frozen-lockfile install; 172 tests passed across the new
characterization and router, narrowing, policy, and outcome suites; diff check.
Typecheck is blocked by pre-existing duplicate declarations in the untracked
`src/types/bidi-js.d 2.ts`; these unrelated files are preserved. The initial check
also caught missing fields in the new provider fixture, corrected before finalizing
this commit.
Review: no runtime behavior changed; source behavior agrees with the previously
observed failure shapes. The catalog-cap reproduction establishes a separate
defect, not proof that the original conversation hit that cap.

Security risk: test-only changes. Real execution and policy boundaries remain
unchanged. End-to-end provider/Task evidence belongs to the next harness slice.

## Commit 2 — Deterministic workflow harness

`src/runtime/research-request.acceptance.test.ts` uses
`src/test/fakes/research-workflow-harness.ts` to exercise `createRuntime`, real
bundled skills, native provider call parsing/planning, tool execution, event
receipts, workspace file tools, SQLite Task storage, the scheduler, child agent
loops, and Task result reading. Provider answers and web content are scripted;
successful work is established separately from receipts, stored results and
file contents. Each harness has a disposable workspace and profile home. Any
unexpected global fetch or unscripted provider request fails the test.

Six scenarios cover the three-turn failure chain (A1–A3), native write/readback,
denied write, three admitted research workers plus synthesis and subsequent file
delivery, missing search at delegation admission (A9), and duplicate successful
extraction (A12). The positive delegation control uses an explicit `/researcher`
route and recognized write wording: it demonstrates functioning execution seams,
not that the failing natural-language workflow has been fixed. Child runs are
serialized for deterministic scripting; this is not a concurrency benchmark.

The harness inspects the delivered selected skill content (full body or existing
bounded contract), tool inventory/schema estimates, stable call IDs, successful
execution receipts, distinct worker sessions/results, synthesis dependencies,
and output bytes. It does not invent requirement state or detailed omission
reasons that current production telemetry does not yet provide. Those remain
PR 1/2/4 work. Policy denial uses a deterministic injected policy; it does not
replace the later strict/adaptive/open conformance matrix.

Validation: 79 tests passed across both new suites and durable delegation,
agent-step execution and Task-result tools. Typecheck reports only the existing
untracked duplicate bidi declarations. Review found and corrected a fixture
argument-name mismatch; Task result reads now use the real `task_id`/`result_id`
schema. No runtime policy or production execution behavior changed.

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

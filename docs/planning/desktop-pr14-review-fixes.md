# PR14 review fixes

Date: 2026-09-13. Branch: `ame/desktop-foundation`. One focused follow-up to PR14A/B/C/D.

## Changes

- Evolution acknowledges its durable operation reservation before revalidation and command gates finish. The existing bridge and execution lease own the accepted work; inspecting a receipt never starts another execution. This removes the 15-second transport timeout from long-running gate execution.
- Host gates resolve an already installed pnpm and execute it using the bridge's owned Node, including under the packaged app's minimal PATH. Profile credentials remain excluded. Corepack network access and pnpm automatic package-manager installation are disabled; this change does not install dependencies. Docker retains its environment toolchain.
- Rejected, stale, expired, cancelled, removed, or unreadable reviews detected before any effect receive a durable failed receipt. Fresh review remains possible. Actual lost acknowledgements and unresolved historical receipts retain conservative recovery behavior.
- Desktop usage inspection validates state without invoking the core store's corrupt-file rename/repair behavior. Malformed usage cannot silently clear a pin or enable promotion.
- Proposal pagination, filtered evidence reads, evaluation fingerprints, recent history, and state rewrites stream JSONL through the existing store owners. Lifetime history no longer encounters the former 1 MiB/1,000-row cliff. Rewrites preserve unrelated records and reject detected concurrent changes. Per-record, per-review and response limits remain; scans are linear in the history inspected, rather than backed by a new index or database.
- A confirmed Settings cancellation clears the settling state after a rejected save. An uncertain save still requires inspection or confirmed cancellation before another save.

## Review and validation

Final review checked acceptance before effects, conservative receipt recovery, profile and symlink boundaries, retained history during mutations, child-process ownership, credential scrubbing, and Settings recovery. No remaining gaps were identified in the five implementation findings addressed here.

The root checkout contains unrelated duplicate TypeScript declaration files that fail typechecking. Core validation used a clean tracked copy with this patch overlaid. Desktop checks ran in the original checkout. Existing planning edits and unrelated untracked files were excluded from this commit. No dependencies or lockfiles changed.

| Check | Result |
| --- | --- |
| Node / pnpm | 24.14.1 / 10.33.0 |
| Frozen dependency install | Passed |
| Core typecheck / build | Passed, repeated after final helper cleanup |
| Full core suite | 11,602 tests passed across 711 files |
| Final targeted skills, protocol, Evolution and storage suite | 255 tests passed across 17 files, including the subsequent removed-proposal and pre-effect revalidation refinements |
| Final helper regressions | 4 tests passed |
| Source and distribution smoke | All cases passed |
| Runtime import and ESM audits | Passed, repeated against the final build |
| Desktop foundation / protocol boundary | Passed |
| Desktop main-process tests | 95 passed across 23 files |
| Desktop browser / visual suite | 224 passed, including English and Arabic rejected-save recovery |
| Diff whitespace check | Passed |

Behavioral regressions include a held accepted operation that can be inspected before it finishes, stale and removed proposals receiving failed receipts, byte-for-byte preservation of corrupt usage files, 1,205 proposals and oversized lifetime observation history, preserving all earlier proposals when approving the last one, bounded recent history, changed-history fingerprints, symlink/UTF-8/oversized-record rejection, and rejecting a concurrent append during rewrite. A real pnpm gate ran with the packaged PATH, the same Node executable, and no inherited provider credential.

Risk note: these paths inspect private profile state and can execute explicitly confirmed project code or mutate skills. Existing trust, approval, target ownership, and promotion policy remain mandatory. Desktop's profile lock is not a universal transaction across every CLI/runtime writer; uncertain outcomes are not force-cleared.

Manual VoiceOver, clean-account/package acceptance, real media-device checks, signing/notarization, and prolonged production monitoring remain separate release/operational checks. The automated suites do not substitute for those checks.

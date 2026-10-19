# Optional research-source rejection recovery

Date: 2026-10-19
Base: `bbc5b20460391c05d475343f2cca6a05eb1e1edb`

## Failure and change

The 120-case live replay left one failure: a research worker selected a token-bearing candidate URL, which `web.extract` correctly rejected before fetching. It then read allowed public sources, but completion feedback and Task settlement continued to reject the report because the first failure remained unresolved.

The worker may now abandon that optional candidate after a later authorized extraction returns nonempty source text from a different URL that the report cites. The rejected URL cannot be required by the assigned objective, research scope, or original user objective, or cited as evidence. Existing grounding and scope checks still apply. The failed read and source limitation remain recorded.

## Security review

The patch changes research completion classification only. It does not change URL validation, authorization, network dispatch, approvals, or provider configuration. It never rewrites a token-bearing URL or retries it automatically. An independently requested public canonical URL must pass the normal tool checks. Execution-policy denials, other URL safety failures, explicitly required sources, missing capabilities, and uncertain side effects remain unresolved.

Regression tests call the real URL guard and verify that the rejected URL causes no DNS lookup or fetch and that its result does not expose the synthetic token. Eighteen cases exercise completion feedback and settlement, including successful alternative/public-canonical reads and negative cases for search-only evidence, earlier/uncited/empty reads, policy denial, explicit requirements, rejected citations, redirect blocks, unavailable capabilities, uncertain effects, and other concurrent failures.

## Validation

Validation used an isolated core checkout containing the focused patch, excluding unrelated working-tree edits. The installed Desktop application and gateway were not updated by this change.

- Focused tests: 222 passed across the Task executor, research evidence, and web tools.
- Full suite: 12,652 tests passed in 766 files.
- Node and pnpm version checks, frozen dependency installation, type checking, build, runtime-import audit, ESM audit, source smoke, and distribution smoke all passed.
- Whitespace/diff validation passed.

## Targeted live replay

All five cases passed using the configured live providers and isolated workspaces:

| Case | Observed outcome |
| --- | --- |
| Previously failing accessible-forms research | Three workers, synthesis, and delivery completed in 285 seconds; researcher skill loaded; ten successful source extracts; cited report saved and read back. Only the requested file was created; 629 words, below the 800-word limit. |
| Denied write | Blocked; no file created. |
| Unrelated follow-up after denial and restart | Answered 30% correctly without tools on the follow-up; denied file remained absent. |
| Unicode exact copy | Completed; original and copy both 68 bytes with identical SHA-256, including blank lines and trailing newline. |
| Five unavailable required sources | All supplied references attempted; retention period remained explicitly unverified; no substitute search or file creation. |

This live research replay encountered no token-bearing URL failure. The deterministic real-guard tests establish that exact recovery behavior; the live replay establishes end-to-end workflow compatibility. These five targeted checks do not replace another full 120-case replay or packaged-app validation.

Bounded measured evidence: [research-source-recovery-2026-10-19.json](../../evals/results/research-source-recovery-2026-10-19.json). Raw provider responses and token-bearing URLs are excluded.

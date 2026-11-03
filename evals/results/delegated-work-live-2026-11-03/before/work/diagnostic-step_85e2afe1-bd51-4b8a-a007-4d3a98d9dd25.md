Static review found two medium-severity search issues. Discovery has targeted regression tests, but release readiness is unverified because the requested test could not run.

## Scope and evidence

Reviewed repository excerpts from the two assigned files and necessary discovery helpers:
- `src/tools/skill-tools.ts`
- `src/tools/skill-tools.test.ts`
- `src/skills/skill-registry.ts`
- `src/skills/skill-limits.ts`

Read `MANIFEST.json`. It declares baseline `fbf1f4db2e190009e217beb9989d6f239568330f` and hashes for the assigned files (`MANIFEST.json:2`, `MANIFEST.json:22–23`). Those hashes were not independently verified.

One grep failed because `max_filesize` was empty. Successful subsequent searches recovered the relevant test evidence. That error and empty/truncated reads are not evidence for the findings below.

## Findings

### Medium — Search does not disclose partial resource coverage

**Location:** `src/tools/skill-tools.ts:1536–1541`

Resource text is truncated to `MAX_SKILL_RESOURCE_CHARS`, but the helper returns only its content, discarding the truncation indicator. Resources can pass the 128,000-byte size check while exceeding the 20,000-character search limit (`src/skills/skill-limits.ts:15–16`).

The response’s top-level `truncated` flag reflects matching results omitted by the result cap, not resource text omitted before searching (`src/tools/skill-tools.ts:1436`, `src/tools/skill-tools.ts:1472–1475`).

**Impact:** A query occurring only in omitted resource text can produce zero matches with `truncated: false`. A negative search result therefore does not establish absence from the indexed resource.

**Recommendation:** Search complete byte-bounded text, or report partial coverage with affected paths. Add a regression test placing a unique query in text omitted by truncation.

**Verification:** Static finding; not execution-verified.

### Medium — Resource read failures can abort the entire search

**Locations:** `src/tools/skill-tools.ts:1510`, `src/tools/skill-tools.ts:1531`

Candidate-path resolution and `stat` failures become structured skip reasons (`src/tools/skill-tools.ts:1512–1525`), but root-directory `realpath` and resource `readFile` are unguarded. The resource loop awaits this helper without a per-resource catch (`src/tools/skill-tools.ts:1417–1424`).

**Impact:** A disappearing or unreadable resource can reject the search instead of returning collected matches and a skip reason. Failure to resolve the skill directory also rejects it. Higher-level presentation of that rejection was outside this review.

**Recommendation:** Convert expected filesystem failures into bounded skip/error metadata. Test one failing indexed resource alongside another searchable resource.

**Verification:** Static control-flow finding; no failure injection was executed.

## Supported guarantees and limits

| Area | Evidence-backed conclusion |
|---|---|
| Visible catalog | Listing uses the inspection registry and trims an optional exact category filter (`src/tools/skill-tools.ts:53–58`, `src/tools/skill-tools.ts:129–149`). Tests cover absent/blank filters, hidden entries, unmatched categories, whitespace trimming, and empty catalogs (`src/tools/skill-tools.test.ts:20–43`). |
| Catalog ordering | Missing categories normalize to `general`; entries sort by category, then name (`src/skills/skill-registry.ts:104–119`). |
| Named search | Search requires a nonempty query and a named, loaded skill from the inspection registry (`src/tools/skill-tools.ts:84–110`). Missing-input and unloaded-skill tests are declared at `src/tools/skill-tools.test.ts:431` and `src/tools/skill-tools.test.ts:444`. No global fallback appears in this path. |
| Indexed-resource scope | Search uses deduplicated, sorted paths from the skill resource index (`src/tools/skill-tools.ts:1415–1418`). |
| Containment checks | Search canonicalizes resource paths, rejects outside-directory targets, and checks file type, size, and probable text content (`src/tools/skill-tools.ts:1510–1533`). Traversal, binary, and oversized-resource cases have tests (`src/tools/skill-tools.test.ts:473–505`). These checks do not establish race-free access during filesystem mutation. |
| Output bounds | Search defaults to five results, caps at ten, and limits excerpts to 1,200 characters (`src/skills/skill-limits.ts:11–13`; `src/tools/skill-tools.ts:1445–1450`, `src/tools/skill-tools.ts:1490–1502`). Output bounds do not imply complete coverage. |
| Read compatibility | Tests cover full root reads, redundant resource modes, traversal/missing-resource rejection, and invalid-mode corrections (`src/tools/skill-tools.test.ts:173–199`). Mode validation precedes the common resource reader (`src/tools/skill-tools.ts:1550–1576`). |
| Visibility regression coverage | Tests compare hidden versus unknown skill responses and check bulk filtering (`src/tools/skill-tools.test.ts:687–725`). These are assertions in source, not observed passing executions. |

No critical/high-severity defect was established from the inspected excerpts. This is a bounded static review, not comprehensive security assurance or verification of the current checkout.

## Requested test

```sh
pnpm exec vitest run --config vitest.node.config.ts src/tools/skill-tools.test.ts
```

- **Status:** Unexecuted.
- **Blocker:** Worker admission rejected `terminal_run` and `execute_code`; the authorized scope remained read/search only.
- **Exit code:** Unavailable.
- **Executed/pass/fail/skip counts:** Unavailable.

The execution restriction remains an unresolved verification gap; successful file reads do not resolve it. No blocked operation was retried or bypassed.

## Release disposition

**Do not treat this review as a passing release gate.** Resolve or explicitly accept the two medium findings, then obtain the requested test result through an authorized execution environment.

Source and tests were preserved unchanged. No installation, network access, personal-state inspection, or inspection of the excluded delegation/security/Task-approval scope was performed.

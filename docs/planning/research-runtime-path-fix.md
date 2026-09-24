# Research runtime path and prerequisite fix

The retained macOS runtime lives under `Application Support`. Bundled skill loading previously used a file URL's encoded `pathname` as a filesystem path, so the space became `%20`. The loader returned an empty catalog even though the bundled files existed. A read-only reproduction loaded zero skills with the old path and all 22 skills with `fileURLToPath`.

The runtime now converts the bundled skill URL with `fileURLToPath`. The packaged acceptance fixture places Desktop data under `Application Support/EstaCoda` and starts both the bridge and research supervisor from the retained runtime there. The previous fixture started its supervisor from the original package, leaving the retention-path failure untested. The strengthened fixture verifies the selected researcher's source path as well as three workers, synthesis, original-request report delivery and save-only continuation after restart.

Research now stops before its provider loop and pre-turn compression when the session proves that an explicitly requested skill is unavailable, or fresh research requires unavailable search. The response names all known prerequisite blockers and preserves the missing report status. It does not spend provider iterations retrying an impossible delegation. Missing search in the packaged fixture must produce a blocked outcome with no provider calls, tool calls, Task creation or output file.

Available but initially unexposed capabilities remain recoverable. Ambiguous skill references still reach normal resolution. Existing Task results can be read without fresh search; result authorization, provenance, file content and readback checks still apply. Provider-supplied replacement contracts cannot weaken runtime-owned requirements.

## Security and scope

No trust, approval, skill visibility, credential, URL or delegation boundary is relaxed. Search availability is independent of extraction: a working URL fetch does not establish a configured search provider. Managed DDGS installation or credentialed search configuration remains an explicit operator setup action. This change neither installs dependencies nor edits live profile configuration. It does not claim to solve general context-packing inefficiency or establish live citation accuracy.

## Validation

All seven changed source/test/script files were byte-compared with the isolated validation checkout. Unrelated workspace files were preserved.

| Check | Result |
| --- | --- |
| Frozen offline install | Passed; Node v24.14.1, pnpm 10.33.0 |
| Core typecheck | Passed |
| Core tests | 11,994 passed in 747 files; four-worker run |
| Research release gate | 1,318 passed; existing routing thresholds unchanged |
| Desktop typecheck and packaged fixture typecheck | Passed |
| Desktop tests | 173 passed in 46 files |
| Core build and signed macOS arm64 package | Passed |
| Source and distribution smoke | Passed |
| Runtime import and ESM audits | Passed |
| Retained-path packaged acceptance | Passed: three workers, five accepted results, verified report, restart/save-only, recovery, unavailable search and false-save rejection |

Initial concurrent validation encountered timing-sensitive failures; the final full suite with bounded concurrency and the release gate passed. The first packaged path assertion required canonicalization of macOS's `/tmp` symlink; it now compares real paths without weakening the retained-root requirement. The packaged run uses synthetic model/web responses, not live research. No live profile settings, dependencies or gateway registration were changed by this patch.

[Measured results](../../evals/results/research-runtime-path-v1.json) record the runtime digest and exact changed-source hashes. The tested package is rebuilt; an already-running gateway must be updated to that runtime before a live retest. A configured, available search provider is still required.

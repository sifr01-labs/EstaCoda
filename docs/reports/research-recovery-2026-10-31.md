# Research source recovery: implementation and live checks

## Scope and conclusion

This change addresses the retrieval, evidence-accounting and progress-display weaknesses observed in the two Telegram research sessions. It improves source access and makes limitations inspectable. The local live runs **do not establish a speed improvement or complete resolution of the original incident**. The original Telegram host was not accessed or deployed to.

The screenshots and Hermes assessment are incident evidence, not sufficient proof of a release regression. Both historical runs reportedly used the same fallback model, but they differed in retrieved evidence, and completion-label rules had changed. The original host's missing-search configuration and Chrome startup failure remain unverified.

## Changes

- Unavailable web capabilities carry their actual bounded setup reason through registry, discovery and current runtime capability evidence. An unavailable capability still has no callable schema. Explicit provider selection retains its existing failure behavior; there is no new fallback, installation or configuration mutation.
- Fetch extraction prefers substantive `main`/`article` content, labels navigation-only fallback, and retains ordinary HTTP(S) link destinations. This fixes a concrete navigation problem: a moved AWS documentation page named its destination, but the previous extractor discarded the link needed to reach it.
- Eligible turn-local public reads cache the bounded source document before selecting query/offset windows. A query miss is successful retrieval with no returned passage, not a transport failure. It remains ineligible as source evidence and can leave an unresolved evidence gap.
- Research progress hashes the full normalized returned passage independently of its URL. Repeated boilerplate does not earn progress; a new cached passage can advance research without pretending a new network request occurred. Distinct recoverable attempts receive guidance rather than an immediate generic no-progress stop; repeat and total-budget controls remain.
- Repeated unproductive reads produce one bounded strategy reminder, including interleaved failed and useful reads. The reminder recommends checking search readiness and following real links; it does not automatically expose or authorize tools.
- Telegram groups classified recoverable search/extraction failures in the normal progress message. Policy denials, unknown failures and other tool errors remain persistent. Traces and completion requirements remain authoritative.
- Chrome startup captures a bounded stderr buffer and reports only reviewed failure categories plus exit status. Raw browser stderr is not exposed. This improves diagnosis; it does not claim to repair an unknown host configuration problem.
- Availability qualification guidance now also applies to CLI research, including exact versions, managed versus self-deployed service, regions and retirement status.

## Live method

Tests used this machine's selected profile, configured Codex `gpt-6.1-sol` route, and public network sources. The baseline was a clean archive of `053903e0903918be971a30701d8070f2187af03f`; the candidate contained this patch. Saved profile settings were not edited. The degraded test overrode search selection in memory to the extraction-only `fetch` provider, reproducing an unavailable search capability without removing credentials or packages.

Both builds received: “Tell me if Kimi GLM and deepseek and openrouter are each on vertex and bedrock”. Runs used fresh sessions, a 25-iteration / 35-tool-call / 240-second budget, and denied any interactive approval request. No Telegram messages were sent. Private raw traces were retained outside the repository; this report contains only task-level results.

These are diagnostic samples, not a statistical benchmark. Live pages, model choices and external latency vary; earlier candidate runs also overlapped validation work. Completion labels are runtime outcomes, not independent answer-accuracy scores.

| Run | Time | Calls | Failed calls | Outcome | Observation |
| --- | ---: | ---: | ---: | --- | --- |
| Baseline, configured search | 63.0 s | 9 | 0 | completed | Confident availability answer without checking the Kimi retirement qualification |
| Interim candidate, configured search | 100.3 s | 15 | 1 | partially_completed | Retrieved lifecycle evidence; no demonstrated speed gain |
| Final candidate, configured search | 83.2 s | 15 | 2 | partially_completed | Retrieved Kimi retirement and current GLM/DeepSeek documentation; still guessed two failing URLs |
| Interim candidate, unavailable search | 72.5 s | 13 | 5 | partially_completed | Repeated guessed URLs exposed missing link destinations and overly narrow reminder triggering |
| Final candidate, unavailable search | 101.9 s | 20 | 2 | partially_completed | Followed AWS catalog/model links and disclosed unresolved Vertex availability; still skipped explicit discovery |

The final degraded run did not establish all requested availability facts. Providing readiness reasons and guidance helps recovery but does not guarantee the model invokes discovery or completes the task. Restoring a working search provider on the original host remains an operator investigation, not something this patch silently performs.

## Direct live extraction and browser checks

The same English Google Kimi page was read on both builds, followed by a literal `retired` query, a deliberately invalid offset and a query from offset zero. The baseline first excerpt returned 12,000 characters from a 29,454-character extraction without the retirement notice. The final candidate returned a 3,624-character main-content extraction containing that notice immediately. The invalid-offset query changed from `ok: false` to `ok: true` with an empty passage and `query-not-found`; the next query retrieved the substantive passage.

Both probes made six HTTP requests. Google's redirect/cache behavior excluded these responses from reuse under the existing conservative policy. This test demonstrates extraction and passage semantics, **not fewer network requests**. Deterministic tests separately verify eligible-document reuse across queries/offsets and its provenance, privacy, policy and invalidation boundaries.

The configured local Chrome executable started successfully in an isolated temporary profile, passed its health check in 5.1 seconds, and was terminated and cleaned up. The Telegram host's `DevToolsActivePort` timeout was not reproduced. A deterministic early-exit test verifies classified startup diagnostics without raw stderr or secret/path leakage.

Telegram adapter tests simulate nine recoverable source failures and verify one progress bubble, persistent denials, and progress-off behavior. Telegram delivery itself was not live-tested because the user selected the local profile test.

## Validation

Validation runs use an isolated copy of tracked sources plus this patch. The working checkout contains unrelated untracked duplicate TypeScript files and unrelated planning edits; those were preserved and excluded. Dependencies were installed with the frozen lockfile; no dependencies or lockfiles changed. Node v24.14.1 and pnpm 10.33.0 were used.

The full suite passed **13,371 tests across 781 files**. Frozen-lockfile installation, typechecking, source smoke, build, runtime-import audit, ESM audit, compiled smoke and diff checks passed. After the final MIME-type casing adjustment, the targeted extraction/recovery/provider-loop suites passed **336 tests across five files**; typechecking, build, both import audits and compiled smoke were rerun on that source. The web extraction snapshot was regenerated intentionally and its content/metadata changes reviewed.

## Risk and limits

This touches sensitive runtime, network, evidence and messaging surfaces. Existing approval, private/metadata URL, redirect, credential, profile and authority checks remain in force. Link text is untrusted data, not authorization. Cache capacity rises to 4,000,000 serialized bytes per executor/turn while retaining 16 entries, 60-second expiry, bounded source size and conservative response exclusions. HTML cleanup is heuristic and does not execute JavaScript; some pages still require another retrieval route.

Distinct failed read attempts may consume more of the existing run budget instead of triggering an early generic no-progress stop. The live degraded case illustrates that tradeoff. Completion is deliberately not relaxed to produce a better-looking success label. A controlled repeated comparison and original-host diagnostics are still needed before claiming the release fixes overall research speed or the Telegram browser incident.

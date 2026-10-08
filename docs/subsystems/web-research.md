---
title: "Web Research"
description: "Search, extraction, crawl provider selection, credential handling, and managed DDGS setup."
---

# Web Research

Web research providers are separate from browser automation and separate from LLM providers. The web research registry backs `web.search`, `web.extract`, and `web.crawl`; browser tools still use the browser backend and CDP/Browserbase policy.

## Research completion and continuity

Explicit research, skill, worker-count and file requests produce bounded runtime requirements. Research workers that require live sources cannot be admitted without an available `web.search`. Successful delegation creates a durable Task; it does not prove that research or report delivery has finished.

Before the research provider loop starts, an unavailable explicitly requested skill or unavailable search for fresh research produces a blocked outcome with setup guidance. All known prerequisite blockers remain visible alongside the file-delivery status. Available capabilities omitted from initial exposure remain recoverable, and reading an existing Task result does not require a new search. Search setup remains an operator action; missing dependencies or credentials are not installed or enabled automatically.

Research synthesis reads accepted worker results and preserves source URLs, supported claims, limitations, observed publication dates and retrieval dates. A snippet is identified as a snippet; an unknown publication date does not establish recency. Missing or failed worker scopes remain explicit. These execution checks establish provenance and coverage, not scientific correctness.

Provider accounting heartbeats retain each dispatch's execution owner. Finishing or revoking one worker cannot stop a sibling's long-running provider call from renewing its lease. A failed heartbeat emits a bounded diagnostic without including provider response text or credentials. The same owner, fencing-token and expiry checks still apply.

If a response arrives but accounting cannot settle it, its tool calls are not executed and its answer is not accepted. Read-only Steps with current authority may retain a redacted diagnostic draft and retry once under their existing retry policy and remaining limits. Recovery receives the previous draft as unaccepted context and must verify the relevant sources again. Mutation-capable Steps and authorization failures do not receive this automatic recovery. A second accounting failure requires the existing review/failure path.

History preserves complete URLs at truncation boundaries, retains larger tool results and bounded repair drafts, and uses native tool-call/result history on Codex fallback routes. Snippet-only accepted reports explicitly disclose that full text was not retrieved; provenance acceptance is not scientific verification. CLI/Desktop-originated Tasks append a durable attention receipt to their authorized conversation when operator review is needed. Restart does not duplicate that receipt or consume the eventual completion delivery.

A save-only follow-up can reuse the authorized accepted synthesis, including after restart. Completion requires a matching file write and complete readback in the active workspace. Pasting Markdown, writing unrelated content or claiming a save without tool evidence cannot satisfy that requirement. For a root research-and-save request, a dependent report-delivery Step reads the accepted synthesis, writes its exact bytes to the requested relative path, and verifies readback before the Task completes. The Step exposes only result reading and file write/read, preserves runtime approval policy, and cannot write a different target. Research workers and synthesis retain their existing read-only authority. If no filename is supplied, delivery uses report.md or report.txt. Missing capabilities or denied actions leave the output incomplete. A later foreground export remains a separate verified action and does not rewrite historical Task settlement. Saving a workspace file does not grant permission to send arbitrary local files to a messaging channel.

Identical successful public extraction reads can be reused within one turn when the provider explicitly supports stateless reuse. Reuse retains the original observation time and provenance and revalidates current URL/security policy. Explicit refresh, authorization changes, credentialed/private reads and unsuccessful results do not reuse the observation.

Foreground and delegated research require citations grounded in successful observations. Cited prose and source/claim tables are accepted; exact table headings and verbatim synthesis claims are not acceptance requirements. The runtime renders a bounded source appendix with observed retrieval/access metadata. Synthesis must read the complete accepted results and cite evidence from each available worker scope; original worker source notes and limitations are retained independently of paraphrasing. A successful search alone is insufficient; provenance checks do not establish scientific truth.

During correction, the runtime pins the latest unaccepted draft, outstanding validator feedback and bounded source excerpts in a measured prompt layer. Feedback survives intervening tool calls and compaction. The bounded native-history window retains earlier tool results, while provider-specific reasoning replay remains fenced. Full messages remain in the worker transcript; the existing session search tool can retrieve them when exposed and authorized. Unrelated new search URLs do not reset the no-progress guard while the original validation defect remains unchanged.

A stopped attempt retains its stopping reason separately from unresolved validation feedback and any safe diagnostic draft. Empty provider output is not reported as successful completion. Safe worker and synthesis failures can enter operator review without discarding accepted dependencies. Targeted retry receives the previous unaccepted draft and must re-establish evidence under its current authority. Scheduler admission, operator retry and Desktop action availability share cumulative execution-limit checks; resume does not reset exhausted limits. Disabled retry actions explain the exhausted limit before any work is queued. Explicit limits, profile boundaries, approvals, file verification and immutable settled Tasks remain enforced.

A failed search-provider read may use other successful observations from the same provider in the same attempt; missing capabilities, denied reads, and ungrounded claims still block acceptance. Failed page fetches and provider reads can use other observed evidence when the page was not explicitly required. DNS resolution failures also leave the source unfetched, but can use other observed evidence; they are distinguished from private-address and explicit website-policy denials. The report retains the source-read limitation. Source acceptance does not impose a fixed citation count; the existing result-size and source-note size bounds still apply.

Delivery copies the accepted report through `file.write` with `sourceResult: {taskId, resultId}` rather than asking the model to reproduce its bytes. The existing Task result service verifies session/profile access and content integrity; ordinary workspace write, overwrite, shrink, editor, and approval checks still apply. `file.read` may return a bounded preview while recording a checksum of the entire materialized host file. Partial ranges and unsaved editor content cannot establish full-file verification. Delivery validation provides corrective feedback before settlement, which still requires executor-owned write/read receipts and the exact accepted-report hash.

Empty or null optional provider fields are normalized for result copying. Reviewed `file.write` validation failures before any mutation use the existing in-process undispatched marker. A later authorized write to the same path can repair such a delivery failure; uncertain effects, denied calls, and missing read-back evidence remain blocking.

Deterministic release checks run with `pnpm run validate:research-reliability -- <report.json>`. After `pnpm run desktop:package`, `pnpm run desktop:research-release` exercises the actual packaged app with synthetic model and web responses. See the [release validation record](../planning/reliability-release-validation.md) for measured scope and the separately pending live-provider assessment.

The [worker recovery validation record](../reports/research-worker-recovery-validation.json) records the focused ownership and recovery checks, including a provider call longer than the 60-second lease, sibling completion, gateway restart, attention delivery and verified report output. Model and web responses in the packaged check are synthetic; this is not a live research-quality assessment.

The [continuation and delivery validation record](../reports/research-continuation-delivery-validation.json) records the focused recovery changes, final packaged checks, and separate live-provider outcomes.

## Research method and report presentation

The research-discovery skill keeps its core method below the inline skill-content limit. Academic API examples live in `references/academic-search.md`; loading them is optional. Restricted workers with only search and extraction tools receive the complete core method without needing `skill.read`. Standard and Jev routing use the assigned worker objective, while the executor still owns Step completion requirements; quoted parent instructions cannot add delegation or file obligations. Skill selection remains subject to session visibility and routing, and tool selection does not grant execution authority.

The method asks for primary-page investigation of central claims in deep research, gap-driven follow-up, date checks, and concise synthesis. It permits a quick snippet-based overview when appropriate and honest partial findings when retrieval fails. There is no new minimum tool count, mandatory extraction gate, or model-based quality evaluator. Existing provenance, dependency coverage, authorization and delivery checks remain enforced.

Source notes appear after the report in a `Source evidence` appendix. A source observed only through search is labelled `snippet; page content not retrieved`; this does not assert that retrieval was attempted or impossible. The attempt transcript records individual failures, and the narrative should name a failure only when one occurred. Extraction is labelled `extracted; full text unverified`, since retrieving content does not prove completeness or accuracy. The runtime omits automatic success/freshness preambles, retains missing-scope warnings, and asks synthesis to state shared limitations once.

The current durable synthesis Step can read accepted worker results but cannot launch another research round. Workers can investigate gaps before returning. If synthesis discovers an unresolved gap, it must disclose it; this change does not add adaptive rescheduling or expand synthesis authority.

Validation includes deterministic worker-provider requests for deep research with successful page access, failed page access, and a quick snippet-only overview. These checks verify loaded instructions, restricted tool exposure, acceptance and report presentation. They do not prove that a live model follows the method or that findings are correct. For a live quality assessment, repeat those three cases in both routing modes and inspect central-claim support, publication dates, coverage, honest limitations and concision. Count searches and page reads as diagnostic evidence, not a quality score. The desktop package and gateway must contain this revision before that assessment.

## Live provider state

| Provider | Capabilities | Status | Setup |
|----------|--------------|--------|-------|
| Brave Search | search | Implemented live provider | Configure `web.searchBackend: "brave"` and a Brave API key env reference |
| DDGS | search | Implemented managed Python provider | Install and verify the registered `ddgs` Python capability |
| fetch | extract | Implemented guarded extraction fallback | No API key required |
| Firecrawl | search, extract, crawl | Registered stub | Reports unavailable |
| Parallel | search | Registered stub | Reports unavailable |
| Tavily | search, extract | Registered stub | Reports unavailable |
| Exa | search | Registered stub | Reports unavailable |
| SearXNG | search | Registered stub | Reports unavailable |

`web.crawl` exists as tool infrastructure, but no live crawl provider is implemented in this release.

## Selection rules

Selection is capability-specific:

```text
web.searchBackend / web.extractBackend / web.crawlBackend
-> web.backend
-> auto-detect available providers
-> unavailable
```

Explicit config wins. If `web.searchBackend` is `brave` and the Brave credential is missing, `web.search` reports Brave as unavailable instead of silently falling back to DDGS. Auto-detect only chooses providers whose availability check succeeds.

For extraction, `fetch` is the guarded fallback only when no explicit unavailable extract provider was configured and no available extract provider was auto-detected.

## Brave Search

Brave is a credentialed external provider. Config stores an environment-variable reference, not a raw key:

```json
{
  "web": {
    "searchBackend": "brave",
    "brave": {
      "apiKeyEnv": "BRAVE_SEARCH_API_KEY"
    }
  }
}
```

`BRAVE_SEARCH_API_KEY` is the default env var name. Setup flows should handle it the same way provider credentials are handled elsewhere: env reference first, optional deferred secret value, redacted review, and write only through the reviewed apply path.

The runtime resolves the credential through the shared runtime credential resolver. Brave provider code must not read `process.env` directly outside that resolver path, must not log the token, and must not return it in errors.

## DDGS

DDGS uses the managed Python capability registry:

```bash
estacoda python-env status ddgs
estacoda python-env setup ddgs
estacoda python-env verify ddgs
```

The runtime provider is available only when the registered `ddgs` capability is installed and verified. Search execution uses the managed capability Python path and a subprocess with JSON passed over stdin. It must not interpolate the query into Python source, run through a shell, install packages at runtime, or accept arbitrary package names from users, skills, or provider output.

If DDGS is unavailable, the repair hint is `estacoda python-env setup ddgs`. Setup Editor and onboarding may offer that reviewed install action, but normal `web.search` execution does not repair or install dependencies automatically.

## URL safety

Search providers return result URLs and snippets. They do not bypass browser or extraction URL policy. `web.extract` still checks URL safety before fetch and again across redirects before reading response bodies.

## Debugging

Useful checks:

```bash
estacoda python-env status ddgs
estacoda python-env verify ddgs
estacoda setup
```

For Brave, confirm that the selected profile config names the expected env reference and that the selected profile `.env` or process environment contains that variable. For DDGS, confirm the managed capability status is installed or verified.

## Desktop selection and setup

Browser & Search settings show the selected search service and the currently resolved service for Automatic. Brave Search and DDGS are selectable implemented search services; registered providers without a search implementation remain browse-only. Availability is setup evidence, not a successful network test. Brave credentials are staged privately. DDGS uses the registered dependency installer with explicit download review and durable receipt reconciliation; downloading software is separate from saving search settings.

Choosing Automatic clears the explicit search selection and the legacy shared backend. When extraction or crawling inherited that shared backend, the reviewed change preserves their existing selection explicitly. Advanced controls retain extraction/crawling and legacy provider settings.


### Foreground report completion

Explicit coordinated requests such as “Use the researcher skill and 3 subagents” retain the worker count. Required delegation, research, and file tools are prioritized within the existing provider schema budget; visibility never bypasses execution authorization.

For a foreground research request that saves a report, citation provenance is checked against the delivered report bytes, not the short chat acknowledgement. The report must have a successful write and a subsequent complete, matching file readback in the current turn. A ranged preview alone is insufficient. Exact write input or a complete read body must match the executor's file digest before being treated as report content. Existing files and unrelated writes cannot satisfy this contract.

Foreground research uses the existing completion repair loop (at most two corrective replies, within the turn's limits). Missing readback or unsupported citations produce feedback before final settlement. Denied actions do not trigger automatic completion retries. New report digests and matching complete readbacks count as progress; repeating unchanged file calls does not. These checks establish delivery and source provenance, not scientific accuracy or source freshness by themselves.

# Desktop PR7 implementation record

Branch: `ame/desktop-foundation`; base: `4a7efb7e`.

## 1. Work list and detail routing

The live Work navigation opens a canonical list with conversation, Task, and active-state filters. Filters apply to the explicitly loaded extent; pagination remains bounded to 2,000 items. Detail selection continues to resolve off-page Work through `work.get`. Local draft and list routes never masquerade as canonical identifiers. Existing per-Work tabs and inspector state remain intact.

Validation: desktop foundation/type boundary checks and desktop unit tests; live list navigation covered by the Work continuity browser suite.

## 2. Bounded search and profile-scoped pins

`work.list` accepts a bounded title/workspace/ID query. Search cursors bind to the normalized query, page size, and capture epoch; the renderer debounces queries and rejects late results. Search is metadata-only and does not scan transcripts. Main persists at most 100 canonical references per profile in presentation storage; titles and execution state remain canonical reads. Off-page pins resolve through `work.get`; profile changes fence pending reads and writes.

Validation: 68 focused core/protocol tests, 35 desktop unit tests, desktop foundation checks, and eight Work continuity browser journeys. Security review: no caller-supplied profile or filesystem path enters pin storage; references cannot authorize execution.

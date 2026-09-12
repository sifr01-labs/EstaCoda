# Desktop PR7 implementation record

Branch: `ame/desktop-foundation`; base: `4a7efb7e`.

## 1. Work list and detail routing

The live Work navigation opens a canonical list with conversation, Task, and active-state filters. Filters apply to the explicitly loaded extent; pagination remains bounded to 2,000 items. Detail selection continues to resolve off-page Work through `work.get`. Local draft and list routes never masquerade as canonical identifiers. Existing per-Work tabs and inspector state remain intact.

Validation: desktop foundation/type boundary checks and desktop unit tests; live list navigation covered by the Work continuity browser suite.

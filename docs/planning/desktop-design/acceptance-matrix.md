# Desktop PR 5 acceptance matrix

Status: required checks; implementation evidence pending. See the [contract](../desktop-visual-contract.md) and [approved reference](README.md). No rows below are claims that production tests already pass.

## Capture setup

Use Kemet light and dark for the complete state set. Reset the reference before each independent journey; default is New chat, comfortable density, 224 px sidebar, inspector closed. In the reference, open Work “Make billing retries resilient” for the approval scenario. Use mock clocks in the test harness to hold intermediate phases; do not depend on racing real timers. Reference states may be driven by test-only instrumentation of an in-memory copy; never modify the frozen file. React fixtures supply equivalent deterministic view models.

Compare a 1024 px product width for the complete state set. Repeat New chat, approval, composer with attachments, inspector open, and provider dialog at 736 and 360 px; check 320 px for overflow and 1440 px for desktop sizing. The standalone wrapper adds 32 px to the outer viewport width. Fix and record product height, scroll position, OS, Chromium version, fonts, device scale, appearance, fixture state, and capture harness version for each baseline. Exclude the inspection wrapper from product comparisons. Production window height/scroll behavior additionally needs Electron checks.

Capture after fonts and icon/mask assets are ready. Disable animations and freeze time for automated comparisons. Compare reference and implementation on the same machine/configuration. Keep readable text and controls in the comparison; restrict rendering-noise tolerances to measured differences. Also inspect the actual packaged/native window before accepting the title bar and scrolling adaptations.

## Required cases

| ID | State or journey | Pass condition |
| --- | --- | --- |
| V01 | Initial New chat | Correct official wordmark/icon, neutral full sidebar, top Settings/Search/New chat, ordered navigation, Pinned Work, workspace list, bottom strip, and composer. |
| V02 | Draft → another Work → draft | Text, attachment metadata, and selected model remain scoped to the original draft; no loss during navigation. |
| V03 | Attachment + menu → choose/sample → remove | Menu, file chips, long names, cancel, and removal fit at each width; model stays right and + stays left. No fixture upload/read occurs. |
| V04 | Search → result → Work; no results | Keyboard-accessible results, correct Work selection, useful empty state, no layout jump. Live scope/limits tested in PR 7. |
| V05 | Pin/unpin; empty Pinned section | Work header and sidebar stay consistent; list order is stable and no duplicate Work appears. |
| V06 | Billing retry / pending approval | Action, target, profile, isolation, Strict scope, Approve once and Reject are legible; routine tool steps are collapsed. |
| V07 | Approve once → running → completed | Fixture transitions and runtime strip agree; completion is visually distinct from waiting/running. Production evidence semantics use the canonical contract. |
| V08 | Running → stop requested → cancelled | Request is not labeled cancelled until acknowledgement; no verified-success treatment. |
| V09 | Reject → partial; deployment logs partial | Unverified edits and missing evidence remain visible; partial is not styled/labeled as verified completion. |
| V10 | Activity / Changes / Results | Keyboard tab navigation works; file-review link reveals Changes; results retain provenance and status. |
| V11 | Inspector open/close | Plan / Execution / Usage match reference, collapse restores space, narrow layout reflows without obscuring composer. |
| V12 | Inbox → approval Work | Attention count and destination agree; resolving the fixture approval removes its pending count. |
| V13 | Settings → Appearance | Kemet, Graphite, Sand; Light, Dark, System; correct selected states and shared-token preview cards. |
| V14 | Theme/mode change with draft and attachments | State and focus retained; System follows OS changes; all three families render New chat and approval in both modes without clipping. |
| V15 | Settings → Models → configure → verify → review → apply | Fixture setup journey works, review is explicit, closing discards staged mock material, background is inert, focus returns. No real credentials or provider calls. |
| V16 | Library → Artifacts → preview → source Work | Preview matches selected sample artifact; provenance leads to the right Work. |
| V17 | Library → Skills & tools → expand capability | Available and not configured states are distinct; visibility does not imply permission. |
| V18 | Connections → Telegram details | Authorization scope and sample status are clear; Email remains a fixture example. |
| V19 | Status strip → background work → schedule detail | Schedule context is shown without counting scheduled or approval-waiting work as active execution. |
| V20 | Bootstrap / disconnected / reconnect / failure | New states use the approved component system; unknown health is explicit and actions do not imply readiness. Additional states absent from the prototype require PR review. |
| V21 | Switch profile with open details/draft | Previous profile content, handles, staged secrets, and subscriptions disappear; original supervisor retains execution ownership. Real isolation test is separate from fixture visuals. |
| V22 | Keyboard, Escape, zoom, reduced motion, mixed Arabic/English | Visible focus, named icon actions, correct dialog focus/restore, no obscured content at 200% zoom, logical direction and isolated technical tokens. Verify screen-reader labels and contrast. |
| V23 | Native desktop window / resize / long activity | Title-bar controls are native, drag region excludes actions, composer remains reachable, scrolling and focus work at supported window sizes. |
| V24 | Fixture isolation / production availability | No fixture path calls runtime mutations, reads real profile state, or accepts real credentials; no demo fallback in release. Unsupported destinations/actions follow live capabilities. |

## Review evidence required in PR 5

- Exact reference hash, implementation revision, capture environment, and scenario identifiers.
- Reference and React captures plus overlays/diffs for V01–V19, and captures of added recovery/accessibility states where appropriate.
- Interaction and boundary check results for all applicable rows, with failures resolved. Later live integration checks remain assigned to their delivery PR; do not mark them passed through fixture behavior.
- Brand asset comparison at 1× and 2× in light and dark; no font approximation or raster-mask halos.
- A short deviations list: native chrome/accessibility/canonical wording changes with reasons; product approval for any design change.
- Documented focused visual-test command integrated into `desktop:e2e`, with reviewed baselines kept under desktop tests. Golden updates must be reviewed, not accepted solely because the runner generated them.

Rerun relevant rows and the baseline shell/theme set for every subsequent desktop UI PR. The complete matrix is a PR 5 exit gate and a release regression reference, not a substitute for live runtime or security tests.

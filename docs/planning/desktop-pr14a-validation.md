# Desktop PR14A — Display language and bilingual acceptance

Implementation record: 13 September 2026, branch `ame/desktop-foundation`, based on `ad161b32`. The nine planned slices implement English/Arabic presentation, persistence, translation of the existing desktop surfaces, RTL layout, bundled Arabic typography, and regression evidence. Automated checks are complete; the manual VoiceOver acceptance below remains open.

## Using display language

Open Settings using the sidebar settings icon and choose **English** or **العربية** under **Display language / لغة العرض**. The selector is also available in the existing setup/recovery surface before normal Work is available. The complete first-run wizard belongs to PR14C.

The current window changes immediately. The desktop saves the choice in its Electron userData `appearance.json`, alongside theme, appearance and density, and restores it after restart. Older appearance files default to English. A failed save leaves the current window usable and announces that the preference was not saved.

Display language is a local presentation preference. It does not change the selected profile, runtime configuration, agent response language, approvals, workspace trust, or execution ownership. Runtime language changes still require the reviewed runtime setup/apply path. Switching display language preserves the selected Work, tab, draft, attachments, model choice, and focused control.

## Implementation and copy ownership

| Surface | Implementation and evidence |
| --- | --- |
| Catalog and safe fallback | `apps/desktop/src/shared/i18n/` contains typed product message keys and Arabic translations. English source messages are stable catalog keys. Missing Arabic falls back to English deterministically; unknown keys use the safe unavailable message. Fallback English is not counted as completed Arabic coverage. |
| Shell, Work and Inbox | Navigation, composer, attachments, approval copy, statuses, dialogs, accessibility names, and local validation messages use the current language. Provider responses and user-authored titles/content stay unchanged. |
| Models, Connections and Settings | Provider setup, route review, Telegram/gateway actions, credential staging, target management, and diagnostics use localized product copy. Action receipts retain the action as well as the outcome. |
| Evidence | Runtime projection supplies bounded `summaryCode` and `limitationCodes`; the desktop translates those codes instead of guessing from backend prose. Protocol 1.1 negotiates these additions. The server removes the new fields for strict 1.0 clients; newer desktops use a safe compatibility explanation for older reports. Existing completion decisions, facts and legacy English fields remain available. |
| Native controls | Browser/terminal confirmations read the same presentation preference. The protected credential window receives its display language during description, translates its controls, and retains one-shot credential handling. |
| Direction and fonts | Document language/direction, logical CSS placement, directional navigation icons, sidebar/inspector placement, and tab arrow keys follow the selected language. Brand geometry stays unchanged. Code, terminal, URLs, paths, model identifiers and shortcuts retain LTR isolation; prose uses its own direction. Noto Sans Arabic is bundled locally under the OFL and allowed by the existing self-only font CSP. |

The copy inventory covers the existing rendered desktop components and the protected credential surface. The AST regression check catches untranslated JSX text, literal accessible attributes, and local error-message keys; catalog checks require Arabic content and matching interpolation tokens. This is a regression guard, not a proof of every possible dynamic backend value. New product copy must add a catalog entry and a corresponding Arabic translation; arbitrary backend errors and user/provider text must not be fed to the product translator.

## Acceptance evidence

| Check | Recorded result |
| --- | --- |
| Catalog, presentation store, credential and native controller unit tests | **82 passed** in 20 desktop test files. Includes fallback, preference migration/validation, isolated persistence, private credential handling and native PTY lifetime checks. |
| Complete desktop UI suite | **208 passed**, including the historical visual comparisons, all 28 new bilingual references, and four native Electron zoom/accessibility cases. |
| Language changes during work | Selection, draft text, attachments, chosen model, keyboard focus, stale preference reads, serialized writes and failed persistence are covered by `language.spec.ts` and `presentation-state.spec.ts`. |
| English and Arabic visuals | 24 approval/Settings/Models references cover both languages, light/dark appearance and 360/1280-pixel windows. Four additional references cover CSS 200% reflow and keyboard navigation. Historical PR5 references were not updated. |
| Native zoom and accessibility | Four isolated Electron cases use real `webContents.setZoomFactor(2)`, focused-control/overflow checks, native viewport captures and Chromium accessibility-tree control names, across both languages and light/dark appearance. |
| Arabic operation boundaries | Provider verification/cancellation, Telegram review, file previews and symlinks, diff text, evidence codes, and terminal activation/input are exercised with current components. Existing browser takeover and protected sign-in tests remain passing. |
| Core evidence/protocol regression | **135 passed** in six focused test files after protocol 1.1 negotiation and legacy down-projection were added. |

See the [visual evidence README](../../apps/desktop/tests/visual-evidence/pr14a/README.md), [capture hashes](../../apps/desktop/tests/visual-evidence/pr14a/manifest.json), and [bilingual reference directory](../../apps/desktop/tests/e2e/bilingual.spec.ts-snapshots/). Native captures and accessibility control lists contain fixture data only. The font's source, checksum and license are recorded in the [asset documentation](../../apps/desktop/public/assets/README.md).

## Validation commands and results

Host: macOS 26.5.2 (25F84), arm64; Node 24.14.1, pnpm 10.33.0; Electron 44.3.0 and Playwright 1.63.0.

Core commands ran against an isolated copy of current tracked source because the working directory already contains unrelated duplicate untracked source files. Those files and the existing planning-document edits were preserved. Desktop commands ran in the working directory. Native PTY and Electron tests required process access and a local fixture server.

| Command | Result |
| --- | --- |
| `node --version`, `pnpm --version` | Versions above confirmed. |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged. |
| `pnpm run typecheck` | Passed, including the final core protocol change. |
| `pnpm run test` | 11,009 of 11,011 passed in the full run. Two existing tests hit their five-second timeout under concurrent load. Both affected files passed all **21 tests** on a focused rerun without changing timeouts or code. |
| `pnpm exec vitest run src/cli/task-commands.test.ts src/storage/sqlite-adapter.test.ts` | 21 passed; focused follow-up to the two full-run timeouts. |
| `pnpm run smoke` | Passed. |
| `pnpm run build` | Passed. |
| `pnpm run audit:runtime-imports` | Passed. |
| `pnpm run audit:esm` | Passed. |
| `pnpm run smoke:dist` | Passed. |
| `pnpm --filter @estacoda/desktop typecheck` and desktop protocol-boundary check | Passed. |
| `pnpm --filter @estacoda/desktop test` | Final run: 82 passed. The restricted run failed native process inspection with `EPERM`; rerunning with process access passed. |
| `pnpm --filter @estacoda/desktop e2e` | Final run: 208 passed, without updating expected screenshots. |
| `pnpm --filter @estacoda/desktop build:renderer` | Passed; Vite reports the existing large-chunk advisory. |
| `pnpm --filter @estacoda/desktop exec vite build --config vite.credential.config.ts --outDir dist-credential` | Passed. Both renderer outputs contain the exact bundled Arabic font and license. |
| `git diff --check` | Passed. |

The full core run is recorded with its two timeouts rather than represented as an entirely green single run. Subsequent focused tests cover both timeout files and all changed core evidence/protocol paths.

## Risk review and remaining acceptance

This change touches credential-window presentation, native approval copy, and the evidence wire contract. It preserves credential ownership, verification/apply gates, approval defaults, workspace trust, and execution authorization. Preference validation rejects unknown fields instead of allowing runtime/profile configuration through the presentation store. Evidence codes describe existing decisions and do not establish new execution authority or upgrade completion claims. Strict older peers are covered by negotiation tests.

The native accessibility evidence is Chromium's accessibility tree plus keyboard checks. **An actual VoiceOver listening session has not been performed.** Before declaring the screen-reader acceptance fully closed, review both languages with VoiceOver: navigate Settings and Work by keyboard, hear names/states on language selection and approval controls, open/close a dialog and confirm focus returns, read mixed Arabic/English content, and repeat at 200% zoom. Verify no clipped actionable content or incorrect announcements. Record any findings separately; automated tree checks do not substitute for this step.

The native test harness uses a fixture inside Electron, not a signed distributable or a live provider. Full clean-account bilingual first Work belongs to PR14C; signed/notarized distribution and repeat acceptance in the shipped package remain PR16 gates. Arabic linguistic review by a fluent product reviewer remains advisable, particularly for security and setup instructions.

## Commit record

1. `d123e3ef` — English/Arabic catalog and deterministic fallback.
2. `6cff0f05` — Persisted presentation language.
3. `92047969` — Shell, Work, Inbox and accessible control copy.
4. `9af51413` — Models, Connections, Settings and safe diagnostics.
5. `ba145c78` — Document direction and logical placement.
6. `4abde557` — Bundled Arabic font and technical-content isolation.
7. `ca97434c` — Persistence, copy coverage and draft-preservation regression tests.
8. `fa5d50e1` — Bilingual visual, keyboard, native zoom and compatibility tests.
9. `docs(desktop): document display language and bilingual acceptance evidence` — This implementation record.

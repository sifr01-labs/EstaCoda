# EstaCoda Desktop — visual specification

Design concept 01 · 10 September 2026 · Superseded

**Historical concept only.** Implement the [approved Desktop visual contract](../../docs/planning/desktop-visual-contract.md) and [frozen branded prototype](../../docs/planning/desktop-design/README.md) instead. The dimensions, provisional mark, navigation, and palette below predate the final approved design and are not PR 5 acceptance criteria.

This specification accompanies the interactive Work, Inbox, Models, and Appearance concept. It proposes the visual foundation for Desktop PR 5 and the component vocabulary for PRs 6–8. It does not change the runtime, existing CLI appearance, approved implementation plan, or execution ownership contracts.

## 1. Direction

**Calm, precise, and visibly governed.** Work should dominate the screen. Navigation should stay predictable; an approval should identify the action and its scope; a result should reveal what was actually verified.

The distinctive elements are Kemet's cool blue accent, restrained surface layers, an editorial Work heading, a quiet execution timeline, and a compact details inspector. Graphite and Sand retain the same structure and interaction rules.

The small “e” tile is a provisional app mark for this concept, not a proposed replacement for the established EstaCoda logo. Final icon and brand assets need a separate design review.

## 2. Layout

| Element | Initial specification |
| --- | --- |
| Window | Opaque product surface; 12 px corner treatment in the concept |
| Title bar | 44 px; application identity and workspace context |
| Sidebar | 184 px; explore 164–216 px through design controls |
| Main header | At least 52 px; breadcrumb and local actions |
| Work content | Flexible width, 24 px horizontal padding |
| Inspector | 205 px at wide widths; user can hide it |
| Main page padding | 30 px; 17 px at narrow widths |
| Responsive behavior | Below 850 px the inspector moves below Work; below 590 px primary navigation becomes a compact row |

The narrow layout is a review aid, not a commitment to ship a mobile app. Production desktop minimum window dimensions should be chosen after usability testing. The standalone inspection wrapper adds 16 px around the concept, so 1056/768/392 px browser viewports correspond to 1024/736/360 px concept widths.

Only functional navigation is shown. Scheduling, Connections, Library, file management, and terminal integration are intentionally outside this prototype.

## 3. Typography and spacing

Use the platform's UI font stack with an appropriate Arabic fallback. Use a system monospace stack for source, commands, model identifiers where helpful, and diffs. Keep technical strings isolated in mixed-direction production views.

| Role | Size | Weight |
| --- | ---: | ---: |
| Work/page heading | 24 px; 22 px in narrow layout | 500 |
| Section/dialog heading | 17 px | 500 |
| Main UI body | 14 px | 400 |
| Work narrative | 13 px | 400 |
| Controls and secondary detail | 12–13 px | 400/500 |
| Supporting metadata | 11 px minimum in this concept | 400 |
| Code | 12 px monospace | 400 |
| Arabic appearance specimen | 16 px with generous line height | 400 |

Build spacing from 4, 8, 12, 16, 24, and 32 px. Compact density reduces spacing while retaining readable text. Production font scaling and zoom must increase text and controls together; metadata should not become the only source of essential information.

## 4. Theme families

Every family has light and dark variants. **System** is a mode preference that follows the operating system; it is not a fourth palette. Default family: **Kemet**. Default mode: **System**.

| Family | Main surface, light / dark | Navigation, light / dark | Action accent, light / dark |
| --- | --- | --- | --- |
| Kemet | `#FCFCFD` / `#151A22` | `#F2F4F7` / `#10151C` | `#245FBA` / `#A0C4FF` |
| Graphite | `#FCFCFC` / `#19191C` | `#F1F1F3` / `#131316` | `#6450AF` / `#C5B5FF` |
| Sand | `#FAF8F3` / `#211E1A` | `#EEEAE1` / `#191713` | `#855A25` / `#E6BD85` |

Kemet expresses the existing brand through cool neutrals and blue. Graphite uses neutral surfaces with a restrained violet accent. Sand uses warm surfaces with a bronze accent. These are initial color choices for comparison, subject to contrast and usability review.

Separate tokens describe background, navigation, panel, inset surface, border, main text, secondary text, accent, accent foreground, selection, positive, warning, and error. Future editor and terminal adapters must use the same semantic palette while retaining their own syntax and ANSI mappings.

Themes must preserve:

- The meaning and visibility of status, approval, and destructive actions.
- Keyboard focus, selection, and form affordances.
- Legibility in light and dark appearances.
- Drafts, selected Work, the chosen tab, and execution state during appearance changes.

The concept uses appearance only in local memory. Production preference persistence should be device-local and non-authoritative. Switching theme must never rebuild a runtime or alter trust, active-profile selection, credentials, or model routes.

Custom imports are a later slice: validated, versioned, data-only color definitions with defaults for missing optional tokens. No arbitrary CSS, executable scripts, external assets, or runtime capabilities should be granted by a theme.

## 5. Components and interactions

### Navigation and Work

- App navigation uses a low-intensity selected surface and a consistent icon family.
- Recent Work has a distinct selected row; status is represented through both icon and text.
- Activity, Changes, and Results are keyboard-operable tabs.
- The inspector groups Plan, Execution, and Usage without turning every value into a separate card.
- Cost is shown as unavailable when the example has no price data. The concept's token counts and timings are explicitly illustrative.
- Draft guidance is retained across visual changes and can be saved inside the concept. It is never sent to a provider.

### Approvals

The initial example requests approval to run one focused test command. The card contains the command, workspace, execution environment, likely local effects, and approval scope. “Approve once” authorizes only that command in the simulated flow. It does not imply a grant for future tool calls.

| State | Presentation | Transition |
| --- | --- | --- |
| Needs approval | Amber status, command card, approve/reject controls | Approve → running; reject → partial |
| Running verification | Blue status and activity feedback | Sample result → completed; stop → cancellation requested |
| Cancellation requested | Amber status; stop control disabled | Simulated settlement → cancelled |
| Completed | Positive status and explicit test result | Inspect changed files and results |
| Partially completed | Amber status plus the missing evidence | Existing edits remain visible |
| Cancelled | Explicit cancelled label | Existing edits remain visible; verification remains incomplete |

The concept deliberately states that Local host is not sandboxed. Production labels must be projections of canonical runtime state; UI timers must never determine real completion or termination.

### Provider setup

The prototype covers a staged route setup flow: configure → simulate verification → review → apply → ready. It accepts only a built-in sample credential; the Local route requires no credential. No requests, secret storage, or runtime configuration writes occur.

Cancel and Escape discard the pending sample credential. Apply adds an illustrative provider row and preserves the existing default model and current Work's model. Background content is inert while the dialog is open; focus is contained and returned when the dialog closes.

Production must use the existing reviewed setup and credential transaction paths, including a read-only verification after persistence. The prototype does not prove those backend paths. OAuth, failure recovery, fallback editing, and custom endpoint policy remain separate implementation work.

### Appearance

Three miniature application previews let the user compare complete palettes. Mode and density controls are separate. The specimen shows an approval state, successful and failed status labels, a primary action, and Arabic text.

The external design controls explore sidebar width, surface radius, and inspector visibility. Those are review alternatives; they are not a proposed second Settings panel.

## 6. Accessibility and motion

- Use semantic native controls, descriptive labels, visible native focus, and status announcements.
- Retain full keyboard operation, including dialog focus handling and Work-tab arrow keys.
- Honor reduced motion; use brief 120 ms hover transitions only where appropriate.
- Avoid auto-scrolling away from something the user is reading or editing.
- Keep status understandable without color. Pair icons with explicit words.
- Target WCAG AA text contrast and validate non-text control boundaries, focus visibility, high contrast, zoom, and screen-reader order before shipping. A polished concept is not an accessibility certification.
- Support mixed Arabic/English content, directional isolation of technical strings, logical CSS properties, and appropriate icon mirroring in production.

The concept includes an Arabic specimen, not a fully localized or RTL application. Full RTL layout, high-contrast variants, font scaling controls, screen-reader testing, and final Electron-native chrome remain production acceptance work.

## 7. Delivery plan

**Before Desktop PR 5:** review this direction against representative Work, approval, setup, and recovery screens. Decide the default palette, typography, density, component geometry, and final application mark.

**Within Desktop PR 5:** implement semantic desktop tokens, primitives, the theme resolver, local appearance preferences, keyboard/focus behavior, the shell, and profile/bootstrap recovery states. Add visual regression fixtures for supported themes and widths.

**PRs 6–8:** implement the actual Models, Work, and Connections flows using those components. Keep renderer behavior backed by canonical protocol capabilities and projections.

Production acceptance includes light/dark/system startup without a theme flash, consistency across windows and dialogs, safe recovery from an invalid preference, preservation of drafts while changing themes, target-accurate inspection, and reliable streaming/scroll behavior under a long session.

## 8. Prototype boundary

Everything is illustrative and runs locally in the preview. There are no real provider calls, approvals, shell commands, profile changes, or persistent settings writes. Refreshing the concept returns to its initial example state. The theme system and visual specification are proposed designs; production implementation is not included in this artifact.

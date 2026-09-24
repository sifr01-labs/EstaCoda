# Desktop gateway build updates and DDGS setup

Validated on macOS arm64 with Node 24.14.1 and pnpm 10.33.0.

## Implemented behavior

- Packaged Desktop can update an installed, stopped user gateway to its own verified retained build, through Connections → Background gateway → Manage. Stop and update have separate confirmations. The target is selected by the backend, never by a renderer-supplied path or command.
- Service configuration publication is atomic for build updates. Activation must report the expected build digest through the authenticated private endpoint. Verification failure attempts to restore/start the previous service; uncertain effects require inspection and are never replayed automatically.
- DDGS declares Python 3.10 as its minimum. Interpreter selection skips incompatible Python and checks explicit Homebrew locations without expanding Desktop’s PATH. Repair creates a fresh environment while retaining the previous directory for inspection.
- Dependency receipts contain fixed error categories and preparing/installing/verifying phases, without installer output or private paths. Desktop distinguishes failed/repair-required setup, shows the Python requirement, hides the duplicate Install opener, and restores keyboard focus after closing the review.

## Measured checks

- Frozen dependency installation using the existing offline pnpm store: passed; no dependency or lockfile changes.
- Core typecheck, Desktop/control-protocol typechecks, and Desktop protocol boundary: passed.
- Full core suite with two workers: 749 files / 12,010 tests passed. Default concurrency initially produced contention timeouts. A temporary source copy excluded pre-existing untracked duplicate TypeScript files; its Desktop protocol facade was linked to that same source copy.
- After the final atomic-publication review fix, focused core regressions: 9 files / 254 tests passed.
- Desktop unit suite: 47 files / 177 tests passed.
- Browser interaction suite: 11 tests passed, including DDGS failure/retry, explicit download approval, gateway stop/update review, uncertain-operation handling, and keyboard focus. Existing visual snapshots were not regenerated.
- Core build, Desktop renderer build, source smoke, runtime-import audit, and ESM audit: passed.
- Compiled-runtime smoke: all cases passed.
- Real DDGS installation in isolated temporary state with PATH restricted to Desktop’s system directories: selected Python 3.12.12, installed ddgs==9.14.4, and verified its import. Preparing, installing, and verifying stages were observed. This did not perform a live search.

## Review and limits

Review covered profile scoping, explicit download/lifecycle authorization, interpreter selection, immutable runtime content verification, opt-in wire compatibility with older readiness clients, interrupted publication, rollback failure reporting, durable reconciliation, redaction, and focus restoration.

The running user gateway and live DDGS environment were not changed. These checks do not claim a newly packaged Electron release or native service installation was deployed. Rebuild/reopen Desktop to use the new controls. Python itself remains operator-installed; retained Python environment backups consume disk space and are not automatically deleted. A failed rollback may require manual service repair and never reports verified readiness.

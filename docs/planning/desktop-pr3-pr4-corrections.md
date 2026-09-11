# Desktop PR3/PR4 review correction

One focused follow-up on `ame/desktop-foundation`, addressing the six review findings.

- Reserve admission capacity for Session Stop, Task Cancel/Pause and approval
  resolution, in addition to RPC cancellation and unsubscribe. Total request and
  output bounds remain unchanged; none of these controls bypass core authority.
- Separate full Session history from bootstrap. Capture Work metadata and bounded
  recent previews; page historical bodies using canonical append high water marks.
  Core transcript rewrites increment a revision that fences old pages. Authenticated,
  epoch-bound continuations permit repeated reads and forward traversal without
  exhausting a cursor map. No Session/Task count or aggregate transcript-size
  cutoff prevents profile access. Metadata memory still grows with Work count.
- Persist canonical user-turn references on outcomes and preserve turn identity
  through compression. New turns cannot inherit previous completion even when
  timestamps tie. Legacy ambiguous ties remain unconfirmed.
- Project blocked Sessions into Inbox and remove those input items when the
  corresponding Work no longer needs attention.
- Supply backend action hints, disabled reasons, origin Session and retry Step
  references. Read-only core target validation and trust/setup checks narrow
  continuation hints. Core lifecycle and Attempt budgets remain authoritative;
  action hints never grant execution or mutate trust/configuration.
- Map `waiting_for_host` to queued, retaining its explanation.

Regression coverage includes request saturation, same-timestamp turns, compression,
long messages/tool histories, more than 1,000 Sessions and Tasks, bounded page size,
repeated/forged/cross-profile cursors, more than 4,096 continuations, action schemas,
retry limits and cancellation after trust loss.

Security review: no new runtime, scheduler, approval orchestrator, credential
transport, dependency or schema migration. New persisted metadata contains only
turn references/timestamps and a transcript revision. Read-only target inspection
cannot create a registry or change its permissions. Actual mutation authorization
still runs in the owning core service. Five-second persisted polling and later
Electron/provider integration gates remain unchanged.

## Validation and final review

Node v24.14.1; pnpm 10.33.0. The final reviewed source passed:

- Focused Desktop/session/workspace regressions: **176 tests in 31 files**.
- Full suite: **10,792 tests in 653 files**.
- `desktop:foundation:check`: both workspace typechecks and pure protocol boundary.
- Complete `validate:execution-release` wrapper: frozen install, conformance
  inventory, root typecheck, full tests, source smoke, build, runtime-import audit,
  ESM audit, dist smoke, execution budgets, source/dist Docker execution and Docker
  image build/validation. Source and dist smoke each passed all 13 cases.
- Documentation link validation and `git diff --check`.

The checkout contains pre-existing untracked duplicate TypeScript files, including
conflicting bidi declarations, so its direct root typecheck fails on those files.
Release validation used an isolated copy without those unrelated duplicates.
All 1,618 executable/test files compared exactly with the working source. No
user files were removed or changed to make validation pass. Local IPC/Docker tests
ran with the required machine permissions and temporary state; providers were
fakes, with no live-provider or Electron certification implied.

Final review found no remaining gap in the six reported findings. Checks cover
both successful behavior and refusal paths. No dependency/lockfile change or
additional execution authority was introduced.

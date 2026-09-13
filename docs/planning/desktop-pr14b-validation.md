# Desktop PR14B validation record

Recorded 2026-09-13 on macOS 26.5.2 arm64, Node 24.14.1, pnpm 10.33.0, branch `ame/desktop-foundation`. Implementation commits run from `4d0359c2` through `0d98f3ff`; the following documentation commit completes the 18-part sequence. This is implementation acceptance evidence, not full public-parity or production-release certification.

## Executed checks

| Check | Result |
| --- | --- |
| `node --version`, `pnpm --version` | Versions above verified |
| `pnpm install --frozen-lockfile` | Passed; no dependency or lockfile changes |
| `pnpm run typecheck` | Passed |
| `pnpm run test --maxWorkers=2` | 700 test files, **11,545 tests passed** |
| `pnpm run smoke` | All smoke cases passed |
| `pnpm run build` | Passed |
| `pnpm run audit:runtime-imports` | Passed |
| `pnpm run audit:esm` | Passed |
| `pnpm run smoke:dist` | All compiled smoke cases passed |
| `pnpm run desktop:foundation:check` | Passed, including Desktop types and protocol boundary |
| `pnpm --filter @estacoda/desktop test` | 22 test files, **88 tests passed** |
| `pnpm --filter @estacoda/desktop e2e` | **220 browser tests passed** |
| `pnpm --filter @estacoda/desktop build:renderer` | Passed; renderer chunk-size warning remains |
| `git diff --check` | Passed before the documentation commit |

Core checks ran in a tracked-source validation copy under `node_modules/.cache/pr14b-validation`. This excludes pre-existing untracked duplicate source files without deleting or changing them. Its shared protocol dependency resolves to its own package so runtime validator identity matches a normal checkout. Desktop checks ran against the working repository. The final core run used two workers to avoid subprocess timeouts seen under host contention; no test expectations or security gates were weakened. The final source tree was synchronized before the run and unchanged during it.

The focused settings suite additionally passed 503 cases across six files, including all **479 registered controls** through actual reviewed persistence and CLI read/save round trips. Lifecycle/dependency guards and retained speech registration received focused regression checks before the final full run. Field cases use valid configured prerequisites and representative values; they do not establish every possible configuration combination or hosted-provider behavior.

## Review findings addressed

Final acceptance review added existing-fallback advanced options and credential scoping, legacy auxiliary/MCP/STT projection, case-insensitive replacement of credential-bearing headers, explicit fixed Docker image provisioning, guarded unused-profile rename/delete and installation-owner inspection. It also corrected provider-dialog focus restoration and removed the duplicate ephemeral record when speech is retained. These changes are included in the tested implementation commit.

## Remaining gates and risk notes

- Native packaged microphone permission, physical microphone capture and live hosted image/STT/TTS journeys were not run. Browser microphone tests pass synthetic audio through the production AudioWorklet. Main-process permission and capture-boundary behavior has unit coverage; this does not substitute for packaged OS acceptance.
- Dependency tests use injected provisioners. No Docker image, managed Python package or local model was downloaded as part of those tests. The stronger `validate:execution-release` host/Docker release wrapper was not run in this pass; its full Docker, budget and distributable gates remain separate release evidence.
- Profile rename/delete rejects active/default profiles, retained history, pending apply and running gateways. It does not migrate used-profile history or establish a global lifecycle lease against an independently starting CLI process. Installation inspection is read-only; update/uninstall remains owner-required. These are explicit action-parity limits in the [inventory](desktop-pr14b-parity.md).
- Retained media preview supports bounded images and MPEG/WAV/Ogg/AAC/FLAC speech up to 8 MB, subject to Electron codecs. Raw PCM and larger outputs lack this retained preview path. Conversation attachments are supported; durable Task media is not added here.
- Security-sensitive changes cover selected-profile config/credential transactions, settings IPC, dependency dispatch, profile lifecycle and media storage/permissions. Review does not grant execution authority. Existing runtime tool, workspace trust, hardline, network and spend policy remains in force. Accepted dependency installation may continue after its window closes; inspect the receipt before retrying.
- The renderer build retains a chunk larger than 500 KB. This is a delivery/performance warning, not a failed build; startup performance remains part of distributable acceptance.
- Schedule editing/delivery remains **PR15 pending**, packaged release acceptance remains PR16, and video remains PR21. Full parity and external-alpha readiness are not claimed by this record.

The [operator guide](desktop-pr14b-settings-and-media.md) describes the delivered controls and their limits. Unrelated pre-existing planning edits and untracked files were not included in the PR14B commits.

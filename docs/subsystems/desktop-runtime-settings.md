# Desktop execution settings

The Runtime entry opens four coordinated sections: Execution, Language & behavior,
Workspaces & profiles, and About. Cards and selectors use the same components as
Models & providers, Images, Voice, and Browser & Search.

Execution shows the selected profile's requested environment. It is not a live
attestation: the runtime verifies environment boundaries when new work starts.
Host commands retain the host account's file and network access. Unsupported
mandatory controls block execution; the UI does not claim host resource isolation.

Choosing Docker inspects the registered `docker-execution` dependency. Preparation
requires an explicit download review, uses the existing operation receipt, and
never replays a lost installation response. A prepared image and available engine
are required before selecting the environment. Selection stages a complete policy
for the existing profile review/apply transaction. Switching to host explicitly
reviews clearing Docker-specific controls. Existing work retains its execution
owner.

Interface language uses the existing desktop appearance preference immediately;
it does not rewrite profile settings. Command-line language, under Personality &
wording, remains a separate reviewed profile preference. Other language and
behavior preferences show normalized runtime values. Response progress is explicitly
identified as a command-line preference. Resource limits
use MB and seconds in the UI and convert to bytes/milliseconds in reviewed changes.
Workspace registration remains separate from trust. Profile and pack maintenance
continue through the existing reviewed action APIs and lifecycle restrictions.
Diagnostics and dependency inspection do not save settings.

## Validation

Runtime metadata is exercised through strict response validation, including every
pagination page. Behavioral tests cover execution transitions, reset semantics,
unit conversion, and reviewed removal of obsolete Docker controls. Desktop tests
cover English/Arabic navigation, explicit preparation, review-before-save, and
uncertain-operation recovery. `apps/desktop/tests/native-settings.mts` exercises
real renderer/preload/IPC and the owned runtime after desktop packaging.

## Risk boundary

This change does not grant workspace trust, forward credentials, start Docker
containers, relax command approval, or install an engine. Preparation only uses the
registered bundled-image operation. Runtime metadata contains public settings only;
unknown response fields remain rejected by strict protocol validation.

## Agent run limits

Execution → Agent run limits uses the same staged review and save flow as other Execution settings. It is available for both host and Docker execution. The CLI Setup Editor exposes the same policy through **Agent run limits**. Changes affect subsequent turns; active turns keep their snapshot.

The selected profile stores `runLimits.interactive` and `runLimits.unattended`. Both accept `maxDurationMinutes`, `maxIterations` (model steps), and `maxToolCalls`. Interactive work defaults to **Until complete**: zero disables each individual ceiling. Unattended work defaults to 30 minutes, 45 model steps, and 100 tool calls and requires positive limits. Supported ranges are up to 10,080 minutes and 1,000,000 steps or tool calls. Invalid policy fails validation rather than silently becoming unlimited.

CLI and desktop foreground conversations use interactive limits. Channel and delegated runs use unattended limits. Request timeouts, command resource limits, cancellation, repeated-failure and no-progress detection, spending controls, workspace trust, and action approvals remain separate and enforced. Increasing a run limit grants no additional tool authority.

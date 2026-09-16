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

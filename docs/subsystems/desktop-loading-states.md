# Desktop loading states

The desktop uses the approved refined loader prototype's dot pulse, satellite
orbit, and breathing skeleton rows. They are implemented locally in
`apps/desktop/src/renderer/components/loading.tsx` and `styles/loading.css`.
No animation package, external assets, new runtime capability, or stored design
preferences are involved.

## Visual contract

- Dot pulse: three 4 px dots, 4 px gaps, 1.5 s cycle, staggered opacity/scale and
  a 0.6 px lift. The live assistant status owns the translated label.
- Orbit: 22 px frame, faint orbital ring, stationary center, and three trailing
  satellite dots; 1.65 s rotation. This is the prototype's true orbit, not its
  alternate minimal arc.
- Skeletons: 68 px rows, 24 px icon slots, the prototype's alternating line
  widths, and a 2.475 s opacity cycle. Decorative rows wait 180 ms before
  becoming visible; their accessible loading status is available immediately.
- Kemet retains the exact approved skeleton colors. Graphite and Sand derive
  their neutral skeleton fill from their own theme tokens. Indicators use the
  existing accent token.
- Initial file/artifact results fade in over 180 ms. No result is withheld to
  finish an animation, and no hidden duplicate of real content is retained.
- Reduced motion renders meaningful static dots, orbit, and skeletons. All
  labels use the existing English/Arabic catalog; text is never split into
  animated characters.

## State ownership and integration

Dot pulse requires an active owner preview, running Work, and no pending
attention. The selected Work/profile and target-generation boundaries remount
the live preview, and inactive or failed owner reads remove it. Received text
remains selectable; only the short status is a live announcement.

Orbit identifies pending connection/Work reads, activity refreshes, provider
setup, onboarding, workspace inspection, media requests, and recorded browser
capture reads. A pending media load, save, or playback request uses its own
label. These indicators never infer success, cancellation, or authorization.

Skeleton rows identify initial artifact, file, search, browser-session, schedule,
and schedule-history reads. Same-profile artifact refreshes and schedule
pagination keep existing rows visible. An artifact profile switch clears the
previous scope; stale asynchronous results cannot replace the new scope.
File-preview failures and unavailable recorded captures show their existing
error/unavailable state rather than a permanent loading indicator.

Historical tool-called entries remain static: the current activity projection
stores starts and results separately and does not expose tool-call correlation.
Animating those historical `running` entries would falsely imply ongoing work.
Per-call animation needs a separately reviewed current-activity projection.

## Verification and risk

`tests/e2e/loading.spec.ts` exercises real animation, exact timing/geometry,
theme/RTL containment, reduced motion, delayed reads, failure, attention,
settlement, and profile/disconnection fencing. Existing files, artifacts, Work
continuity, browser, onboarding, media, schedules, and provider tests cover the
integrated components.

Risk is presentation/state labeling. No protocol, credential, approval,
execution-owner, browser-authority, or dependency-install policy is changed.
The prototype's sample results and manual completion control are not shipped.

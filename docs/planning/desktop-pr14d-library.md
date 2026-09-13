# Desktop Library and Agent Evolution — PR14D

Implemented on `ame/desktop-foundation`. The approved Library primitives and neutral/ocean appearance remain in use; the live views have English and Arabic labels, bounded plain-text previews, compact layouts, and keyboard review cancellation. Models and Connections retain their existing dedicated surfaces.

## Browsing and privacy

- **Artifacts** retains the existing canonical artifact inspector and source Work navigation.
- **Skills & tools** lists file-backed skills in the selected profile's effective registry. Profile-local skills shadow bundled and pack skills using the core registry's precedence. Details show instructions and declared required/optional toolsets. Visibility does not enable tools or grant execution authority.
- **Memory** reads the selected profile's `USER.md`, `SOUL.md`, and `MEMORY.md`. These are read-only previews. Global shared memory is separate and is not implicitly loaded into this view. This milestone does not provide memory editing or a browser for every memory backend.
- **Evidence** shows proposals, linked observation summaries, metadata gate results, and available source Work links. Source Sessions are checked against the selected profile in core and again before navigation. Raw trace stores, credentials, internal snapshot paths, and other profiles' records are not exposed.
- **Agent Evolution** adds proposal decisions and promotion history to this evidence view. Missing/disconnected data stays unavailable; fixture examples never substitute for live results. Changing profile or disconnecting clears loaded private previews and invalidates pending results.

Source files are bounded to 1 MiB; Evolution JSONL stores are additionally bounded to 1,000 rows each. Skills and proposals are paged, with aggregate encoded-byte bounds in addition to field limits. Memory and instruction previews are at most 16,384 characters; memory may truncate sooner to bound escaped JSON. Oversized, malformed, or linked private state fails closed. A truncation notice is a preview limit, not data deletion.

## Review, gates, and promotion

1. Open a proposal and inspect its evidence, current metadata checks, approval, risk, and proposed change.
2. Choose **Check proposal gates**, **Approve proposal**, **Reject proposal**, or **Promote proposal**. This prepares a review and does not apply the decision.
3. If the linked manifest has command gates, select an available workspace. Review displays the backend-selected canonical workspace and commands. Confirmation authorizes those project commands, which may execute project code and produce workspace changes.
4. Confirm the prepared decision. Core checks that the proposal, skill, evidence, eval inputs, usage policy, and manifest still match the review. A changed or expired review must be prepared again.

Every Desktop promotion requires explicit proposal approval, including low-risk proposals. Linked manifests retain the existing test → approve → promote transitions. Failing metadata checks block approval/promotion; rejection remains available. The core promotion owner checks source trust, mutation policy, proposed content and candidate evals, snapshots the current skill, and records promotion. Bundled/external source assets are not overwritten; promotion uses a profile-local working copy.

**Metadata skill evals do not execute real task fixtures.** A “not tested” result is not a successful test run. Declared command gates are separate: the existing core allowlist supports `pnpm run typecheck`, `pnpm run test`, `pnpm run smoke`, and `pnpm run eval:fixtures`, including its normalized aliases. These execute through the selected environment's process owner with workspace trust and canonical target validation. Each command shares core's five-minute timeout; captured output is bounded to 1 MiB and discarded rather than sent to the renderer. Processes are settled on completion, failure, overflow, or cancellation. Failed settlement retains the target borrower.

The selected project/environment must provide the tools and scripts required by its gates. Desktop does not install pnpm, project dependencies, or gate commands implicitly. Unsupported or oversized command reviews are blocked. Reviews expire after five minutes, and final changes are serialized with the existing profile write lock. No background promotion or automatic mutation is introduced.

## Supported restoration

**Restore previous skill version** prepares a separate explicit review. It is available only for the latest promotion of a local skill when:

- The retained snapshot is a bounded regular file inside that profile's snapshot directory.
- The current `SKILL.md` exactly matches the result of applying that promotion's patch to the snapshot.
- The skill is unpinned, the restored content passes the existing content-mutation policy and metadata checks, and any linked manifest is still promoted.

Confirmation revalidates eligibility, preserves a snapshot of the promoted version, and restores only `SKILL.md`, the file promotion changes. It leaves other files and later edits intact. Supported linked manifest commands run before restoration; the manifest is then marked reverted and the core mutation record records rollback. Promotion history remains historical after restoration, so its proposal can still say “promoted” while the manifest is reverted and restoration is no longer available.

Missing snapshots, later edits, newer promotions, authority-expanding restoration, or incompatible proposal kinds require review outside this narrow restore path. Desktop does not provide arbitrary directory restoration, force rollback, or a generic undo for every Evolution proposal type. Snapshot retention alone does not imply that restoration is currently safe or available.

## Cancellation and recovery

Cancel or Escape discards an unaccepted review without applying its decision. Escape returns focus to its initiating control. Closing/disconnecting invalidates review authority; Main binds confirmation to the current window generation and profile. The renderer cannot supply operation IDs, substitute commands, or choose another profile.

After confirmation, **Inspect last Evolution operation** reads the selected profile's durable receipt using Main's saved reference. Inspection also runs when the decision view opens. It does not rerun the operation. Completed and failed receipts permit a fresh review; unknown or uncertain outcomes block further Evolution operations in Desktop. Refresh canonical proposal/skill/manifest state and have the owning operator reconcile an unresolved receipt; this UI does not force-clear uncertain state or claim that inspection itself settles it. Accepted actions cannot be undone by cancelling a later screen.

Operation completion describes that decision only. It is not a claim that task fixtures ran, a promotion succeeded for another proposal, or all production reliability checks passed. Existing CLI/runtime writers still use their own core owners; the Desktop profile lock is not a new universal transaction across every external writer. Reviews recheck state, and ambiguous outcomes remain inspectable rather than automatically replayed.

See [validation evidence](desktop-pr14d-validation.md).

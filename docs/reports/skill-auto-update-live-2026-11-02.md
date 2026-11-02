# Automatic skill activation: live validation

On 2026-11-02, EstaCoda automatically learned, saved and reused a corrected local skill without human approval or a paired task-evaluation report. Fresh sessions using the updated profile passed 3/3 unseen file-processing tasks; the previous version's profile passed 1/3. Approval-required mode, pinning, snapshots and undo also behaved as intended.

This is a controlled demonstration of automatic skill activation and reuse after an explicit correction. It does not establish general spontaneous self-improvement or performance superiority over Hermes.

## Change

In proactive/autonomous mode, `skills.writeApproval` defaults to `false`. A supported low-risk body-only patch to a profile-owned local skill can activate through the existing proposal/promotion service. Setting the boolean to `true` leaves the patch pending until approval. Suggest/off modes do not activate changes automatically. Existing pending proposals retain their recorded gates.

Ordinary eligible instruction edits no longer require a performance benchmark before activation. Operators can still request evaluations; an attached failed evaluation blocks promotion. Other learned executable changes retain their existing requirements. This is a policy change, documented in AGENTS.md and current product copy, rather than a hidden approval bypass.

The service preserves content hashes, ownership and authority checks, pinning, profile isolation, snapshots and audit records. Promotion is serialized. Background execution revalidates live authority and cancellation before writing. Changing skill configuration revokes the running runtime's authority, preventing a pending reviewer from retaining stale permission. Updates enter session history, emit an update event, and appear in the CLI. Subsequent turns refresh the skill catalog and revalidate visibility. No automatic rollback is introduced.

## Live protocol

- Previous revision: `f68f2490a`; updated production files are pinned by SHA-256 in [manifest.json](../../evals/results/skill-auto-update-live-2026-11-02/manifest.json).
- Actual provider: Codex `gpt-6.1-sol`, with no fallback routes.
- Thirteen completed real-model tasks using real file reads/writes and commands, isolated profiles, and synthetic inventory data.
- Four training profiles: previous runtime, updated automatic mode, updated approval-required mode, and updated pinned skill.
- Each starts with the same intentionally stale “last row wins because exports are chronological” skill. A user correction points to an exporter contract and an operator-owned verifier.
- The foreground agent is explicitly told to leave skill changes to background review. The reviewer receives the real session evidence and generates the patch itself.
- Follow-up tasks use fresh sessions and fresh workspaces, loading the actual skill persisted in each profile. No manual candidate installation, training conversation, contract or expected answer is supplied to those sessions.
- Expected JSON was frozen before execution and graded externally. The grader also checks unchanged input fixtures and normal task termination. Three previous/automatic pairs use alternating arm order.
- Foreground limits: 16 provider iterations, 24 tool calls, 180 seconds and 4,000 output tokens; temperature 0. The background reviewer retains its existing bounded single-call budget.

## Results

| Check | Observed result |
| --- | --- |
| Previous runtime after one corrected task | Proposal pending; active skill unchanged |
| Updated automatic mode | One review call; proposal promoted; active skill changed without approval or task evaluation |
| Update visibility | Session notice and `skill-updated` event recorded |
| Out-of-order revisions | Previous failed; automatic passed |
| Revision ties and tombstones | Previous failed; automatic passed |
| Chronological regression | Both passed |
| Approval-required mode | Proposal pending; active skill unchanged; unapproved promotion refused |
| Fresh session before explicit approval | Original out-of-order failure remained |
| Explicit approval and promotion | Succeeded without requiring a task-evaluation report; fresh session then passed |
| Pinned skill | Training task completed; skill unchanged; no executable proposal created |
| Snapshot | Saved original SKILL.md matched the initial bytes exactly |
| Undo | Restored the initial bytes exactly; a fresh session reproduced the original out-of-order failure |

The automatically applied patch replaced the chronological-order assumption with greatest-numeric-revision selection, last-occurrence tie breaking, and protection against an older row reviving a newer tombstone. The unedited result is in [automatically-active-skill.md](../../evals/results/skill-auto-update-live-2026-11-02/automatically-active-skill.md).

The before-approval and after-undo failures are intentional controls demonstrating that the old instructions remained/restored. They are retained in the raw results rather than counted as successful reconciliation tasks.

## Test setup correction

An initial pilot used an ambiguous instruction to honor the learning policy. The previous runtime's foreground agent attempted skill-management tools and exhausted its 16-step budget despite writing the correct output. The pilot was stopped because it did not isolate background review. Its undo helper also lacked the manifest-store connection used in production. The final runner explicitly delegates learning to background review and wires the same manifest store. No production source changed between the pilot and completed run. [Pilot evidence and explanation](../../evals/results/skill-auto-update-live-2026-11-02/aborted-pilot/NOTE.json) are retained; partial pilot runs are excluded from the completed comparison, and interrupted usage may be incomplete.

## Evidence, validation and limits

[Summary](../../evals/results/skill-auto-update-live-2026-11-02/summary.json), [frozen fixtures](../../evals/results/skill-auto-update-live-2026-11-02/fixtures.json), [runner](../../evals/results/skill-auto-update-live-2026-11-02/run.mjs), and [validation record](../../evals/results/skill-auto-update-live-2026-11-02/validation.json). Per-run directories contain redacted transcripts, usage, outcomes and learning records. Temporary task credentials were removed. Exported artifacts passed credential-pattern and absolute-user-path scans.

The runner makes paid provider calls using the selected profile's Codex account. Run from this repository with `node --import tsx evals/results/skill-auto-update-live-2026-11-02/run.mjs /private/tmp/<new-directory>`. Archive the existing results first; the runner replaces adjacent evidence files. Runtime comparisons use the previous revision plus the working tree's changed production TypeScript files. The manifest records the exact tested bytes.

All 13,446 repository tests across 786 files passed, along with typechecking, frozen dependency installation, source/distribution smoke checks, build, runtime-import audit, ESM audit and diff checks. Targeted validation passed 430 tests. Full repository validation overlapped parts of the live experiment, so elapsed times are not used to claim a speed advantage.

Risk: a supported-looking model suggestion can still be wrong. Automatic activation intentionally removes mandatory human/performance review for this narrow class of edits. Read boundaries, redaction, locked skills, content binding, snapshots and permission checks limit exposure but cannot prove semantic correctness. Three synthetic task types and one learned change are insufficient to establish broad quality. Built-in/external assets, frontmatter, higher-risk changes and permission expansion are outside this automatic path. Use write approval or pinning where automatic instruction changes are unwanted.

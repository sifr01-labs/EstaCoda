# Chat-owned task completion

The task remains responsible for the requested deliverable after the foreground
agent hands it off. Desktop projects the latest request's status from its durable
task. A successful handoff does not make a pending report appear complete.

## Implemented behavior

- Worker completion uses its assigned request, not the parent's quoted file-save
  instruction. The report-delivery step still requires file-write and read-back
  evidence for the accepted synthesis.
- A failed `web.extract` HTTP response can be superseded by other observed sources
  in a research worker's source/claim table. The failed URL cannot be cited or
  explicitly required by the assignment. Missing evidence, missing tools,
  authorization failures, and failed writes remain blockers. Access limitations
  are retained in the accepted result and the attempt history.
- Safe research failures pause for review while attempts remain. A targeted retry
  uses the existing task authority and budget, preserving accepted results and
  diagnostic drafts. Exhausted attempts retain the existing partial/failure policy.
  Historical terminal tasks are not reopened.
- Unexpected executor errors preserve a bounded exception class, relative source
  locations and correlation reference. Exception messages and absolute paths are
  excluded. A missing webpage is classified as a retrieval failure, not a missing
  tool.
- Desktop-originated delegation registers the existing durable transcript outbox.
  The gateway appends terminal success, partial results or failure to the originating
  conversation and acknowledges persistence. Stable message IDs make interrupted
  appends retryable without duplicate transcript messages. Profile, lineage and
  Desktop target identity/generation checks apply to delivery and recovery.
- Conversation contains a compact Tasks entry. Tasks contains the plan, expandable
  workers, preserved-draft indicators, reviewed retries and guidance. Child attempts
  stay out of default sidebar/Work navigation; deep links and explicit search remain.
  Chat composer drafts survive tab changes. Changes and Results remain separate.
  A report is labelled saved and verified only from that task's delivery receipt.

## Boundaries

The source table verifies provenance and the retained claim/limitation contract;
it is not an independent scientific fact checker. A successful release fixture
proves execution plumbing, not the factual quality of a live model's research.

The two historical executor exceptions had already lost their diagnostic details.
Their exact causes cannot be recovered from the stored generic failures. The new
failure diagnostics and bounded recovery cover future occurrences; they do not
constitute a retrospective identification of those exceptions. Existing historical
missing delivery bindings and settled failures are not silently rewritten.

## Risk review

No new model-visible tools, grants, package installs, network exceptions or remote
sending permissions are introduced. Capability restrictions, current workspace
trust, approvals, task ownership, fencing and remaining budgets still govern retry.
Only an allowed read-only HTTP retrieval is eligible for source substitution.
Desktop delivery reuses the local transcript outbox; channel send semantics remain
unchanged. The Tasks projection is bounded and exposes no raw source contents.

## Validation

Validation uses a clean archive plus the implementation patch, because the working
checkout contains unrelated duplicate source declarations. The final [release measurement](chat-owned-task-reliability-validation.json) and
[Tasks screenshot](chat-owned-tasks.png) are attached in this directory. The packaged test uses a real
signed application, owned bridge, gateway, scheduler, workers and filesystem, with
synthetic model/web responses and an isolated home/workspace. It exercises page
failures, a worker evidence failure, review/retry after gateway restart, synthesis,
file read-back, and exactly-once completion delivery. It also checks missing search,
false save claims and a save-only follow-up after restart.

Final review preserved foreground Stop controls during handoff and classified the
background task host as internal so it does not appear as an extra conversation.

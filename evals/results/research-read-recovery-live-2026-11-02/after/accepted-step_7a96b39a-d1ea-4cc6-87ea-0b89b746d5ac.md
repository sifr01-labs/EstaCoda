Hermes preserves usable text despite tool or schema errors, but explicit run failures take precedence. A completed delegation status alone does not prove research completion.

## Scope and revision

This is the **Hermes-only evidence contribution**, not the cross-codebase synthesis. Discovery found the supplied Hermes files, and targeted reads covered `_validate_child_output_schema`, `_build_tool_trace`, `_build_result_entry`, `run_tool_round`, and the stop-gate implementation.

`MANIFEST.json` identifies the pinned Hermes revision as **`5e7c2b254d414e4e25105231f818f385fee67469`** and supplies input hashes for the inspected files. This is the manifest’s source identity, not a claim about upstream HEAD or independently verified file hashes. No live-source evidence was required or used. [Repository: `MANIFEST.json`, `hermesRevision` and `inputHashes`.]

## Observed implementation

### 1. Tool errors are not automatically delegation failures

`_build_tool_trace` pairs assistant tool calls with tool messages by `tool_call_id`, falling back to the latest call where necessary. Each tool result receives a trace status of `"error"` or `"ok"` through `_looks_like_error_output(content)`.

However, `_build_result_entry` does **not** inspect that trace to decide delegation status. It bases status on interruption, structured run failure fields, and final-response presence. Thus, a child result containing error-marked tool messages can still produce a parent-visible `"completed"` result. [Repository: `hermes/tools/delegate_tool_child_run.py:565–630`, `_build_tool_trace`, `_build_result_entry`.]

`run_tool_round` likewise contains no general “any tool error fails the run” check after `_execute_tool_calls`. Its ordinary path processes results, performs compression, updates session activity, and returns `"continue"`. Mixed batches with invalid tool names receive matching error-result messages, while invalid calls are removed from execution. [Repository: `hermes/agent/turn_tool_round.py:101–128,170–238`, `run_tool_round`.]

**Inference:** A local read error can be recoverable within the conversation without permanently poisoning delegation acceptance. These sections do not establish whether a particular recovery occurred or whether the eventual report has adequate evidence.

### 2. Real run failures override nonempty text

The status precedence in `_build_result_entry` is:

1. `interrupted` → `"interrupted"`;
2. otherwise, truthy `failed` or `error` → `"failed"` with `exit_reason="error"`;
3. otherwise, classify by summary presence and the child’s `completed` flag.

Consequently, an error explanation in `final_response` cannot disguise an explicitly failed run as successful. Failed entries expose `error` and, when supplied as a nonempty string, `failure_reason`. The summary itself remains available. [Repository: `hermes/tools/delegate_tool_child_run.py:595–670`, `_build_result_entry`.]

There are concrete infrastructure failures in `run_tool_round`: if the pre-execution canonical persistence flush returns `False` or raises, it sets `failed=True`, clears the final response, and breaks **before executing tools**. If tool-result persistence subsequently fails, it similarly breaks rather than sending the noncanonical result back to the model. [Repository: `hermes/agent/turn_tool_round.py:129–153,176–183`, `run_tool_round`.]

This durability gate should not be confused with execution authorization. Scope, approval, and scheduling mechanisms are called or referenced here, but their complete implementations were not inspected.

### 3. Partial output is deliberately retained

With no structured failure, a usable summary gives `status="completed"` even when the child’s `completed` flag is false. In that case Hermes emits `exit_reason="max_iterations"` and `truncated=true`. Thus **“completed status” can mean deliverable text exists, not that the task reached normal completion**. [Repository: `hermes/tools/delegate_tool_child_run.py:621–649`, `_build_result_entry`.]

On interruption, Hermes searches backward for the last non-placeholder assistant text, substitutes it as the summary, and retains the interruption placeholder as an error note when such partial text exists. Status remains `"interrupted"`. [Repository: `hermes/tools/delegate_tool_child_run.py:606–616,669–670`, `_build_result_entry`.]

A small implementation edge: `usable_summary` rejects an empty string and the stripped sentinel `"(empty)"`, but its expression does not reject whitespace-only strings. This is a source-level observation, not a tested behavior. [Repository: `hermes/tools/delegate_tool_child_run.py:601–605`.]

### 4. Schema failure is a separate verdict

`_validate_child_output_schema` validates only when the attached schema is a dictionary. Invalid nonblank, uninterrupted output gets one retry conversation. Retry exceptions are logged; the original result can survive. A nonblank retry response replaces `final_response`; API-call counts and compatible message lists are merged. [Repository: `hermes/tools/delegate_tool_child_run.py:520–563`, `_validate_child_output_schema`.]

Persistent schema invalidity does not independently fail `_build_result_entry`. It exposes `schema_valid=false`, optional errors/retry count, and a `schema_note` identifying the summary as raw, unvalidated text. Although a nearby comment says the summary is prefixed with a notice, the implementation adds a **separate field**, not a summary prefix. A status-and-summary-only consumer can therefore miss the warning. [Repository: `hermes/tools/delegate_tool_child_run.py:621–630,672–686`, `_build_result_entry`.]

Another boundary worth testing: the retry merger does not propagate the retry result’s `failed`, `error`, `completed`, or `interrupted` fields into the original result. Its implications require tests; it should not be assumed that every retry failure becomes a structured delegation failure.

### 5. Stop gates request more work; they do not certify research coverage

`apply_stop_gates` checks late LSP notes, verify-on-stop, pre-verify hooks, and Kanban nudges in that implementation order. Continuation preserves the proposed answer as `pending_verification_response` while clearing `final_response`. Several helper exceptions are logged and return no nudge. [Repository: `hermes/agent/turn_stop_gates.py:36–118,134–223`, helper functions and `apply_stop_gates`.]

These mechanisms are not, in the inspected code, a required-source or citation-coverage validator. No nudge is therefore insufficient evidence of verified research completion.

## Acceptance recommendation and regression cases

**Recommendation, not existing Hermes behavior:** keep execution authorization, retained report text, evidence coverage, and verified completion as separate decisions. Accept useful text after recoverable read errors only when required sources were subsequently obtained or gaps are explicitly reported. Preserve partial or schema-invalid text, but do not silently elevate it to verified completion.

Proposed tests, **not executed**:

- Error-marked read followed by successful evidence reads and a report.
- Required source still unread despite nonempty output.
- Nonempty summary plus explicit `failed` or `error`.
- Budget exhaustion with retained summary and `truncated=true`.
- Interrupted run with partial assistant text.
- Invalid schema after one retry; consumer must inspect `schema_valid`.
- Retry exception, blank retry, and retry carrying failure flags.
- Persistence failure before dispatch: verify no tool execution.
- Whitespace-only and `"(empty)"` summaries.
- Stop-gate continuation: candidate text retained without being treated as verified final output.

**Limitations:** no tests were run; upstream behavior, imported validator internals, full authorization machinery, and finalizer handling of pending verification were not established by these targeted reads.
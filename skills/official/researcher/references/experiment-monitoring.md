# Experiment Execution & Monitoring

Running experiments reliably, monitoring progress, and recovering from failures. Load this when experiments are running or about to launch (Phase 3).

---

## Launch Patterns

### Foreground Execution

Use for short experiments (< 1 hour):

```bash
python run_experiment.py --config config.yaml
```

### Background Execution

Use `nohup` for long-running experiments:

```bash
nohup python run_experiment.py --config config.yaml > logs/experiment_01.log 2>&1 &
echo $!  # Record the PID
```

### Parallel Execution

Run independent experiments simultaneously, but be aware of API rate limits. 4+ concurrent experiments on the same API will slow each down.

---

## Monitoring (Cron Pattern)

### Cron Prompt Template

For each experiment batch, create a monitoring prompt:

```
Check the status of the [EXPERIMENT_NAME] experiment:

1. Process check: ps aux | grep [PROCESS_PATTERN]
2. Log check: tail -30 [LOG_FILE]
3. Results check: ls [RESULT_DIR]/eval/
4. If results are available:
   - Read the result JSON files
   - Report metrics in a table
   - Compute key comparisons between methods
5. If all experiments in this batch are complete:
   - Report final summary
6. Key question: [SPECIFIC ANALYTICAL QUESTION]

If nothing has changed since the last check, respond with [SILENT].
```

### Monitoring Best Practices

1. **Check processes first** — don't read results if the experiment is still running
2. **Read the log tail** — look for errors, progress indicators, completion messages
3. **Count completed vs expected** — "45/150 problems done" is more useful than "some results exist"
4. **Report in structured tables** — always include key metrics in a table
5. **Answer the key question** — each experiment should have a specific analytical question
6. **[SILENT] for no-news** — suppress notifications when nothing has changed
7. **Commit on completion** — every completed batch gets committed with a descriptive message

### Example Monitoring Report

```
## Code Experiments (Haiku 3.5) - COMPLETE

| Strategy | Pass Rate (150 problems) | vs Single |
|----------|------------------------|-----------|
| single_pass | 38.0% | — |
| critique_revise | 35.2% | -2.8pp |
| **autoreason** | **40.0%** | **+2.0pp** |
| best_of_6 | 31.0% | -7.0pp |

Key finding: Autoreason shows +2pp improvement over single pass, while
best-of-6 collapses due to single-public-test selection issue.

Next: Run significance tests on these results.
```

---

## Failure Recovery

### Common Failures and Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| **API credit exhaustion** | 402 errors in logs, incomplete results | Top up credits, re-run (skips completed work) |
| **Rate limiting** | 429 errors, slow progress | Add retry logic with exponential backoff |
| **Process crash** | PID gone, log stops mid-problem | Re-run script (resumes from last checkpoint) |
| **Wrong model ID** | Model not found errors | Fix ID and re-run |
| **Parallel slowdown** | Each experiment taking 2x longer | Reduce parallel experiments to 2-3 max |
| **Security scan blocks** | Commands blocked by security | Use `execute_code` instead of piped `terminal` commands |
| **Delegation failures** | `delegate_task` returns errors | Fall back to doing work directly |
| **Timeout on hard problems** | Process stuck, no log progress | Kill, skip problem, note in results |
| **Dataset path mismatch** | File not found errors | Verify paths before launching |

### Retry Naming Convention

When re-running failed experiments, use a suffix to track rounds:

```
logs/experiment_haiku_0_50.log       # Round 1
logs/experiment_haiku_0_50_r2.log    # Round 2 (after credit exhaustion)
logs/experiment_haiku_0_50_r3.log    # Round 3 (after bug fix)
```

---

## Pre-Flight Checklist

Before launching any experiment batch:

- [ ] API credits sufficient for estimated calls
- [ ] Model IDs correct (test with 1 problem first)
- [ ] Output directory exists and is writable
- [ ] Resume logic works (re-run won't overwrite existing results)
- [ ] Log file path is unique (won't overwrite previous logs)
- [ ] Dataset/task files are accessible
- [ ] Config matches intended experiment

---

## Experiment Journal

Git commits track what happened, but not the **exploration tree** — the decisions about what to try next based on what you learned. Maintain a structured experiment journal:

```json
{
  "id": "exp_003",
  "parent": "exp_001",
  "timestamp": "2025-05-10T14:30:00Z",
  "hypothesis": "Adding scope constraints will fix convergence failure from exp_001",
  "plan": "Re-run with max_tokens=2000 and fixed structure template",
  "config": {"model": "haiku", "strategy": "autoreason", "max_tokens": 2000},
  "status": "completed",
  "result_path": "results/exp_003/",
  "key_metrics": {"win_rate": 0.85, "convergence_rounds": 3},
  "analysis": "Scope constraints fixed convergence. Win rate jumped from 0.42 to 0.85.",
  "next_steps": ["Try same constraints on stronger model", "Test without structure template"],
  "figures": ["figures/exp003_convergence.pdf"]
}
```

**Why a journal, not just git?** Git tracks file changes. The journal tracks reasoning: why you tried X, what you learned, and what that implies for the next experiment. When writing the paper, this tree is invaluable for the Methods section ("we observed X, which motivated Y") and for honest failure reporting.

**Selecting the best path**: When the journal shows a branching tree, identify the path that best supports the paper's claims. Document dead-end branches in the appendix as ablations or negative results.

**Snapshot code per experiment**: Copy the experiment script after each run to enable exact reproduction even after subsequent code changes.

---

## Cost Tracking

Track actual spend as experiments run:

```python
import json
from datetime import datetime

COST_LOG = "results/cost_log.jsonl"

def log_cost(experiment: str, model: str, input_tokens: int, output_tokens: int, cost_usd: float):
    entry = {
        "timestamp": datetime.now().isoformat(),
        "experiment": experiment,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost_usd,
    }
    with open(COST_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
```

**When budget is tight**: Run pilot experiments (1-2 seeds, subset of tasks) before committing to full sweeps. Use cheaper models for debugging pipelines, then switch to target models for final runs.

---

## Compute Budget Checklist

- [ ] API costs estimated and tracked
- [ ] GPU hours estimated and tracked
- [ ] Human evaluation costs estimated
- [ ] Total budget ceiling set with 30-50% contingency
- [ ] Pilot experiments run before full sweeps
- [ ] Cheaper models used for pipeline debugging

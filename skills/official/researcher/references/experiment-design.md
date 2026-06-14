# Experiment Design Guide

Designing experiments that directly support paper claims. Load this when the user is planning experiments (Phase 2).

---

## Claim-to-Experiment Mapping

Before running anything, create an explicit mapping:

| Claim | Experiment | Expected Evidence |
|-------|-----------|-------------------|
| "Our method outperforms baselines" | Main comparison (Table 1) | Win rate, statistical significance |
| "Effect is larger for weaker models" | Model scaling study | Monotonic improvement curve |
| "Convergence requires scope constraints" | Constrained vs unconstrained | Convergence rate comparison |

**Rule**: If an experiment doesn't map to a claim, don't run it.

---

## Baseline Categories

Strong baselines separate accepted papers from rejected ones.

| Category | Description | Example |
|----------|-------------|---------|
| **Naive baseline** | Simplest possible approach | Majority class, random guessing |
| **Strong baseline** | Best known existing method | Current SOTA on the benchmark |
| **Ablation baselines** | Your method minus one component | Remove attention mechanism |
| **Compute-matched baselines** | Same compute budget, different allocation | Same training steps, different architecture |

---

## Evaluation Protocol

Define before running anything:

- **Metrics**: What you're measuring, with direction symbols (↑ higher better, ↓ lower better)
- **Aggregation**: How results combine across runs/tasks (mean, median, etc.)
- **Statistical tests**: Which tests establish significance (McNemar, paired t-test, bootstrap)
- **Sample sizes**: Number of runs, seeds, problems, tasks

---

## Experiment Infrastructure

### Directory Structure

Organize experiments with a consistent structure:

```
workspace/
  experiments/
    run_main.py                # Core experiment runner
    run_baselines.py           # Baseline comparison
    run_ablation.py            # Ablation studies
    strategies.py              # Method implementations
    config.yaml                # Shared configuration
  results/
    <experiment_name>/
      <task_or_problem>/
        <strategy>/
          result.json          # Final metrics
          final_output.md      # Final output artifact
          history.json         # Full trajectory/log
          pass_01/             # Per-iteration artifacts (if iterative)
            intermediate.md
  analysis/
    analyze_results.py         # Statistical analysis
    compute_stats.py           # Significance tests
    make_charts.py             # Visualization
  paper/
    paper.tex                  # LaTeX source
    fig_*.pdf                  # Generated figures
```

### Script Design Principles

**1. Incremental Saving (Crash Recovery)**

Save results after each unit of work, and skip already-completed work on restart:

```python
import json, os
from pathlib import Path

def run_experiment(problems, strategies, output_dir):
    for problem in problems:
        for strategy in strategies:
            result_path = Path(output_dir) / problem["id"] / strategy / "result.json"
            if result_path.exists():
                print(f"Skipping {problem['id']}/{strategy} (already done)")
                continue
            result = execute_strategy(problem, strategy)
            result_path.parent.mkdir(parents=True, exist_ok=True)
            with open(result_path, 'w') as f:
                json.dump(result, f, indent=2)
```

**2. Artifact Preservation**

Save all intermediate outputs:

```python
def save_pass_artifacts(output_dir, pass_num, artifacts):
    pass_dir = Path(output_dir) / f"pass_{pass_num:02d}"
    pass_dir.mkdir(parents=True, exist_ok=True)
    for name, content in artifacts.items():
        with open(pass_dir / f"{name}.md", 'w') as f:
            f.write(content)
```

**3. Configuration Management**

Use YAML configs for reproducibility:

```yaml
# config.yaml
model: anthropic/claude-sonnet-4-20250514
author_temperature: 0.8
judge_temperature: 0.3
max_tokens: 4096
num_judges: 3
max_passes: 15
convergence_k: 2
```

```python
import yaml
with open("config.yaml") as f:
    config = yaml.safe_load(f)
```

**4. Separation of Concerns**

| Script | Purpose |
|--------|---------|
| `run_experiment.py` | Core method execution |
| `run_baselines.py` | Baseline comparisons at same compute |
| `run_eval.py` | Blind evaluation / judge panels |
| `analyze_results.py` | Statistical analysis |
| `make_charts.py` | Figure generation |

---

## Evaluation Protocols

### Blind Judge Panels (for Subjective Tasks)

When evaluating subjective outputs, use a blind judge panel:

```python
import random

def run_blind_evaluation(outputs: dict, task_prompt: str, num_judges: int = 7):
    rankings = []
    for judge_i in range(num_judges):
        methods = list(outputs.keys())
        random.shuffle(methods)
        labels = {m: chr(65 + i) for i, m in enumerate(methods)}
        prompt = f"Task: {task_prompt}\n\n"
        for method in methods:
            prompt += f"--- Proposal {labels[method]} ---\n{outputs[method]}\n\n"
        prompt += "Rank all proposals from best to worst. Format: RANKING: [best], [second], [worst]"
        ranking = call_judge(prompt)
        rankings.append({"labels": labels, "ranking": ranking})
    return compute_borda(rankings)

def compute_borda(rankings, n_methods=3):
    scores = {}
    points = {0: n_methods, 1: n_methods - 1, 2: n_methods - 2}
    for r in rankings:
        for position, method in enumerate(r["ranking"]):
            scores[method] = scores.get(method, 0) + points.get(position, 0)
    return scores
```

Key design decisions:
- Randomize both labels AND order per judge to prevent position bias
- Use odd number of judges (3, 5, 7) to break ties
- Conservative tiebreak: incumbent/baseline wins ties

### Code/Objective Evaluation

For tasks with ground-truth evaluation:

```python
import subprocess

def evaluate_code(solution: str, test_cases: list, timeout: int = 30):
    results = {"public": [], "private": []}
    for test in test_cases:
        try:
            proc = subprocess.run(
                ["python3", "-c", solution],
                input=test["input"],
                capture_output=True,
                timeout=timeout,
                text=True
            )
            passed = proc.stdout.strip() == test["expected"].strip()
        except subprocess.TimeoutExpired:
            passed = False
        category = "public" if test.get("public") else "private"
        results[category].append(passed)
    return {
        "public_pass_rate": sum(results["public"]) / max(len(results["public"]), 1),
        "private_pass_rate": sum(results["private"]) / max(len(results["private"]), 1),
    }
```

### Compute-Matched Comparison

Always compare methods at equal compute budget:

| Method | Call Budget | Allocation |
|--------|-----------|------------|
| Single pass | 6 calls | 6 independent generations |
| Critique & revise | 6 calls | 1 generate + 5 revise rounds |
| Iterative refinement | 6 calls | 1 generate + 1 analysis + 4 revisions |
| Best-of-N | 6 calls | 6 independent, pick best on public test |

---

## Task/Benchmark Design

### Open-Ended Tasks (Subjective Evaluation)

Design tasks with clear objectives but subjective quality:

```markdown
# Task: [Title]

## Context
[Specific scenario with concrete details]

## Deliverable
[Exact format and structure required]

## Requirements
- [Specific, measurable requirements]
- [Not vague — "be comprehensive" is bad, "include exactly 6 sections" is good]
```

### Constrained Tasks

Constrain scope (what to include), not length:

| Bad Constraint | Why | Good Constraint |
|---------------|-----|-----------------|
| "Max 500 words" | Judges reject for length | "Exactly 4 sections, each with 3 numbered items" |
| "Be concise" | Too vague | "Each prohibition must reference a specific base fact" |
| "Improve this" | Unbounded scope | "Write a 600-word incident postmortem with this exact structure" |

**Do NOT use word count as a scope constraint.** Word limits cause false convergence.

---

## Statistical Analysis

### Required Tests

| Test | When to Use |
|------|------------|
| McNemar's test | Comparing two methods on same problems |
| Two-proportion z-test | Comparing success rates |
| Fisher's exact test | Small sample pairwise comparison |
| Bootstrapped CI | Confidence intervals for any metric |
| Cohen's h | Effect size for proportions |

### Standard Analysis Script

```python
import numpy as np
from scipy import stats
from pathlib import Path
import json

def pairwise_mcnemar(method_a_results, method_b_results):
    a_win_b_lose = sum(1 for a, b in zip(method_a_results, method_b_results) if a and not b)
    b_win_a_lose = sum(1 for a, b in zip(method_a_results, method_b_results) if b and not a)
    n = a_win_b_lose + b_win_a_lose
    if n < 25:
        result = stats.binomtest(a_win_b_lose, n, 0.5)
        p_value = result.pvalue
    else:
        chi2 = (abs(a_win_b_lose - b_win_a_lose) - 1)**2 / (a_win_b_lose + b_win_a_lose)
        p_value = 1 - stats.chi2.cdf(chi2, df=1)
    return {"a_wins": a_win_b_lose, "b_wins": b_win_a_lose, "p_value": p_value, "significant": p_value < 0.05}

def bootstrap_ci(data, n_bootstrap=10000, ci=0.95):
    means = [np.mean(np.random.choice(data, size=len(data), replace=True)) for _ in range(n_bootstrap)]
    return {"mean": np.mean(data), "ci_lower": np.percentile(means, (1-ci)/2*100), "ci_upper": np.percentile(means, (1+ci)/2*100)}

def cohens_h(p1, p2):
    return 2 * np.arcsin(np.sqrt(p1)) - 2 * np.arcsin(np.sqrt(p2))
```

### Reporting Standards

Always include:
- Sample sizes: n=X problems/tasks
- Number of runs: K independent runs
- Error bars: specify standard deviation or standard error
- Confidence intervals: 95% CI for key results
- Significance tests: p-values for key comparisons
- Effect sizes: Cohen's d or h for practical significance

---

## Visualization Best Practices

### Setup: SciencePlots + matplotlib

```bash
pip install SciencePlots matplotlib numpy
```

```python
import matplotlib.pyplot as plt
import scienceplots

with plt.style.context(['science', 'no-latex']):
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    # ... plot ...
    fig.savefig('paper/fig_results.pdf', bbox_inches='tight')
```

### Colorblind-Safe Palette (Okabe-Ito)

```python
COLORS = {
    'blue': '#0072B2', 'orange': '#E69F00', 'green': '#009E73',
    'red': '#D55E00', 'purple': '#CC79A7', 'cyan': '#56B4E9',
    'yellow': '#F0E442', 'black': '#000000',
}
COLOR_CYCLE = ['#0072B2', '#D55E00', '#009E73', '#E69F00', '#CC79A7', '#56B4E9']

STYLES = [
    {'color': '#0072B2', 'marker': 'o', 'linestyle': '-'},
    {'color': '#D55E00', 'marker': 's', 'linestyle': '--'},
    {'color': '#009E73', 'marker': '^', 'linestyle': '-.'},
    {'color': '#E69F00', 'marker': 'D', 'linestyle': ':'},
]
```

### Output Rules

- Always save as PDF: `fig.savefig('fig.pdf')`
- Never save as PNG for paper figures
- Exception: screenshots, photographs → PNG at 600 DPI
- Verify grayscale readability

### Chart Types for Common Comparisons

| Comparison Type | Chart | Notes |
|----------------|-------|-------|
| Method vs method | Grouped bar chart | Include error bars |
| Across model sizes | Line chart with CI bands | Log scale for model size |
| Ablation study | Stacked/grouped bar | Highlight removed component |
| Trajectory/convergence | Line chart over iterations | Show winner per iteration |
| Per-task breakdown | Heatmap or grouped bar | Show variance across tasks |

---

## Human Evaluation Design

Many NLP, HCI, and alignment papers require human evaluation. Design this before running automated experiments — human eval often has longer lead times (IRB approval, annotator recruitment).

See `references/human-evaluation.md` for the complete guide including annotation guidelines, agreement metrics, statistical analysis, crowdsourcing platforms, and IRB guidance.

### When Human Evaluation Is Needed

| Task Type | Required? |
|-----------|-----------|
| Text generation quality | **Yes** |
| Factual accuracy of generated text | **Strongly recommended** |
| Preference between two systems | **Yes** |
| Summarization quality | **Yes** |
| Classification accuracy | Usually no |

### Key Design Decisions

| Decision | Options | Guidance |
|----------|---------|----------|
| **Annotator type** | Expert, crowdworker, end-user | Match to what your claims require |
| **Scale** | Likert (1-5), pairwise comparison, ranking | Pairwise is more reliable than Likert for LLM outputs |
| **Sample size** | Per annotator and total items | Minimum 100 items, 3+ annotators |
| **Agreement metric** | Cohen's kappa, Krippendorff's alpha, ICC | Krippendorff's alpha for >2 annotators |
| **Platform** | Prolific, MTurk, internal team | Prolific for quality; MTurk for scale |

### Annotation Guideline Checklist

- [ ] Clear task description with examples (good AND bad)
- [ ] Decision criteria for ambiguous cases
- [ ] At least 2 worked examples per category
- [ ] Attention checks / gold standard items (10-15% of total)
- [ ] Qualification task or screening round
- [ ] Estimated time per item and fair compensation (>= local minimum wage)
- [ ] IRB/ethics review if required

---

## Experiment Design Checklist

- [ ] Every experiment maps to a specific paper claim
- [ ] Baselines cover naive, strong, ablation, and compute-matched categories
- [ ] Evaluation protocol defined before running (metrics, aggregation, tests, sample sizes)
- [ ] Scripts use incremental saving and skip completed work
- [ ] All hyperparameters listed in config files
- [ ] Random seeds set and recorded
- [ ] Human evaluation designed (if applicable) before automated experiments
- [ ] IRB approval obtained (if applicable) before collecting human data

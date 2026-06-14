# Analysis & Figures

Extracting findings from experiments, computing statistics, and creating publication-quality visualizations. Load this after experiments complete (Phase 4).

---

## Aggregating Results

Write analysis scripts that:
1. Load all result files from a batch
2. Compute per-task and aggregate metrics
3. Generate summary tables

```python
import json
from pathlib import Path
import numpy as np

results = {}
for result_file in Path("results/").rglob("result.json"):
    data = json.loads(result_file.read_text())
    strategy = result_file.parent.name
    task = result_file.parent.parent.name
    results.setdefault(strategy, {})[task] = data

for strategy, tasks in results.items():
    scores = [t["score"] for t in tasks.values()]
    print(f"{strategy}: mean={np.mean(scores):.1f}, std={np.std(scores):.1f}")
```

---

## Statistical Significance

Always compute:

| Statistic | When to use | Implementation |
|-----------|-------------|----------------|
| **Error bars** | All plots and tables | Standard deviation or standard error (specify which) |
| **Confidence intervals** | Key results | Bootstrap (1000 samples) or exact formula |
| **Pairwise tests** | Comparing two methods | McNemar's test for binary outcomes; paired t-test for continuous |
| **Effect sizes** | Practical significance | Cohen's d (continuous) or Cohen's h (proportions) |

**McNemar's test** for comparing two methods on the same set of problems:
```python
from scipy.stats import binom_test

def mcnemar_test(y1, y2):
    """y1, y2 are binary correct/incorrect arrays."""
    n01 = sum((y1[i] == 0 and y2[i] == 1) for i in range(len(y1)))
    n10 = sum((y1[i] == 1 and y2[i] == 0) for i in range(len(y1)))
    if n01 + n10 == 0:
        return 1.0
    return binom_test(n01, n01 + n10, p=0.5)
```

**Bootstrap confidence intervals**:
```python
import numpy as np

def bootstrap_ci(data, n_bootstrap=1000, ci=0.95):
    bootstrapped = np.random.choice(data, size=(n_bootstrap, len(data)), replace=True)
    means = np.mean(bootstrapped, axis=1)
    lower = np.percentile(means, (1 - ci) / 2 * 100)
    upper = np.percentile(means, (1 + ci) / 2 * 100)
    return lower, upper
```

---

## Identifying the Story

After analysis, explicitly answer:

1. **What is the main finding?** State it in one sentence.
2. **What surprised you?** Unexpected results often make the best papers.
3. **What failed?** Failed experiments can be the most informative. Honest reporting strengthens the paper.
4. **What follow-up experiments are needed?**

---

## Handling Negative or Null Results

When your hypothesis was wrong or results are inconclusive:

| Situation | Action | Venue Fit |
|-----------|--------|-----------|
| Hypothesis wrong but **why** is informative | Frame paper around the analysis of why | NeurIPS, ICML (if analysis is rigorous) |
| Method doesn't beat baselines but **reveals something new** | Reframe contribution as understanding/analysis | ICLR (values understanding), workshops |
| Clean negative result on popular claim | Write it up — the field needs to know | NeurIPS D&B, TMLR, workshops |
| Results inconclusive, no clear story | Pivot — run different experiments or reframe | Don't force a paper that isn't there |

**How to write a negative results paper**:
- Lead with what the community believes and why it matters to test it
- Describe your rigorous methodology (must be airtight)
- Present the null result clearly with statistical evidence
- Analyze **why** the expected result didn't materialize
- Discuss implications for the field

---

## Figure Design

### Technical Requirements

- **Vector graphics** (PDF) for all plots and diagrams: `plt.savefig('fig.pdf')`
- **Raster** (PNG 600 DPI) only for photographs
- **Colorblind-safe palettes** (Okabe-Ito or Paul Tol)
- **Verify grayscale readability** — 8% of men have color vision deficiency
- **No title inside figure** — the caption serves this function
- **Self-contained captions** — reader should understand without main text

### Standard Figure Sizes (two-column format)

| Type | matplotlib figsize |
|------|-------------------|
| Single column | `(3.5, 2.5)` |
| Double column | `(7.0, 3.0)` |
| Square (heatmaps) | `(3.5, 3.5)` |

### SciencePlots

```python
import matplotlib.pyplot as plt
import scienceplots

with plt.style.context(['science', 'no-latex']):
    fig, ax = plt.subplots(figsize=(3.5, 2.5))
    ax.plot(x, y, label='Ours', color='#0072B2')
    ax.plot(x, y2, label='Baseline', color='#D55E00', linestyle='--')
    ax.set_xlabel('Training Steps')
    ax.set_ylabel('Accuracy')
    ax.legend()
    fig.savefig('paper/fig_results.pdf', bbox_inches='tight')
```

---

## Table Design

Use `booktabs` for professional formatting:

```latex
\usepackage{booktabs}
\begin{tabular}{lcc}
\toprule
Method & Accuracy $\uparrow$ & Latency $\downarrow$ \\
\midrule
Baseline & 85.2 & 45ms \\
\textbf{Ours} & \textbf{92.1} & 38ms \\
\bottomrule
\end{tabular}
```

Rules:
- Bold best value per metric
- Include direction symbols (↑ higher better, ↓ lower better)
- Right-align numerical columns
- Consistent decimal precision

---

## Page Budget Management

When over the page limit:

| Cut Strategy | Saves | Risk |
|-------------|-------|------|
| Move proofs to appendix | 0.5-2 pages | Low — standard practice |
| Condense related work | 0.5-1 page | Medium — may miss key citations |
| Combine tables with subfigures | 0.25-0.5 page | Low — often improves readability |
| Remove qualitative examples | 0.5-1 page | Medium — reviewers like examples |
| Reduce figure sizes | 0.25-0.5 page | High — figures must remain readable |

**Do NOT**: reduce font size, change margins, remove required sections, or use `\small`/`
\footnotesize` for main text.

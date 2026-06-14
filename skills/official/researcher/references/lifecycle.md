# Research Lifecycle Overview

This reference describes the full research lifecycle as an iterative loop. Load this when the user wants a map of the whole process, or when you need to determine what phase comes next.

---

## The Iterative Loop

```
Project Setup → Literature Review ↔ Experiment Design ↔ Execution ↔ Analysis
                          ↑                                      ↓
                   Review / Rebuttal ← Paper Drafting ←────────┼────────→ Submission
```

Results trigger new experiments. Reviews trigger new analysis. The loop continues until the paper is accepted or the project is archived.

---

## Phase 0: Project Setup

**Goal**: Understand existing work, identify the contribution, establish workspace and artifacts.

### Explore the Repository

Look for:
- `README.md` — project overview and claims
- `results/`, `outputs/`, `experiments/` — existing findings
- `configs/` — experimental settings
- `.bib` files — existing citations
- Draft documents or notes

### Identify the Contribution

Before writing anything, articulate:
- **The What**: What is the single thing this paper contributes?
- **The Why**: What evidence supports it?
- **The So What**: Why should readers care?

If the contribution cannot be stated in one sentence, the project needs more focus.

### Create Control Artifacts

- `paper-plan.md`: contribution, venue, claim map, TODO list
- `experiment-log.md`: structured log (see template)
- `citations.bib`: starts empty, populated during literature review

### Estimate Compute Budget

Before running experiments, estimate total cost and time:

```
Compute Budget Checklist:
- [ ] API costs: (model price per token) × (estimated tokens per run) × (number of runs)
- [ ] GPU hours: (time per experiment) × (number of experiments) × (number of seeds)
- [ ] Human evaluation costs: (annotators) × (hours) × (hourly rate)
- [ ] Total budget ceiling and contingency (add 30-50% for reruns)
```

Track actual spend as experiments run. A simple JSONL cost logger is sufficient.

### Workspace Structure

Establish a consistent structure:

```
workspace/
  paper/               # LaTeX source, figures, compiled PDFs
  experiments/         # Experiment runner scripts
  code/                # Core method implementation
  results/             # Raw experiment results (auto-generated)
  tasks/               # Task/benchmark definitions
  human_eval/          # Human evaluation materials (if needed)
```

---

## Phase 1: Literature Review

**Goal**: Find related work, identify baselines, gather verified citations.

- Start from seed papers already referenced in the codebase.
- Use breadth-first, then depth-first search (2-3 rounds typically suffice).
- Group papers by methodology, not paper-by-paper.
- Verify every citation programmatically. Never generate BibTeX from memory.

See `literature-review.md` for search strategies and `citation-workflow.md` for verification APIs.

---

## Phase 2: Experiment Design

**Goal**: Design experiments that directly support paper claims.

- Create an explicit claim-to-experiment mapping.
- Include strong baselines (naive, strong, ablation, compute-matched).
- Define evaluation protocol before running anything: metrics, aggregation, statistical tests, sample sizes.
- Design human evaluation before running automated experiments if applicable — human eval often has longer lead times.

See `experiment-design.md` for complete patterns.

---

## Phase 3: Execution & Monitoring

**Goal**: Run experiments reliably, monitor progress, recover from failures.

- Scripts should save results incrementally and skip already-completed work on restart.
- Preserve all intermediate artifacts.
- Maintain an experiment journal capturing the reasoning tree (why X was tried, what was learned, what that implies for next steps).
- Track costs as experiments run.

See `experiment-monitoring.md` for execution patterns and failure recovery.

---

## Phase 4: Analysis

**Goal**: Extract findings, compute statistics, identify the story.

- Aggregate results across runs and tasks.
- Compute error bars, confidence intervals, and pairwise statistical tests.
- Explicitly answer: What is the main finding? What surprised you? What failed?
- Create `experiment_log.md` as a bridge to drafting if it does not yet exist.
- Decide: more experiments, or move to drafting?

See `analysis-and-figures.md` for statistical methods and visualization standards.

---

## Phase 5: Paper Drafting

**Goal**: Write a complete, publication-ready paper.

- Load only the context needed for the current section (see context management table in `drafting-guide.md`).
- Follow the narrative principle: one clear contribution, supported by evidence.
- Spend equal time on abstract, introduction, figures, and everything else combined.
- Use two-pass refinement: write per section, then global pass for consistency.
- Include a Limitations section — required by all major venues.

See `drafting-guide.md` for section-by-section guidance and writing style rules.

---

## Phase 6: Self-Review & Revision

**Goal**: Catch weaknesses before submission.

- Simulate reviews from multiple perspectives (ensemble pattern).
- Run a claim verification pass: trace every number to its result file.
- Prioritize feedback: critical (must fix), high (should fix), medium (if time), low (future work).
- For actual reviewer feedback, write point-by-point rebuttals with evidence.

See `review-and-revision.md` for review simulation and rebuttal templates.

---

## Phase 7: Submission Preparation

**Goal**: Final checks, formatting, and submission.

- Complete venue-specific checklists.
- Verify anonymization for double-blind venues.
- Run pre-compilation validation (lint, citation check, figure check).
- Compile cleanly. Fix errors before declaring done.
- Convert between venues by copying content into the target template — never copy preambles.

See `submission-checklists.md` for universal checklists and `venue-guide.md` for venue-specific rules.

---

## Phase 8: Post-Acceptance

**Goal**: Maximize impact through presentation materials and community engagement.

- **Camera-ready**: De-anonymize, add acknowledgments, address mandatory revisions.
- **Poster**: Title, 1-sentence contribution, method figure, 2-3 key results. Bullet points only.
- **Talk**: One idea per slide. Minimize text. Include a takeaway slide.
- **Blog / social**: Lead with the result, not the method. Post within 1-2 days of proceedings release.
- **Code release**: Clean README, pinned dependencies, one-script-per-result reproduction.

---

## Decision Table: What Phase Next?

| Situation | Next Phase |
|-----------|------------|
| New project, no plan | Phase 0: Setup |
| Plan exists, no related work gathered | Phase 1: Literature Review |
| Related work done, no experiments designed | Phase 2: Experiment Design |
| Experiments designed, not running | Phase 3: Execution |
| Experiments running | Phase 3: Monitoring (wait) |
| Results collected, no analysis | Phase 4: Analysis |
| Analysis done, contribution unclear | Phase 0: Refine contribution |
| Analysis done, story clear | Phase 5: Drafting |
| Draft complete, no review | Phase 6: Self-Review |
| Reviews received | Phase 6: Revision / Rebuttal |
| Revision done, ready to submit | Phase 7: Submission |
| Accepted | Phase 8: Post-Acceptance |
| Rejected | Phase 7: Resubmission (address concerns, convert format) |

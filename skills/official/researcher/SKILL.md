---
{
  "name": "researcher",
  "description": "Plan, execute, analyze, draft, review, and submit research papers with citation verification and experiment discipline.",
  "version": "2.0.0",
  "category": "research",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "research.paper-writing",
      "academic.workflow",
      "researcher"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "researcher"
      },
      {
        "type": "contains",
        "value": "research paper"
      },
      {
        "type": "contains",
        "value": "write a paper"
      },
      {
        "type": "contains",
        "value": "latex paper"
      },
      {
        "type": "contains",
        "value": "paper submission"
      }
    ],
    "requiredToolsets": [
      "core",
      "files",
      "research"
    ],
    "confirmation": "policy"
  },
  "requiredToolsets": [
    "core",
    "files",
    "research"
  ],
  "optionalToolsets": [
    "web",
    "shell-readonly",
    "shell-write",
    "coding",
    "memory"
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write",
    "ask-before-external-send",
    "ask-before-destructive-action"
  ],
  "playbook": [
    {
      "id": "scope-paper",
      "description": "Clarify paper type, claims, target venue, constraints, and current artifacts.",
      "toolsets": [
        "core",
        "files",
        "research"
      ]
    },
    {
      "id": "plan-and-verify-evidence",
      "description": "Map claims to citations, experiments, figures, tables, and missing evidence.",
      "toolsets": [
        "research",
        "web",
        "files"
      ]
    },
    {
      "id": "draft-or-revise",
      "description": "Write or revise paper sections while preserving source files and citation integrity.",
      "toolsets": [
        "files",
        "coding"
      ]
    },
    {
      "id": "review-and-submit",
      "description": "Run checks and prepare submission artifacts only after explicit approval for external actions.",
      "toolsets": [
        "shell-readonly",
        "shell-write"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Help me turn these experiment results into an ICLR paper outline.",
      "shouldUseToolsets": [
        "files",
        "research"
      ]
    },
    {
      "input": "Check my LaTeX paper for missing references and citation issues.",
      "shouldUseToolsets": [
        "files",
        "shell-readonly"
      ]
    }
  ]
}
---

# Research Lifecycle Conductor

Orchestrates the full ML/AI research lifecycle: project setup, literature review, experiment design, execution, analysis, drafting, review, and submission. This skill is intentionally thin. The detailed guidance lives in `references/` and is loaded progressively based on the current stage.

This is **not a linear pipeline** — it is an iterative loop. Results trigger new experiments. Reviews trigger new analysis.

## When To Use This Skill

Use this skill when:
- **Starting a new research paper** from an existing codebase or idea
- **Designing and running experiments** to support paper claims
- **Writing or revising** any section of a research paper
- **Preparing for submission** to a specific conference or workshop
- **Responding to reviews** with additional experiments or revisions
- **Converting** a paper between conference formats
- **Writing non-empirical papers** — theory, survey, benchmark, or position papers
- **Designing human evaluations** for NLP, HCI, or alignment research
- **Preparing post-acceptance deliverables** — posters, talks, code releases

## Core Philosophy

1. **Be proactive.** Deliver complete drafts, not questions. Produce something concrete the scientist can react to, then iterate.
2. **Never hallucinate citations.** AI-generated citations have high error rates. Always fetch programmatically or mark as `[CITATION NEEDED]`.
3. **Paper is a story, not a collection of experiments.** Every paper needs one clear contribution stated in a single sentence.
4. **Experiments serve claims.** Every experiment must explicitly state which claim it supports.
5. **Control artifacts matter more than prose quality.** Paper work spans sessions — `paper-plan.md`, `experiment-log.md`, and citation notes are the persistent state.

## Playbook

### 1. Classify Research Stage

Detect which stage the user is in:

| Stage | Signals |
|-------|---------|
| **Project setup** | New repo, unclear contribution, no plan |
| **Literature review** | "Find related work", "what should I cite", reading papers |
| **Experiment design** | Planning baselines, choosing metrics, writing protocols |
| **Running experiments** | Scripts executing, monitoring progress, handling failures |
| **Analysis** | Aggregating results, computing statistics, identifying the story |
| **Drafting** | Writing sections, creating figures, assembling the paper |
| **Revision / rebuttal** | Addressing reviews, running new experiments, editing |
| **Submission** | Checklists, formatting, anonymization, final compilation |
| **Post-acceptance** | Camera-ready, posters, talks, code release |

Load only the references relevant to the current stage. Do not inject the full lifecycle guide into context unless the user explicitly asks for an overview.

### 2. Establish Control Artifacts

Create or update these files early. They are the primary state bridge across sessions:

| Artifact | Purpose | When to create |
|----------|---------|----------------|
| `paper-plan.md` | One-sentence contribution, claim-to-experiment map, target venue, TODO list | Project setup |
| `experiment-log.md` | Per-experiment records: hypothesis, config, result, key metrics, next steps | Before first experiment |
| `citations.bib` | Verified BibTeX entries only | Literature review |
| Manual TODO list | Granular task tracking | Project setup |

If these files already exist, read them before taking any action.

### 3. Ground Claims In Evidence

Require every claim to map to source material:

| Claim type | Required evidence |
|------------|-------------------|
| "Our method outperforms X" | Result files, statistical tests, experiment log entry |
| "Convergence requires Y" | Experiment log showing with/without comparison |
| "Prior work uses Z" | Verified citation in `citations.bib` |
| "The key finding is W" | Explicit link to result file and metric value |

Never state a number from memory. Always trace it to a result file or experiment log.

### 4. Load Only Relevant References

| Current task | Load this reference |
|--------------|---------------------|
| Literature review | `references/literature-review.md` + `references/citation-workflow.md` |
| Experiment design | `references/experiment-design.md` |
| Running experiments | `references/experiment-monitoring.md` |
| Analysis and figures | `references/analysis-and-figures.md` |
| Drafting any section | `references/drafting-guide.md` |
| Review or rebuttal | `references/review-and-revision.md` |
| Submission prep | `references/submission-checklists.md` + `references/venue-guide.md` |
| Theory / survey / benchmark | `references/paper-types.md` |

Point the user to these references rather than reciting their contents inline.

### 5. Ask Only For Blocking Decisions

Block for human input only on decisions that fundamentally change direction:

| Blocking decision | Why it blocks |
|-------------------|---------------|
| Target venue | Affects page limit, framing, required sections |
| Contribution framing | Determines which experiments to run and how to sell them |
| Budget limits | Determines experiment scope and model selection |
| Submission readiness | Final gate before irreversible external action |

Do **not** ask about word choice, section ordering, which results to highlight, or citation completeness. Be proactive, make a choice, flag it in the draft, and iterate on feedback.

### 6. Produce Reviewable Artifacts

Prefer concrete deliverables over vague coaching:

| Stage | Artifact |
|-------|----------|
| Setup | `paper-plan.md`, workspace structure |
| Literature | Organized citation notes, `citations.bib` |
| Design | `experiment-log.md` with claim-to-experiment map |
| Execution | Updated experiment log, result files |
| Analysis | Summary tables, figures, statistical report |
| Drafting | Complete section files in LaTeX or Markdown |
| Review | Simulated review report, prioritized fix list |
| Submission | Compiled PDF, completed checklists, anonymized code bundle |

## Tool Safety

### Conservative Defaults

- `requiredToolsets`: `["core", "files", "research"]`
- `optionalToolsets`: `["web", "shell-readonly", "shell-write", "coding", "memory"]`
- `permissionExpectations`: `["auto-read", "ask-before-write", "ask-before-external-send", "ask-before-destructive-action"]`

### Actions Requiring Explicit Approval

Always ask before:
- Running long experiments that consume significant compute or API budget
- Installing packages or modifying system state
- Executing `git push` or any external publication action
- Submitting a paper to a venue or posting to arXiv
- Destructive operations (deleting result files, overwriting LaTeX source)

For read-only exploration (searching papers, reading repos, analyzing results), proceed autonomously.

## Related Skills

Compose this skill with smaller, focused skills:

| Skill | Role in pipeline | How to load |
|-------|------------------|-------------|
| **research-discovery** | Paper discovery and BibTeX generation | Load skill: `research-discovery` |
| **pdf-extraction** | PDF extraction for reading papers | Load skill: `pdf-extraction` |
| **system-diagram** | Method figures and conceptual diagrams | Load skill: `system-diagram` |
| **planning workflow** | Structured implementation planning | Use the current repo planning conventions or a dedicated planning skill if one is installed. |

Future additions (not yet required):
- `latex-paper` — compilation, template handling, citation checks
- `dataset-documentation` — datasheets and model cards

## Reference Index

| File | Contents |
|------|----------|
| `references/lifecycle.md` | Full research lifecycle overview — when to use each phase |
| `references/literature-review.md` | Finding, organizing, and synthesizing related work |
| `references/citation-workflow.md` | Programmatic citation verification, BibTeX management |
| `references/experiment-design.md` | Mapping claims to experiments, baseline design, protocols, infrastructure, visualization |
| `references/experiment-monitoring.md` | Execution patterns, cron monitoring, failure recovery, experiment journals |
| `references/analysis-and-figures.md` | Statistical analysis, figure design, table formatting, negative results |
| `references/drafting-guide.md` | Narrative structure, abstract formula, section-by-section guidance, writing style, Gopen & Swan, Lipton, Perez |
| `references/review-and-revision.md` | Simulated reviews, revision cycles, rebuttal writing, venue-specific reviewer criteria |
| `references/submission-checklists.md` | Pre-submission, anonymization, formatting, camera-ready, code packaging |
| `references/venue-guide.md` | NeurIPS, ICML, ICLR, ACL, AAAI, COLM specific requirements |
| `references/paper-types.md` | Theory, survey, benchmark, position, and replication papers |
| `references/human-evaluation.md` | Designing, running, and reporting human evaluations (annotation, agreement, IRB) |
| `references/sources.md` | Complete bibliography of writing guides, conference guidelines, APIs, tools |

| Template | Purpose |
|----------|---------|
| `templates/experiment-log.md` | Structured record for each experiment run |
| `templates/paper-plan.md` | Living document for contribution, claims, and TODOs |
| `templates/review-request.md` | Format for requesting simulated reviews |
| `templates/rebuttal-response.md` | Point-by-point rebutal structure |
| `templates/research-code-readme.md` | README for code release accompanying a paper |

| Script | Purpose |
|----------|---------|
| `scripts/verify_citations.py` | Verify that every `\cite{}` resolves to a real paper |
| `scripts/check_latex_refs.py` | Lint LaTeX for broken references, missing figures, duplicate labels |
| `scripts/summarize_results.py` | Aggregate experiment results into summary tables |
| `scripts/make_experiment_journal.py` | Generate `experiment-log.md` from result directories |

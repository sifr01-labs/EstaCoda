# Submission Checklists

Pre-submission, formatting, and post-acceptance procedures. Load this when preparing to submit (Phase 7).

---

## Universal Pre-Submission Checklist

### Paper Content

- [ ] Abstract ≤ word limit (usually 250-300 words)
- [ ] Main content within page limit
- [ ] References complete and verified
- [ ] Limitations section included
- [ ] All figures/tables have captions
- [ ] Captions are self-contained

### Formatting

- [ ] Correct template used (venue + year specific)
- [ ] Margins not modified
- [ ] Font sizes not modified
- [ ] Double-blind requirements met
- [ ] Page numbers correct (for review) or none (camera-ready)

### Technical

- [ ] All claims supported by evidence
- [ ] Error bars included
- [ ] Baselines appropriate
- [ ] Hyperparameters documented
- [ ] Compute resources stated

### Reproducibility

- [ ] Code will be available (or justification)
- [ ] Data will be available (or justification)
- [ ] Environment documented
- [ ] Commands to reproduce provided

### Ethics

- [ ] Broader impacts considered
- [ ] Limitations honestly stated
- [ ] Licenses respected
- [ ] IRB obtained if needed

### Final Checks

- [ ] PDF compiles without errors
- [ ] All figures render correctly
- [ ] All citations resolve
- [ ] Supplementary material organized
- [ ] Conference checklist completed

---

## Anonymization Checklist

Double-blind review means reviewers cannot know who wrote the paper.

- [ ] No author names or affiliations anywhere in the PDF
- [ ] No acknowledgments section (add after acceptance)
- [ ] Self-citations written in third person: "Smith et al. [1] showed..." not "We previously showed..."
- [ ] No GitHub/GitLab URLs pointing to personal repos
- [ ] Use Anonymous GitHub (https://anonymous.4open.science/) for code links
- [ ] No institutional logos or identifiers in figures
- [ ] No file metadata containing author names (check PDF properties)
- [ ] No "our previous work" or "in our earlier paper" phrasing
- [ ] Dataset names don't reveal institution (rename if needed)
- [ ] Supplementary materials don't contain identifying information

**Common mistakes**: Git commit messages visible in supplementary code, watermarked figures, acknowledgments left in from a previous draft, arXiv preprint posted before anonymity period.

---

## Pre-Compilation Validation

Run these automated checks **before** attempting `pdflatex`:

### 1. Lint with chktex

```bash
chktex main.tex -q -n2 -n24 -n13 -n1
```

### 2. Verify all citations exist in .bib

```python
import re

tex = open('main.tex').read()
bib = open('references.bib').read()
cites = set(re.findall(r'\\cite[tp]?{([^}]+)}', tex))
for cite_group in cites:
    for cite in cite_group.split(','):
        cite = cite.strip()
        if cite and cite not in bib:
            print(f'WARNING: \\cite{{{cite}}} not found in references.bib')
```

### 3. Verify all referenced figures exist on disk

```python
import re, os

tex = open('main.tex').read()
figs = re.findall(r'\\includegraphics(?:\[.*?\])?{([^}]+)}', tex)
for fig in figs:
    if not os.path.exists(fig):
        print(f'WARNING: Figure file not found: {fig}')
```

### 4. Check for duplicate \label definitions

```python
import re
from collections import Counter

tex = open('main.tex').read()
labels = re.findall(r'\\label{([^}]+)}', tex)
dupes = {k: v for k, v in Counter(labels).items() if v > 1}
for label, count in dupes.items():
    print(f'WARNING: Duplicate label: {label} (appears {count} times)')
```

Fix any warnings before proceeding.

---

## Final Compilation

```bash
# Clean build
rm -f *.aux *.bbl *.blg *.log *.out *.pdf
latexmk -pdf main.tex

# Or manual (triple pdflatex + bibtex for cross-references)
pdflatex -interaction=nonstopmode main.tex
bibtex main
pdflatex -interaction=nonstopmode main.tex
pdflatex -interaction=nonstopmode main.tex

# Verify output exists and has content
ls -la main.pdf
```

**If compilation fails**: Parse the `.log` file for the first error. Common fixes:
- "Undefined control sequence" → missing package or typo
- "Missing $ inserted" → math symbol outside math mode
- "File not found" → wrong figure path or missing .sty file
- "Citation undefined" → .bib entry missing or bibtex not run

---

## Camera-Ready Preparation

After acceptance:

- [ ] De-anonymize: add author names, affiliations, emails
- [ ] Add Acknowledgments (funding, compute grants, helpful reviewers)
- [ ] Add public code/data URL (real repo, not anonymous)
- [ ] Address any mandatory revisions from meta-reviewer
- [ ] Switch template to camera-ready mode if applicable
- [ ] Add copyright notice if required
- [ ] Update "anonymous" placeholders in text
- [ ] Verify final PDF compiles cleanly
- [ ] Check camera-ready page limit (sometimes differs from submission)
- [ ] Upload supplementary materials to venue portal

---

## arXiv & Preprint Strategy

Posting to arXiv is standard practice in ML but has timing and anonymity considerations.

| Situation | Recommendation |
|-----------|---------------|
| Submitting to double-blind venue (NeurIPS, ICML, ACL) | Post to arXiv **after** submission deadline |
| Submitting to ICLR | ICLR explicitly allows arXiv posting before submission |
| Paper already on arXiv, submitting to new venue | Acceptable at most venues. Do NOT update with review-responsive changes during review |
| Workshop paper | arXiv is fine at any time — workshops are typically not double-blind |
| Want to establish priority | Post immediately if scooping is a concern — accept the anonymity tradeoff |

**arXiv category selection** (ML/AI papers):

| Category | Code | Best For |
|----------|------|----------|
| Machine Learning | `cs.LG` | General ML methods |
| Computation and Language | `cs.CL` | NLP, language models |
| Artificial Intelligence | `cs.AI` | Reasoning, planning, agents |
| Computer Vision | `cs.CV` | Vision models |
| Information Retrieval | `cs.IR` | Search, recommendation |

**Versioning strategy**:
- **v1**: Initial submission (matches conference submission)
- **v2**: Post-acceptance with camera-ready corrections
- Don't post v2 during review period with changes that clearly respond to reviewer feedback

---

## Research Code Packaging

Releasing clean, runnable code significantly increases citations and reviewer trust.

### Repository Structure

```
your-method/
  README.md              # Setup, usage, reproduction instructions
  requirements.txt       # Or environment.yml
  setup.py               # For pip-installable packages
  LICENSE                # MIT or Apache 2.0 recommended
  configs/               # Experiment configurations
  src/                   # Core method implementation
  scripts/               # Training, evaluation, analysis
    reproduce_table1.sh  # One script per main result
  data/                  # Small data or download scripts
  results/               # Expected outputs for verification
```

### README Template

```markdown
# [Paper Title]

Official implementation of "[Paper Title]" (Venue Year).

## Setup
[Exact commands]

## Reproduction
To reproduce Table 1: `bash scripts/reproduce_table1.sh`
To reproduce Figure 2: `python scripts/make_figure2.py`

## Citation
[BibTeX entry]
```

### Pre-Release Checklist

- [ ] Code runs from a clean clone
- [ ] All dependencies pinned to specific versions
- [ ] No hardcoded absolute paths
- [ ] No API keys, credentials, or personal data in repo
- [ ] README covers setup, reproduction, and citation
- [ ] LICENSE file present
- [ ] Results reproducible within expected variance
- [ ] .gitignore excludes data files, checkpoints, logs

### Anonymous Code for Submission

Use Anonymous GitHub (https://anonymous.4open.science/) for double-blind review.

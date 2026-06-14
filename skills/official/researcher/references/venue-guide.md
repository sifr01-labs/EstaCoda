# Venue Guide

Conference-specific requirements for major ML/AI venues. Load this when the target venue is known or when converting between venues.

---

## Quick Reference: Page Limits

| Conference | Main Content | References | Appendix |
|------------|-------------|------------|----------|
| NeurIPS 2025 | 9 pages | Unlimited | Unlimited (checklist separate) |
| ICML 2026 | 8 pages (+1 camera) | Unlimited | Unlimited |
| ICLR 2026 | 9 pages (+1 camera) | Unlimited | Unlimited |
| ACL 2025 | 8 pages (long) | Unlimited | Unlimited |
| AAAI 2026 | 7 pages (+1 camera) | Unlimited | Unlimited |
| COLM 2025 | 9 pages (+1 camera) | Unlimited | Unlimited |

**Universal**: Double-blind, references don't count, appendices unlimited, LaTeX required.

---

## NeurIPS

### Mandatory Paper Checklist

All NeurIPS submissions must include a completed paper checklist (16 items). Papers lacking this face **automatic desk rejection**. The checklist appears after references, outside the page limit.

Key items:
- Claims alignment (abstract matches results)
- Limitations discussion
- Theory & proofs (if applicable)
- Reproducibility statement
- Data & code access instructions
- Experimental details (splits, hyperparameters)
- Statistical significance (error bars, number of runs)
- Compute resources
- Ethics code compliance
- Broader impacts
- Safeguards (for high-risk models)
- License respect
- Asset documentation
- Human subjects details (if applicable)
- IRB approvals (if applicable)
- LLM declaration (if used as core methodology)

Authors select "yes," "no," or "N/A" per question, with optional 1-2 sentence justifications.

**Important**: Reviewers are explicitly instructed not to penalize honest limitation acknowledgment.

### Scoring

| Score | Label | Description |
|-------|-------|-------------|
| 6 | Strong Accept | Groundbreaking, flawless; top 2-3% |
| 5 | Accept | Technically solid, high impact |
| 4 | Borderline Accept | Solid work with limited evaluation |
| 3 | Borderline Reject | Weaknesses outweigh strengths |
| 2 | Reject | Technical flaws or weak evaluation |
| 1 | Strong Reject | Well-known results or ethics issues |

---

## ICML

### Broader Impact Statement

Required at the end of the paper, before references. Does NOT count toward the page limit.

**Required elements**:
- Potential positive impacts
- Potential negative impacts
- Mitigation strategies
- Who may be affected

### Reproducibility Checklist

- [ ] Data splits clearly specified
- [ ] Hyperparameters listed
- [ ] Search ranges documented
- [ ] Selection method explained
- [ ] Compute resources specified
- [ ] Code availability stated

### Statistical Reporting

- [ ] Error bars on all figures
- [ ] Standard deviation vs standard error specified
- [ ] Number of runs stated
- [ ] Significance tests if comparing methods

### Anonymization

- [ ] No author names in paper
- [ ] No acknowledgments
- [ ] No grant numbers
- [ ] Prior work cited in third person
- [ ] No identifiable repository URLs

---

## ICLR

### LLM Disclosure Policy (2026+)

> "If LLMs played a significant role in research ideation and/or writing to the extent that they could be regarded as a contributor, authors must describe their precise role in a separate appendix section."

**When disclosure is required**: LLM used for significant research ideation or substantial writing.
**When NOT required**: Grammar checking, minor editing, code completion.
**Consequences of non-disclosure**: Desk rejection.

### Scoring

- **Soundness**: 1-4 scale
- **Presentation**: 1-4 scale
- **Contribution**: 1-4 scale
- **Overall**: 1-10 scale
- **Confidence**: 1-5 scale

### Unique Considerations

- OpenReview process (public reviews after decisions)
- Reciprocal reviewing: authors on 3+ papers must serve as reviewers for ≥6 papers
- Emphasis on code availability

---

## ACL

### Mandatory Limitations Section

ACL specifically requires a Limitations section. Does NOT count toward the page limit.

**What to include**:
- Strong assumptions made
- Scope limitations
- When method may fail
- Generalization concerns

### Responsible NLP Checklist

- [ ] Bias considerations addressed
- [ ] Fairness evaluated if applicable
- [ ] Dual-use concerns discussed

### Human Evaluation (if applicable)

- [ ] Annotator details provided
- [ ] Agreement metrics reported
- [ ] Compensation documented

---

## AAAI

### Formatting (Strictest of All Venues)

AAAI enforces formatting rules more strictly than any other major venue. Papers that deviate are desk-rejected.

- [ ] Use the **exact** AAAI style file without modification — no `\setlength`, no `\vspace` hacks, no font overrides
- [ ] 7 pages main content (8 for camera-ready)
- [ ] Two-column format, Times font (set by template)
- [ ] Abstract must be a single paragraph, no math or citations
- [ ] Do not modify margins, column widths, or font sizes

### Key Differences

- **No separate limitations section required** (unlike ACL), but discussing limitations is recommended
- **Strictest formatting enforcement** — style checker rejects non-compliant PDFs
- **No paper checklist** like NeurIPS, but universal checklist still applies
- **Unified template** covers main paper and supplementary in the same file
- **Broader AI scope**: covers planning, reasoning, knowledge representation, NLP, vision, robotics
- **Application papers** are more receptive than at NeurIPS/ICML

---

## COLM

### Scope

COLM focuses specifically on language model research. Contributions must be relevant to the language modeling community (broadly interpreted: training, evaluation, applications, theory, alignment, safety).

### Formatting

- 9 pages main content (10 for camera-ready)
- Double-blind review
- Template derived from ICLR with modifications

### Content Expectations

- [ ] Contribution must be relevant to language models
- [ ] If method is general, frame with language model examples
- [ ] Baselines should include recent LM-specific methods where applicable
- [ ] LLM disclosure expected if used in research

### Key Differences

- **Narrower scope** than NeurIPS/ICML — must frame for LM community
- **Newer venue** — reviewer norms still establishing; write more defensively
- **ICLR-derived process** — open reviews, author response, discussion among reviewers

---

## Conference Resubmission & Format Conversion

When converting between venues, **never copy LaTeX preambles between templates**:

1. Start fresh with target template
2. Copy ONLY content sections (not preamble)
3. Adjust for page limits
4. Add venue-specific required sections
5. Update references

| From → To | Page Change | Key Adjustments |
|-----------|-------------|-----------------|
| NeurIPS → ICML | 9 → 8 | Cut 1 page, add Broader Impact |
| ICML → ICLR | 8 → 9 | Expand experiments, add LLM disclosure |
| NeurIPS → ACL | 9 → 8 | Restructure for NLP conventions, add Limitations |
| ICLR → AAAI | 9 → 7 | Significant cuts, strict style adherence |
| Any → COLM | varies → 9 | Reframe for language model focus |

**After rejection**: Address reviewer concerns in the new version, but don't include a "changes" section or reference the previous submission (blind review).

---

## Template Setup

Always copy the entire template directory first, then write within it:

1. **Copy entire template directory** (not just `.tex` file)
2. **Verify template compiles as-is** before making any changes
3. **Keep template content as reference** (comment out, don't delete)
4. **Replace content section by section**
5. **Use template macros** (`\newcommand` definitions in preamble)
6. **Clean up template artifacts only at the end**

### Common Template Pitfalls

| Pitfall | Problem | Solution |
|---------|---------|----------|
| Copying only `.tex` file | Missing `.sty`, won't compile | Copy entire directory |
| Modifying `.sty` files | Breaks conference formatting | Never edit style files |
| Adding random packages | Conflicts, breaks template | Only add if necessary |
| Deleting template content early | Lose formatting reference | Keep as comments until done |
| Not compiling frequently | Errors accumulate | Compile after each section |
| Raster PNGs for figures | Blurry in paper | Always use vector PDF |

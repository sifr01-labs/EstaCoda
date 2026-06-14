# Review & Revision

Simulating the review process, addressing feedback, and writing rebuttals. Load this when drafting is complete or reviews have been received (Phase 6).

---

## Simulated Reviews (Ensemble Pattern)

Generate reviews from multiple perspectives. The key insight from automated research pipelines: **ensemble reviewing with a meta-reviewer produces far more calibrated feedback than a single review pass.**

### Step 1: Generate N Independent Reviews (N=3-5)

Use different models or temperature settings. Each reviewer sees only the paper, not other reviews. **Default to negative bias** — LLMs have well-documented positivity bias in evaluation.

Review prompt structure:
```
You are an expert reviewer for [VENUE]. You are critical and thorough.
If a paper has weaknesses, flag them clearly and reflect that in scores.
Do not give the benefit of the doubt.

Evaluate:
1. Soundness (are claims well-supported? baselines fair?)
2. Clarity (well-written? reproducible?)
3. Significance (does this matter to the community?)
4. Originality (new insights, not just incremental combination?)

Provide structured output:
- summary (2-3 sentences)
- strengths (3-5 bullets)
- weaknesses (3-5 bullets, most critical first)
- questions (2-4 items)
- missing_references (list)
- numerical scores
```

### Step 2: Meta-Review

Feed all N reviews to a meta-reviewer:

```
You are an Area Chair at [VENUE]. You have received [N] independent reviews.
Identify consensus strengths and weaknesses. Resolve disagreements by examining
the paper directly. Be conservative: if reviewers disagree on whether a weakness
is serious, treat it as serious until addressed.
```

### Step 3: Claim Verification Pass

After simulated reviews, run a separate verification pass:

1. Extract every factual claim from the paper (numbers, comparisons, trends)
2. For each claim, trace it to the specific experiment/result that supports it
3. Verify the number in the paper matches the actual result file
4. Flag any claim without a traceable source as [VERIFY]

For agent-based workflows: delegate verification to a **fresh sub-agent** that receives only the paper text and raw result files. Fresh context prevents confirmation bias.

---

## Prioritizing Feedback

After collecting reviews (simulated or real), categorize:

| Priority | Action |
|----------|--------|
| **Critical** (technical flaw, missing baseline) | Must fix. May require new experiments → back to Phase 2 |
| **High** (clarity issue, missing ablation) | Should fix in this revision |
| **Medium** (minor writing issues, extra experiments) | Fix if time allows |
| **Low** (style preferences, tangential suggestions) | Note for future work |

---

## Revision Cycle

For each critical/high issue:
1. Identify the specific section(s) affected
2. Draft the fix
3. Verify the fix doesn't break other claims
4. Update the paper
5. Re-check against the reviewer's concern

---

## Rebuttal Writing

When responding to actual reviews (post-submission), rebuttals are a distinct skill from revision:

**Format**: Point-by-point. For each reviewer concern:
```
> R1-W1: "The paper lacks comparison with Method X."

We thank the reviewer for this suggestion. We have added a comparison with
Method X in Table 3 (revised). Our method outperforms X by 3.2pp on [metric]
(p<0.05). We note that X requires 2x our compute budget.
```

**Rules**:
- Address every concern — reviewers notice if you skip one
- Lead with the strongest responses
- Be concise and direct — reviewers read dozens of rebuttals
- Include new results if you ran experiments during the rebuttal period
- Never be defensive or dismissive
- Use `latexdiff` to generate a marked-up PDF showing changes
- Thank reviewers for specific, actionable feedback

**What NOT to do**:
- "We respectfully disagree" without evidence
- "This is out of scope" without explanation
- Ignoring a weakness by only responding to strengths

---

## When to Accept vs. Push Back

**Accept gracefully**:
- Valid technical errors
- Missing important related work
- Unclear explanations
- Missing experimental details

Acknowledge: "The reviewer is correct that... We will revise to..."

**Push back respectfully** when:
- Reviewer misunderstood the paper
- Requested experiments are out of scope
- Criticism is factually incorrect

Frame: "We appreciate this perspective. However, [explanation]..."

---

## Paper Evolution Tracking

Save snapshots at key milestones:

```
paper/
  paper.tex                    # Current working version
  paper_v1_first_draft.tex     # First complete draft
  paper_v2_post_review.tex     # After simulated review
  paper_v3_pre_submission.tex  # Final before submission
  paper_v4_camera_ready.tex    # Post-acceptance final
```

---

## Reviewer Evaluation Criteria

Understanding what reviewers look for helps focus effort.

### Universal Evaluation Dimensions

All major ML conferences assess papers across four core dimensions:

**1. Quality (Technical Soundness)**
- Are claims well-supported by theoretical analysis or experimental results?
- Are the proofs correct? Are the experiments properly controlled?
- Are baselines appropriate and fairly compared?
- Is the methodology sound?

**How to ensure high quality:**
- Include complete proofs (main paper or appendix with sketches)
- Use appropriate baselines (not strawmen)
- Report variance/error bars with methodology
- Document hyperparameter selection process

**2. Clarity (Writing & Organization)**
- Is the paper clearly written and well organized?
- Can an expert in the field reproduce the results?
- Is notation consistent? Are terms defined?
- Is the paper self-contained?

**3. Significance (Impact & Importance)**
- Are the results impactful for the community?
- Will others build upon this work?
- Does it address an important problem?
- What is the potential for real-world impact?

**4. Originality (Novelty & Contribution)**
- Does this provide new insights?
- How does it differ from prior work?
- Is the contribution non-trivial?

**Key insight from NeurIPS guidelines:**
> "Originality does not necessarily require introducing an entirely new method. Papers that provide novel insights from evaluating existing approaches or shed light on why methods succeed can also be highly original."

---

## Venue-Specific Reviewer Guidelines

### NeurIPS

**Scoring System (1-6 Scale):**

| Score | Label | Description |
|-------|-------|-------------|
| **6** | Strong Accept | Groundbreaking, flawless; top 2-3% |
| **5** | Accept | Technically solid, high impact |
| **4** | Borderline Accept | Solid work with limited evaluation |
| **3** | Borderline Reject | Weaknesses outweigh strengths |
| **2** | Reject | Technical flaws or weak evaluation |
| **1** | Strong Reject | Well-known results or ethics issues |

Reviewers are explicitly instructed to:
1. Evaluate the paper as written — not what it could be with revisions
2. Provide constructive feedback — 3-5 actionable points
3. Not penalize honest limitations — acknowledging weaknesses is encouraged
4. Assess reproducibility — can the work be verified?
5. Consider ethical implications — potential misuse or harm

### ICML

**Review Structure:**
1. Summary — Brief description of contributions
2. Strengths — Positive aspects
3. Weaknesses — Areas for improvement
4. Questions — Clarifications for authors
5. Limitations — Assessment of stated limitations
6. Ethics — Any concerns
7. Overall Score — Recommendation

**Scoring Guidelines:**
- Top 25% of accepted papers: Score 5-6
- Typical accepted paper: Score 4-5
- Borderline: Score 3-4
- Clear reject: Score 1-2

**Key Evaluation Points:**
1. Reproducibility — Are there enough details?
2. Experimental rigor — Multiple seeds, proper baselines?
3. Writing quality — Clear, organized, well-structured?
4. Novelty — Non-trivial contribution?

### ICLR

**OpenReview Process:**
- Public reviews (after acceptance decisions)
- Author responses visible to reviewers
- Discussion between reviewers and ACs

**Scoring:**
- **Soundness**: 1-4 scale
- **Presentation**: 1-4 scale
- **Contribution**: 1-4 scale
- **Overall**: 1-10 scale
- **Confidence**: 1-5 scale

**Unique Considerations:**
1. LLM Disclosure — Reviewers assess whether LLM use is properly disclosed
2. Reproducibility — Emphasis on code availability
3. Reciprocal Reviewing — Authors must also serve as reviewers

### ACL

**ACL-Specific Criteria:**
1. Linguistic soundness — Are linguistic claims accurate?
2. Resource documentation — Are datasets/models properly documented?
3. Multilingual consideration — If applicable, is language diversity addressed?

**Limitations Section:**
ACL specifically requires a Limitations section. Reviewers check:
- Are limitations honest and comprehensive?
- Do limitations undermine core claims?
- Are potential negative impacts addressed?

**Ethics Review:**
ACL has a dedicated ethics review process for:
- Dual-use concerns
- Data privacy issues
- Bias and fairness implications

### AAAI

**Evaluation Criteria:**

| Criterion | Weight | Notes |
|-----------|--------|-------|
| Technical quality | High | Soundness of approach, correctness |
| Significance | High | Importance of problem and contribution |
| Novelty | Medium-High | New ideas, methods, or insights |
| Clarity | Medium | Clear writing, well-organized |
| Reproducibility | Medium | Sufficient detail to reproduce |

**AAAI-Specific Considerations:**
- Broader AI scope: covers planning, reasoning, knowledge representation, NLP, vision, robotics
- Formatting strictness: reviewers flag formatting violations; non-compliant papers may be desk-rejected
- Application papers: more receptive to application-focused work than NeurIPS/ICML
- Senior Program Committee mediates between reviewers

**Scoring (AAAI Scale):**
- Strong Accept → Accept → Weak Accept → Weak Reject → Reject → Strong Reject

### COLM

**Evaluation Criteria:**

| Criterion | Weight | Notes |
|-----------|--------|-------|
| Relevance | High | Must be relevant to language modeling |
| Technical quality | High | Sound methodology, well-supported claims |
| Novelty | Medium-High | New insights about language models |
| Clarity | Medium | Clear presentation, reproducible |
| Significance | Medium-High | Impact on LM research and practice |

**COLM-Specific Considerations:**
- Language model focus: general ML needs explicit LM framing
- Newer venue: reviewer calibration varies more; write defensively
- ICLR-derived process: open reviews, author response, discussion
- Broad interpretation of "language modeling": training, evaluation, alignment, safety, efficiency, applications, theory, multimodality

**Scoring (ICLR-style):**
- 8-10: Strong accept (top papers)
- 6-7: Weak accept (solid contribution)
- 5: Borderline
- 3-4: Weak reject
- 1-2: Strong reject

---

## What Makes Reviews Strong

### Following Daniel Dennett's Rules

Good reviewers follow these principles:

1. **Re-express the position fairly** — Show you understand the paper
2. **List agreements** — Acknowledge what works well
3. **List what you learned** — Credit the contribution
4. **Only then critique** — After establishing understanding

### Strong Review Structure

```
Summary (1 paragraph):
- What the paper does
- Main contribution claimed

Strengths (3-5 bullets):
- Specific positive aspects
- Why these matter

Weaknesses (3-5 bullets):
- Specific concerns
- Why these matter
- Suggestions for addressing

Questions (2-4 items):
- Clarifications needed
- Things that would change assessment

Overall Assessment:
- Clear recommendation with reasoning
```

---

## Common Reviewer Concerns

### Technical Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Baselines too weak" | Use state-of-the-art baselines, cite recent work |
| "Missing ablations" | Include systematic ablation study |
| "No error bars" | Report std dev/error, multiple runs |
| "Hyperparameters not tuned" | Document tuning process, search ranges |
| "Claims not supported" | Ensure every claim has evidence |

### Novelty Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Incremental contribution" | Clearly articulate what's new vs prior work |
| "Similar to [paper X]" | Explicitly compare to X in Related Work |
| "Straightforward extension" | Highlight non-obvious aspects |

### Clarity Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Hard to follow" | Use clear structure, signposting |
| "Notation inconsistent" | Review all notation, create notation table |
| "Missing details" | Include reproducibility appendix |
| "Figures unclear" | Self-contained captions, proper sizing |

### Significance Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Limited impact" | Discuss broader implications |
| "Narrow evaluation" | Evaluate on multiple benchmarks |
| "Only works in restricted setting" | Acknowledge scope, explain why still valuable |

---

## Pre-Submission Reviewer Simulation

Before submitting, ask yourself:

**Quality:**
- [ ] Would I trust these results if I saw them?
- [ ] Are all claims supported by evidence?
- [ ] Are baselines fair and recent?

**Clarity:**
- [ ] Can someone reproduce this from the paper?
- [ ] Is the writing clear to non-experts in this subfield?
- [ ] Are all terms and notation defined?

**Significance:**
- [ ] Why should the community care about this?
- [ ] What can people do with this work?
- [ ] Is the problem important?

**Originality:**
- [ ] What specifically is new here?
- [ ] How does this differ from closest related work?
- [ ] Is the contribution non-trivial?

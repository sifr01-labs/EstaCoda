# Drafting Guide

Writing a complete, publication-ready research paper. Load this when drafting any section (Phase 5).

---

## Context Management

A paper project with many experiment files and literature notes can exceed the agent's context window. Load only what's needed for the current task:

| Drafting Task | Load Into Context | Do NOT Load |
|---------------|------------------|-------------|
| Writing Introduction | `experiment_log.md`, contribution statement, 5-10 most relevant paper abstracts | Raw result JSONs, full experiment scripts |
| Writing Methods | Experiment configs, pseudocode, architecture description | Raw logs, results from other experiments |
| Writing Results | `experiment_log.md`, result summary tables, figure list | Full analysis scripts, intermediate data |
| Writing Related Work | Organized citation notes, `.bib` file | Experiment files, raw PDFs |
| Revision pass | Full paper draft, specific reviewer concerns | Everything else |

**`experiment_log.md` is the primary context bridge** — it summarizes everything needed for writing without loading raw data files.

For very large projects, create a `context/` directory with pre-compressed summaries:

```
context/
  contribution.md          # 1 sentence
  experiment_summary.md    # Key results table
  literature_map.md        # Organized citation notes
  figure_inventory.md      # List of figures with descriptions
```

---

## The Narrative Principle

Your paper is not a collection of experiments — it's a story with one clear contribution supported by evidence.

**Three Pillars** (must be crystal clear by end of introduction):

| Pillar | Description | Test |
|--------|-------------|------|
| **The What** | 1-3 specific novel claims | Can you state them in one sentence? |
| **The Why** | Rigorous empirical evidence | Do experiments distinguish your hypothesis from alternatives? |
| **The So What** | Why readers should care | Does this connect to a recognized community problem? |

**If you cannot state your contribution in one sentence, you don't yet have a paper.**

### From Neel Nanda

"A paper is a short, rigorous, evidence-based technical story with a takeaway readers care about."

Vague contributions like "we study X" fail immediately—reviewers need precise, falsifiable claims.

### From Andrej Karpathy

"A paper is not a random collection of experiments you report on. The paper sells a single thing that was not obvious or present before. The entire paper is organized around this core contribution with surgical precision."

NeurIPS explicitly notes that "originality does not necessarily require an entirely new method."

---

## Time Allocation

Spend approximately **equal time** on each of:
1. The abstract
2. The introduction
3. The figures
4. Everything else combined

**Why?** Most reviewers form judgments before reaching your methods. Readers encounter your paper as: title → abstract → introduction → figures → maybe the rest.

### Reviewer Reading Patterns

- Abstract is read 100% of the time
- Introduction is skimmed by 90%+ of reviewers
- Figures are examined before methods by most reviewers
- Full methods are read only if interest is established

**Implication**: Front-load your paper's value. Don't bury the contribution.

---

## Writing Workflow

```
Paper Writing Checklist:
- [ ] Step 1: Define the one-sentence contribution
- [ ] Step 2: Draft Figure 1 (core idea or most compelling result)
- [ ] Step 3: Draft abstract (5-sentence formula)
- [ ] Step 4: Draft introduction (1-1.5 pages max)
- [ ] Step 5: Draft methods
- [ ] Step 6: Draft experiments & results
- [ ] Step 7: Draft related work
- [ ] Step 8: Draft conclusion & discussion
- [ ] Step 9: Draft limitations (REQUIRED by all venues)
- [ ] Step 10: Plan appendix
- [ ] Step 11: Complete paper checklist
- [ ] Step 12: Final review
```

### Two-Pass Refinement

**Pass 1 — Write + immediate refine per section:**
For each section, write a complete draft, then immediately refine it in the same context. This catches local issues (clarity, flow, completeness) while the section is fresh.

**Pass 2 — Global refinement with full-paper context:**
After all sections are drafted, revisit each section with awareness of the complete paper. This catches cross-section issues: redundancy, inconsistent terminology, narrative flow, and gaps.

Second-pass refinement prompt (per section):
> "Review the [SECTION] in the context of the complete paper. Does it fit with the rest? Are there redundancies? Is terminology consistent? Can anything be cut without weakening the message? Does the narrative flow from the previous section and into the next? Make minimal, targeted edits."

---

## Section-by-Section Guidance

### Title

The title is the single most-read element.

**Good titles**:
- State the contribution or finding: "Autoreason: When Iterative LLM Refinement Works and Why It Fails"
- Name the method + what it does: "DPO: Direct Preference Optimization of Language Models"

**Bad titles**:
- Too generic: "An Approach to Improving Language Model Outputs"
- Too long: anything over ~15 words
- Jargon-only: "Asymptotic Convergence of Iterative Stochastic Policy Refinement"

**Rules**:
- Include your method name if you have one (for citability)
- Include 1-2 keywords reviewers will search for
- Test: would a reviewer know the domain and contribution from the title alone?

### Abstract (5-Sentence Formula)

From Sebastian Farquhar (DeepMind):

1. **What you achieved**: "We introduce...", "We prove...", "We demonstrate..."
2. **Why this is hard and important**
3. **How you do it** (with specialist keywords for discoverability)
4. **What evidence you have**
5. **Your most remarkable number/result**

**Example (Good Abstract):**

```
We prove that gradient descent on overparameterized neural networks
converges to global minima at a linear rate. [What]
This resolves a fundamental question about why deep learning works
despite non-convex optimization landscapes. [Why hard/important]
Our proof relies on showing that the Neural Tangent Kernel remains
approximately constant during training, reducing the problem to
kernel regression. [How with keywords]
We validate our theory on CIFAR-10 and ImageNet, showing that
predicted convergence rates match experiments within 5%. [Evidence]
This is the first polynomial-time convergence guarantee for
networks with practical depth and width. [Remarkable result]
```

**Delete** generic openings like "Large language models have achieved remarkable success..."

From Zachary Lipton: "If the first sentence can be pre-pended to any ML paper, delete it."

### Figure 1

Figure 1 is the second thing most readers look at (after abstract). Draft it before writing the introduction.

| Figure 1 Type | When to Use |
|---------------|-------------|
| **Method diagram** | New architecture or pipeline |
| **Results teaser** | One compelling result tells the whole story |
| **Problem illustration** | The problem is unintuitive |
| **Conceptual diagram** | Abstract contribution needs visual grounding |

Rules: Figure 1 must be understandable without reading any text. The caption alone should communicate the core idea.

### Introduction (1-1.5 pages max)

Must include:
- Clear problem statement
- Brief approach overview
- 2-4 bullet contribution list (max 1-2 lines each in two-column format)
- Methods should start by page 2-3

**Structure Template:**

```markdown
1. Opening Hook (2-3 sentences)
   - State the problem your paper addresses
   - Why it matters RIGHT NOW

2. Background/Challenge (1 paragraph)
   - What makes this problem hard?
   - What have others tried? Why is it insufficient?

3. Your Approach (1 paragraph)
   - What do you do differently?
   - Key insight that enables your contribution

4. Contribution Bullets (2-4 items)
   - Be specific and falsifiable
   - Each bullet: 1-2 lines maximum

5. Results Preview (2-3 sentences)
   - Most impressive numbers
   - Scope of evaluation

6. Paper Organization (optional, 1-2 sentences)
```

**Good contribution bullets:**
- We prove that X converges in O(n log n) time under assumption Y
- We introduce Z, a 3-layer architecture that reduces memory by 40%
- We demonstrate that A outperforms B by 15% on benchmark C

**Bad contribution bullets:**
- We study the problem of X (not a contribution)
- We provide extensive experiments (too vague)
- We make several contributions to the field (says nothing)

### Methods

Enable reimplementation:
- Conceptual outline or pseudocode
- All hyperparameters listed
- Architectural details sufficient for reproduction
- Present final design decisions; ablations go in experiments

### Experiments & Results

For each experiment, explicitly state:
- **What claim it supports**
- How it connects to main contribution
- What to observe: "the blue line shows X, which demonstrates Y"

Requirements:
- Error bars with methodology (std dev vs std error)
- Hyperparameter search ranges
- Compute infrastructure (GPU type, total hours)
- Seed-setting methods

### Related Work

Organize methodologically, not paper-by-paper. Cite generously — reviewers likely authored relevant papers.

### Limitations (REQUIRED)

All major conferences require this. Honesty helps:
- Reviewers are instructed not to penalize honest limitation acknowledgment
- Pre-empt criticisms by identifying weaknesses first
- Explain why limitations don't undermine core claims

### Conclusion & Discussion

**Conclusion** (required, 0.5-1 page):
- Restate the contribution in one sentence (different wording from abstract)
- Summarize key findings (2-3 sentences, not a list)
- Implications: what does this mean for the field?
- Future work: 2-3 concrete next steps (not vague "we leave X for future work")

**Do NOT** introduce new results or claims in the conclusion.

### Appendix Strategy

Appendices are unlimited at all major venues and essential for reproducibility.

| Appendix Section | What Goes Here |
|-----------------|---------------|
| **Proofs & Derivations** | Full proofs too long for main text |
| **Additional Experiments** | Ablations, scaling curves, per-dataset breakdowns |
| **Implementation Details** | Full hyperparameter tables, hardware specs, seeds |
| **Dataset Documentation** | Data collection, annotation guidelines, licensing |
| **Prompts & Templates** | Exact prompts used (for LLM-based methods) |
| **Human Evaluation** | Annotation interface, instructions, IRB details |
| **Additional Figures** | Per-task breakdowns, failure case examples |

Rules:
- The main paper must be self-contained — reviewers are not required to read appendices
- Never put critical evidence only in the appendix
- Cross-reference: "Full results in Table 5 (Appendix B)" not just "see appendix"

---

## Writing Style

### Sentence-Level Clarity (Gopen & Swan)

The seminal 1990 paper by George Gopen and Judith Swan establishes that **readers have structural expectations** about where information appears in prose.

> "If the reader is to grasp what the writer means, the writer must understand what the reader needs."

#### The 7 Principles of Reader Expectations

| Principle | Rule | Mnemonic |
|-----------|------|----------|
| **Subject-Verb Proximity** | Keep subject and verb close | "Don't interrupt yourself" |
| **Stress Position** | Emphasis at sentence end | "Save the best for last" |
| **Topic Position** | Context at sentence start | "First things first" |
| **Old Before New** | Familiar → unfamiliar | "Build on known ground" |
| **One Unit, One Function** | Each paragraph = one point | "One idea per container" |
| **Action in Verb** | Use verbs, not nominalizations | "Verbs do, nouns sit" |
| **Context Before New** | Explain before presenting | "Set the stage first" |

**Principle 1: Subject-Verb Proximity**

Weak: "The model, which was trained on 100M tokens and fine-tuned on domain-specific data using LoRA with rank 16, achieves state-of-the-art results"

Strong: "The model achieves state-of-the-art results after training on 100M tokens and fine-tuning with LoRA (rank 16)"

**Principle 2: Stress Position (Save the Best for Last)**

Weak: "Accuracy improves by 15% when using attention"
Strong: "When using attention, accuracy improves by **15%**"

**Principle 3: Topic Position (First Things First)**

Weak: "A novel attention mechanism that computes alignment scores is introduced"
Strong: "To address the alignment problem, we introduce a novel attention mechanism"

**Principle 4: Old Information Before New**

Weak: "Sparse attention was introduced by Child et al. The quadratic complexity of standard attention motivates this work."
Strong: "Standard attention has quadratic complexity. To address this, Child et al. introduced sparse attention."

**Principle 5: One Unit, One Function**

Each unit of discourse (sentence, paragraph, section) should serve a single function. If you have two points, use two units.

**Principle 6: Articulate Action in the Verb**

Weak: "We performed an analysis of the results" (nominalization)
Strong: "We analyzed the results" (action in verb)

**Principle 7: Context Before New Information**

Weak: "Equation 3 shows that convergence is guaranteed when the learning rate satisfies..."
Strong: "For convergence to be guaranteed, the learning rate must satisfy the condition in Equation 3..."

---

## Micro-Level Writing Tips

### From Ethan Perez (Anthropic)

#### Pronoun Management

**Minimize pronouns** ("this," "it," "these," "that"). When pronouns are necessary, use them as adjectives with a noun:

Weak: "This shows that the model converges."
Strong: "This result shows that the model converges."

#### Verb Placement

**Position verbs early** in sentences for better parsing:

Weak: "The gradient, after being computed and normalized, updates the weights."
Strong: "The gradient updates the weights after being computed and normalized."

#### Apostrophe Unfolding

Transform possessive constructions for clarity:

"X's Y" → "The Y of X"

Before: "The model's accuracy on the test set"
After: "The accuracy of the model on the test set"

#### Words to Eliminate

Delete these filler words in almost all cases:
- "actually", "a bit", "fortunately" / "unfortunately"
- "very" / "really", "quite", "basically", "essentially"
- Excessive connectives ("however," "moreover," "furthermore" when not needed)

#### Sentence Construction Rules

1. **One idea per sentence**
2. **No repeated sounds** — Avoid similar-sounding words in the same sentence
3. **Every sentence adds information** — Delete sentences that merely restate
4. **Active voice always** — Specify the actor ("We find..." not "It is found...")
5. **Expand contractions** — "don't" → "do not" for formality

#### Paragraph Architecture

- **First sentence**: State the point clearly
- **Middle sentences**: Support with evidence
- **Last sentence**: Reinforce or transition

Don't bury key information in the middle of paragraphs.

---

## Word Choice and Precision

### From Zachary Lipton

**Eliminate hedging** unless genuine uncertainty exists:
- Delete "may" and "can" unless necessary
- "provides *very* tight approximation" drips with insecurity
- "provides tight approximation" is confident

**Avoid vacuous intensifiers**:
- Delete: very, extremely, highly, significantly (unless statistical)
- These words signal insecurity, not strength

### From Jacob Steinhardt

**Precision over brevity**: Replace vague terms with specific ones.

| Vague | Specific |
|-------|----------|
| performance | accuracy, latency, throughput |
| improves | increases accuracy by X%, reduces latency by Y |
| large | 1B parameters, 100M tokens |
| fast | 3x faster, 50ms latency |
| good results | 92% accuracy, 0.85 F1 |

**Consistent terminology**: Referring to the same concept with different terms creates confusion. Choose one and stick with it:
- "model" vs "network" vs "architecture"
- "training" vs "learning" vs "optimization"
- "sample" vs "example" vs "instance"

**Vocabulary signaling**:
- Never: "combine," "modify," "expand," "extend"
- Instead: "develop," "propose," "introduce"

"We combine X and Y" sounds like you stapled two existing ideas together. "We develop a method that leverages X for Y" sounds like genuine contribution.

---

## Mathematical Writing

### General Principles

1. **State all assumptions formally** before theorems
2. **Provide intuitive explanations** alongside proofs
3. **Use consistent notation** throughout the paper
4. **Define symbols at first use**

### Notation Conventions

```latex
% Scalars: lowercase italic
$x$, $y$, $\alpha$, $\beta$

% Vectors: lowercase bold
$\mathbf{x}$, $\mathbf{v}$

% Matrices: uppercase bold
$\mathbf{W}$, $\mathbf{X}$

% Sets: uppercase calligraphic
$\mathcal{X}$, $\mathcal{D}$

% Functions: roman for named functions
$\mathrm{softmax}$, $\mathrm{ReLU}$
```

---

## Figure Design

### From Neel Nanda

Figures should tell a coherent story even if the reader skips the text. Many readers DO skip the text initially.

### Design Principles

1. **Figure 1 is crucial**: Often the first thing readers examine after abstract
2. **Self-contained captions**: Reader should understand figure without main text
3. **No title inside figure**: The caption serves this function (ICML/NeurIPS rule)
4. **Vector graphics**: PDF/EPS for plots, PNG (600 DPI) only for photographs

### Accessibility Requirements

8% of men have color vision deficiency. Your figures must work for them.

- Use colorblind-safe palettes: Okabe-Ito or Paul Tol
- Avoid red-green combinations
- Verify figures work in grayscale
- Use different line styles (solid, dashed, dotted) in addition to colors

### Tools

```python
import matplotlib.pyplot as plt
plt.style.use(['science', 'ieee'])
```

---

## Ethics & Broader Impact Statement

Most venues now require or strongly encourage an ethics/broader impact statement. This is not boilerplate — reviewers read it and can flag ethics concerns.

| Component | Content | Required By |
|-----------|---------|-------------|
| **Positive societal impact** | How your work benefits society | NeurIPS, ICML |
| **Potential negative impact** | Misuse risks, dual-use concerns | NeurIPS, ICML |
| **Fairness & bias** | Known biases in method or data | All venues (implicitly) |
| **Environmental impact** | Compute carbon footprint | ICML, increasingly NeurIPS |
| **Privacy** | Use of personal data | ACL, NeurIPS |
| **LLM disclosure** | AI use in writing or experiments | ICLR (mandatory), ACL |

**Common mistakes**:
- Writing "we foresee no negative impacts" (almost never true)
- Being vague: "this could be misused" without specifying how
- Ignoring compute costs for large-scale work

**Compute carbon footprint** (for training-heavy papers):
```python
gpu_hours = 1000
gpu_tdp_watts = 400
pue = 1.1
carbon_intensity = 0.429  # kg CO2/kWh (US average)
energy_kwh = (gpu_hours * gpu_tdp_watts * pue) / 1000
carbon_kg = energy_kwh * carbon_intensity
print(f"Energy: {energy_kwh:.0f} kWh, Carbon: {carbon_kg:.0f} kg CO2eq")
```

---

## LaTeX Quality Checklist

Verify after every edit:

- [ ] No unenclosed math symbols (`$` signs balanced)
- [ ] Only reference figures/tables that exist (`\ref` matches `\label`)
- [ ] No fabricated citations (`\cite` matches entries in `.bib`)
- [ ] Every `\begin{env}` has matching `\end{env}`
- [ ] No HTML contamination (`</end{figure}>` instead of `\end{figure}`)
- [ ] No unescaped underscores outside math mode (use `\_` in text)
- [ ] No duplicate `\label` definitions
- [ ] No duplicate section headers
- [ ] Numbers in text match actual experimental results
- [ ] All figures have captions and labels
- [ ] No overly long lines that cause overfull hbox warnings

For automated checking, run `scripts/check_latex_refs.py`.

---

## Common Mistakes to Avoid

### Structure Mistakes

| Mistake | Solution |
|---------|----------|
| Introduction too long (>1.5 pages) | Move background to Related Work |
| Methods buried (after page 3) | Front-load contribution, cut intro |
| Missing contribution bullets | Add 2-4 specific, falsifiable claims |
| Experiments without explicit claims | State what each experiment tests |

### Writing Mistakes

| Mistake | Solution |
|---------|----------|
| Generic abstract opening | Start with your specific contribution |
| Inconsistent terminology | Choose one term per concept |
| Passive voice overuse | Use active voice: "We show" not "It is shown" |
| Hedging everywhere | Be confident unless genuinely uncertain |

### Figure Mistakes

| Mistake | Solution |
|---------|----------|
| Raster graphics for plots | Use vector (PDF/EPS) |
| Red-green color scheme | Use colorblind-safe palette |
| Title inside figure | Put title in caption |
| Captions require main text | Make captions self-contained |

### Citation Mistakes

| Mistake | Solution |
|---------|----------|
| Paper-by-paper Related Work | Organize methodologically |
| Missing relevant citations | Reviewers authored papers—cite generously |
| AI-generated citations | Always verify via APIs |
| Inconsistent citation format | Use BibLaTeX with consistent keys |

---

## Pre-Submission Checklist

**Narrative**:
- [ ] Can state contribution in one sentence
- [ ] Three pillars (What/Why/So What) clear in intro
- [ ] Every experiment supports a specific claim

**Structure**:
- [ ] Abstract follows 5-sentence formula
- [ ] Introduction ≤1.5 pages
- [ ] Methods start by page 2-3
- [ ] 2-4 contribution bullets included
- [ ] Limitations section present

**Writing**:
- [ ] Consistent terminology throughout
- [ ] No generic opening sentences
- [ ] Hedging removed unless necessary
- [ ] All figures have self-contained captions

**Technical**:
- [ ] All citations verified via API
- [ ] Error bars included with methodology
- [ ] Compute resources documented
- [ ] Code/data availability stated

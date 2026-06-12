---
{
  "name": "product-builder",
  "description": "Guides non-technical builders through agent-assisted product development using decision maps, phased PRDs, vertical slices, reviewer-agent loops, and milestone control artifacts.",
  "version": "0.1.0",
  "category": "coding",
  "routing": {
    "labels": ["product planning", "prd creation", "builder agent", "reviewer agent", "decision gate", "milestone review"],
    "triggerPatterns": [
      { "type": "contains", "value": "I want to build" },
      { "type": "contains", "value": "turn this into a PRD" },
      { "type": "contains", "value": "builder agent" },
      { "type": "contains", "value": "reviewer agent" },
      { "type": "contains", "value": "decision gate" },
      { "type": "contains", "value": "vertical slice" },
      { "type": "contains", "value": "product control" },
      { "type": "contains", "value": "phase buildout" },
      { "type": "contains", "value": "non technical founder" },
      { "type": "contains", "value": "non-technical founder" },
      { "type": "contains", "value": "product roadmap" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "build error" },
      { "type": "contains", "value": "build failed" },
      { "type": "contains", "value": "how to build" },
      { "type": "contains", "value": "docker build" }
    ],
    "requiredToolsets": ["core"],
    "confirmation": "policy",
    "priority": 25
  },
  "intentLabels": [
    "product planning",
    "prd creation",
    "agent orchestration",
    "builder agent",
    "reviewer agent",
    "decision gate",
    "milestone review",
    "architecture review",
    "nontechnical builder support",
    "vertical slice",
    "product control"
  ],
  "triggerPatterns": [
    "I want to build",
    "turn this into a PRD",
    "builder agent",
    "reviewer agent",
    "decision gate",
    "what are we not seeing",
    "how does this affect us downstream",
    "next phase",
    "vertical slice",
    "product control",
    "phase buildout",
    "agent squad",
    "non technical founder",
    "non-technical founder",
    "product roadmap"
  ],
  "negativePatterns": [
    "build error",
    "build failed",
    "how to build",
    "docker build"
  ],
  "whenToUse": [
    "The user wants to turn a product idea into a structured build plan or phased PRD.",
    "The user is coordinating one or more builder agents and needs implementation prompts, reviewer prompts, or decision-gate structure.",
    "The user needs help understanding the engine of a product without becoming syntax-level technical.",
    "The user wants to map product decisions, downstream risks, reversibility, architecture implications, or milestone sequencing.",
    "The user wants to review progress after a first vertical slice, compare independent agent assessments, or resolve divergence between agents.",
    "The user needs a source-of-truth control artifact for an agent-built software project."
  ],
  "requiredToolsets": [
    "core"
  ],
  "optionalToolsets": [
    "files",
    "shell-write",
    "web",
    "research"
  ],
  "playbook": [
    {
      "id": "classify-stage",
      "description": "Classify the user's current product-building stage: idea, research, PRD, first vertical slice, documentation, review, decision gate, refactor, internal alpha, or milestone planning.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "The current stage is named explicitly.",
        "The next useful artifact or decision is identified.",
        "The agent avoids forcing the user into irrelevant steps."
      ]
    },
    {
      "id": "define-product-intent",
      "description": "Capture the product's problem, target user, core use case, primary workflow, success condition, and non-goals. If the user already provided these, extract them instead of asking again.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "Problem, user, core use case, success condition, and non-goals are stated.",
        "The output distinguishes problem-first thinking from function-first thinking.",
        "The non-goals are specific enough to prevent agent sprawl."
      ]
    },
    {
      "id": "build-research-map",
      "description": "Structure research into known facts, common patterns, reference products, open questions, important unknowns, and unimportant unknowns. Use web or research tools only when current or external information is needed.",
      "toolsets": [
        "core",
        "research"
      ],
      "fallbackTo": [
        "define-product-intent"
      ],
      "successCriteria": [
        "Facts are separated from interpretation.",
        "Reference products or comparable systems are identified when relevant.",
        "Open questions are classified by whether they block progress."
      ]
    },
    {
      "id": "map-the-engine",
      "description": "Create an engine map that explains the product as input, processing, storage, output, external dependencies, failure points, and human approval points.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "The user can understand how the product functions at system level.",
        "Failure points and human decision points are named.",
        "The explanation avoids unnecessary syntax-level detail."
      ]
    },
    {
      "id": "identify-decision-gates",
      "description": "Create or update a decision log covering each major decision, options, default choice, rationale, rejected options, downstream impact, reversibility, and trigger for reconsideration.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "Important decisions are explicit.",
        "Each decision includes downstream impact and reversibility.",
        "The agent distinguishes reversible from hard-to-reverse choices."
      ]
    },
    {
      "id": "draft-phased-prd",
      "description": "Generate a phased PRD. Each phase must include goal, user-visible behavior, technical requirements, non-goals, acceptance criteria, tests, and risks. Phase 1 should usually be the smallest working vertical slice.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "The PRD is phased.",
        "Each phase has observable acceptance criteria.",
        "The first phase is an end-to-end vertical slice rather than an arbitrary percentage of the PRD."
      ]
    },
    {
      "id": "prepare-builder-agent-brief",
      "description": "Prepare a builder-agent instruction brief that tells the builder to inspect relevant files first, preserve architecture boundaries, build a thin vertical slice, avoid unnecessary dependencies, work in small commits, run validation commands, and surface decision gates.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "The builder brief is directly usable.",
        "The brief includes implementation rules, validation expectations, and decision-gate behavior.",
        "The brief does not encourage sloppy architecture under the excuse of speed."
      ]
    },
    {
      "id": "prepare-reviewer-agent-briefs",
      "description": "Prepare independent reviewer-agent briefs with distinct roles such as architecture reviewer, security and reliability reviewer, product and use-case reviewer, or testing reviewer.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "Each reviewer has a distinct scope.",
        "Each reviewer must cite evidence from code or docs.",
        "Each reviewer must classify severity, risk, recommendation, and confidence."
      ]
    },
    {
      "id": "compare-reviewer-findings",
      "description": "Compare reviewer outputs by separating consensus, divergence, unresolved risks, evidence needed, recommended default, and required human decision. Do not force fake convergence.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "Agreement and disagreement are separated.",
        "Divergence is documented rather than prematurely collapsed.",
        "The recommended default is justified by risk, reversibility, and product stage."
      ]
    },
    {
      "id": "request-builder-response",
      "description": "Prepare a prompt asking the builder agent to respond to reviewer findings with accepted changes, rejected changes, modifications, rationale, affected files, tests, and rollback plan.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "The builder must explain acceptance or rejection of each recommendation.",
        "Affected files and tests are identified.",
        "Rollback or recovery path is included for risky changes."
      ]
    },
    {
      "id": "produce-control-artifacts",
      "description": "Create or update source-of-truth artifacts such as PRODUCT_CONTROL.md, decision log, risk register, architecture map, dependency map, roadmap, testing plan, internal alpha plan, and milestone review.",
      "toolsets": [
        "core",
        "files"
      ],
      "fallbackTo": [
        "draft-phased-prd",
        "identify-decision-gates"
      ],
      "successCriteria": [
        "A durable control artifact exists or is drafted in the response.",
        "The artifact captures current thesis, architecture summary, roadmap, decisions, risks, known debt, and next milestone.",
        "The user can hand the artifact to a builder or reviewer agent without extra explanation."
      ]
    },
    {
      "id": "run-milestone-review",
      "description": "At major milestones, review what works, what is fragile, what changed from the PRD, decisions made, debt created, what should be deleted, what should be deferred, and the next vertical slice.",
      "toolsets": [
        "core"
      ],
      "successCriteria": [
        "The milestone review identifies working behavior and fragility.",
        "Created technical or product debt is documented.",
        "The next vertical slice is explicit."
      ]
    }
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write",
    "ask-before-destructive-action"
  ],
  "examples": [
    "I want to build a product but I am non-technical. Help me structure the process.",
    "Turn this product idea into a phased PRD for a builder agent.",
    "The builder agent finished the first vertical slice. What docs and reviews should come next?",
    "Two reviewer agents disagree on the architecture direction. Help me compare their findings.",
    "We are at a decision gate. How does choosing path A or path B affect us downstream?",
    "Prepare a builder-agent prompt for the next phase.",
    "Create a PRODUCT_CONTROL.md for this agent-built project.",
    "What are we not seeing before we start the refactor?"
  ],
  "evaluations": [
    {
      "input": "I have an idea for a local-first CRM and want an agent to build it. I am not technical. What should I prepare first?",
      "shouldUseToolsets": [
        "core"
      ],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent classifies the stage as idea or research, defines product intent, creates an engine map and decision gates, and prepares a phased PRD outline with a first vertical slice."
    },
    {
      "input": "The builder agent completed around 20% of the PRD. What should I ask it to document before we continue?",
      "shouldUseToolsets": [
        "core"
      ],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent reframes the milestone around a working vertical slice, then lists architecture map, dependency map, environment docs, README, roadmap, testing plan, internal alpha plan, risk register, and decision log."
    },
    {
      "input": "Reviewer Agent A says we should refactor the router now. Reviewer Agent B says wait until after alpha. How do I decide?",
      "shouldUseToolsets": [
        "core"
      ],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent structures consensus, divergence, evidence needed, downstream impact, reversibility, recommended default, and a builder response prompt."
    },
    {
      "input": "Create a builder-agent brief for Phase 1 of this PRD.",
      "shouldUseToolsets": [
        "core"
      ],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent produces a direct implementation brief requiring inspection first, a thin vertical slice, architecture boundary preservation, small commits, validation commands, and decision-gate surfacing."
    }
  ]
}
---

# Product Builder Control

Use this skill when the user is building a product with AI agents and needs structured control over research, PRDs, builder-agent execution, reviewer-agent feedback, decision gates, documentation, dependency mapping, milestone reviews, or downstream product/architecture decisions.

## Multi-agent briefs are portable prompts

This skill produces builder-agent and reviewer-agent briefs as text artifacts you can reuse. In EstaCoda, `delegate_task` can run up to 3 children concurrently with limited nesting. Use the briefs as templates: paste them into new sessions, subagents, or external agents as needed.

## Default behavior

- Classify the current stage first: idea, research, PRD, first vertical slice, documentation, review, decision gate, refactor, internal alpha, or milestone planning.
- Produce the artifact needed for the current stage instead of giving generic product advice.
- Treat the user as the final decision-maker. Agents are evidence generators, not judges.
- Prefer a thin working vertical slice over arbitrary milestones like "20% of the PRD."
- Separate facts, assumptions, interpretations, open questions, and decisions.
- Keep the user's role focused on product intent, decision quality, downstream impact, reversibility, and source-of-truth maintenance.
- Do not force reviewer agents to converge. Document consensus, divergence, unresolved risks, and evidence needed. Require reviewers to cite evidence from source code, docs, tests, logs, or explicit requirements.
- Require builder agents to respond to reviewer findings with accepted/rejected changes, rationale, affected files, tests, and rollback plans.
- For major technical decisions, compare against relevant reference products or systems when external research is available or requested.
- Create durable control artifacts when useful: `PRODUCT_CONTROL.md`, phased PRD, decision log, risk register, architecture map, dependency map, roadmap, testing plan, internal alpha plan, and milestone review.
- If asked to write files, draft the file content first when filesystem write permission is unavailable or when write confirmation is required.
- If repo access is available, inspect existing docs, contracts, source layout, tests, and validation commands before proposing implementation instructions. If repo access is unavailable, create portable prompts and templates the user can paste into a builder or reviewer agent.
- Avoid syntax-level explanations unless the user asks. Explain the engine: input, processing, storage, output, dependencies, failure points, and human approval points.
- Preserve architecture boundaries. Do not recommend fast hacks that create hidden global state, brittle coupling, or undocumented behavior unless explicitly marked as temporary debt.
- Always include acceptance criteria for build phases and observable success criteria for process steps. Always include non-goals when drafting product definitions, PRDs, or milestone plans.

## Stage guide

Produce the artifact for the user's current stage. See `references/stage-guide.md` for full mapping and `references/stage-templates.md` for detailed templates.

Key stages: idea → Product Definition, research → Research Map, PRD → phased PRD (vertical slice first), builder → Builder Brief, reviewer → Reviewer Briefs, milestone → Milestone Review, control → `PRODUCT_CONTROL.md`.

## Operating principles

See `references/operating-principles.md` for the full list.

Short version:

- The non-technical builder's advantage is forcing clarity, preserving product intent, preventing architecture drift, and making staged decisions.
- Agent consensus is not correctness. Evidence, tests, user behavior, and source-of-truth discipline matter more.
- Testing starts with the first vertical slice. Documentation is the control layer for directing agents.
- Refactors need blast-radius analysis. A good decision is explicit, reversible when possible, and tied to current product stage.

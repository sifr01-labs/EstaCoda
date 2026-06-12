---
{
  "name": "skillify",
  "description": "Capture this session's repeatable process into an EstaCoda skill through a structured interview and review step, using governed skill creation tools.",
  "version": "1.0.0",
  "category": "software-development",
  "routing": {
    "labels": ["skill-authoring", "process-capture", "agent-evolution"],
    "triggerPatterns": [
      { "type": "contains", "value": "/skillify" },
      { "type": "contains", "value": "turn this into a skill" },
      { "type": "contains", "value": "save this as a skill" },
      { "type": "contains", "value": "capture this workflow" },
      { "type": "contains", "value": "make a skill from this" },
      { "type": "contains", "value": "create a reusable skill" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "skill issue" },
      { "type": "contains", "value": "not skilled" }
    ],
    "requiredToolsets": ["files", "research"],
    "confirmation": "ask",
    "priority": 35
  },
  "intentLabels": ["skill-authoring", "process-capture"],
  "triggerPatterns": ["/skillify", "turn this into a skill", "save this as a skill", "capture this workflow", "make a skill from this", "create a reusable skill"],
  "negativePatterns": ["skill issue", "not skilled"],
  "whenToUse": [
    "The user invokes /skillify with an optional process description.",
    "The user asks to capture the current or recent workflow as a reusable skill.",
    "The user wants to turn an observed process into a SKILL.md."
  ],
  "requiredToolsets": ["files", "research"],
  "optionalToolsets": [],
  "playbook": [
    {
      "id": "analyze-session",
      "description": "Analyze the session or provided context to identify the repeatable process, inputs, steps, tools, user steering, and success artifacts.",
      "toolsets": ["research", "files"],
      "successCriteria": ["A candidate skill name, description, goals, inputs, and step list are identified."]
    },
    {
      "id": "interview-user",
      "description": "Ask the user a bounded structured interview: high-level confirmation, step details, invocation rules, and final gotchas. Do not over-ask for simple processes.",
      "toolsets": ["research"],
      "successCriteria": ["User has confirmed the skill scope, name, steps, and save location."]
    },
    {
      "id": "draft-skill",
      "description": "Draft a complete EstaCoda SKILL.md using JSON frontmatter, required routing metadata, playbook steps, success criteria, permission expectations, examples, and evaluations.",
      "toolsets": ["files"],
      "successCriteria": ["Complete SKILL.md draft is ready for review."]
    },
    {
      "id": "review-before-write",
      "description": "Show the complete SKILL.md draft to the user and ask for approval before creating. If the user requests edits, revise and ask again.",
      "toolsets": ["research"],
      "successCriteria": ["User approves the final SKILL.md content."]
    },
    {
      "id": "create-skill",
      "description": "Create the approved skill using skill.create or skill.propose_patch. For private/profile-local skills, use skill.create directly. For official repo skills, use skill.propose_patch and route through the approval flow.",
      "toolsets": ["files"],
      "preferredTool": "skill.create",
      "successCriteria": ["Skill is created or proposed, and path/status is reported."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": [
    "/skillify code review workflow",
    "Turn this process into a skill.",
    "Capture what we just did as a reusable skill."
  ],
  "evaluations": [
    {
      "input": "/skillify release docs workflow",
      "shouldUseToolsets": ["files", "research"],
      "shouldNotAskUserFirst": false,
      "expectedOutcome": "The agent analyzes the session, interviews the user, drafts a valid EstaCoda SKILL.md, asks for approval, and creates the skill via skill.create or skill.propose_patch."
    }
  ]
}
---

# Skillify

Capture this session's repeatable process as a reusable EstaCoda skill, using governed skill creation tools.

## Step 1: Analyze the Session

Before asking questions, analyze the current session and available context to identify:

- What repeatable process was performed
- What the inputs/parameters were
- The distinct steps, in order
- The success artifacts/criteria for each step
- Where the user corrected or steered you
- What tools and permissions were needed
- What subagents were used
- What goals and completion artifacts mattered

Pay special attention to user corrections. Those often encode the most important skill rules.

## Step 2: Interview the User

Ask the user directly. Keep the interview bounded and do not over-ask for simple processes.

### Round 1: High-level confirmation

Suggest:

- Skill name
- One-line description
- High-level goal
- Specific success criteria

Ask the user to confirm or rename.

### Round 2: More details

Present the high-level steps as a numbered list. Ask for corrections.

If the skill needs arguments, suggest them based on what you observed. Make sure it is clear what a future user would need to provide.

Ask where the skill should be saved. Suggest a default based on context:

- **Private workspace** — for review before repo import
- **Profile-local skill** — for personal workflows
- **Official EstaCoda skill candidate** — for workflows that should eventually ship in `skills/official/`

Do not write into the EstaCoda repo unless explicitly asked.

### Round 3: Step detail

For each major step, if not obvious, ask:

- What does this step produce that later steps need?
- What proves that this step succeeded?
- Should the user confirm before proceeding?
- Are any steps independent and parallelizable?
- Should the step be direct or delegated to subagents?
- What are the hard constraints or hard preferences?

### Round 4: Invocation rules

Confirm when this skill should be invoked. Suggest trigger phrases and example user messages.

Ask for any final gotchas if unclear.

## Step 3: Write the SKILL.md Draft

Use EstaCoda's official skill format:

```markdown
---
{
  "name": "skill-name",
  "description": "One-line description.",
  "version": "1.0.0",
  "category": "software-development",
  "routing": {
    "labels": ["label"],
    "triggerPatterns": [
      { "type": "contains", "value": "trigger phrase" }
    ],
    "requiredToolsets": ["files"],
    "confirmation": "policy",
    "priority": 20
  },
  "intentLabels": ["label"],
  "triggerPatterns": ["trigger phrase"],
  "whenToUse": ["Use when..."],
  "requiredToolsets": ["files"],
  "optionalToolsets": [],
  "playbook": [
    {
      "id": "step-id",
      "description": "Actionable step description.",
      "toolsets": ["files"],
      "successCriteria": ["Concrete success criterion."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": ["example user request"],
  "evaluations": [
    {
      "input": "example user request",
      "shouldUseToolsets": ["files"],
      "shouldNotAskUserFirst": false,
      "expectedOutcome": "Expected behavior."
    }
  ]
}
---

# Skill Title

Instructions here.
```

## Step 4: Confirm and Create

Before creating, output the complete SKILL.md content so the user can review it. Ask for confirmation.

Use the appropriate governed skill tool based on the save location:

- **Private workspace or profile-local**: Use `skill.create` to write the skill directly.
- **Official EstaCoda repo**: Use `skill.propose_patch` to route through the approval flow. The skill will not be active until reviewed and promoted.

After creating, tell the user:

- Where the skill was saved
- How it will be invoked
- That they can edit the SKILL.md directly to refine it
- For repo skills, how to review and promote the proposal

---
{
  "name": "external-agent-runtime-comparison",
  "description": "Compare agent codebases and their underlying runtimes using pinned source evidence, executed checks and explicit benchmark limits.",
  "version": "1.0.0",
  "category": "research",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "research.runtime-comparison"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "external-agent-runtime-comparison"
      },
      {
        "type": "regex",
        "value": "\\b(?:compare|benchmark)\\b.{0,180}\\b(?:codebases?|harnesses?|agent runtimes?)\\b"
      },
      {
        "type": "regex",
        "value": "(?:قارن|مقارنة).{0,120}(?:وكلاء|كود|أنظمة التشغيل)"
      }
    ],
    "confirmation": "policy",
    "negativePatterns": [
      {
        "type": "contains",
        "value": "benchmark stock prices"
      },
      {
        "type": "contains",
        "value": "compare agent salaries"
      }
    ]
  },
  "requiredToolsets": [
    "files"
  ],
  "optionalToolsets": [
    "web",
    "shell-readonly",
    "research",
    "core"
  ],
  "playbook": [
    {
      "id": "establish-scope",
      "description": "Pin repositories and separate an application bundle from its underlying runtime; inspect available tools and delegation readiness.",
      "toolsets": [
        "files",
        "core"
      ]
    },
    {
      "id": "investigate",
      "description": "Trace equivalent implementations, preserve source references, and execute discriminating checks with declared input scopes when dependencies are known.",
      "toolsets": [
        "files",
        "web",
        "shell-readonly"
      ]
    },
    {
      "id": "deliver",
      "description": "Deliver supported findings, artifacts and verification limits; separate incomplete execution from useful partial results.",
      "toolsets": [
        "core",
        "files"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Find Super-agent and benchmark it against EstaCoda's codebase and capabilities.",
      "shouldUseToolsets": [
        "files"
      ],
      "expected": {
        "selectedSkill": "external-agent-runtime-comparison"
      }
    }
  ],
  "permissionExpectations": [
    "Workspace trust and normal command/network approvals apply; delegation requires configured durable Tasks."
  ]
}
---

# External agent runtime comparison

Compare the complete stacks relevant to the user's task. Establish whether the published project is an application, plugin, skill bundle or runtime, and identify which capabilities come from its host. Inspect implementation rather than treating README claims or directory presence as demonstrated behavior.

## Investigation

1. Pin each repository revision and record the comparison date. Distinguish current source from the revision actually deployed in an incident. Use authorized retrieval tools; do not run unreviewed upstream scripts merely to inspect them.
2. Inspect the actual tool inventory. If delegation is relevant, use capability.discover for delegate_task and capability.request only when available. Missing durable Task prerequisites require operator setup; do not bypass them or pretend a worker ran. Proceed with local investigation when delegation is unavailable.
3. For independent investigations, give each worker one scope: the external project, its underlying runtime, or the corresponding EstaCoda paths. Specify source references, executed checks, unresolved questions, and a bounded budget. Parent synthesis owns the comparison and final report.
4. Trace equivalent end-to-end paths. For every important claim retain repository revision, path and line/symbol, observation reference, and what the evidence establishes. Separate source inspection, deterministic tests, live-model experiments, and inference. A count of passing unrelated tests is not a performance ranking.
5. Run checks that discriminate between designs, including negative and recovery cases. When all inputs are known, declare verificationInputs on terminal.run or execute_code, including source, tests, config and dependency manifests. Paths are workspace-relative; include resolved dependencies, not just an alias. Omit the scope or use '.' if uncertain. An unrelated report write should not require rerunning a scoped source check.
6. Page retained output through session_search mode=read using its observation reference and nextOffset. Avoid rerunning commands to recover output. Tool-level truncation and retention limits may still mean bytes are unavailable; state that limitation and make a targeted authorized read if needed.

## Delivery and learning

Lead with findings and implications. Cite precise source references. Explain material differences in model, budget, skills, concurrency and environment before comparing results. Reserve time for synthesis; near a limit, deliver useful supported findings and report paths with explicit unfinished work. Never claim a check passed merely because an answer must be delivered.

Write and read back an output file when requested. Keep Telegram delivery readable with short paragraphs and bullets; prefer attaching or linking the report over a wide Markdown table.

Record symptoms, evidence, suspected cause, proposed correction and verification separately. Infrastructure defects belong in runtime regression tests; procedural improvements may become skill proposals. A proposed correction is not a validated lesson. Abstain when evidence is insufficient. Retain approval and task-evaluation gates; do not silently mutate live skills.

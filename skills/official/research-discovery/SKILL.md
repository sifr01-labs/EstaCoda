---
{
  "name": "research-discovery",
  "description": "Discover research sources and academic literature, compare evidence, and synthesize cited reports; save output when requested.",
  "version": "1.0.0",
  "category": "research",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "research.discovery",
      "research.paper-search"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "research discovery"
      },
      {
        "type": "contains",
        "value": "research-discovery"
      },
      {
        "type": "contains",
        "value": "find papers"
      },
      {
        "type": "contains",
        "value": "paper search"
      },
      {
        "type": "regex",
        "value": "\\b(?:find|search|review|survey)\\b.{0,100}\\b(?:papers?|arxiv|literature)\\b"
      },
      {
        "type": "regex",
        "value": "\\bliterature\\s+(?:review|report|survey)\\b"
      },
      {
        "type": "regex",
        "value": "(?:ابحث|راجع).{0,100}(?:أوراق|أبحاث|أدبيات)"
      },
      {
        "type": "contains",
        "value": "deep research"
      },
      {
        "type": "regex",
        "value": "\\b(?:research|investigate)\\b.{0,160}\\b(?:report|sub[- ]?agents?)\\b"
      },
      {
        "type": "regex",
        "value": "ابحث.{0,160}(?:بعمق|وكلاء|sub[- ]?agents?)"
      }
    ],
    "requiredToolsets": [
      "web"
    ],
    "confirmation": "policy",
    "aliases": [
      "research"
    ]
  },
  "requiredToolsets": [
    "web"
  ],
  "optionalToolsets": [
    "files",
    "shell-readonly",
    "research"
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write"
  ],
  "playbook": [
    {
      "id": "form-query",
      "description": "Identify the question, freshness scope and suitable primary sources; scale depth to the request.",
      "toolsets": [
        "core"
      ]
    },
    {
      "id": "search-research-discovery",
      "description": "Discover sources with web.search, then use web.extract to investigate central claims, dates and contradictions.",
      "toolsets": [
        "web"
      ],
      "fallbackTo": [
        "shell-readonly"
      ]
    },
    {
      "id": "summarize-results",
      "description": "Synthesize supported findings and material limitations concisely; save and read back a report only when requested.",
      "toolsets": [
        "core",
        "files"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Find recent arXiv papers on GRPO reinforcement learning.",
      "shouldUseToolsets": [
        "web"
      ]
    }
  ]
}
---

# Research Discovery

Investigate the user's question using sources appropriate to the topic. Scale effort to the request: a quick overview needs less investigation than deep research. Academic papers are useful when relevant; general research does not require an academic paper or experiment workflow.

## Research method

- Establish the question, scope and freshness needs. For latest developments, distinguish a source's publication or release date from the date you retrieved it. An undated page does not establish recency.
- Use web.search to discover sources. For deep research, use web.extract to read the primary pages supporting the central conclusions: official documentation, release notes, original studies or first-hand records. Search snippets identify leads; they may omit qualifications or contain outdated context.
- After reading, assess what remains uncertain. Follow important leads, resolve contradictions and try alternative authoritative sources when a page fails. Choose the next action from the evidence gaps, not a fixed number of searches or pages. A successful extraction is not itself proof of a claim.
- Compare sources before drawing conclusions. Cite observed URLs beside supported claims; distinguish the source's findings from your inference. Never invent citations, dates, access failures or verification.
- If access or permissions prevent adequate investigation, preserve the useful findings and state the specific limitation. Never bypass an access restriction. Say page content was not retrieved when you have only a search snippet; say retrieval failed only if an attempted tool call failed.

## Delegated work

Give each worker a distinct question, source guidance and expected depth. A research worker should investigate unresolved central claims within its assigned scope before returning findings, citations and material limitations. It should not repeat the parent's delegation or save the final report.

When synthesizing, compare all assigned findings and identify gaps. If follow-up tools are available and authorized, investigate important gaps before concluding. If the step permits only reading worker results, state unresolved gaps honestly; do not imply further verification or silently fill them with training knowledge.

## Report and delivery

Lead with the answer and the most consequential findings. Organize supporting evidence around the user's questions, including disagreements and limitations where they affect conclusions. Let length follow substantive findings, not the number of links collected. State shared limitations once; do not repeat workflow status, boilerplate disclaimers or source tables already retained by the runtime.

For reports, use a short synthesis, supported findings and remaining uncertainties. The optional template at templates/research-report.md provides a starting point; these instructions are sufficient when skill.read is unavailable. Keep detailed source records in an appendix after the report.

When a file is requested, use workspace tools to write it and read back the same target before reporting it saved. A synthesis result alone is not a saved file. In a delegated task, only the delivery step owns the final file.

## Optional academic references

For arXiv query syntax, Semantic Scholar endpoints, BibTeX and helper script examples, read references/academic-search.md with skill.read when that tool is available and literature is relevant. These reference details are not prerequisites for ordinary web research. Prefer web tools; inspect scripts before executing them under the existing execution policy. This skill does not author experiments or replace the paper-writing researcher skill.

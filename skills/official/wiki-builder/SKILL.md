---
{
  "name": "wiki-builder",
  "description": "Build, query, lint, and maintain a persistent markdown knowledge wiki with raw-source provenance, cross-links, schema discipline, and compounding synthesis.",
  "version": "1.0.0",
  "category": "research",
  "platforms": ["linux", "macos", "windows"],
  "routing": {
    "labels": ["knowledge-wiki", "markdown-knowledge-base", "research-notes", "wiki-maintenance", "source-ingest"],
    "triggerPatterns": [
      { "type": "contains", "value": "wiki-builder" },
      { "type": "contains", "value": "build a wiki" },
      { "type": "contains", "value": "create a wiki" },
      { "type": "contains", "value": "knowledge base" },
      { "type": "contains", "value": "knowledge wiki" },
      { "type": "contains", "value": "ingest this source" },
      { "type": "contains", "value": "add this to my wiki" },
      { "type": "contains", "value": "query my wiki" },
      { "type": "contains", "value": "lint my wiki" },
      { "type": "contains", "value": "audit my wiki" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "wikipedia" },
      { "type": "contains", "value": "mediawiki install" },
      { "type": "contains", "value": "wiki page about" }
    ],
    "requiredToolsets": ["core", "files", "research"],
    "confirmation": "policy",
    "priority": 24
  },
  "intentLabels": ["knowledge-wiki", "markdown-knowledge-base", "research-notes", "wiki-maintenance"],
  "triggerPatterns": ["wiki-builder", "build a wiki", "create a wiki", "knowledge base", "knowledge wiki", "ingest this source", "add this to my wiki", "query my wiki", "lint my wiki", "audit my wiki"],
  "negativePatterns": ["wikipedia", "mediawiki install", "wiki page about"],
  "whenToUse": [
    "The user wants to create, maintain, query, or audit a durable markdown knowledge base.",
    "The user wants to ingest URLs, PDFs, pasted notes, transcripts, papers, or other sources into an interlinked wiki.",
    "The user refers to their wiki or notes in a research, intelligence, learning, or knowledge-management context.",
    "The user wants a compounding alternative to repeated ad hoc retrieval."
  ],
  "requiredToolsets": ["core", "files", "research"],
  "optionalToolsets": ["web", "shell-readonly", "shell-write", "coding", "memory"],
  "playbook": [
    {
      "id": "orient-to-wiki",
      "description": "Resolve the wiki path, confirm access boundaries, then read SCHEMA.md, index.md, and recent log.md before creating, querying, or updating content.",
      "toolsets": ["files", "research"],
      "successCriteria": ["The schema, index, recent activity, and write boundary are understood."]
    },
    {
      "id": "initialize-wiki",
      "description": "For a new wiki, create the directory structure, domain-specific schema, empty sectioned index, and append-only log after confirming the wiki domain and path.",
      "toolsets": ["files", "research"],
      "successCriteria": ["The wiki has SCHEMA.md, index.md, log.md, raw directories, and layer-2 content directories."]
    },
    {
      "id": "ingest-source",
      "description": "Capture immutable raw source material, compute provenance metadata, search existing pages, create or update relevant pages, cross-link, update index.md, and append log.md.",
      "toolsets": ["files", "web", "research"],
      "successCriteria": ["Raw source is preserved, synthesized pages are updated, provenance is traceable, and navigation/log files are current."]
    },
    {
      "id": "query-wiki",
      "description": "Answer from the existing wiki by reading the index, searching when needed, loading relevant pages, citing wikilinks, and filing valuable syntheses back into queries or comparisons.",
      "toolsets": ["files", "research"],
      "successCriteria": ["The answer is grounded in wiki pages and useful non-trivial synthesis is preserved."]
    },
    {
      "id": "lint-wiki",
      "description": "Audit orphans, broken links, index completeness, frontmatter, stale pages, contradictions, source drift, page size, tags, and log rotation needs.",
      "toolsets": ["files", "coding", "shell-readonly"],
      "successCriteria": ["Findings are grouped by severity with specific paths and proposed fixes."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write", "ask-before-destructive-action", "ask-before-external-send"],
  "examples": [
    "Start a knowledge wiki for my AI research notes.",
    "Ingest this article into my wiki and update related pages.",
    "Query my wiki for what we know about inference optimization.",
    "Lint my wiki and tell me what is stale or broken."
  ],
  "evaluations": [
    {
      "input": "Create a wiki for tracking AI model releases and papers.",
      "shouldUseToolsets": ["files", "research"],
      "shouldNotAskUserFirst": false,
      "expectedOutcome": "The agent confirms scope and path, initializes the wiki structure, writes a tailored schema, creates index/log files, and explains how to ingest the first sources."
    },
    {
      "input": "Add this paper to my knowledge wiki and update any related concept pages.",
      "shouldUseToolsets": ["files", "web", "research"],
      "expectedOutcome": "The agent orients to the wiki, captures raw source material with provenance, searches existing pages, updates relevant pages with links and sources, refreshes index.md, and logs the ingest."
    },
    {
      "input": "Audit my wiki for broken links, stale pages, and contradictions.",
      "shouldUseToolsets": ["files", "coding", "shell-readonly"],
      "expectedOutcome": "The agent reads schema/index/log, scans wiki markdown files, reports broken links, orphan pages, stale content, low-confidence pages, source drift, and suggested repairs."
    }
  ]
}
---

# Wiki Builder

Build and maintain a persistent, compounding knowledge base as interlinked markdown files.

The pattern is simple: compile knowledge once, keep it current, preserve raw sources, and let each ingest strengthen the next query. Cross-references are maintained, contradictions are flagged, and synthesis reflects everything already processed.

Division of labor:

- The human curates sources, confirms scope, and steers judgment calls.
- The agent captures sources, summarizes, cross-references, files, audits, and maintains consistency.

## Path And Permissions

Prefer a workspace-local wiki path such as `wiki/`. This gives EstaCoda's file tools the lowest-friction read/write path.

If the user already has a wiki elsewhere, use their chosen path only after confirming access. EstaCoda file tools operate inside the active trusted workspace; for an external `~/wiki`, ask the user to open/trust that directory as the workspace or configure the runtime to expose it before writing. Do not silently copy private wiki content into the current repo.

If no path is given:

1. Use `wiki/` inside the current workspace for new wikis.
2. Use `$WIKI_PATH` only when the environment or user explicitly provides it.
3. Ask before creating or writing outside the active workspace.

## Structure

```text
wiki/
+-- SCHEMA.md
+-- index.md
+-- log.md
+-- raw/
|   +-- articles/
|   +-- papers/
|   +-- transcripts/
|   +-- assets/
+-- entities/
+-- concepts/
+-- comparisons/
+-- queries/
```

Layers:

- Raw sources: immutable source material. Read but do not edit after capture.
- Wiki pages: agent-maintained markdown pages for entities, concepts, comparisons, and durable query results.
- Schema: `SCHEMA.md` defines domain, conventions, taxonomy, thresholds, and update policy.

## Always Orient First

Before ingesting, querying, linting, or archiving an existing wiki:

1. Read `SCHEMA.md`.
2. Read `index.md`.
3. Read the last 20-30 entries of `log.md`.
4. For large wikis, search markdown files for the topic before creating anything new.

This prevents duplicate pages, missed cross-links, schema violations, and repeated work.

## Initialize A Wiki

When the user asks to create or start a wiki:

1. Resolve and confirm the wiki path.
2. Ask what domain the wiki covers. Be specific.
3. Create the directory structure.
4. Write `SCHEMA.md` customized to the domain.
5. Write initial `index.md`.
6. Write initial `log.md`.
7. Confirm the wiki is ready and suggest first sources to ingest.

### SCHEMA.md Template

Adapt this to the user's domain.

```markdown
# Wiki Schema

## Domain
[What this wiki covers, such as "AI/ML research", "startup intelligence", or "personal learning notes".]

## Conventions
- File names: lowercase, hyphenated, no spaces.
- Every wiki page starts with YAML frontmatter.
- Use `[[wikilinks]]` between wiki pages. Aim for at least 2 outbound links per page.
- When updating a page, bump the `updated` date.
- Every new page must be added to `index.md`.
- Every action must be appended to `log.md`.
- Tags must appear in the taxonomy below before use.
- Raw source files are immutable after capture.

## Frontmatter

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from taxonomy below]
sources: [raw/articles/source-name.md]
confidence: high | medium | low
contested: false
contradictions: []
---
```

Use `confidence` and `contested` for opinion-heavy, fast-moving, or disputed claims.

## Raw Source Frontmatter

```yaml
---
source_url: https://example.com/article
ingested: YYYY-MM-DD
sha256: <hex digest of body content after this frontmatter>
---
```

Compute `sha256` over the body only. On re-ingest, compare hashes. Skip unchanged sources, and flag drift when the source changed.

## Tag Taxonomy
[Define 10-20 top-level tags for the domain.]

Example for AI/ML:
- Models: model, architecture, benchmark, training
- People/Orgs: person, company, lab, open-source
- Techniques: optimization, fine-tuning, inference, alignment, data
- Meta: comparison, timeline, controversy, prediction

## Page Thresholds
- Create a page when an entity or concept appears in 2+ sources or is central to one source.
- Add to an existing page when a source mentions something already covered.
- Do not create pages for passing mentions, minor details, or out-of-domain material.
- Split pages over about 200 lines into subtopics with cross-links.
- Archive fully superseded pages under `_archive/` and remove them from `index.md`.

## Page Types

Entity pages include overview, key facts/dates, relationships, and sources.

Concept pages include definition, current state, open questions, debates, related concepts, and sources.

Comparison pages include comparison purpose, dimensions, table, verdict/synthesis, and sources.

Query pages preserve substantial answers that would be painful to re-derive.

## Update Policy
When new information conflicts with existing content:
1. Check dates and source quality.
2. If newer information supersedes old information, update with provenance.
3. If genuinely contradictory, state both claims with dates and sources.
4. Mark `contested: true` and populate `contradictions: [...]`.
5. Flag unresolved contradictions for user review.
```

### index.md Template

```markdown
# Wiki Index

> Content catalog. Every wiki page is listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: YYYY-MM-DD | Total pages: N

## Entities
<!-- Alphabetical within section -->

## Concepts

## Comparisons

## Queries
```

Scaling rule: when a section exceeds 50 entries, split by first letter or sub-domain. When the index exceeds 200 entries, create `_meta/topic-map.md` to group pages by theme.

### log.md Template

```markdown
# Wiki Log

> Chronological record of wiki actions. Append-only.
> Format: `## [YYYY-MM-DD] action | subject`
> Actions: ingest, update, query, lint, create, archive, delete
> Rotate to `log-YYYY.md` after 500 entries.

## [YYYY-MM-DD] create | Wiki initialized
- Domain: [domain]
- Structure created with SCHEMA.md, index.md, and log.md
```

## Ingest Sources

When the user provides a URL, PDF, file, paste, transcript, or note:

1. Capture raw source material.
   - URL: use `web.extract` when available, then save markdown under `raw/articles/`.
   - PDF: use available PDF extraction skills/tools when needed, then save under `raw/papers/`.
   - Paste or local file: save to the appropriate `raw/` subdirectory.
   - Name files descriptively, such as `raw/articles/karpathy-llm-wiki-2026.md`.
   - Add raw frontmatter with `source_url`, `ingested`, and body-only `sha256`.
2. Discuss takeaways with the user unless running in an automated/cron context.
3. Search `index.md` and existing pages for mentioned entities/concepts.
4. Create or update wiki pages.
   - Follow `SCHEMA.md` page thresholds.
   - Add new facts to existing pages where possible.
   - Bump `updated` dates.
   - Use only schema-approved tags.
   - Add wikilinks, including backlinks where useful.
   - For synthesis from 3+ sources, add provenance markers such as `^[raw/articles/source-file.md]` at paragraph ends where claims trace to a source.
   - Mark low-confidence, contested, or single-source claims honestly.
5. Update `index.md`.
   - Add new pages under the correct section.
   - Keep entries alphabetical within sections.
   - Update `Last updated` and `Total pages`.
6. Append a log entry listing every file created or updated.
7. Report changed files to the user.

A single rich source can update 5-15 pages. That is expected. If an ingest would touch 10+ existing pages or perform a broad restructuring, confirm scope first.

## Query The Wiki

When the user asks a question about the wiki's domain:

1. Orient by reading `SCHEMA.md`, `index.md`, and recent `log.md`.
2. Identify relevant pages from the index.
3. For large wikis, search all markdown files for key terms.
4. Read relevant pages and their most important linked neighbors.
5. Synthesize an answer grounded in wiki content. Cite source pages using wikilinks, for example: "Based on [[page-a]] and [[page-b]]..."
6. If the answer is a substantial comparison, deep dive, or novel synthesis, ask or proceed according to policy to file it under `queries/` or `comparisons/`.
7. Append a `query` log entry when a query produces durable value or files a page.

Do not file trivial lookups.

## Lint And Health Check

When asked to lint, audit, or health-check the wiki:

1. Orphan pages: find pages with no inbound `[[wikilinks]]`.
2. Broken links: find links that point to missing pages.
3. Index completeness: ensure every wiki page appears in `index.md`.
4. Frontmatter validation: check `title`, `created`, `updated`, `type`, `tags`, and `sources`.
5. Tag audit: flag tags not present in `SCHEMA.md`.
6. Stale content: flag pages whose `updated` date is older than newer raw sources about the same entities.
7. Contradictions: surface `contested: true`, `contradictions:`, and pages with conflicting facts.
8. Quality signals: list `confidence: low` pages and single-source pages with no confidence field.
9. Source drift: recompute raw source `sha256` body hashes and flag mismatches.
10. Page size: flag pages over about 200 lines.
11. Log rotation: flag `log.md` after 500 entries.
12. Report findings by severity: broken links, missing index entries, source drift, contested pages, stale content, style issues.
13. Append a `lint` log entry with issue count.

For programmatic scans, use `execute_code` or approved shell-readonly tooling. Keep generated reports inside the wiki only after the user approves or when policy allows.

### Lint Scan Sketch

```python
from pathlib import Path
import re

wiki = Path("wiki")
pages = [p for folder in ["entities", "concepts", "comparisons", "queries"] for p in (wiki / folder).glob("*.md")]
slugs = {p.stem for p in pages}
incoming = {slug: set() for slug in slugs}
broken = []

for page in pages:
    text = page.read_text(encoding="utf-8")
    for target in re.findall(r"\[\[([^\]|#]+)", text):
        target_slug = target.strip().replace(" ", "-").lower()
        if target_slug in incoming:
            incoming[target_slug].add(page.stem)
        else:
            broken.append((page, target))

orphans = [slug for slug, sources in incoming.items() if not sources]
```

Adapt the sketch to the actual schema and file layout.

## Bulk Ingest

When ingesting multiple sources:

1. Read/capture all sources first.
2. Identify all entities and concepts across the batch.
3. Search existing pages once for all candidate entities/concepts.
4. Create/update pages in one pass.
5. Update `index.md` once.
6. Write a single batch log entry listing sources and changed files.

## Archive Or Supersede

When content is fully superseded or the domain scope changes:

1. Create `_archive/` if needed.
2. Move the page to `_archive/` preserving enough original path context.
3. Remove the page from `index.md`.
4. Update pages that linked to it, replacing the wikilink with plain text plus "(archived)" or a link to the replacement page.
5. Log the archive action.

Do not delete raw sources unless the user explicitly requests deletion and the command/file operation is approved.

## Obsidian Compatibility

The wiki works as an Obsidian vault:

- `[[wikilinks]]` render as clickable links.
- Graph View visualizes the knowledge network.
- YAML frontmatter supports Dataview-style workflows.
- `raw/assets/` holds images referenced by wiki pages.

For optional Obsidian Sync or headless-server setup, read `references/obsidian-headless.md` only when the user asks for sync, Obsidian integration, or server operation.

## Pitfalls

- Never modify files in `raw/` after capture. Corrections belong in wiki pages.
- Always orient first.
- Always update `index.md` and `log.md`.
- Do not create pages for passing mentions.
- Do not create isolated pages without cross-references.
- Keep frontmatter complete.
- Add new tags to `SCHEMA.md` before using them.
- Split pages that grow beyond about 200 lines.
- Ask before mass-updating 10+ existing pages.
- Rotate `log.md` after 500 entries.
- Handle contradictions explicitly; do not silently overwrite disputed claims.

## Related Tooling

Batch wiki compilers can generate Obsidian-compatible concept wikis from source directories, but they trade away some agent judgment about page creation, contradiction handling, and synthesis. Use this skill when the user wants agent-in-the-loop curation, provenance, and incremental knowledge maintenance.

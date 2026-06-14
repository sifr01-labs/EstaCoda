# Literature Review Guide

Finding, organizing, and synthesizing related work. Load this reference when the user is in Phase 1 (Literature Review).

---

## Identifying Seed Papers

Start from papers already referenced in the codebase:

```bash
grep -r "research-discovery\|doi\|cite" --include="*.md" --include="*.bib" --include="*.py"
find . -name "*.bib"
```

Also check:
- `README.md` for cited works
- Any existing draft documents
- Recent papers from the same research group

---

## Search Strategy: Breadth-First, Then Depth

A flat search (one round of queries) typically misses important related work. Use an iterative pattern:

**Round 1 (Breadth)**: 4-6 parallel queries covering different angles
- "[method] + [domain]"
- "[problem name] state-of-the-art 2024 2025"
- "[baseline method] comparison"
- "[alternative approach] vs [your approach]"
→ Collect papers, extract key concepts and terminology

**Round 2 (Depth)**: Generate follow-up queries from Round 1 learnings
- New terminology discovered in Round 1 papers
- Papers cited by the most relevant Round 1 results
- Contradictory findings that need investigation
→ Collect papers, identify remaining gaps

**Round 3 (Targeted)**: Fill specific gaps
- Missing baselines identified in Rounds 1-2
- Concurrent work (last 6 months, same problem)
- Key negative results or failed approaches
→ Stop when new queries return mostly papers already in your collection

**When to stop**: If a round returns >80% papers already in your collection, the search is saturated. Typically 2-3 rounds suffice. For survey papers, expect 4-5 rounds.

**For agent-based workflows**: Delegate each round's queries in parallel via sub-agents. Collect results, deduplicate, then generate the next round's queries from combined learnings.

---

## Search Tools

| Tool | Best For | Pattern |
|------|----------|---------|
| **research-discovery skill** | arXiv REST search, BibTeX generation, Semantic Scholar citation graphs | Load skill: `research-discovery` |
| **web search** | Broad discovery, finding non-arXiv papers, recent work | Query: `"[technique] [domain] site:arxiv.org"` |
| **web extract** | Fetching specific paper content for verification | URL: `https://arxiv.org/abs/XXXX.XXXXX` |
| **Semantic Scholar API** | ML/AI papers, citation counts, author profiles | `semanticscholar` Python package |

**Exa MCP** (optional): For real-time academic search:
```bash
# Optional: configure an approved research/search connector for the current EstaCoda profile when available
```

---

## Organizing Related Work

Group papers by methodology, not paper-by-paper:

**Good**: "One line of work uses X's assumption [refs] whereas we use Y's assumption because..."
**Bad**: "Smith et al. introduced X. Jones et al. introduced Y. We combine both."

Create a structured note file as you read:

```markdown
## Category: [Methodological theme]

### [Author et al., Year]
- **Relevance**: [High/Medium/Low]
- **Key claim**: [One sentence]
- **How it relates to us**: [Similar/different assumption, baseline, or extension]
- **BibTeX key**: [author_year_keyword]
- **Verified**: [Yes / Placeholder]
```

---

## Citation Verification

**Never generate BibTeX from memory. Always verify programmatically.**

For each citation, follow the 5-step process in `citation-workflow.md`:

1. SEARCH → Query Semantic Scholar or similar with specific keywords
2. VERIFY → Confirm paper exists in 2+ sources
3. RETRIEVE → Get BibTeX via DOI content negotiation
4. VALIDATE → Confirm the claim you're citing actually appears in the paper
5. ADD → Add verified BibTeX to `citations.bib`

If any step fails, mark as `[CITATION NEEDED]` and inform the scientist.

---

## Common Literature Review Pitfalls

| Pitfall | Fix |
|---------|-----|
| Search stops after one round | Run 2-3 rounds minimum; saturation test |
| Related work is a list of summaries | Group by methodology; synthesize, don't list |
| Missing concurrent work | Search arXiv for last 6 months explicitly |
| Citations unverified | Run `scripts/verify_citations.py` before drafting |
| Missing key baselines | Ask: "What would a reviewer ask why we didn't compare against?" |

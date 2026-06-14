# Citation Management & Hallucination Prevention

This reference provides a workflow for managing citations programmatically, preventing AI-generated citation hallucinations, and maintaining clean bibliographies. Load this during literature review and before any drafting that involves citations.

---

## Why Verification Matters

Research has documented significant issues with AI-generated citations:
- **~40% error rate** in AI-generated citations (Enago Academy research)
- Common errors: fabricated titles with real author names, wrong venues, non-existent papers, incorrect DOIs

**Consequences**: desk rejection, loss of credibility, potential retraction, wasted time.

**Rule**: Never generate citations from memory. Always verify programmatically.

---

## Citation APIs

| API | Coverage | Rate Limits | Best For |
|-----|----------|-------------|----------|
| **Semantic Scholar** | 214M papers | 1 RPS (free key) | ML/AI papers, citation graphs |
| **CrossRef** | 140M+ DOIs | Polite pool with mailto | DOI lookup, BibTeX retrieval |
| **arXiv** | Preprints | 3-second delays | ML preprints, PDF access |
| **OpenAlex** | 240M+ works | 100K/day, 10 RPS | Open alternative to MAG |

**No official Google Scholar API.** Scraping violates ToS. Use SerpApi only if Semantic Scholar coverage is insufficient.

**API selection guide:**
- Need ML paper search? → Semantic Scholar
- Have DOI, need BibTeX? → CrossRef content negotiation
- Looking for preprint? → arXiv API
- Need open data, bulk access? → OpenAlex

---

## Verified Citation Workflow

### 5-Step Process

```
1. SEARCH → Query Semantic Scholar with specific keywords
     ↓
2. VERIFY → Confirm paper exists in 2+ sources
     ↓
3. RETRIEVE → Get BibTeX via DOI content negotiation
     ↓
4. VALIDATE → Confirm the claim appears in source
     ↓
5. ADD → Add verified entry to .bib file
```

### Step 1: Search

```python
from semanticscholar import SemanticScholar

sch = SemanticScholar()
results = sch.search_paper("transformer attention mechanism", limit=10)

for paper in results:
    print(f"Title: {paper.title}")
    print(f"Year: {paper.year}")
    print(f"DOI: {paper.externalIds.get('DOI', 'N/A')}")
    print(f"arXiv: {paper.externalIds.get('ArXiv', 'N/A')}")
    print("---")
```

### Step 2: Verify Existence

Confirm in at least two sources:

```python
import requests

def verify_paper(doi=None, arxiv_id=None):
    sources = []
    if doi:
        resp = requests.get(f"https://api.crossref.org/works/{doi}")
        if resp.status_code == 200:
            sources.append("CrossRef")
    if arxiv_id:
        resp = requests.get(f"http://export.arxiv.org/api/query?id_list={arxiv_id}")
        if "<entry>" in resp.text:
            sources.append("arXiv")
    return len(sources) >= 2, sources
```

### Step 3: Retrieve BibTeX

```python
import requests

def doi_to_bibtex(doi: str) -> str:
    response = requests.get(
        f"https://doi.org/{doi}",
        headers={"Accept": "application/x-bibtex"},
        allow_redirects=True
    )
    response.raise_for_status()
    return response.text
```

### Step 4: Validate Claims

Before citing a paper for a specific claim, verify the claim exists in the abstract or relevant section:

```python
def get_paper_abstract(doi):
    sch = SemanticScholar()
    paper = sch.get_paper(f"DOI:{doi}")
    return paper.abstract if paper else None
```

### Step 5: Add to Bibliography

Use consistent citation keys: `author_year_firstword`

```
vaswani_2017_attention
devlin_2019_bert
brown_2020_language
```

---

## BibTeX Management

### BibTeX vs BibLaTeX

| Feature | BibTeX | BibLaTeX |
|---------|--------|----------|
| Unicode support | Limited | Full |
| Entry types | Standard | Extended |
| Backend | bibtex | Biber (recommended) |

**Recommendation for conferences**: Use natbib with BibTeX. All major venue templates ship with natbib and `.bst` files.

### Citation Commands

```latex
\cite{key}       % Numeric: [1]
\citep{key}      % Parenthetical: (Author, 2020)
\citet{key}      % Textual: Author (2020)
\citeauthor{key} % Just author name
\citeyear{key}   % Just year
```

---

## Quick Functions

```python
"""Quick citation utilities."""
import requests, time, re
from typing import Optional, List

try:
    from semanticscholar import SemanticScholar
except ImportError:
    SemanticScholar = None

def quick_cite(query: str) -> Optional[str]:
    """Search and return BibTeX for top result."""
    if not SemanticScholar:
        return None
    sch = SemanticScholar()
    results = sch.search_paper(query, limit=5)
    if not results:
        return None
    paper = results[0]
    if paper.externalIds and paper.externalIds.get('DOI'):
        return doi_to_bibtex(paper.externalIds['DOI'])
    return None

def batch_cite(queries: List[str], output_file: str = "references.bib"):
    """Cite multiple papers and save to file."""
    entries = []
    for query in queries:
        bibtex = quick_cite(query)
        if bibtex:
            entries.append(bibtex)
        time.sleep(1)
    with open(output_file, 'w') as f:
        f.write("\n\n".join(entries))
    print(f"Saved {len(entries)} citations to {output_file}")

def doi_to_bibtex(doi: str) -> str:
    resp = requests.get(
        f"https://doi.org/{doi}",
        headers={"Accept": "application/x-bibtex"},
        allow_redirects=True
    )
    resp.raise_for_status()
    return resp.text

def generate_citation_key(bibtex: str) -> str:
    author = re.search(r'author\s*=\s*\{([^}]+)\}', bibtex, re.I)
    first_author = author.group(1).split(',')[0].split()[-1] if author else "unknown"
    year = re.search(r'year\s*=\s*\{?(\d{4})\}?', bibtex, re.I)
    yr = year.group(1) if year else "0000"
    title = re.search(r'title\s*=\s*\{([^}]+)\}', bibtex, re.I)
    first_word = re.sub(r'[^a-z]', '', title.group(1).split()[0].lower()) if title else "paper"
    return f"{first_author.lower()}_{yr}_{first_word}"
```

---

## Common Citation Formats

**Conference paper:**
```bibtex
@inproceedings{vaswani_2017_attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and ...},
  booktitle = {Advances in Neural Information Processing Systems},
  volume = {30},
  year = {2017}
}
```

**Journal article:**
```bibtex
@article{hochreiter_1997_long,
  title = {Long Short-Term Memory},
  author = {Hochreiter, Sepp and Schmidhuber, J{\"u}rgen},
  journal = {Neural Computation},
  volume = {9},
  number = {8},
  pages = {1735--1780},
  year = {1997}
}
```

**arXiv preprint:**
```bibtex
@misc{brown_2020_language,
  title = {Language Models are Few-Shot Learners},
  author = {Brown, Tom B and ...},
  year = {2020},
  eprint = {2005.14165},
  archivePrefix = {arXiv}
}
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| DOI returns HTML | Missing Accept header | Add `Accept: application/x-bibtex` |
| Semantic Scholar returns nothing | Rate limit | Wait 1 second, retry |
| BibTeX has Unicode issues | BibTeX backend | Use BibLaTeX/Biber, or escape characters |
| Can't verify a citation | Paper too new / obscure | Mark `[CITATION NEEDED]`, inform user |

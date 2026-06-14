---
{
  "name": "pdf-extraction",
  "description": "Extract text, tables, metadata, images, Markdown, and OCR-ready content from PDFs, scans, and document images using managed Python extractors.",
  "version": "2.3.0",
  "category": "documents",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "document.ocr",
      "pdf.extraction"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "pdf extraction"
      },
      {
        "type": "contains",
        "value": "extract text from pdf"
      },
      {
        "type": "contains",
        "value": "ocr"
      },
      {
        "type": "contains",
        "value": "scanned pdf"
      },
      {
        "type": "attachment-kind",
        "value": "document"
      }
    ],
    "requiredToolsets": [
      "files"
    ],
    "confirmation": "policy"
  },
  "requiredToolsets": [
    "files"
  ],
  "optionalToolsets": [
    "web",
    "shell-readonly",
    "shell-write",
    "research"
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write",
    "ask-before-credential-access"
  ],
  "playbook": [
    {
      "id": "classify-document",
      "description": "Determine whether the input is URL, local text PDF, scanned PDF, image, DOCX, or PPTX.",
      "toolsets": [
        "core",
        "files"
      ]
    },
    {
      "id": "extract-locally-or-remotely",
      "description": "Use URL extraction for URLs when available; otherwise use approved local Python extractor scripts.",
      "toolsets": [
        "files",
        "web"
      ],
      "fallbackTo": [
        "shell-readonly"
      ]
    },
    {
      "id": "write-structured-output",
      "description": "Return or save text, Markdown, tables, images, and metadata in the requested format.",
      "toolsets": [
        "files"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Extract text and tables from this scanned PDF.",
      "shouldUseToolsets": [
        "files"
      ],
      "shouldNotAskUserFirst": false
    }
  ],
  "pythonCapabilities": [
    {
      "id": "pdf-extraction",
      "required": true,
      "groups": []
    },
    {
      "id": "pdf-extraction",
      "required": false,
      "groups": [
        "tables"
      ]
    },
    {
      "id": "pdf-extraction",
      "required": false,
      "groups": [
        "advancedOcr"
      ]
    }
  ]
}
---

# PDF Extraction

For DOCX: use `python-docx` (parses actual document structure, far better than OCR).
For PPTX: see the `powerpoint` skill (uses `python-pptx` with full slide/notes support).
This skill covers **PDFs and scanned documents**.

## Step 1: Remote URL Available?

If the document has a URL, try URL extraction first when the web tool is available:

```
web.extract(urls=["https://arxiv.org/pdf/2402.03300"])
web.extract(urls=["https://example.com/report.pdf"])
```

URL extraction may return useful text or Markdown without local dependencies, but PDF/OCR support depends on the active extraction backend.

Use local extraction when: the file is local, URL extraction fails, OCR is required, or you need batch processing.

## Step 2: Choose Local Extractor

| Feature | pymupdf (~25MB) | marker-pdf (~3-5GB) |
|---------|-----------------|---------------------|
| **Text-based PDF** | ✅ | ✅ |
| **Scanned PDF (OCR)** | ❌ | ✅ (90+ languages) |
| **Tables** | ✅ (basic) | ✅ (high accuracy) |
| **Equations / LaTeX** | ❌ | ✅ |
| **Code blocks** | ❌ | ✅ |
| **Forms** | ❌ | ✅ |
| **Headers/footers removal** | ❌ | ✅ |
| **Reading order detection** | ❌ | ✅ |
| **Images extraction** | ✅ (embedded) | ✅ (with context) |
| **Images → text (OCR)** | ❌ | ✅ |
| **EPUB** | ✅ | ✅ |
| **Markdown output** | ✅ (via pymupdf4llm) | ✅ (native, higher quality) |
| **Install size** | ~25MB | ~3-5GB (PyTorch + models) |
| **Speed** | Instant | ~1-14s/page (CPU), ~0.2s/page (GPU) |

**Decision**: Use pymupdf unless you need OCR, equations, forms, or complex layout analysis.

If the user needs marker capabilities but the system lacks ~5GB free disk:
> "This document needs OCR/advanced extraction (marker-pdf), which requires ~5GB for PyTorch and models. Your system has [X]GB free. Options: free up space, provide a URL so I can use web.extract, or I can try pymupdf which works for text-based PDFs but not scanned documents or equations."

---

## pymupdf (lightweight)

**Managed environment:** this skill requires the EstaCoda `pdf-extraction` Python capability. If the skill is visible, the base environment is already installed and verified. To run local scripts, use the Python path from:

```bash
estacoda python-env status pdf-extraction
```

Do not use system `python`, global `pip`, or ad hoc virtualenvs. If status says setup or upgrade is required, ask before running the reported `estacoda python-env setup/upgrade pdf-extraction` command. Use `${skill_dir}` as the base path for bundled scripts.

**Via helper script**:
```bash
"<Python path from status>" "${skill_dir}/scripts/extract_pymupdf.py" document.pdf              # Plain text
"<Python path from status>" "${skill_dir}/scripts/extract_pymupdf.py" document.pdf --markdown    # Markdown
"<Python path from status>" "${skill_dir}/scripts/extract_pymupdf.py" document.pdf --tables      # Tables
"<Python path from status>" "${skill_dir}/scripts/extract_pymupdf.py" document.pdf --images out/ # Extract images
"<Python path from status>" "${skill_dir}/scripts/extract_pymupdf.py" document.pdf --metadata    # Title, author, pages
"<Python path from status>" "${skill_dir}/scripts/extract_pymupdf.py" document.pdf --pages 0-4   # Specific pages
```

**Inline**, when a quick probe is better than the helper script:
```bash
"<Python path from status>" -c "
import pymupdf
doc = pymupdf.open('document.pdf')
for page in doc:
    print(page.get_text())
"
```

---

## marker-pdf (high-quality OCR)

**Managed optional group:** marker-pdf is available through the optional `advancedOcr` group. Check status first:

```bash
estacoda python-env status pdf-extraction --group advancedOcr
"<Python path from status>" "${skill_dir}/scripts/extract_marker.py" --check
```

If the group is missing, ask before running `estacoda python-env setup pdf-extraction --group advancedOcr`; it has a large install footprint.

**Via helper script**:
```bash
"<Python path from status>" "${skill_dir}/scripts/extract_marker.py" document.pdf                # Markdown
"<Python path from status>" "${skill_dir}/scripts/extract_marker.py" document.pdf --json         # JSON with metadata
"<Python path from status>" "${skill_dir}/scripts/extract_marker.py" document.pdf --output_dir out/  # Save images
"<Python path from status>" "${skill_dir}/scripts/extract_marker.py" scanned.pdf                 # Scanned PDF (OCR)
"<Python path from status>" "${skill_dir}/scripts/extract_marker.py" document.pdf --use_llm      # LLM-boosted accuracy
```

---

## Arxiv Papers

```
# Abstract only (fast)
web.extract(urls=["https://arxiv.org/abs/2402.03300"])

# Full paper
web.extract(urls=["https://arxiv.org/pdf/2402.03300"])

# Search
web.search(query="research-discovery GRPO reinforcement learning 2026")
```

## Split, Merge & Search

pymupdf handles these natively — use `execute_code` or inline Python:

```python
# Split: extract pages 1-5 to a new PDF
import pymupdf
doc = pymupdf.open("report.pdf")
new = pymupdf.open()
for i in range(5):
    new.insert_pdf(doc, from_page=i, to_page=i)
new.save("pages_1-5.pdf")
```

```python
# Merge multiple PDFs
import pymupdf
result = pymupdf.open()
for path in ["a.pdf", "b.pdf", "c.pdf"]:
    result.insert_pdf(pymupdf.open(path))
result.save("merged.pdf")
```

```python
# Search for text across all pages
import pymupdf
doc = pymupdf.open("report.pdf")
for i, page in enumerate(doc):
    results = page.search_for("revenue")
    if results:
        print(f"Page {i+1}: {len(results)} match(es)")
        print(page.get_text("text"))
```

No extra dependencies needed — pymupdf covers split, merge, search, and text extraction in one package.

---

## Notes

- URL extraction is the first attempt for URLs when available, but local OCR/document extraction is required for scans or unsupported PDF extraction
- pymupdf is the safe default — instant, no models, works everywhere
- marker-pdf is for OCR, scanned docs, equations, complex layouts — install only when needed
- Both helper scripts accept `--help` for full usage
- marker-pdf downloads ~2.5GB of models to `~/.cache/huggingface/` on first use
- For Word docs: prefer a managed document capability such as `python-docx`; parse structure rather than OCR when possible
- For PowerPoint: see the `powerpoint` skill (uses python-pptx)

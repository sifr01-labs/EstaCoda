---
{
  "name": "pdf-editor",
  "description": "Edit PDFs through a managed pdf-editor environment with explicit approval, output-copy safety, and verification.",
  "version": "1.0.0",
  "category": "documents",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "pdf.editing",
      "document.edit"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "pdf editor"
      },
      {
        "type": "contains",
        "value": "edit this pdf"
      },
      {
        "type": "contains",
        "value": "modify this pdf"
      },
      {
        "type": "contains",
        "value": "pdf-editor"
      }
    ],
    "requiredToolsets": [
      "files"
    ],
    "confirmation": "ask"
  },
  "requiredToolsets": [
    "files"
  ],
  "optionalToolsets": [
    "shell-readonly",
    "shell-write"
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write",
    "ask-before-credential-access",
    "ask-before-destructive-action"
  ],
  "playbook": [
    {
      "id": "inspect-pdf-request",
      "description": "Identify target PDF, pages, intended edit, and output-copy path.",
      "toolsets": [
        "core",
        "files"
      ]
    },
    {
      "id": "perform-approved-edit",
      "description": "Use pdf-editor only when installed and explicitly approved; never silently mutate the original.",
      "toolsets": [
        "shell-write"
      ]
    },
    {
      "id": "verify-output",
      "description": "Check page count and render or inspect output before delivery.",
      "toolsets": [
        "shell-readonly",
        "files"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Use pdf-editor to replace text on page 2.",
      "shouldUseToolsets": [
        "files"
      ],
      "shouldNotAskUserFirst": false
    }
  ],
  "pythonCapabilities": [
    {
      "id": "pdf-editor",
      "required": true,
      "groups": []
    }
  ]
}
---

# PDF Editor

Edit PDFs using natural-language instructions. Point it at a page and describe what to change.

## Managed Environment

This skill requires the EstaCoda `pdf-editor` Python capability. If the skill is visible, the managed environment is already installed and verified. Before running an edit, get the managed Python path:

```bash
estacoda python-env status pdf-editor
```

Do not use global `pip`, system `python`, or a user virtualenv. If status says setup or upgrade is required, ask before running the reported `estacoda python-env setup/upgrade pdf-editor` command. Use `${skill_dir}` as the base path for the bundled wrapper.

## Usage

Use the bundled wrapper so the managed Python environment invokes nano-pdf consistently across platforms:

```bash
"<Python path from status>" "${skill_dir}/scripts/run_nano_pdf.py" edit <file.pdf> <page_number> "<instruction>"
```

## Examples

```bash
# Change a title on page 1
"<Python path from status>" "${skill_dir}/scripts/run_nano_pdf.py" edit deck.pdf 1 "Change the title to 'Q3 Results' and fix the typo in the subtitle"

# Update a date on a specific page
"<Python path from status>" "${skill_dir}/scripts/run_nano_pdf.py" edit report.pdf 3 "Update the date from January to February 2026"

# Fix content
"<Python path from status>" "${skill_dir}/scripts/run_nano_pdf.py" edit contract.pdf 2 "Change the client name from 'Acme Corp' to 'Acme Industries'"
```

## Notes

- Page numbers may be 0-based or 1-based depending on version — if the edit hits the wrong page, retry with ±1
- Always verify the output PDF after editing (use `file.read` to check file size, or open it)
- The tool may use an LLM under the hood; ask before using credentials or external model calls
- Works well for text changes; complex layout modifications may need a different approach

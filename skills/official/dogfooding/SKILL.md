---
{
  "name": "dogfooding",
  "description": "Run exploratory QA on web apps with Browser inspection, screenshots, console checks, and structured bug reports.",
  "version": "1.0.0",
  "category": "testing",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "qa.exploratory",
      "browser.testing",
      "dogfooding"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "dogfooding"
      },
      {
        "type": "contains",
        "value": "dogfooding"
      },
      {
        "type": "contains",
        "value": "exploratory QA"
      },
      {
        "type": "contains",
        "value": "test this website"
      },
      {
        "type": "contains",
        "value": "find bugs in this app"
      }
    ],
    "requiredToolsets": [
      "browser"
    ],
    "confirmation": "policy"
  },
  "requiredToolsets": [
    "browser",
    "files"
  ],
  "optionalToolsets": [
    "web",
    "media"
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write"
  ],
  "playbook": [
    {
      "id": "plan-scope",
      "description": "Define test scope, flows, output directory, and evidence format.",
      "toolsets": [
        "core",
        "files"
      ]
    },
    {
      "id": "explore-browser",
      "description": "Navigate, inspect DOM snapshots, interact with flows, and check console errors.",
      "toolsets": [
        "browser"
      ]
    },
    {
      "id": "capture-evidence",
      "description": "Save screenshots for reproducible findings.",
      "toolsets": [
        "browser",
        "files"
      ]
    },
    {
      "id": "write-report",
      "description": "Produce a concise report sorted by severity with reproduction steps.",
      "toolsets": [
        "files"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Dogfooding http://localhost:3000 and report the top issues.",
      "shouldUseToolsets": [
        "browser",
        "files"
      ]
    }
  ]
}
---

# Dogfooding

## Overview

This skill guides you through systematic exploratory QA testing of web applications using the browser toolset. You will navigate the application, interact with elements, capture evidence of issues, and produce a structured bug report.

## Prerequisites

- Browser toolset must be available (`browser.navigate`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.vision`, `browser.console`, `browser.scroll`, `browser.back`, `browser.press`)
- A target URL and testing scope from the user

## Inputs

The user provides:
1. **Target URL** — the entry point for testing
2. **Scope** — what areas/features to focus on (or "full site" for comprehensive testing)
3. **Output directory** (optional) — where to save screenshots and the report (default: `./dogfooding-output`)

## Workflow

Follow this 5-phase systematic workflow:

### Phase 1: Plan

1. Create the output directory structure:
   ```
   {output_dir}/
   ├── screenshots/       # Evidence screenshots
   └── report.md          # Final report (generated in Phase 5)
   ```
2. Identify the testing scope based on user input.
3. Build a rough sitemap by planning which pages and features to test:
   - Landing/home page
   - Navigation links (header, footer, sidebar)
   - Key user flows (sign up, login, search, checkout, etc.)
   - Forms and interactive elements
   - Edge cases (empty states, error pages, 404s)

### Phase 2: Explore

For each page or feature in your plan:

1. **Navigate** to the page:
   ```
   browser.navigate(url="https://example.com/page")
   ```

2. **Take a snapshot** to understand the DOM structure:
   ```
   browser.snapshot()
   ```

3. **Check the console** for JavaScript errors:
   ```
   browser.console(clear=true)
   ```
   Do this after every navigation and after every significant interaction. Silent JS errors are high-value findings.

4. **Take an annotated screenshot** to visually assess the page and identify interactive elements:
   ```
   browser.screenshot(path="{output_dir}/screenshots/page-name.png")
   browser.vision(question="Describe the page layout, identify any visual issues, broken elements, or accessibility concerns")
   ```
   Use `browser.snapshot()` refs such as `@eN` for subsequent browser commands; screenshots are evidence, and `browser.vision` is for analysis.

5. **Test interactive elements** systematically:
   - Click buttons and links: `browser.click(ref="@eN")`
   - Fill forms: `browser.type(ref="@eN", text="test input")`
   - Test keyboard navigation: `browser.press(key="Tab")`, `browser.press(key="Enter")`
   - Scroll through content: `browser.scroll(direction="down")`
   - Test form validation with invalid inputs
   - Test empty submissions

6. **After each interaction**, check for:
   - Console errors: `browser.console()`
   - Visual changes: `browser.vision(question="What changed after the interaction?")`
   - Expected vs actual behavior

### Phase 3: Collect Evidence

For every issue found:

1. **Take a screenshot** showing the issue:
   ```
   browser.screenshot(path="{output_dir}/screenshots/issue-N.png")
   browser.vision(question="Describe the issue visible on this page")
   ```
   Reference the screenshot path you provided to `browser.screenshot` in the report.

2. **Record the details**:
   - URL where the issue occurs
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Console errors (if any)
   - Screenshot path

3. **Classify the issue** using the issue taxonomy (see `references/issue-taxonomy.md`):
   - Severity: Critical / High / Medium / Low
   - Category: Functional / Visual / Accessibility / Console / UX / Content

### Phase 4: Categorize

1. Review all collected issues.
2. De-duplicate — merge issues that are the same bug manifesting in different places.
3. Assign final severity and category to each issue.
4. Sort by severity (Critical first, then High, Medium, Low).
5. Count issues by severity and category for the executive summary.

### Phase 5: Report

Generate the final report using the template at `templates/dogfooding-report-template.md`.

The report must include:
1. **Executive summary** with total issue count, breakdown by severity, and testing scope
2. **Per-issue sections** with:
   - Issue number and title
   - Severity and category badges
   - URL where observed
   - Description of the issue
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshot references using the saved workspace path or Markdown image syntax
   - Console errors if relevant
3. **Summary table** of all issues
4. **Testing notes** — what was tested, what was not, any blockers

Save the report to `{output_dir}/report.md`.

## Tools Reference

| Tool | Purpose |
|------|---------|
| `browser.navigate` | Go to a URL |
| `browser.snapshot` | Get DOM text snapshot (accessibility tree) |
| `browser.click` | Click an element by ref (`@eN`) or text |
| `browser.type` | Type into an input field |
| `browser.scroll` | Scroll up/down on the page |
| `browser.back` | Go back in browser history |
| `browser.press` | Press a keyboard key |
| `browser.vision` | Visual analysis of the current page or saved screenshot |
| `browser.console` | Get JS console output and errors |

## Tips

- **Always check `browser.console()` after navigating and after significant interactions.** Silent JS errors are among the most valuable findings.
- **Use `browser.snapshot()` refs** for interactions. Use `browser.vision` for visual analysis when the DOM snapshot is not enough.
- **Test with both valid and invalid inputs** — form validation bugs are common.
- **Scroll through long pages** — content below the fold may have rendering issues.
- **Test navigation flows** — click through multi-step processes end-to-end.
- **Check responsive behavior** by noting any layout issues visible in screenshots.
- **Don't forget edge cases**: empty states, very long text, special characters, rapid clicking.
- When reporting screenshots to the user, include the saved workspace path or a Markdown image reference so they can see the evidence inline.

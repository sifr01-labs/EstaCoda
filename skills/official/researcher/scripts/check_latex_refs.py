#!/usr/bin/env python3
"""Lint LaTeX for broken references, missing figures, unbalanced math, and duplicate labels."""

import argparse
import os
import re
import sys
from collections import Counter


def check_unbalanced_math(text: str) -> list:
    issues = []
    # Simple check: count $ outside of \$ and \( \)
    # This is heuristic, not a full LaTeX parser
    cleaned = re.sub(r"\\\$", "", text)
    cleaned = re.sub(r"\\[()\[\]]", "", cleaned)
    single_dollars = cleaned.count("$")
    if single_dollars % 2 != 0:
        issues.append(f"Unbalanced $: {single_dollars} occurrences (expected even)")
    return issues


def check_broken_references(text: str) -> list:
    issues = []
    refs = re.findall(r"\\ref\{([^}]+)\}", text)
    labels = re.findall(r"\\label\{([^}]+)\}", text)
    missing = set(refs) - set(labels)
    for r in missing:
        issues.append(f"\\ref{{{r}}} has no matching \\label")
    return issues


def check_missing_figures(text: str, tex_dir: str) -> list:
    issues = []
    figs = re.findall(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}", text)
    for fig in figs:
        # Try common extensions
        found = any(
            os.path.exists(os.path.join(tex_dir, f"{fig}{ext}"))
            for ext in [".pdf", ".png", ".jpg", ".jpeg", ".eps", ""]
        )
        if not found:
            issues.append(f"Figure file not found: {fig}")
    return issues


def check_duplicate_labels(text: str) -> list:
    issues = []
    labels = re.findall(r"\\label\{([^}]+)\}", text)
    dupes = {k: v for k, v in Counter(labels).items() if v > 1}
    for label, count in dupes.items():
        issues.append(f"Duplicate label: \\label{{{label}}} appears {count} times")
    return issues


def check_fabricated_citations(text: str, bib_text: str = "") -> list:
    issues = []
    if not bib_text:
        return issues
    cites = re.findall(r"\\cite(?:t|p)?\{([^}]+)\}", text)
    for group in cites:
        for key in group.split(","):
            key = key.strip()
            if key and key not in bib_text:
                issues.append(f"Citation not in .bib: \\cite{{{key}}}")
    return issues


def check_html_contamination(text: str) -> list:
    issues = []
    # Look for common HTML tag patterns in LaTeX
    html_patterns = re.findall(r"</[^>]+>", text)
    for tag in html_patterns:
        issues.append(f"Possible HTML contamination: {tag}")
    return issues


def check_unescaped_underscores(text: str) -> list:
    issues = []
    # Find underscores outside math mode and commands
    # Heuristic: look for _ not preceded by \ and not inside $...$
    lines = text.splitlines()
    for i, line in enumerate(lines, 1):
        # Skip lines that are obviously math or commands
        if line.strip().startswith("%"):
            continue
        # Very heuristic: count bare underscores
        bare = re.findall(r"(?<!\\)_", line)
        if bare:
            # Check if line has balanced $ (suggesting math mode)
            if line.count("$") % 2 == 0 and line.count("$") > 0:
                continue
            # Otherwise flag conservatively
            # issues.append(f"Line {i}: possible unescaped underscore")
            pass
    return issues


def main():
    parser = argparse.ArgumentParser(description="Lint LaTeX for common errors")
    parser.add_argument("tex_file", help="Path to .tex file")
    parser.add_argument("--bib", help="Optional .bib file to check citations against")
    args = parser.parse_args()

    tex_dir = os.path.dirname(os.path.abspath(args.tex_file)) or "."
    with open(args.tex_file, "r") as f:
        text = f.read()

    bib_text = ""
    if args.bib and os.path.exists(args.bib):
        with open(args.bib, "r") as f:
            bib_text = f.read()

    all_issues = []
    all_issues.append(("Unbalanced math", check_unbalanced_math(text)))
    all_issues.append(("Broken references", check_broken_references(text)))
    all_issues.append(("Missing figures", check_missing_figures(text, tex_dir)))
    all_issues.append(("Duplicate labels", check_duplicate_labels(text)))
    all_issues.append(("Fabricated citations", check_fabricated_citations(text, bib_text)))
    all_issues.append(("HTML contamination", check_html_contamination(text)))

    total = 0
    for category, issues in all_issues:
        if issues:
            print(f"\n{category}:")
            for issue in issues:
                print(f"  - {issue}")
            total += len(issues)

    if total == 0:
        print("No issues found.")
        sys.exit(0)
    else:
        print(f"\n{total} issue(s) found.")
        sys.exit(1)


if __name__ == "__main__":
    main()

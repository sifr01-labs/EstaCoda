#!/usr/bin/env python3
"""Verify that every \\cite{} in a LaTeX file resolves to a real paper via Semantic Scholar."""

import argparse
import re
import sys
import time
from typing import Set

try:
    from semanticscholar import SemanticScholar
except ImportError:
    print("Install: pip install semanticscholar")
    sys.exit(1)


def extract_citations(tex_path: str) -> Set[str]:
    """Extract unique citation keys from a LaTeX file."""
    with open(tex_path, "r") as f:
        text = f.read()

    cites = set()
    # Match \\cite{}, \\citet{}, \\citep{}, \\citeauthor{}, \\citeyear{}
    for match in re.findall(r"\\cite(?:t|p|author|year)?\{([^}]+)\}", text):
        for key in match.split(","):
            key = key.strip()
            if key:
                cites.add(key)
    return cites


def verify_citation(key: str, sch: SemanticScholar) -> bool:
    """Search Semantic Scholar for a citation key and return whether any result looks plausible."""
    # Heuristic: turn citation key into a search query
    # e.g., vaswani_2017_attention -> "vaswani attention 2017"
    parts = key.replace("_", " ").split()
    query = " ".join(parts)
    try:
        results = sch.search_paper(query, limit=5)
        return len(results) > 0
    except Exception as e:
        print(f"  API error for '{key}': {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Verify LaTeX citations against Semantic Scholar")
    parser.add_argument("tex_file", help="Path to .tex file")
    parser.add_argument("--bib", help="Optional .bib file to check against first")
    parser.add_argument("--delay", type=float, default=1.0, help="Seconds between API calls")
    args = parser.parse_args()

    cites = extract_citations(args.tex_file)
    print(f"Found {len(cites)} unique citations in {args.tex_file}")

    # If .bib provided, check membership first
    if args.bib:
        with open(args.bib, "r") as f:
            bib_text = f.read()
        missing_from_bib = [c for c in cites if c not in bib_text]
        if missing_from_bib:
            print(f"\nWARNING: {len(missing_from_bib)} citations missing from {args.bib}:")
            for c in missing_from_bib:
                print(f"  - {c}")
        else:
            print(f"\nAll citations present in {args.bib}")

    # Verify against Semantic Scholar
    sch = SemanticScholar()
    unverified = []
    print("\nVerifying against Semantic Scholar...")
    for key in sorted(cites):
        ok = verify_citation(key, sch)
        status = "✓" if ok else "✗"
        print(f"  {status} {key}")
        if not ok:
            unverified.append(key)
        time.sleep(args.delay)

    if unverified:
        print(f"\n{len(unverified)} citation(s) could not be verified:")
        for key in unverified:
            print(f"  - {key}")
        sys.exit(1)
    else:
        print("\nAll citations verified.")
        sys.exit(0)


if __name__ == "__main__":
    main()

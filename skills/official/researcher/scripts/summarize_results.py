#!/usr/bin/env python3
"""Aggregate experiment results into summary tables and compute statistics."""

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def load_results(results_dir: str):
    """Recursively load all result.json files."""
    data = {}
    for path in Path(results_dir).rglob("result.json"):
        # Heuristic path parsing: results_dir / exp / task / strategy / result.json
        rel = path.relative_to(results_dir)
        parts = rel.parts
        if len(parts) >= 3:
            exp, task, strategy = parts[0], parts[1], parts[2]
        elif len(parts) == 2:
            exp, task, strategy = parts[0], "default", parts[1]
        else:
            exp, task, strategy = "default", "default", parts[0]

        entry = json.loads(path.read_text())
        data.setdefault(exp, {}).setdefault(strategy, {})[task] = entry
    return data


def summarize(data: dict, metric_key: str = "score"):
    """Print summary tables per experiment."""
    for exp, strategies in sorted(data.items()):
        print(f"\n## Experiment: {exp}")
        print(f"{'Strategy':<20} {'N':>5} {'Mean':>10} {'Std':>10} {'Min':>10} {'Max':>10}")
        print("-" * 65)
        for strategy, tasks in sorted(strategies.items()):
            values = []
            for task, entry in tasks.items():
                val = entry.get(metric_key)
                if val is None:
                    # Try common aliases
                    for alias in ("accuracy", "f1", "score", "value", "result", "metric"):
                        if alias in entry:
                            val = entry[alias]
                            break
                if val is not None:
                    try:
                        values.append(float(val))
                    except (TypeError, ValueError):
                        pass
            if values:
                arr = np.array(values)
                print(f"{strategy:<20} {len(arr):>5} {arr.mean():>10.3f} {arr.std():>10.3f} {arr.min():>10.3f} {arr.max():>10.3f}")
            else:
                print(f"{strategy:<20} {'-':>5} {'-':>10} {'-':>10} {'-':>10} {'-':>10}")


def pairwise_comparison(data: dict, baseline: str, metric_key: str = "score"):
    """Print pairwise win/tie/loss vs a baseline strategy."""
    for exp, strategies in sorted(data.items()):
        if baseline not in strategies:
            continue
        print(f"\n## Pairwise vs {baseline} in {exp}")
        baseline_tasks = strategies[baseline]
        for strategy, tasks in sorted(strategies.items()):
            if strategy == baseline:
                continue
            wins = ties = losses = 0
            for task, entry in tasks.items():
                if task not in baseline_tasks:
                    continue
                val = entry.get(metric_key)
                base_val = baseline_tasks[task].get(metric_key)
                if val is None or base_val is None:
                    continue
                try:
                    val, base_val = float(val), float(base_val)
                except (TypeError, ValueError):
                    continue
                if val > base_val:
                    wins += 1
                elif val < base_val:
                    losses += 1
                else:
                    ties += 1
            total = wins + ties + losses
            if total > 0:
                print(f"  {strategy}: {wins}W / {ties}T / {losses}L (n={total})")


def main():
    parser = argparse.ArgumentParser(description="Summarize experiment results")
    parser.add_argument("results_dir", help="Directory containing result.json files")
    parser.add_argument("--metric", default="score", help="Metric key to aggregate")
    parser.add_argument("--baseline", help="Baseline strategy name for pairwise comparison")
    args = parser.parse_args()

    if not Path(args.results_dir).exists():
        print(f"Directory not found: {args.results_dir}")
        sys.exit(1)

    data = load_results(args.results_dir)
    if not data:
        print(f"No result.json files found under {args.results_dir}")
        sys.exit(1)

    summarize(data, args.metric)
    if args.baseline:
        pairwise_comparison(data, args.baseline, args.metric)


if __name__ == "__main__":
    main()

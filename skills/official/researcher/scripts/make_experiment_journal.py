#!/usr/bin/env python3
"""Generate an experiment-log.md from a directory of result files."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path


def discover_experiments(results_dir: str):
    """Walk results_dir and group result.json files by experiment."""
    experiments = {}
    for path in Path(results_dir).rglob("result.json"):
        rel = path.relative_to(results_dir)
        parts = rel.parts
        if len(parts) >= 3:
            exp, task, strategy = parts[0], parts[1], parts[2]
        elif len(parts) == 2:
            exp, task, strategy = parts[0], "default", parts[1]
        else:
            exp, task, strategy = "default", "default", parts[0]

        entry = json.loads(path.read_text())
        exp_data = experiments.setdefault(exp, {"tasks": {}})
        exp_data["tasks"].setdefault(strategy, {})[task] = {
            "path": str(path),
            "result": entry,
        }
    return experiments


def extract_key_metrics(result: dict) -> dict:
    """Heuristic extraction of common metric keys."""
    metrics = {}
    for key in ("score", "accuracy", "f1", "win_rate", "metric", "value", "result"):
        if key in result:
            try:
                metrics[key] = float(result[key])
            except (TypeError, ValueError):
                metrics[key] = result[key]
    return metrics


def generate_markdown(experiments: dict, contribution: str = "") -> str:
    lines = ["# Experiment Log\n"]
    lines.append("## Contribution (one sentence)\n")
    lines.append(contribution or "[The paper's main claim]\n")
    lines.append("## Experiments Run\n")

    for exp_name in sorted(experiments):
        exp = experiments[exp_name]
        lines.append(f"### Experiment: {exp_name}\n")
        lines.append(f"- **Claim tested**: [Which paper claim this supports]\n")
        lines.append(f"- **Setup**: [Model, dataset, config, number of runs]\n")

        # Aggregate metrics across strategies
        all_metrics = {}
        for strategy, tasks in exp["tasks"].items():
            strategy_metrics = []
            for task, info in tasks.items():
                m = extract_key_metrics(info["result"])
                if m:
                    strategy_metrics.append(m)
            if strategy_metrics:
                # Simple mean for numeric metrics
                numeric = {}
                for m in strategy_metrics:
                    for k, v in m.items():
                        if isinstance(v, (int, float)):
                            numeric.setdefault(k, []).append(v)
                all_metrics[strategy] = {
                    k: sum(vs) / len(vs) for k, vs in numeric.items()
                }

        if all_metrics:
            lines.append("- **Key results**:\n")
            for strategy, metrics in sorted(all_metrics.items()):
                metric_str = ", ".join(f"{k}={v:.3f}" for k, v in metrics.items())
                lines.append(f"  - {strategy}: {metric_str}\n")
        else:
            lines.append("- **Key result**: [One sentence with the number]\n")

        lines.append(f"- **Result files**: `results/{exp_name}/`\n")
        lines.append("- **Figures generated**: [List generated figures]\n")
        lines.append("- **Surprising findings**: [Anything unexpected]\n")

    lines.append("## Failed Experiments\n")
    lines.append("- [What was tried, why it failed, what it tells us]\n")
    lines.append("## Open Questions\n")
    lines.append("- [Anything the results raised that the paper should address]\n")
    return "".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate experiment-log.md from results")
    parser.add_argument("results_dir", help="Directory containing result.json files")
    parser.add_argument("--output", default="experiment-log.md", help="Output markdown file")
    parser.add_argument("--contribution", default="", help="One-sentence contribution")
    args = parser.parse_args()

    if not Path(args.results_dir).exists():
        print(f"Directory not found: {args.results_dir}")
        sys.exit(1)

    experiments = discover_experiments(args.results_dir)
    if not experiments:
        print(f"No result.json files found under {args.results_dir}")
        sys.exit(1)

    markdown = generate_markdown(experiments, args.contribution)
    with open(args.output, "w") as f:
        f.write(markdown)
    print(f"Wrote {args.output} with {len(experiments)} experiment(s).")


if __name__ == "__main__":
    main()

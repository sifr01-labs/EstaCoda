"""Provider-free operator preflight and phase-aware Harbor result inspection.

Uses the caller's exact Docker environment/configuration. Never disables egress
policy, edits benchmark tasks, or includes exception bodies (which can contain
encoded instructions/credentials) in the diagnostic report.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path


def inspect_trial(path: Path) -> dict:
    result = json.loads((path / "result.json").read_text())
    verifier = result.get("verifier_result") or {}
    rewards = verifier.get("rewards")
    phases = []
    exception = result.get("exception_info") or {}
    kind = exception.get("exception_type", "")
    if isinstance(kind, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,100}", kind):
        phases.append({"phase": "trial", "code": kind})
    # Harbor can preserve the first exception while logging a later verifier
    # failure. Keep both; absence of a reward is not a zero score.
    log_path = path / "trial.log"
    log = log_path.read_text(errors="replace") if log_path.exists() else ""
    signatures = [
        ("verifier_setup", "egress-sidecar-build-failed", r"Failed to build Docker image[^\n]*egress-control-sidecar"),
        ("verifier_setup", "docker-buildx-unavailable", r"unknown flag: --file|unknown command: docker buildx"),
        ("cleanup", "compose-sidecar-image-unresolved", r'has neither an image nor a build context specified'),
    ]
    for phase, code, pattern in signatures:
        match = re.search(pattern, log)
        if match:
            phases.append({"phase": phase, "code": code, "logLine": log[:match.start()].count("\n") + 1})
    summary_paths = sorted(path.glob("artifacts/logs/artifacts/estacoda/attempt-*/summary.json"))
    agent = None
    if summary_paths:
        summary = json.loads(summary_paths[-1].read_text())
        status = summary.get("execution", {}).get("status")
        if isinstance(status, str) and re.fullmatch(r"[a-z_]{1,40}", status):
            agent = status
            if status != "success":
                phases.insert(0, {"phase": "agent", "code": status})
    safe_rewards = {k: v for k, v in (rewards or {}).items()
                    if isinstance(k, str) and re.fullmatch(r"[a-zA-Z0-9_]{1,40}", k)
                    and isinstance(v, (int, float)) and not isinstance(v, bool)} if isinstance(rewards, dict) else None
    return {"trial": path.name, "agentStatus": agent,
            "grading": "graded" if safe_rewards else "ungraded",
            "rewards": safe_rewards or None, "failures": phases}


def preflight() -> dict:
    checks = []
    for name, command in [
        ("harbor", ["harbor", "--version"]),
        ("docker-buildx", ["docker", "buildx", "version"]),
        ("docker-compose", ["docker", "compose", "version"]),
        ("docker-daemon", ["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"]),
    ]:
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
            checks.append({"check": name, "ok": result.returncode == 0, "exitCode": result.returncode})
        except (OSError, subprocess.TimeoutExpired):
            checks.append({"check": name, "ok": False})
    return {"prerequisitesPassed": all(c["ok"] for c in checks), "checks": checks,
            "separateVerifierValidated": False}


def verifier_probe(output: Path, image: str) -> dict:
    """Explicit local oracle fixture: no model, dataset edits, or task answers."""
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,250}", image):
        raise ValueError("Invalid Docker image reference")
    task = output / "verifier-probe"
    task.mkdir(parents=True, exist_ok=False)
    for folder in ["environment", "solution", "tests"]:
        (task / folder).mkdir()
    (task / "instruction.md").write_text("Write the word ready to /app/operator-probe.txt.\n")
    (task / "environment/Dockerfile").write_text(f"FROM {image}\nWORKDIR /app\n")
    (task / "solution/solve.sh").write_text("#!/bin/sh\nset -eu\nmkdir -p /app\nprintf ready > /app/operator-probe.txt\n")
    (task / "tests/test.sh").write_text("#!/bin/sh\nset -eu\nmkdir -p /logs/verifier\nif [ \"$(cat /app/operator-probe.txt)\" = ready ]; then printf 1 > /logs/verifier/reward.txt; else printf 0 > /logs/verifier/reward.txt; fi\n")
    (task / "task.toml").write_text(f'''schema_version = "1.0"
artifacts = ["/app/operator-probe.txt"]
[task]
name = "estacoda/operator-probe"
description = "Separate verifier artifact-transfer probe"
[agent]
timeout_sec = 60
[environment]
build_timeout_sec = 120
docker_image = "{image}"
cpus = 1
memory_mb = 512
storage_mb = 1024
[verifier]
environment_mode = "separate"
timeout_sec = 60
[verifier.environment]
build_timeout_sec = 120
# Inherit the agent image so Harbor uploads tests/test.sh. An explicit
# verifier docker_image means the image already bundles its tests.
cpus = 1
memory_mb = 512
storage_mb = 1024
allow_internet = false
''')
    command = ["harbor", "run", "--path", str(task), "--agent", "oracle", "--jobs-dir", str(output / "jobs"), "--job-name", "operator-probe", "-n", "1", "-k", "1", "-r", "0"]
    # Keep native Harbor logs for diagnosis, but never copy raw errors into JSON.
    with (output / "harbor-probe.log").open("w") as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    trials = [inspect_trial(p.parent) for p in (output / "jobs").glob("*/*/result.json")]
    return {"exitCode": result.returncode, "trials": trials,
            "separateVerifierValidated": result.returncode == 0 and len(trials) == 1 and
            trials[0]["rewards"] == {"reward": 1.0} and not trials[0]["failures"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["preflight", "inspect"])
    parser.add_argument("--jobs", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--probe-image", help="Explicit image with bash/sh for a provider-free separate-verifier trial")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.mode == "inspect":
        if args.jobs is None:
            parser.error("inspect requires --jobs")
        report = {"trials": [inspect_trial(p.parent) for p in sorted(args.jobs.glob("*/*/result.json"))]}
        ok = True
    else:
        report = preflight()
        if report["prerequisitesPassed"] and args.probe_image:
            report["probe"] = verifier_probe(args.out.resolve(), args.probe_image)
            report["separateVerifierValidated"] = report["probe"]["separateVerifierValidated"]
        ok = report["prerequisitesPassed"] and report["separateVerifierValidated"]
    (args.out / "operator-check.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report, indent=2, allow_nan=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

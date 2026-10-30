import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from benchmarks.terminal_bench.operator_check import inspect_trial, preflight, verifier_probe


class OperatorCheckTest(unittest.TestCase):
    def test_retains_agent_and_later_verifier_failure_without_raw_error_bodies(self):
        with tempfile.TemporaryDirectory() as tmp:
            trial = Path(tmp)
            (trial / "result.json").write_text(json.dumps({"exception_info": {"exception_type": "NonZeroAgentExitCodeError", "exception_message": "PRIVATE"}, "verifier_result": None}))
            (trial / "trial.log").write_text("PRIVATE\nFailed to build Docker image harbor-egress-control-sidecar: unknown flag: --file\n")
            summary = trial / "artifacts/logs/artifacts/estacoda/attempt-1/summary.json"
            summary.parent.mkdir(parents=True)
            summary.write_text(json.dumps({"execution": {"status": "provider_error"}}))
            result = inspect_trial(trial)
            self.assertEqual(result["grading"], "ungraded")
            self.assertIsNone(result["rewards"])
            self.assertEqual([x["phase"] for x in result["failures"]], ["agent", "trial", "verifier_setup", "verifier_setup"])
            self.assertNotIn("PRIVATE", json.dumps(result))

    def test_zero_reward_is_graded_not_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            trial = Path(tmp)
            (trial / "result.json").write_text(json.dumps({"verifier_result": {"rewards": {"reward": 0.0}}}))
            self.assertEqual(inspect_trial(trial)["grading"], "graded")

    def test_preflight_fails_without_buildx_and_never_claims_lifecycle_validation(self):
        with patch("subprocess.run", side_effect=lambda command, **kw: SimpleNamespace(returncode=1 if "buildx" in command else 0)):
            result = preflight()
        self.assertFalse(result["prerequisitesPassed"])
        self.assertFalse(result["separateVerifierValidated"])

    def test_probe_keeps_separate_verifier_egress_policy_and_requires_reward(self):
        with tempfile.TemporaryDirectory() as tmp, patch("subprocess.run", return_value=SimpleNamespace(returncode=0)):
            result = verifier_probe(Path(tmp), "debian:bookworm-slim")
            self.assertFalse(result["separateVerifierValidated"])
            task = (Path(tmp) / "verifier-probe/task.toml").read_text()
            self.assertIn('name = "estacoda/operator-probe"', task)
            self.assertIn('environment_mode = "separate"', task)
            self.assertIn("allow_internet = false", task)


if __name__ == "__main__":
    unittest.main()

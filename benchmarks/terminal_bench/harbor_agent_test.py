import shlex
import unittest
from types import SimpleNamespace

from benchmarks.terminal_bench.harbor_agent import (
    AdapterConfigError,
    build_bench_args,
    build_config,
    build_installed_agent_command,
)


class EstaCodaHarborAgentTest(unittest.TestCase):
    def test_builds_bench_run_args_with_terminal_bench_identity(self):
        config = build_config({
            "ESTACODA_BENCH_COMMAND": "node --import tsx src/index.ts",
            "ESTACODA_BENCH_MODEL": "anthropic/claude-sonnet",
            "ESTACODA_BENCH_TASK_ID": "task/with spaces",
            "ESTACODA_BENCH_ATTEMPT": "2",
            "ESTACODA_BENCH_HOME": "/tmp/estacoda-home",
            "ESTACODA_BENCH_TEMPERATURE": "0",
            "ESTACODA_BENCH_MAX_TOKENS": "1200",
            "ESTACODA_BENCH_TIMEOUT_MS": "9000",
        })

        args = build_bench_args(config, "/tmp/instruction.txt")

        self.assertEqual(args[:5], ["node", "--import", "tsx", "src/index.ts", "bench"])
        self.assertIn("--instruction-file", args)
        self.assertIn("/tmp/instruction.txt", args)
        self.assertIn("--benchmark-name", args)
        self.assertIn("terminal-bench", args)
        self.assertIn("--benchmark-version", args)
        self.assertIn("2.0", args)
        self.assertIn("--task-id", args)
        self.assertIn("task/with spaces", args)
        self.assertIn("--attempt", args)
        self.assertIn("2", args)
        self.assertIn("--home", args)
        self.assertIn("/tmp/estacoda-home", args)
        self.assertIn("--model", args)
        self.assertIn("anthropic/claude-sonnet", args)
        self.assertIn("--max-tokens", args)
        self.assertNotIn("--isolated-home", args)
        self.assertEqual(config.out_dir, "/tmp/estacoda-terminal-bench/task-with-spaces/attempt-2")

    def test_defaults_to_isolated_home_without_real_user_home(self):
        config = build_config({
            "ESTACODA_BENCH_TASK_ID": "openssl-selfsigned-cert",
        })

        args = build_bench_args(config, "/tmp/instruction.txt")

        self.assertIn("--isolated-home", args)
        self.assertNotIn("--home", args)

    def test_command_writes_instruction_file_without_raw_instruction_argument(self):
        config = build_config({
            "ESTACODA_BENCH_TASK_ID": "file-create",
            "ESTACODA_BENCH_MODEL": "openai/gpt-test",
        })

        command = build_installed_agent_command(config, "Create answer.txt && do not run this as shell")
        parts = shlex.split(command)

        self.assertIn("estacoda", parts)
        self.assertIn("--instruction-file", parts)
        self.assertNotIn("Create answer.txt && do not run this as shell", command)
        self.assertIn("&&", command)

    def test_reads_task_identity_from_context_when_env_is_absent(self):
        context = SimpleNamespace(
            task=SimpleNamespace(id="context-task"),
            trial=SimpleNamespace(attempt=3),
            model=SimpleNamespace(id="openai/gpt-context"),
        )

        config = build_config({}, context)

        self.assertEqual(config.task_id, "context-task")
        self.assertEqual(config.attempt, 3)
        self.assertEqual(config.model, "openai/gpt-context")

    def test_rejects_invalid_numeric_configuration(self):
        with self.assertRaises(AdapterConfigError):
            build_config({
                "ESTACODA_BENCH_TASK_ID": "file-create",
                "ESTACODA_BENCH_ATTEMPT": "0",
            })

    def test_maps_provider_budget_flags(self):
        config = build_config({
            "ESTACODA_BENCH_TASK_ID": "file-create",
            "ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS": "4",
            "ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS": "12",
        })

        args = build_bench_args(config, "/tmp/instruction.txt")

        self.assertIn("--max-provider-iterations", args)
        self.assertIn("4", args)
        self.assertIn("--max-provider-tool-calls", args)
        self.assertIn("12", args)


if __name__ == "__main__":
    unittest.main()

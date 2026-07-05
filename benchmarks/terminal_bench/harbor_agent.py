"""Harbor installed-agent adapter for running EstaCoda on Terminal-Bench."""

from __future__ import annotations

import base64
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Mapping

try:
    from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext
except ImportError:  # pragma: no cover - exercised by local unit tests without Harbor installed.
    class BaseInstalledAgent:  # type: ignore[no-redef]
        pass

    def with_prompt_template(fn):  # type: ignore[no-redef]
        return fn

    BaseEnvironment = Any  # type: ignore[assignment,misc]
    AgentContext = Any  # type: ignore[assignment,misc]


DEFAULT_BENCHMARK_NAME = "terminal-bench"
DEFAULT_BENCHMARK_VERSION = "2.0"
DEFAULT_WORKSPACE = "/app"
DEFAULT_OUT_ROOT = "/tmp/estacoda-terminal-bench"
DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
HARBOR_ARTIFACTS_DIR = "/logs/artifacts/estacoda"


class AdapterConfigError(ValueError):
    """Raised when the Harbor adapter receives invalid configuration."""


@dataclass(frozen=True)
class EstaCodaHarborConfig:
    estacoda_command: tuple[str, ...]
    workspace: str
    out_dir: str
    home: str | None
    model: str | None
    benchmark_name: str
    benchmark_version: str
    task_id: str
    attempt: int
    temperature: float
    max_tokens: int | None
    timeout_ms: int
    redact: bool
    provider_budget_flags: tuple[tuple[str, str], ...]


def build_config(
    env: Mapping[str, str] | None = None,
    context: Any = None,
) -> EstaCodaHarborConfig:
    values = env if env is not None else os.environ
    task_id = first_present(
        values.get("ESTACODA_BENCH_TASK_ID"),
        values.get("HARBOR_TASK_ID"),
        values.get("TERMINAL_BENCH_TASK_ID"),
        context_value(context, "task_id", "taskId", "task.id", "trial.task_id", "trial.task.id"),
        "unknown-task",
    )
    attempt = parse_positive_int(
        first_present(
            values.get("ESTACODA_BENCH_ATTEMPT"),
            values.get("HARBOR_ATTEMPT"),
            context_value(context, "attempt", "trial.attempt"),
            "1",
        ),
        "ESTACODA_BENCH_ATTEMPT",
    )
    out_dir = values.get("ESTACODA_BENCH_OUT") or str(
        PurePosixPath(DEFAULT_OUT_ROOT) / sanitize_path_segment(task_id) / f"attempt-{attempt}"
    )
    command = tuple(shlex.split(values.get("ESTACODA_BENCH_COMMAND", "estacoda")))
    if len(command) == 0:
        raise AdapterConfigError("ESTACODA_BENCH_COMMAND must not be empty.")

    provider_budget_flags = tuple(
        (flag, value)
        for env_name, flag in (
            ("ESTACODA_BENCH_MAX_PROVIDER_ITERATIONS", "--max-provider-iterations"),
            ("ESTACODA_BENCH_MAX_PROVIDER_TOOL_CALLS", "--max-provider-tool-calls"),
            ("ESTACODA_BENCH_MAX_REPEATED_TOOL_FAILURES", "--max-repeated-tool-failures"),
            ("ESTACODA_BENCH_MAX_PROVIDER_WALL_CLOCK_MS", "--max-provider-wall-clock-ms"),
        )
        if (value := optional_positive_int_text(values.get(env_name), env_name)) is not None
    )

    return EstaCodaHarborConfig(
        estacoda_command=command,
        workspace=values.get("ESTACODA_BENCH_WORKSPACE", DEFAULT_WORKSPACE),
        out_dir=out_dir,
        home=blank_to_none(values.get("ESTACODA_BENCH_HOME")),
        model=first_optional(
            values.get("ESTACODA_BENCH_MODEL"),
            values.get("HARBOR_MODEL"),
            context_value(context, "model_id", "model.id", "model.name", "trial.model", "trial.model_id"),
        ),
        benchmark_name=values.get("ESTACODA_BENCHMARK_NAME", DEFAULT_BENCHMARK_NAME),
        benchmark_version=values.get("ESTACODA_BENCHMARK_VERSION", DEFAULT_BENCHMARK_VERSION),
        task_id=task_id,
        attempt=attempt,
        temperature=parse_float(values.get("ESTACODA_BENCH_TEMPERATURE", "0"), "ESTACODA_BENCH_TEMPERATURE"),
        max_tokens=optional_positive_int(values.get("ESTACODA_BENCH_MAX_TOKENS"), "ESTACODA_BENCH_MAX_TOKENS"),
        timeout_ms=parse_positive_int(values.get("ESTACODA_BENCH_TIMEOUT_MS", str(DEFAULT_TIMEOUT_MS)), "ESTACODA_BENCH_TIMEOUT_MS"),
        redact=parse_bool(values.get("ESTACODA_BENCH_REDACT", "true"), "ESTACODA_BENCH_REDACT"),
        provider_budget_flags=provider_budget_flags,
    )


def build_bench_args(config: EstaCodaHarborConfig, instruction_file: str) -> list[str]:
    args = [
        *config.estacoda_command,
        "bench",
        "run",
        "--workspace",
        config.workspace,
        "--instruction-file",
        instruction_file,
        "--out",
        config.out_dir,
        "--benchmark-name",
        config.benchmark_name,
        "--benchmark-version",
        config.benchmark_version,
        "--task-id",
        config.task_id,
        "--attempt",
        str(config.attempt),
        "--temperature",
        format_number(config.temperature),
        "--timeout-ms",
        str(config.timeout_ms),
    ]
    if config.home is None:
        args.append("--isolated-home")
    else:
        args.extend(["--home", config.home])
    if config.model is not None:
        args.extend(["--model", config.model])
    if config.max_tokens is not None:
        args.extend(["--max-tokens", str(config.max_tokens)])
    if not config.redact:
        args.append("--no-redact")
    for flag, value in config.provider_budget_flags:
        args.extend([flag, value])
    return args


def build_installed_agent_command(config: EstaCodaHarborConfig, instruction: str) -> str:
    instruction_file = str(PurePosixPath(config.out_dir) / "instruction.txt")
    instruction_payload = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
    write_instruction = shlex.join([
        "python3",
        "-c",
        (
            "import base64,pathlib,sys;"
            "path=pathlib.Path(sys.argv[1]);"
            "path.parent.mkdir(parents=True,exist_ok=True);"
            "path.write_bytes(base64.b64decode(sys.argv[2]))"
        ),
        instruction_file,
        instruction_payload,
    ])
    bench_command = shlex.join(build_bench_args(config, instruction_file))
    copy_artifacts = (
        f"{shlex.join(['mkdir', '-p', HARBOR_ARTIFACTS_DIR])} && "
        f"{shlex.join(['cp', '-R', config.out_dir, HARBOR_ARTIFACTS_DIR + '/'])} || true"
    )
    run_and_collect = (
        f"{{ {bench_command}; estacoda_status=$?; "
        f"{copy_artifacts}; exit \"$estacoda_status\"; }}"
    )
    return " && ".join([
        shlex.join(["mkdir", "-p", config.out_dir]),
        write_instruction,
        run_and_collect,
    ])


class EstaCodaHarborAgent(BaseInstalledAgent):
    """Harbor installed-agent wrapper for EstaCoda's headless benchmark mode."""

    @staticmethod
    def name() -> str:
        return "estacoda"

    def version(self) -> str | None:
        return os.environ.get("ESTACODA_VERSION")

    async def install(self, environment: BaseEnvironment) -> None:
        install_command = blank_to_none(os.environ.get("ESTACODA_HARBOR_INSTALL_COMMAND"))
        if install_command is not None:
            await self.exec_as_agent(environment, command=install_command)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        config = build_config(os.environ, context)
        command = build_installed_agent_command(config, instruction)
        result = await environment.exec(command=command)
        record_context(context, config, result)


EstaCodaAgent = EstaCodaHarborAgent


def record_context(context: Any, config: EstaCodaHarborConfig, result: Any) -> None:
    output = extract_command_output(result)
    set_context_field(context, "output", output)
    set_context_field(context, "final_answer", output)
    set_context_field(context, "estacoda_artifacts_dir", config.out_dir)
    set_context_field(context, "estacoda_summary_path", str(PurePosixPath(config.out_dir) / "summary.json"))
    exit_code = getattr(result, "return_code", None)
    if exit_code is not None:
        set_context_field(context, "estacoda_exit_code", str(exit_code))


def extract_command_output(result: Any) -> str:
    for name in ("stdout", "output", "text"):
        value = getattr(result, name, None)
        if isinstance(value, str):
            return value
    if isinstance(result, str):
        return result
    return ""


def set_context_field(context: Any, name: str, value: str) -> None:
    if context is None:
        return
    try:
        setattr(context, name, value)
    except Exception:
        pass
    metadata = getattr(context, "metadata", None)
    if isinstance(metadata, dict):
        metadata[name] = value


def context_value(context: Any, *paths: str) -> str | None:
    for path in paths:
        value = read_context_path(context, path)
        if isinstance(value, str) and value.strip() != "":
            return value
        if isinstance(value, int):
            return str(value)
    return None


def read_context_path(context: Any, path: str) -> Any:
    current = context
    for part in path.split("."):
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
    return current


def first_present(*values: str | None) -> str:
    for value in values:
        if value is not None and value.strip() != "":
            return value
    raise AdapterConfigError("Expected at least one non-empty value.")


def first_optional(*values: str | None) -> str | None:
    for value in values:
        if value is not None and value.strip() != "":
            return value
    return None


def blank_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped != "" else None


def sanitize_path_segment(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip(".-")
    return sanitized[:120] or "task"


def parse_bool(value: str, name: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise AdapterConfigError(f"{name} must be true or false.")


def parse_float(value: str, name: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise AdapterConfigError(f"{name} must be a finite number.") from exc
    if parsed != parsed or parsed in {float("inf"), float("-inf")}:
        raise AdapterConfigError(f"{name} must be a finite number.")
    return parsed


def optional_positive_int(value: str | None, name: str) -> int | None:
    if value is None or value.strip() == "":
        return None
    return parse_positive_int(value, name)


def optional_positive_int_text(value: str | None, name: str) -> str | None:
    parsed = optional_positive_int(value, name)
    return None if parsed is None else str(parsed)


def parse_positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise AdapterConfigError(f"{name} must be a positive integer.") from exc
    if parsed <= 0:
        raise AdapterConfigError(f"{name} must be a positive integer.")
    return parsed


def format_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)

#!/usr/bin/env python3
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


def main() -> int:
    try:
        request = json.load(sys.stdin)
        tool = request.get("tool")
        payload = request.get("input", {})

        if tool == "python.probe":
            return respond(
                {
                    "ok": True,
                    "content": "Python worker bridge is ready.",
                    "metadata": {
                        "tool": tool,
                        "python": sys.version.split()[0],
                        "receivedKeys": sorted(payload.keys()),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                }
            )

        if tool == "document.probe":
            return respond(document_probe(payload))

        if tool == "execute_code":
            return respond(execute_code(payload))

        return respond(
            {
                "ok": False,
                "content": f"Unknown Python worker tool: {tool}",
                "metadata": {"tool": tool},
            }
        )
    except Exception as exc:
        return respond(
            {
                "ok": False,
                "content": f"Python worker failed: {exc}",
                "metadata": {"errorType": type(exc).__name__},
            }
        )


def respond(payload: dict) -> int:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if payload.get("ok") else 1


def document_probe(payload: dict) -> dict:
    path = payload.get("path")
    max_preview_chars = int(payload.get("maxPreviewChars", 500))

    if not isinstance(path, str) or not path:
        return {
            "ok": False,
            "content": "document.probe requires a non-empty path",
            "metadata": {"tool": "document.probe"},
        }

    if not os.path.exists(path):
        return {
            "ok": False,
            "content": f"Document not found: {path}",
            "metadata": {"tool": "document.probe", "path": path},
        }

    if not os.path.isfile(path):
        return {
            "ok": False,
            "content": f"Path is not a file: {path}",
            "metadata": {"tool": "document.probe", "path": path},
        }

    stat = os.stat(path)
    mime_type, encoding = mimetypes.guess_type(path)
    preview = read_text_preview(path, max_preview_chars)

    content_lines = [
        f"Document: {os.path.basename(path)}",
        f"Size: {stat.st_size} bytes",
        f"MIME: {mime_type or 'unknown'}",
    ]

    if preview:
        content_lines.extend(["Preview:", preview])
    else:
        content_lines.append("Preview: unavailable for this file type")

    return {
        "ok": True,
        "content": "\n".join(content_lines),
        "metadata": {
            "tool": "document.probe",
            "path": path,
            "basename": os.path.basename(path),
            "sizeBytes": stat.st_size,
            "mimeType": mime_type,
            "encoding": encoding,
            "hasPreview": bool(preview),
        },
    }


def read_text_preview(path: str, max_chars: int) -> str:
    try:
        with open(path, "rb") as handle:
            sample = handle.read(min(max_chars * 4, 8192))
        if b"\x00" in sample:
            return ""
        return sample.decode("utf-8", errors="replace")[:max_chars].strip()
    except OSError:
        return ""


def execute_code(payload: dict) -> dict:
    code = payload.get("code")
    input_payload = payload.get("input", {})
    timeout_ms = int(payload.get("timeoutMs", 5000))
    max_output_chars = int(payload.get("maxOutputChars", 12000))

    if not isinstance(code, str) or not code.strip():
        return {
            "ok": False,
            "content": "execute_code requires non-empty Python code",
            "metadata": {"tool": "execute_code"},
        }

    if timeout_ms < 1:
        timeout_ms = 1

    if timeout_ms > 30000:
        timeout_ms = 30000

    if max_output_chars < 1000:
        max_output_chars = 1000

    if max_output_chars > 48000:
        max_output_chars = 48000

    with tempfile.NamedTemporaryFile("w", suffix=".py", encoding="utf-8", delete=False) as handle:
        script_path = handle.name
        handle.write(
            "import json\n"
            "import os\n"
            "import sys\n"
            "ESTACODA_INPUT = json.loads(os.environ.get('ESTACODA_INPUT_JSON', '{}'))\n"
        )
        handle.write("\n")
        handle.write(code)

    try:
        completed = subprocess.run(
            [sys.executable, script_path],
            cwd=os.getcwd(),
            env={
                **os.environ,
                "ESTACODA_INPUT_JSON": json.dumps(input_payload, ensure_ascii=False),
            },
            text=True,
            capture_output=True,
            timeout=timeout_ms / 1000,
            check=False,
        )
        stdout = completed.stdout[-max_output_chars:]
        stderr = completed.stderr[-max_output_chars:]
        content = stdout.strip() if stdout.strip() else "(no stdout)"

        if stderr.strip():
            content = f"{content}\nstderr:\n{stderr.strip()}"

        return {
            "ok": completed.returncode == 0,
            "content": content[:max_output_chars],
            "metadata": {
                "tool": "execute_code",
                "exitCode": completed.returncode,
                "timeoutMs": timeout_ms,
                "maxOutputChars": max_output_chars,
                "truncatedStdout": len(completed.stdout) > len(stdout),
                "truncatedStderr": len(completed.stderr) > len(stderr),
            },
        }
    except subprocess.TimeoutExpired as exc:
        stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else (exc.stdout or b"").decode("utf-8", errors="replace")
        stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else (exc.stderr or b"").decode("utf-8", errors="replace")

        return {
            "ok": False,
            "content": f"execute_code timed out after {timeout_ms}ms\n{stdout[-max_output_chars:]}\n{stderr[-max_output_chars:]}".strip(),
            "metadata": {
                "tool": "execute_code",
                "timeoutMs": timeout_ms,
                "timedOut": True,
            },
        }
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

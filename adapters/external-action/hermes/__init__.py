"""Hermes pre-tool hook for the HUQAN external action guard."""

import json
import os
import re
import subprocess
from pathlib import Path

# A blocked call still has to say why it was blocked. Before #1954 every
# failure -- a missing interpreter, a crashed gate, an unparseable payload --
# produced the same four words, so neither an operator watching their session
# stall nor a maintainer reading a red test could get any further.
_DIAGNOSTIC_LIMIT = 200
_SECRET = re.compile(
    r"(?i)(?:bearer\s+\S+"
    r"|(?:api[-_]?key|token|secret|password|authorization)\s*[=:]\s*\S+"
    r"|\b[A-Za-z0-9_\-]{32,}\b)"
)


def _diagnostic(detail):
    """Reduce process output to one bounded, redacted line.

    The line naming the error is preferred over the last line: a Node stack
    ends in internal frames that say nothing, while its `Error:` line names the
    failure. The result is length-capped and secret-shaped runs are removed,
    because this string reaches logs and a Trust Receipt.
    """
    lines = [" ".join(line.split()) for line in str(detail or "").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    chosen = next((line for line in lines if re.search(r"(?i)\berror\b", line)), lines[-1])
    chosen = _SECRET.sub("[redacted]", chosen)
    if len(chosen) > _DIAGNOSTIC_LIMIT:
        chosen = chosen[: _DIAGNOSTIC_LIMIT - 1] + "…"
    return chosen


def _blocked(reason, detail=""):
    """Every failure path blocks; only the explanation differs."""
    suffix = " ({})".format(detail) if detail else ""
    return {"action": "block", "message": "{}; blocked fail-closed{}".format(reason, suffix)}


def _gate_command():
    """Return the recorded gate argv, or the reason it is unusable."""
    path = Path(__file__).parent / "huqan-gate.json"
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        return None, _diagnostic("{}: {}".format(type(error).__name__, error))
    except ValueError as error:
        return None, _diagnostic("{} is not valid JSON: {}".format(path.name, error))
    if not isinstance(config, dict):
        return None, "{} does not hold an object".format(path.name)
    argv = config.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(value, str) and value for value in argv):
        return None, "{} has no usable argv".format(path.name)
    return argv, ""


def guard_tool_call(tool_name: str, args: dict, task_id: str, **kwargs):
    """Block Hermes execution unless HUQAN returns an explicit allow."""
    command, unusable = _gate_command()
    if not command:
        return _blocked("HUQAN guard unavailable", unusable)

    payload = {
        "tool_call_id": kwargs.get("tool_call_id"),
        "session_id": kwargs.get("session_id") or task_id,
        "turn_id": kwargs.get("turn_id"),
        "tool_name": tool_name,
        "args": args or {},
        "cwd": kwargs.get("cwd") or os.getcwd(),
    }
    try:
        completed = subprocess.run(
            [*command, "--profile", "hermes"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            shell=False,
        )
        if completed.returncode != 0:
            # capture_output already collected this; discarding it was the
            # whole defect.
            detail = _diagnostic(completed.stderr) or _diagnostic(completed.stdout)
            return _blocked(
                "HUQAN guard failed",
                "exit {}{}".format(completed.returncode, ": " + detail if detail else ""),
            )
        try:
            decision = json.loads(completed.stdout or "{}")
        except ValueError as error:
            return _blocked("HUQAN returned unreadable output", _diagnostic(str(error)))
        if decision.get("action") == "block":
            return decision
        if decision:
            # Name the action rather than echoing the payload: the shape is
            # what is wrong, and the payload may carry tool arguments.
            return _blocked(
                "HUQAN returned an invalid decision",
                "action={!r}".format(decision.get("action")),
            )
        return None
    except subprocess.TimeoutExpired:
        return _blocked("HUQAN guard failed", "no decision within 30s")
    except (OSError, subprocess.SubprocessError, ValueError, TypeError) as error:
        return _blocked(
            "HUQAN guard failed",
            "{}{}".format(type(error).__name__, ": " + _diagnostic(str(error)) if str(error) else ""),
        )


def register(ctx):
    """Register the policy callback for both Hermes CLI and Gateway sessions."""
    ctx.register_hook("pre_tool_call", guard_tool_call)

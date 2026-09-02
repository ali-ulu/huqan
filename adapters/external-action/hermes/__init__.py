"""Hermes pre-tool hook for the HUQAN external action guard."""

import json
import os
import subprocess
from pathlib import Path


def _gate_command():
    try:
        config = json.loads((Path(__file__).parent / "huqan-gate.json").read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            return None
        argv = config.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(value, str) and value for value in argv):
            return None
        return argv
    except (OSError, ValueError, TypeError):
        return None


def guard_tool_call(tool_name: str, args: dict, task_id: str, **kwargs):
    """Block Hermes execution unless HUQAN returns an explicit allow."""
    command = _gate_command()
    if not command:
        return {"action": "block", "message": "HUQAN guard unavailable; blocked fail-closed"}

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
            return {"action": "block", "message": "HUQAN guard failed; blocked fail-closed"}
        decision = json.loads(completed.stdout or "{}")
        if decision.get("action") == "block":
            return decision
        if decision:
            return {"action": "block", "message": "HUQAN returned an invalid decision; blocked fail-closed"}
        return None
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        return {"action": "block", "message": "HUQAN guard failed; blocked fail-closed"}


def register(ctx):
    """Register the policy callback for both Hermes CLI and Gateway sessions."""
    ctx.register_hook("pre_tool_call", guard_tool_call)

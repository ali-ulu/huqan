"""Hermes pre-tool hook for the HUQAN external action guard."""

import json
import os
import shutil
import subprocess


def _gate_executable():
    configured = os.environ.get("HUQAN_GATE_PATH")
    if configured:
        return configured
    return shutil.which("huqan-gate") or shutil.which("huqan-gate.cmd")


def guard_tool_call(tool_name: str, args: dict, task_id: str, **kwargs):
    """Block Hermes execution unless HUQAN returns an explicit allow."""
    executable = _gate_executable()
    if not executable:
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
            [executable, "--profile", "hermes"],
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

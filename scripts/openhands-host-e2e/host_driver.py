"""Drive a real OpenHands SDK host against a workspace's `.openhands/hooks.json`.

This is the host side of the #4572 E2E and it deliberately imports nothing from
HUQAN: the point of the test is to prove what the *host* does, not to re-run
HUQAN's own projection. It loads the hook config exactly as the host does
(`HookConfig.load(working_dir=...)`), feeds each action through the host's own
`HookEventProcessor` (which runs `pre_tool_use` and records a blocked action in
conversation state), and then dispatches the action batch through the host's own
`_ActionBatch.prepare`, which is where a blocked action is partitioned out before
the tool runner is reached.

argv: <workspace_dir> <sentinel_file>
stdin: {"session_id": "...", "actions": [{"tool_name": "...", "tool_input": {...}}]}
stdout: {"openhands_sdk_version": "...", "results": [...]}

The tool runner appends one JSON line per *executed* action to the sentinel file,
so the caller can assert a destructive command never reached the executor.

`_ActionBatch` is a private name: the host's executor-suppression path is not a
public API, so the CI workflow pins an exact `openhands-sdk` version and this
driver is allowed to depend on that pinned shape. A host upgrade that moves it is
meant to fail here loudly rather than silently stop testing the real path.
"""

import json
import sys
import uuid
from importlib.metadata import version

from openhands.sdk.agent.agent import Agent
from openhands.sdk.agent.parallel_executor import ParallelToolExecutor
from openhands.sdk.conversation.state import ConversationState
from openhands.sdk.event import HookExecutionEvent
from openhands.sdk.hooks.config import HookConfig
from openhands.sdk.hooks.conversation_hooks import HookEventProcessor
from openhands.sdk.hooks.manager import HookManager
from openhands.sdk.llm import LLM
from openhands.sdk.llm.message import MessageToolCall
from openhands.sdk.workspace import LocalWorkspace


def build_host(workspace, session_id, captured):
    """Wire the same object graph a real conversation uses for pre_tool_use."""
    config = HookConfig.load(working_dir=workspace)
    manager = HookManager(config=config, working_dir=workspace, session_id=session_id)
    processor = HookEventProcessor(
        hook_manager=manager,
        original_callback=captured.append,
        emit_hook_events=True,
    )
    state = ConversationState(
        id=str(uuid.uuid4()),
        agent=Agent(llm=LLM(model="litellm_proxy/e2e", usage_id="e2e"), tools=[]),
        workspace=LocalWorkspace(working_dir=workspace),
    )
    processor.set_conversation_state(state)
    return processor, state


def make_action(tool_name, tool_input):
    from openhands.sdk.event.llm_convertible.action import ActionEvent
    from openhands.sdk.tool.schema import Action
    from pydantic import Field

    # A local Action subclass, not the built-in TerminalAction: importing
    # `openhands.tools` drags in browser-use and a heavy dependency tree, and the
    # host's pre_tool_use path only needs the action to materialize so
    # `event.action is not None` and its dump feeds the hook. The tool_name the
    # hook matches on is carried separately on the ActionEvent.
    class TerminalAction(Action):
        command: str = Field(default="")

    call = MessageToolCall(
        id=f"call_{uuid.uuid4().hex[:12]}",
        name=tool_name,
        arguments=json.dumps(tool_input),
        origin="completion",
    )
    return ActionEvent(
        thought=[],
        action=TerminalAction(**tool_input),
        tool_name=tool_name,
        tool_call_id=call.id,
        tool_call=call,
        llm_response_id="resp",
    )


def action_batch_class():
    """The host's blocked-action partitioner.

    `_ActionBatch` is private, so this resolves it by name and fails with a
    message a maintainer can act on rather than an AttributeError when an SDK
    upgrade moves it. The CI workflow pins the SDK version for the same reason.
    """
    import openhands.sdk.agent.agent as agent_module

    batch = getattr(agent_module, "_ActionBatch", None)
    if batch is None:
        raise SystemExit(
            "openhands-sdk no longer exposes agent._ActionBatch; "
            "update scripts/openhands-host-e2e/host_driver.py to the new executor-suppression path"
        )
    return batch


def main():
    workspace, sentinel_path = sys.argv[1], sys.argv[2]
    request = json.load(sys.stdin)

    captured = []
    processor, state = build_host(workspace, request.get("session_id", "e2e"), captured)
    executor = ParallelToolExecutor()
    batch_class = action_batch_class()

    def tool_runner(action_event):
        with open(sentinel_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"tool_name": action_event.tool_name, "action_id": action_event.id}) + "\n")
        return []

    results = []
    for spec in request["actions"]:
        action_event = make_action(spec["tool_name"], spec["tool_input"])
        before = len(captured)
        processor.on_event(action_event)
        hook_events = [event for event in captured[before:] if isinstance(event, HookExecutionEvent)]

        # The host partitions blocked actions out here, before the runner.
        batch = batch_class.prepare([action_event], state, executor, tool_runner)

        results.append({
            "tool_name": spec["tool_name"],
            "command": spec["tool_input"].get("command"),
            "blocked": action_event.id in batch.blocked_reasons,
            "reason": batch.blocked_reasons.get(action_event.id),
            "executed": action_event.id in batch.results_by_id,
            "hooks": [
                {
                    "command": event.hook_command,
                    "success": event.success,
                    "blocked": event.blocked,
                    "exit_code": event.exit_code,
                    "stdout": event.stdout,
                    "stderr": event.stderr,
                    "reason": event.reason,
                    "error": event.error,
                }
                for event in hook_events
            ],
        })

    json.dump({"openhands_sdk_version": version("openhands-sdk"), "results": results}, sys.stdout)


if __name__ == "__main__":
    main()

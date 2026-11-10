"""Runtime-mode routing for Hook events with explicit effect ports."""

from dataclasses import dataclass
from typing import Callable

from mae_flow_core import RuntimeMode
from mae_flow_core.application.hooks.models import HookResponse


@dataclass(frozen=True)
class HookEventPorts:
    conflict: Callable
    corrupt: Callable
    terminal: Callable
    standalone_pretool: Callable
    standalone_inject: Callable
    direct: Callable
    inactive: Callable
    pretool: Callable
    inject: Callable
    subagentstop: Callable
    posttool: Callable
    stop: Callable
    log: Callable


def _merge(left, right):
    return HookResponse(
        exit_code=right.exit_code or left.exit_code,
        stdout=left.stdout + right.stdout,
        stderr=left.stderr + right.stderr,
    )


def _active_event(event, payload, ports):
    if event == "pretooluse":
        return ports.pretool(payload)
    if event == "userprompt":
        return ports.inject(payload, False)
    if event == "sessionstart":
        return ports.inject(payload, True)
    if event == "subagentstop":
        return ports.subagentstop(payload)
    if event == "posttooluse":
        return ports.posttool(payload)
    if event == "stop":
        return ports.stop(payload)
    return HookResponse()


def _standalone_event(event, payload, ports):
    if event == "pretooluse":
        return ports.standalone_pretool(payload)
    if event == "subagentstop":
        return ports.subagentstop(payload)
    if event == "userprompt":
        return ports.standalone_inject(payload, False)
    if event == "sessionstart":
        return ports.standalone_inject(payload, True)
    if event == "posttooluse":
        return ports.posttool(payload)
    return ports.inactive(event, payload)


def handle_hook_event(event, payload, runtime, ports):
    """Route one decoded Hook event and return its observable response."""
    prefix = HookResponse()
    if runtime.has_conflict:
        prefix = ports.conflict(event, payload, runtime)
    if runtime.mode == RuntimeMode.CORRUPT:
        result = ports.corrupt(event, payload, runtime)
    elif runtime.flow_terminal:
        result = ports.terminal(event, payload, runtime)
    elif runtime.mode == RuntimeMode.STANDALONE:
        result = _standalone_event(event, payload, ports)
    elif runtime.mode == RuntimeMode.DIRECT:
        result = ports.direct(event, payload, runtime)
    elif (
            runtime.mode == RuntimeMode.INACTIVE
            and event in (
                "pretooluse",
                "posttooluse",
                "subagentstop",
                "stop",
            )):
        result = ports.inactive(event, payload)
    else:
        result = _active_event(event, payload, ports)
    return _merge(prefix, result)

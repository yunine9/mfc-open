#!/usr/bin/env python3
"""SubagentStop records lifecycle only and treats return prose as opaque."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.application.hooks.agent_completion import (  # noqa: E402
    AgentCompletionPorts,
    handle_agent_completion,
)
from mae_flow_core.application.hooks.models import HookResponse  # noqa: E402


class AgentCompletionTests(unittest.TestCase):
    def ports(self, latest="run-1", scope_violation=""):
        events = []
        ports = AgentCompletionPorts(
            state_path="/repo/.mae-flow.json",
            latest_started=lambda **_kwargs: latest,
            record_finished=lambda *args: events.append(args),
            record_execution=lambda *_args: None,
            scope_violation=lambda *_args: scope_violation,
            log=lambda message: events.append(("log", message)),
        )
        return ports, events

    def test_return_text_is_opaque_in_any_language_or_format(self):
        samples = (
            "编译完成，没有发现问题。",
            "**CLEAR**\n- no findings",
            "status=anything\nTASK_CARD_SHA256: not-a-hash",
            "COMPILE_RESULT: FAIL\nUT_RESULT: PASS",
            "",
        )
        for detail in samples:
            with self.subTest(detail=detail):
                ports, events = self.ports()
                response = handle_agent_completion({
                    "invocation_id": "run-1",
                    "assistant_text": detail,
                }, ports)
                self.assertEqual(HookResponse(), response)
                self.assertEqual(
                    ("/repo/.mae-flow.json", "run-1", "returned", detail),
                    events[0],
                )

    def test_lifecycle_metadata_controls_interrupted_and_timeout(self):
        for raw, expected in (("interrupted", "interrupted"),
                              ("timeout", "timeout"),
                              ("completed", "returned")):
            with self.subTest(raw=raw):
                ports, events = self.ports()
                response = handle_agent_completion({
                    "invocation_id": "run-1", "lifecycle": raw,
                }, ports)
                self.assertEqual(0, response.exit_code)
                self.assertEqual(expected, events[0][2])

    def test_missing_invocation_uses_latest_open_start(self):
        ports, events = self.ports(latest="latest-open")
        handle_agent_completion({}, ports)
        self.assertEqual("latest-open", events[0][1])

    def test_unmatched_stop_fails_open_without_inventing_acceptance(self):
        ports, events = self.ports(latest="")
        response = handle_agent_completion({}, ports)
        self.assertEqual(HookResponse(), response)
        self.assertEqual([], [event for event in events if event[0] != "log"])

    def test_real_file_scope_violation_blocks_without_parsing_return_prose(self):
        ports, events = self.ports(
            scope_violation="craft-reviewer-agent 是只读角色，却修改了 src/a.py")
        response = handle_agent_completion({
            "invocation_id": "run-1",
            "assistant_text": "CLEAR，检视完成。",
        }, ports)
        self.assertEqual(2, response.exit_code)
        self.assertIn("src/a.py", response.stderr)
        self.assertEqual("returned", events[0][2])


if __name__ == "__main__":
    unittest.main()

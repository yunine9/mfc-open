#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Contracts for the side-effect-free CLI command routing table."""

import os
import inspect
import sys
import unittest


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.command_dispatch import (  # noqa: E402
    ACTION_ROUTES,
    FLOW_ROUTES,
    CommandRoute,
    action_route,
    flow_route,
    invoke,
)
from mae_flow_core import cli_runtime  # noqa: E402


class CommandDispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cli = cli_runtime

    def test_action_routes_preserve_every_legacy_signature(self):
        self.assertEqual(
            {
                "start": CommandRoute(
                    "cmd_action_start", ("flow", "state", "args")),
                "confirm-scope": CommandRoute(
                    "cmd_action_confirm_scope", ("flow", "args")),
                "status": CommandRoute("cmd_action_status", ()),
                "critic": CommandRoute("cmd_action_critic", ("args",)),
                "finish": CommandRoute("cmd_action_finish", ("args",)),
                "cancel": CommandRoute("cmd_action_cancel", ()),
            },
            dict(ACTION_ROUTES),
        )

    def test_flow_routes_preserve_every_legacy_signature(self):
        flow_state_args = {
            "exit": "cmd_exit",
            "config-review": "cmd_config_review",
            "moonlight": "cmd_moonlight",
            "role-task": "cmd_role_task",
            # 云端宿主喂平台事实的口子;加路由时漏了这行,基线就一直红着
            "pipeline": "cmd_pipeline",
            "delivery": "cmd_delivery",
            "intervention": "cmd_user_intervention",
            "milestone": "cmd_build_milestone",
            "accept-risk": "cmd_accept_risk",
            "allow": "cmd_allow",
            "spec": "cmd_spec",
            "done": "cmd_done",
            "skip": "cmd_skip",
            "status": "cmd_status",
            "goto": "cmd_goto",
            "unlock": "cmd_unlock",
            "reloaded": "cmd_reloaded",
            "doctor": "cmd_doctor",
            "report": "cmd_report",
        }
        expected = {
            command: CommandRoute(handler, ("flow", "state", "args"))
            for command, handler in flow_state_args.items()
        }
        expected.update({
            "messages": CommandRoute(
                "cmd_messages", ("state", "args")),
            "requirement-record": CommandRoute(
                "cmd_requirement_record", ("state", "args")),
            "current": CommandRoute(
                "print_current", ("flow", "state")),
            "execution-plan": CommandRoute(
                "cmd_execution_plan", ("flow", "state", "args")),
        })
        self.assertEqual(expected, dict(FLOW_ROUTES))

    def test_unknown_routes_are_explicitly_unhandled(self):
        self.assertIsNone(action_route("unknown"))
        self.assertIsNone(flow_route("unknown"))

    def test_route_tables_cannot_be_mutated(self):
        with self.assertRaises(TypeError):
            ACTION_ROUTES["new"] = CommandRoute("handler", ())
        with self.assertRaises(TypeError):
            FLOW_ROUTES["new"] = CommandRoute("handler", ())

    def test_every_route_resolves_to_a_callable_handler(self):
        for route in list(ACTION_ROUTES.values()) + list(
                FLOW_ROUTES.values()):
            with self.subTest(handler=route.handler):
                self.assertTrue(callable(getattr(
                    self.cli, route.handler, None)))
                self.assertTrue(set(route.arguments) <= {
                    "flow", "state", "args"})
                self.assertEqual(
                    len(route.arguments),
                    len(inspect.signature(getattr(
                        self.cli, route.handler)).parameters),
                )

    def test_invoke_uses_the_declared_argument_order(self):
        calls = []

        def handler(*values):
            calls.append(values)
            return "handled"

        route = CommandRoute("handler", ("state", "flow", "args"))
        self.assertEqual(
            "handled",
            invoke(
                route,
                {"handler": handler},
                flow="FLOW",
                state="STATE",
                args="ARGS",
            ),
        )
        self.assertEqual([("STATE", "FLOW", "ARGS")], calls)

    def test_invoke_rejects_an_unknown_handler(self):
        with self.assertRaisesRegex(
                RuntimeError, "unknown Mae-Flow command handler"):
            invoke(CommandRoute("missing", ()), {})


if __name__ == "__main__":
    unittest.main()

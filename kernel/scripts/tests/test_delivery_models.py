#!/usr/bin/env python3
"""Immutable application result tests for Delivery use cases."""

import os
import sys
import unittest
from dataclasses import FrozenInstanceError


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.delivery.models import (  # noqa: E402
    DeliveryEffect,
    DeliveryResult,
    thaw,
)


class DeliveryModelTests(unittest.TestCase):
    def test_effect_deep_freezes_payload(self):
        source = {"state": {"items": [1, 2]}, "paths": {"a", "b"}}
        effect = DeliveryEffect("save_state", source)
        source["state"]["items"].append(3)
        self.assertEqual((1, 2), effect.payload["state"]["items"])
        self.assertEqual(frozenset({"a", "b"}), effect.payload["paths"])
        with self.assertRaises(TypeError):
            effect.payload["new"] = True
        with self.assertRaises(FrozenInstanceError):
            effect.kind = "changed"

    def test_result_preserves_effect_and_message_order(self):
        first = DeliveryEffect("save_state", {"revision": 2})
        second = DeliveryEffect("write_report", {"path": "report.md"})
        result = DeliveryResult(
            effects=(first, second),
            stdout=("saved", "reported"),
            stderr=("warning",),
            exit_code=0,
        )
        self.assertEqual((first, second), result.effects)
        self.assertEqual(("saved", "reported"), result.stdout)
        self.assertEqual(("warning",), result.stderr)

    def test_result_rejects_ambiguous_container_types(self):
        with self.assertRaisesRegex(TypeError, "effects must be tuple"):
            DeliveryResult(effects=[], stdout=(), stderr=(), exit_code=0)
        with self.assertRaisesRegex(TypeError, "exit_code must be int"):
            DeliveryResult(effects=(), stdout=(), stderr=(), exit_code=False)

    def test_thaw_returns_mutable_copy_of_frozen_payload(self):
        effect = DeliveryEffect(
            "save_state",
            {"state": {"items": ["first"]}, "paths": {"a", "b"}},
        )
        mutable = thaw(effect.payload)
        mutable["state"]["items"].append("second")
        mutable["paths"].add("c")
        self.assertEqual(["first", "second"], mutable["state"]["items"])
        self.assertEqual({"a", "b", "c"}, mutable["paths"])
        self.assertEqual(("first",), effect.payload["state"]["items"])


if __name__ == "__main__":
    unittest.main()

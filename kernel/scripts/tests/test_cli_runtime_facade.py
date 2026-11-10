"""Compatibility contract for the public CLI runtime facade."""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import cli_runtime
from mae_flow_core.cli_commands import evidence_registry
from mae_flow_core.cli_commands.wiring import api


class CliRuntimeFacadeTests(unittest.TestCase):
    def test_legacy_evidence_rule_objects_remain_exported(self):
        for name in (
                "_AGENT_EVIDENCE",
                "_DELIVERY_EVIDENCE",
                "_QUALITY_EVIDENCE",
                "_WORKFLOW_EVIDENCE"):
            with self.subTest(name=name):
                self.assertIs(
                    getattr(evidence_registry, name),
                    getattr(cli_runtime, name),
                )

    def test_flow_reads_follow_composition_registry_updates(self):
        original = api.FLOW
        marker = object()
        try:
            api.FLOW = marker
            self.assertIs(marker, cli_runtime.FLOW)
        finally:
            api.FLOW = original

    def test_evidence_rule_overrides_reach_registry_module(self):
        original = cli_runtime._AGENT_EVIDENCE
        marker = object()
        try:
            cli_runtime._AGENT_EVIDENCE = marker
            self.assertIs(marker, evidence_registry._AGENT_EVIDENCE)
        finally:
            cli_runtime._AGENT_EVIDENCE = original


if __name__ == "__main__":
    unittest.main()

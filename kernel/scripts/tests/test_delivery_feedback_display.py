"""Opaque identities stay separate from explanatory feedback in current output."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mae_flow_core.cli_commands.delivery_support import render_delivery_feedback


class FeedbackDisplayTests(unittest.TestCase):
    def test_identity_and_multiline_summary_are_separate_json_fields(self):
        identity = "pipeline:" + "a" * 40 + ":CODECHECK+COMPILE:r0@" + "a" * 40
        item = {"id": identity, "source": "pipeline", "source_id": "CODECHECK+COMPILE",
                "summary": 'FAILED stage=CodeCheck2.0\n含冒号：与"引号"', "material": "report.txt"}
        output = render_delivery_feedback({"delivery_loop": {
            "active_batch_id": "current", "batches": [
                {"batch_id": "old", "items": [{"id": "obsolete"}]},
                {"batch_id": "current", "items": [item]},
            ]}})
        rows = json.loads(output[output.index("[\n"):])
        self.assertEqual([item], rows)
        self.assertNotIn(identity + "：FAILED", output)
        self.assertNotIn("obsolete", output)

    def test_no_active_batch_has_no_receipt_instructions(self):
        self.assertEqual("", render_delivery_feedback({}))

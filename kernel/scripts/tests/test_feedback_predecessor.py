import copy
import os
import sys
import unittest
from unittest import mock
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from mae_flow_core import cli_runtime  # noqa: initialize command wiring
from mae_flow_core.cli_commands import host_receipts as receipts


class FeedbackPredecessorTests(unittest.TestCase):
    def setUp(self):
        self.state = {"current": "build", "delivery_loop": None}
        projection = receipts.host_projection(self.state, "selection-reconcile", {})
        proof = {"schema": receipts.PROOF_SCHEMA, "task_id": "task-20",
                 "action": "selection-reconcile", "payload_digest": "signed-payload"}
        self.record = {"schema": receipts.RECEIPT_SCHEMA, "proof": proof,
                       "payload_digest": "signed-payload", "projection": projection,
                       "projection_digest": receipts._digest(projection)}
        self.scan = mock.patch.object(receipts, "_scan_receipts", side_effect=lambda state:
                                     iter([({"task_id": "task-20"}, self.record)]))
        self.signature = mock.patch.object(receipts, "_verify_rsa_sha256", return_value=True)
        self.scan.start(); self.signature.start()
        self.addCleanup(self.scan.stop); self.addCleanup(self.signature.stop)

    def test_step_movement_allows_predecessor_but_not_completion_attestation(self):
        self.state["current"] = "external_verify"
        before = copy.deepcopy(self.state)
        self.assertTrue(receipts.trusted_feedback_loop(self.state))
        self.assertFalse(receipts.trusted_current_lifecycle(self.state, ["selection-reconcile"]))
        self.assertEqual(before, self.state)
        self.assertEqual("build", self.record["projection"]["current"])

    def test_unrelated_facts_do_not_block_feedback_or_become_pipeline_proof(self):
        self.state.update(current="external_verify", user_intervention={"updated": True},
                          quality={"external_verification": {"verdict": "PASS"}})
        self.assertTrue(receipts.trusted_feedback_loop(self.state))
        self.assertFalse(receipts.trusted_pipeline_projection(self.state, {"verdict": "PASS"}))
        self.assertFalse(receipts.trusted_current_lifecycle(self.state, ["selection-reconcile"]))

    def test_feedback_changes_and_bad_signatures_stay_rejected(self):
        for field, value in (("delivery_loop", {}),):
            with self.subTest(field=field):
                changed = dict(self.state, current="external_verify", **{field: value})
                self.assertFalse(receipts.trusted_feedback_loop(changed))
        with mock.patch.object(receipts, "_verify_rsa_sha256", return_value=False):
            self.assertFalse(receipts.trusted_feedback_loop(self.state))
        self.record["projection"]["current"] = "external_verify"
        self.assertFalse(receipts.trusted_feedback_loop(self.state))

    def test_empty_recovery_ignores_all_historical_receipt_actions(self):
        for loop in (None, {}, {"schema": "mae-flow-delivery-loop/1", "batches": [],
                               "published": None, "close_events": [], "delivery_round": 3}):
            with self.subTest(loop=loop):
                receipts.verify_feedback_facts({"current": "delivery_review", "delivery_loop": loop})

    def test_close_seals_feedback_without_locking_new_host_work(self):
        loop = {"batches": [{"batch_id": "old", "status": "closed"}],
                "active_batch_id": "", "close_events": [{"reason": "merged"}]}
        self.state.update(current="end", delivery_loop=loop)
        projection = receipts.host_projection(self.state, "close", {})
        self.record.update(projection=projection, projection_digest=receipts._digest(projection))
        self.record["proof"]["action"] = "close"
        self.state["current"] = "delivery_review"
        receipts.verify_feedback_facts(self.state)
        self.assertTrue(receipts.trusted_feedback_loop(self.state))
        self.assertFalse(receipts.trusted_current_lifecycle(self.state, ["close"]))
        self.state["delivery_loop"]["batches"][0]["status"] = "forged"
        with self.assertRaises(SystemExit):
            receipts.verify_feedback_facts(self.state)

    def test_unsigned_nonempty_feedback_is_not_endorsed_by_new_host_action(self):
        with mock.patch.object(receipts, "_scan_receipts", return_value=iter([])):
            with self.assertRaises(SystemExit):
                receipts.verify_feedback_facts({"delivery_loop": {"batches": [{"results": ["forged"]}]}})


if __name__ == "__main__":
    unittest.main()

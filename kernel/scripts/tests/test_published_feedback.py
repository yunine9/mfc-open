import copy
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from mae_flow_core import cli_runtime  # noqa
from mae_flow_core.cli_commands import delivery_commands as delivery, host_receipts
from mae_flow_core.cli_commands.published_feedback import record_publication
from mae_flow_core.cli_commands.feedback_control import scheduled_items
from mae_flow_core.cli_commands.delivery_support import render_delivery_feedback


class PublishedFeedbackTests(unittest.TestCase):
    def test_same_push_after_merged_close_is_a_read_only_idempotent_replay(self):
        sha = "b" * 40
        value = {"current": "end", "history": [], "delivery_loop": {
            "schema": delivery.STATE_SCHEMA,
            "published": {"sha": sha, "receipt": {
                "sha": sha, "ref": "refs/heads/task", "remote": "origin"}},
            "active_batch_id": "", "batches": [],
            "close_events": [{"reason": "merged", "sha": sha}],
        }}
        payload = {"receipt": {
            "sha": sha, "ref": "refs/heads/task", "remote": "origin"}}
        output = io.StringIO()
        with mock.patch.object(delivery, "_capability"), \
                mock.patch.object(host_receipts, "trusted_feedback_loop", return_value=False), \
                mock.patch.object(host_receipts, "save_with_host_proof") as save, \
                contextlib.redirect_stdout(output):
            record_publication(value, payload, {})
        self.assertTrue(json.loads(output.getvalue())["idempotent"])
        save.assert_not_called()

    def test_first_push_with_uninitialized_delivery_loop_passes_trusted_check(self):
        # task-22 实测 bug:首次推送时 delivery_loop 还是 None,收据里封的是
        # 空 {} 的 digest;record_publication 先调 _loop() 把它初始化成完整
        # 结构,再查 trusted_feedback_loop,新 digest 跟收据旧 digest 对不上,
        # 永远 die。修法:_loop() 移到 trusted 检查之后。
        fresh = "b" * 40
        value = {"current": "external_verify", "history": [],
                 # delivery_loop 是 None——首次推送、还没开过反馈批次
                 "delivery_loop": None}
        payload = {"receipt": {
            "sha": fresh, "ref": "refs/heads/task", "remote": "origin"}}
        output = io.StringIO()

        def trusted_before_initialization(state):
            self.assertIsNone(state["delivery_loop"])
            return True

        with mock.patch.object(delivery, "_capability"), \
                mock.patch.object(host_receipts, "verify_feedback_facts", side_effect=trusted_before_initialization), \
                mock.patch.object(host_receipts, "save_with_host_proof") as save, \
                mock.patch.object(delivery, "_head", return_value=fresh), \
                contextlib.redirect_stdout(output):
            record_publication(value, payload, {})
        result = json.loads(output.getvalue())
        self.assertFalse(result["idempotent"])
        save.assert_called_once_with(value, {})
        # _loop() 通过后才初始化,published 写进去了
        self.assertEqual(fresh, value["delivery_loop"]["published"]["sha"])

    def test_mixed_batch_receipt_requires_human_but_not_retired_ci(self):
        old, fresh = "a" * 40, "b" * 40
        active = {"batch_id": "mixed", "base_sha": fresh, "status": "repairing", "items": [
            {"id": "old-ci", "source": "pipeline", "source_id": old + ":COMPILE"},
            {"id": "human", "source": "workspace", "summary": "接口意见"}]}
        value = {"current": "feedback_triage", "history": [], "delivery_loop": {
            "schema": delivery.STATE_SCHEMA, "published": {"sha": fresh},
            "active_batch_id": "mixed", "batches": [active]}}
        payload = {"batch_id": "mixed", "results": [
            {"id": "human", "status": "explained", "summary": "已说明兼容策略"}]}
        with mock.patch.object(delivery, "_payload", return_value=payload), \
                mock.patch.object(delivery, "_verify_host_proof", return_value={}), \
                mock.patch.object(delivery, "_capability"), \
                mock.patch.object(delivery, "host_managed_continuous_review", return_value=False), \
                mock.patch.object(delivery, "_head", return_value=fresh), \
                mock.patch.object(delivery, "save_with_host_proof"), contextlib.redirect_stdout(io.StringIO()):
            delivery._result({}, value, SimpleNamespace(file="fixture.json"))
        self.assertEqual(["human"], [item["id"] for item in active["results"]])
        self.assertEqual("closed", active["status"])
        self.assertEqual(2, len(active["items"]))

    def test_new_push_retires_only_old_ci_without_forging_pass_or_dropping_human(self):
        for mode in ("old", "mixed", "current", "unknown"):
            with self.subTest(mode=mode):
                old, fresh = "a" * 40, "b" * 40
                source = fresh if mode == "current" else "" if mode == "unknown" else old
                items = [{"id": "ci", "source": "pipeline", "source_id": source + ":COMPILE", "summary": "OLD_ONLY"}]
                if mode == "mixed":
                    items.append({"id": "human", "source": "workspace", "summary": "处理接口意见"})
                active = {"batch_id": "batch", "base_sha": old, "status": "repairing", "items": items}
                value = {"current": "feedback_triage", "history": [],
                         "quality": {"external_verification": {"sha": old, "verdict": "RED"}},
                         "delivery_loop": {"schema": delivery.STATE_SCHEMA, "active_batch_id": "batch", "batches": [active]}}
                quality = copy.deepcopy(value["quality"])
                with mock.patch.object(delivery, "_capability"), mock.patch.object(delivery, "_head", return_value=fresh), \
                        mock.patch.object(host_receipts, "verify_feedback_facts"), \
                        mock.patch.object(host_receipts, "save_with_host_proof"), contextlib.redirect_stdout(io.StringIO()):
                    payload = {"receipt": {"sha": fresh, "ref": "refs/heads/task", "remote": "origin"}}
                    record_publication(value, payload, {})
                    after = copy.deepcopy(value)
                    record_publication(value, payload, {})
                    self.assertEqual(after, value, "同 SHA 重放幂等")
                self.assertEqual(quality, value["quality"], "推送不篡改旧 RED 或伪造 PASS")
                self.assertEqual(items, active["items"], "保留原始反馈")
                if mode == "old":
                    self.assertEqual("superseded", active["status"])
                    self.assertEqual("external_verify", value["current"])
                    self.assertEqual([], scheduled_items(value, active))
                    self.assertNotIn("OLD_ONLY", render_delivery_feedback(value))
                elif mode == "mixed":
                    self.assertEqual("repairing", active["status"])
                    self.assertEqual(["human"], [i["id"] for i in scheduled_items(value, active)])
                    self.assertNotIn("OLD_ONLY", render_delivery_feedback(value))
                    self.assertIn("处理接口意见", render_delivery_feedback(value))
                else:
                    self.assertEqual("repairing", active["status"])
                    self.assertEqual(items, scheduled_items(value, active))


if __name__ == "__main__":
    unittest.main()

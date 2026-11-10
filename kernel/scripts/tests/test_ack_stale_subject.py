#!/usr/bin/env python3
"""真实回答按步骤复用，遗留内容指纹不再作废用户决定。"""

import contextlib
import json
import os
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_commands.ack import _implicit_ack_verified  # noqa: E402
from mae_flow_core.cli_commands import state_config  # noqa: E402
from mae_flow_core.cli_commands.wiring import api  # noqa: E402

# ack 经 api 迟绑定取 _step_entered_at 等;单测不走 CLI 引导,补注册。
api.register(state_config)


@contextlib.contextmanager
def in_directory(path):
    original = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(original)


CONFIRM = "Story 与实施附录无需再调整，确认进入编码"


def ledger_row(sha, when="2026-08-26 10:00:00"):
    return {
        "id": "m1", "at": when, "step": "story",
        "text": json.dumps({"answers": {"Story 是否确认": CONFIRM}},
                           ensure_ascii=False),
        "approval_subject_sha256": sha,
        "approval_subject_id": sha[:16],
    }


class StaleSubjectAckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.step = {"user_ack": True, "confirmation_answers": [CONFIRM]}
        self.state = {
            "current": "story",
            "config": {"单号": "REQ-1"},
            "approval_subject": {
                "step": "story", "sha256": "n" * 64, "id": "n" * 16,
                "paths": [".mae-flow-work/REQ-1/story.md",
                          ".mae-flow-work/REQ-1/implementation.md"],
            },
        }

    def tearDown(self):
        self.temp.cleanup()

    def _write_ledger(self, rows):
        with open(os.path.join(self.temp.name, ".mae-flow.json.usermsg"),
                  "w", encoding="utf-8") as out:
            json.dump(rows, out, ensure_ascii=False)

    def test_changed_content_keeps_actual_confirmation(self):
        self._write_ledger([ledger_row("o" * 64)])
        with in_directory(self.temp.name):
            self.assertEqual((True, ""), _implicit_ack_verified(self.step, self.state))

    def test_no_answer_or_another_step_cannot_supply_confirmation(self):
        row = ledger_row("o" * 64)
        row["step"] = "open"
        for rows in ([], [row]):
            self._write_ledger(rows)
            with in_directory(self.temp.name):
                self.assertFalse(_implicit_ack_verified(self.step, self.state)[0])

    def test_halfwidth_comma_and_fullwidth_comma_are_the_same_confirmation(self):
        for standard, answer in ((CONFIRM, CONFIRM.replace("，", ",")),
                                 (CONFIRM.replace("，", ","), CONFIRM)):
            with self.subTest(standard=standard, answer=answer):
                self.step["confirmation_answers"] = [standard]
                row = ledger_row("n" * 64)
                row["text"] = json.dumps({"answers": {"Story 是否确认": answer}}, ensure_ascii=False)
                self._write_ledger([row])
                with in_directory(self.temp.name):
                    self.assertEqual((True, ""), _implicit_ack_verified(self.step, self.state))

    def test_punctuation_compatibility_does_not_accept_refusal_or_empty_answer(self):
        for answer, sha in (("不确认,需要修改", "n" * 64),
                            (",", "n" * 64)):
            row = ledger_row(sha)
            row["text"] = json.dumps({"answers": {"Story 是否确认": answer}}, ensure_ascii=False)
            self._write_ledger([row])
            with in_directory(self.temp.name):
                self.assertFalse(_implicit_ack_verified(self.step, self.state)[0])

    def test_three_choice_receipt_maps_punctuation_without_using_option_order(self):
        from mae_flow_core.workflow.completion import receipt_choice
        step = {"choices": ["a", "b", "c"], "choice_answers": {
            "a": ["方案甲，执行"], "b": ["方案乙，执行"], "c": ["方案丙，执行"]}}
        receipt = {"askuser": {"questions": [{"options": [
            "方案丙,执行", "方案甲,执行", "方案乙,执行"]}]}}
        self.assertEqual("b", receipt_choice(step, receipt, "方案乙，执行"))
        self.assertEqual("", receipt_choice(step, receipt, "不存在的方案，执行"))

    def test_direct_human_reply_does_not_need_to_repeat_standard_button(self):
        for answer in ("可以", "确认并继续", "没问题", "确认 并继续", "确认\n并继续", " 没 问题 "):
            row = ledger_row("n" * 64)
            row["text"] = answer
            self._write_ledger([row])
            with in_directory(self.temp.name):
                self.assertEqual((True, ""), _implicit_ack_verified(self.step, self.state))
        for answer in ("不确认", "什么意思？", "需要调整"):
            row["text"] = answer
            self._write_ledger([row])
            with in_directory(self.temp.name):
                self.assertFalse(_implicit_ack_verified(self.step, self.state)[0])

    def test_matching_stamp_still_passes(self):
        self._write_ledger([ledger_row("n" * 64)])
        with in_directory(self.temp.name):
            ok, why = _implicit_ack_verified(self.step, self.state)
        self.assertEqual((True, ""), (ok, why))


if __name__ == "__main__":
    unittest.main()

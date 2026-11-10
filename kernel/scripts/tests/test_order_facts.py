#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下单事实(.mae-flow-order.json,宿主契约):云端表单收齐的配置事实
由内核机械消费,不靠模型转述。

为什么要这个契约(2026-08-19,用户拍板"不等出问题再修"):云端把
单号/基线/工号/交付方式在下单表单收齐后,原来只能写进开场 prompt 靠
模型转述给 config-review——弱模型会漏、会再问一遍(交付方式折成是/否
卡的实战同款)。文件是机械读取:config-review 拿它补缺省,确认卡不再
问交付方式,workflow_select 无捕获答案时以它为准。

三条纪律钉在这里:
- --set 显式给的赢(打回改口永远压过下单值);
- 捕获的卡上答案赢(用户中途改口压过下单值,fallback 只兜"没人问过");
- 文件缺席=一切照旧(非云端形态一个字不变)。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAE = os.path.join(ROOT, "scripts", "mae-flow.py")
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.cli_commands import ack  # noqa: E402
from mae_flow_core.cli_commands.shared import resolve_order_workflow  # noqa: E402


SELECT_STEP = {
    "choices": ["full", "hotfix", "tweak", "review"],
    "choice_answers": {
        "full": ["完整开发"], "hotfix": ["已定位问题修复"],
        "tweak": ["局部修改"], "review": ["处理评审意见"],
    },
}


class ResolveTests(unittest.TestCase):
    def test_accepts_key_or_exact_label_only(self):
        self.assertEqual(
            resolve_order_workflow(SELECT_STEP, {"交付方式": "tweak"}), "tweak")
        self.assertEqual(
            resolve_order_workflow(SELECT_STEP, {"交付方式": "局部修改"}),
            "tweak")
        # 子串/叙述句不认——与 ack 的对账纪律同款,防"这次不是 hotfix"误触
        self.assertEqual(
            resolve_order_workflow(SELECT_STEP, {"交付方式": "走局部修改吧"}),
            "")
        self.assertEqual(resolve_order_workflow(SELECT_STEP, {}), "")


class ChoiceFallbackTests(unittest.TestCase):
    def _verify(self, choice, facts):
        with tempfile.TemporaryDirectory() as project, \
                mock.patch.object(ack, "_current_ack_messages",
                                  return_value=[]), \
                mock.patch.object(ack, "_out_of_scope_ack_reason",
                                  return_value=""), \
                mock.patch.object(ack, "_ack_failure", return_value=1):
            cwd = os.getcwd()
            os.chdir(project)
            try:
                if facts is not None:
                    with open(".mae-flow-order.json", "w",
                              encoding="utf-8") as stream:
                        json.dump(facts, stream, ensure_ascii=False)
                return ack._choice_verified(
                    SELECT_STEP, {"current": "workflow_select"}, choice)
            finally:
                os.chdir(cwd)

    def test_order_fact_authorizes_choice_without_card(self):
        accepted, why = self._verify("tweak", {"交付方式": "局部修改"})
        self.assertTrue(accepted, why)

    def test_mismatch_is_rejected_with_order_truth(self):
        accepted, why = self._verify("full", {"交付方式": "局部修改"})
        self.assertFalse(accepted)
        self.assertIn("下单时选定", why)

    def test_absent_file_keeps_old_refusal(self):
        accepted, why = self._verify("tweak", None)
        self.assertFalse(accepted)
        self.assertIn("真实选项回答", why)


class ConfigReviewMergeTests(unittest.TestCase):
    def test_order_fills_missing_and_explicit_set_wins(self):
        """端到端跑真 CLI:init 后 config-review 缺省项由下单事实补上,
        --set 显式给的基线分支压过下单值;Q2 被抑制(不再列四项)。"""
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(["git", "init", "-q", "-b", "master", project],
                           check=True, capture_output=True)
            subprocess.run(["git", "-C", project, "commit", "-q",
                            "--allow-empty", "-m", "init"],
                           check=True, capture_output=True,
                           env={**os.environ,
                                "GIT_AUTHOR_NAME": "t",
                                "GIT_AUTHOR_EMAIL": "t@t",
                                "GIT_COMMITTER_NAME": "t",
                                "GIT_COMMITTER_EMAIL": "t@t"})
            req = os.path.join(project, "req.md")
            with open(req, "w", encoding="utf-8") as stream:
                stream.write("需求:演练下单事实契约,补齐配置不再逐项问。\n")
            with open(os.path.join(project, ".mae-flow-order.json"), "w",
                      encoding="utf-8") as stream:
                json.dump({"单号": "DTS2026081900001", "基线分支": "master",
                           "工号": "cloudbot", "交付方式": "局部修改",
                           # 跨仓拆单形态:方案文档由宿主落盘并在此指路
                           "需求文档": "req.md",
                           "UT生成方式": "参考仓内写法",
                           "execution_contract": {
                               "schema": "mae-flow-execution/1",
                               "host": "cloud",
                               "compile": "pipeline",
                               "ut_write": "agent",
                               "ut_run": "pipeline",
                               "codecheck": "pipeline",
                           }},
                          stream, ensure_ascii=False)
            env = {**os.environ, "MAE_FLOW_NO_NOTIFY": "1"}
            init = subprocess.run(
                [sys.executable, MAE, "init"], cwd=project,
                text=True, capture_output=True, timeout=30, env=env)
            self.assertEqual(0, init.returncode, init.stderr)
            current = subprocess.run(
                [sys.executable, MAE, "current"], cwd=project,
                text=True, capture_output=True, timeout=30, env=env)
            self.assertEqual(0, current.returncode,
                             current.stdout + current.stderr)
            self.assertIn("验证环境 = 权威流水线", current.stdout)
            self.assertIn("UT生成方式=<值>", current.stdout)
            self.assertNotIn("编译方式=<值>", current.stdout)
            self.assertNotIn("UT运行命令=<值>", current.stdout)
            review = subprocess.run(
                [sys.executable, MAE, "config-review",
                 "--set", "基线分支=develop"],  # 显式改口:压过下单值
                cwd=project, text=True, capture_output=True,
                timeout=30, env=env)
            self.assertEqual(0, review.returncode,
                             review.stdout + review.stderr)
            with open(os.path.join(project, ".mae-flow.json"),
                      encoding="utf-8") as stream:
                state = json.load(stream)
            pending = state["config_review"]["config"]
            contract = state["execution_contract"]
            self.assertEqual("order", contract["source"])
            self.assertEqual("pipeline", contract["compile"])
            self.assertEqual("pipeline", contract["ut_run"])
            self.assertEqual("pipeline", contract["codecheck"])
            self.assertEqual(pending["单号"], "DTS2026081900001",
                             "缺省单号该由下单事实补上")
            self.assertEqual(pending["需求文档"], "req.md",
                             "需求文档同样走下单事实(跨仓拆单形态)")
            self.assertEqual(pending["工号"], "cloudbot")
            self.assertEqual(pending["基线分支"], "develop",
                             "--set 显式给的必须压过下单值")
            self.assertEqual(pending["UT生成方式"], "参考仓内写法")
            self.assertNotIn("编译方式", pending)
            self.assertNotIn("UT运行命令", pending)
            self.assertEqual(pending["单号类型"], "fix", "DTS→fix 推导照旧")
            self.assertIn("UT 编写方式: 参考仓内写法", review.stdout)
            self.assertIn("验证环境: 权威流水线", review.stdout)
            self.assertNotIn("编译方式:", review.stdout)
            self.assertNotIn("UT运行命令:", review.stdout)
            self.assertIn("Q2 不问", review.stdout,
                          "下单已选交付方式,确认卡不许再问一遍")
            self.assertNotIn("Q2 交付方式", review.stdout)


if __name__ == "__main__":
    unittest.main()

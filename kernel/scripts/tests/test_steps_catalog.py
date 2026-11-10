#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宿主契约:steps --json 的机读目录。

为什么有这一档(2026-08-18 云端实战逮住):宿主的下单表单要让人先选
交付方式,它自造了一套"快速/慢速车道"——内核只认 完整开发/已定位问题
修复/局部修改/处理评审意见。两套词对不上,于是用户在下单时选过的答案
在 workflow_select 那张卡上永远命中不了,人被重复问一遍交付方式。

分类是内核的领地。这里把它变成明面上的契约:宿主问一句就拿到代号与
**选项原文**,`answers` 里那句话就是它该回传、也是 done --choice 对账
的那句。这条用例钉住的是"目录必须与真流程一致",不是某个具体措辞:
措辞可以改,改了这里跟着 flow.json 走;能漂的是宿主,漂了它就哑,
而不是悄悄退回自造一套。
"""

import json
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.cli_commands.done_status import _steps_catalog  # noqa: E402
from mae_flow_core import cli_parser  # noqa: E402


def load_flow():
    with open(os.path.join(ROOT, "flow", "flow.json"), encoding="utf-8") as f:
        return json.load(f)


class StepsCatalogTests(unittest.TestCase):
    def setUp(self):
        self.flow = load_flow()
        self.catalog = _steps_catalog(self.flow, None)

    def test_lists_every_workflow_choice(self):
        keys = [item["key"] for item in self.catalog["workflows"]]
        self.assertEqual(keys, self.flow["steps"]["workflow_select"]["choices"])

    def test_review_is_not_for_new_orders(self):
        """review 仅限已交付单(步骤文档的禁令):目录要机器可读地标出来,
        宿主的下单表单照它摆——否则新单选了 review,跳过设计与定稿还不碰
        规格,必错。其余三项照常可选。"""
        flags = {item["key"]: item["for_new_orders"]
                 for item in self.catalog["workflows"]}
        self.assertEqual(flags, {
            "full": True, "hotfix": True, "tweak": True, "review": False,
        })

    def test_answers_are_the_texts_done_verifies_against(self):
        """目录给的选项原文必须就是 workflow_select 对账用的那几句——
        宿主照目录出卡、照目录回传,done --choice 才认得出来。"""
        answers = self.flow["steps"]["workflow_select"]["choice_answers"]
        for item in self.catalog["workflows"]:
            self.assertEqual(item["answers"], answers[item["key"]])
            self.assertTrue(item["label"])

    def test_descriptions_only_explain_when_to_choose_each_workflow(self):
        descriptions = self.flow["steps"]["workflow_select"][
            "choice_descriptions"]
        for item in self.catalog["workflows"]:
            self.assertEqual(item["description"], descriptions[item["key"]])
            self.assertTrue(item["description"])
            self.assertNotIn("步", item["description"])
            self.assertNotIn("拍板", item["description"])

    def test_chain_is_the_real_chain_with_user_gates_marked(self):
        chains = {item["key"]: [step["id"] for step in item["steps"]]
                  for item in self.catalog["workflows"]}
        for key, chain in chains.items():
            self.assertEqual(chain[0], "config_confirm", key)
            self.assertIn("workflow_select", chain, key)
            for sid in chain:
                self.assertIn(sid, self.flow["steps"], f"{key} 链上有幽灵步 {sid}")
        # 交付方式不同,链就不同(否则"选它"没有意义)
        self.assertNotEqual(chains["full"], chains["tweak"])
        gates = {step["id"] for item in self.catalog["workflows"]
                 for step in item["steps"] if step["user_ack"]}
        self.assertIn("workflow_select", gates, "用户确认标记丢了宿主就不知道哪步会举卡")

    def test_flag_is_parseable(self):
        args = cli_parser.build_parser().parse_args(["steps", "--json"])
        self.assertTrue(args.json)
        self.assertFalse(
            cli_parser.build_parser().parse_args(["steps"]).json,
            "不带 --json 时仍是给人看的全景,别把人话输出改掉")


if __name__ == "__main__":
    unittest.main()

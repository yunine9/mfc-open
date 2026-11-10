#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 规则总账红线:无残留、无死锁。

这两条不是风格约束，是这个项目反复踩的两类真实故障:
  残留 — 退役机制留下读取方(COMPILE 令牌没了写入方却仍参与提交裁决),
         于是"永远不成立"的条件把流程拦死;
  死锁 — 绝对类拦截只说"禁止"，不给出路，Agent 只能反复试写法变体。
"""

import ast
import json
import os
import sys
import unittest


TESTS = os.path.abspath(os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(TESTS, "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
for path in (TESTS, SCRIPTS):
    if path not in sys.path:
        sys.path.insert(0, path)

from architecture_rules import (  # noqa: E402
    dead_gate_context_fields,
    gate_rule_inventory,
    hook_token_evidence_violations,
    hook_token_writers,
)


CONTRACT = os.path.join(TESTS, "gate_rule_contract.json")
PARSER = os.path.join(SCRIPTS, "mae_flow_core", "cli_parser.py")
ESCAPE_KINDS = ("permit", "comply", "user-terminal")
TIERS = ("A", "B", "C")


def load_contract():
    with open(CONTRACT, encoding="utf-8") as stream:
        return json.load(stream)["rules"]


def cli_subcommands():
    """Every subcommand the CLI actually accepts."""
    with open(PARSER, encoding="utf-8") as stream:
        tree = ast.parse(stream.read())
    return {
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and getattr(node.func, "attr", "") == "add_parser"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    }


class GateRuleContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory = gate_rule_inventory(ROOT)
        cls.contract = load_contract()
        cls.subcommands = cli_subcommands()

    def test_contract_matches_production_rules_exactly(self):
        """无残留:删规则必须删条目，新增规则必须登记。"""
        self.assertEqual(
            sorted(self.inventory),
            sorted(self.contract),
            "Gate 规则与总账不一致——多出的是未登记的新规则，"
            "少掉的是删了代码没删条目(或删了条目没删代码)",
        )

    def test_declared_kind_matches_the_real_decision_class(self):
        for rule, entry in sorted(self.contract.items()):
            with self.subTest(rule=rule):
                self.assertEqual(
                    self.inventory[rule]["kind"], entry["kind"],
                    "裁决类会自动追加放行令出口，绝对类不会;"
                    "类别声明错了，无死锁结论就是假的")

    def test_every_rule_declares_a_reachable_escape(self):
        """无死锁:每条规则都要有出路，声明 CLI 命令的必须真实存在。"""
        for rule, entry in sorted(self.contract.items()):
            with self.subTest(rule=rule):
                escape = entry["escape"]
                self.assertIn(entry["tier"], TIERS)
                if escape.startswith("cli:"):
                    command = escape[len("cli:"):]
                    self.assertIn(
                        command, self.subcommands,
                        "逃生口指向不存在的子命令")
                else:
                    self.assertIn(escape, ESCAPE_KINDS)

    def test_permit_class_escapes_through_the_break_glass_path(self):
        for rule, entry in sorted(self.contract.items()):
            if entry["kind"] != "permit":
                continue
            with self.subTest(rule=rule):
                self.assertEqual(
                    "permit", entry["escape"],
                    "裁决类的出口就是 strike_escalation 追加的一次性放行令")

    def test_absolute_messages_carry_the_escape_they_declare(self):
        """绝对类不会被追加出口，所以出路必须写在文案里。"""
        for rule, entry in sorted(self.contract.items()):
            if entry["kind"] != "absolute":
                continue
            with self.subTest(rule=rule):
                evidence = entry.get("evidence", "")
                self.assertTrue(
                    evidence,
                    "绝对类必须声明文案里指向出路的关键词")
                self.assertIn(
                    evidence, self.inventory[rule]["message"],
                    "拦截文案没有给出所声明的出路——Agent 会反复试写法变体")

    def test_break_glass_guidance_names_a_real_command(self):
        from mae_flow_core.guard.permits import strike_escalation

        guidance = strike_escalation(
            1, 3, False, "block-1", "/plugin/scripts/mae-flow.py")
        self.assertIn("allow", guidance)
        self.assertIn("messages", guidance)
        for command in ("allow", "messages"):
            self.assertIn(command, self.subcommands)

        unattended = strike_escalation(
            1, 3, True, "block-1", "/plugin/scripts/mae-flow.py")
        self.assertIn("moonlight", unattended)
        self.assertIn("moonlight", self.subcommands)

    def test_no_gate_reads_an_evidence_source_nobody_writes(self):
        """无残留:退役证据源必须连读取方一起消失。

        COMPILE/CODECHECK 令牌曾在写入方被移除后继续参与提交裁决，于是"永远
        不成立"的条件把提交拦死。以后再出现这种半套机制，这条直接失败。
        """
        self.assertEqual([], hook_token_evidence_violations(ROOT))

    def test_only_unforgeable_user_interaction_still_issues_tokens(self):
        """ASKUSER 是唯一无法用别的方式证明的事实，其余都已退役。"""
        self.assertEqual(["ASKUSER", "UTRUN"], hook_token_writers(ROOT))


if __name__ == "__main__":
    unittest.main()


class DeadGateContextFieldTests(unittest.TestCase):
    def test_no_gate_context_field_is_carried_without_a_reader(self):
        """门禁 context 里不许有无人读的字段——那是"说了不做数"的来源。

        `allow_source_edit` 曾这样空转：current 展示了写入范围，活跃 Hook
        却不消费。现在它已恢复为步骤级源码授权，这条继续防止再次漂移。
        """
        self.assertEqual([], dead_gate_context_fields(ROOT))

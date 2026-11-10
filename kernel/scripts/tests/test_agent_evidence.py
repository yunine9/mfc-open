#!/usr/bin/env python3
"""Agent evidence depends on lifecycle, never return wording or fingerprints."""

import json
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.agent_evidence import (  # noqa: E402
    AgentEvidencePorts,
    AgentEvidenceRules,
)


def make_ports(**overrides):
    values = {
        "moonlight": lambda _state: False,
        "step_entered": lambda _state: "2026-07-29 10:00:00",
        "risk_acceptance": lambda _kind, _state: (False, ""),
        "script_path": lambda: "/repo/scripts/mae-flow.py",
        "risk_labels": {"COMPILE": "compile risk"},
        "finished_observation": lambda _kind, _step, _since: None,
        "quality_execution": lambda _kind, _step, _state: None,
        "askuser_tokens": lambda: {},
        "changed_source_files": lambda _state: (["src/main.py"], ""),
        "shell_output": lambda _command: "a" * 40,
        "argv_output": lambda _arguments: "commit",
        "blocking_dirty_source_paths": lambda _state: [],
        "open_observation": lambda _kind, _step, _since: None,
        "step_scoped_source_files": None,
    }
    values.update(overrides)
    return AgentEvidencePorts(**values)


class AgentEvidenceRuleTests(unittest.TestCase):
    def test_missing_return_has_actionable_message_without_receipt_language(self):
        result = AgentEvidenceRules(make_ports()).agent_ran(
            {"agent": "COMPILE", "statuses": ["OK"]},
            {"current": "build"},
        )
        self.assertFalse(result.passed)
        self.assertIn("本步内未检测到 COMPILE 子 Agent 已返回", result.reason)
        self.assertNotIn("令牌", result.reason)
        self.assertNotIn("XXX_RESULT", result.reason)

    def test_open_start_with_missing_return_forbids_automatic_redispatch(self):
        ports = make_ports()
        object.__setattr__(ports, "open_observation", lambda *_args: {
                "kind": "GRILL_FINAL",
                "step": "grill",
                "lifecycle": "started",
                "invocation_id": "toolu-final",
                "at": "2026-07-29 10:01:00",
            })

        result = AgentEvidenceRules(ports).agent_ran(
            {"agent": "GRILL_FINAL"}, {"current": "grill"})

        self.assertFalse(result.passed)
        self.assertIn("禁止自动重派", result.reason)
        self.assertNotIn("请启动对应专项 Agent", result.reason)
        self.assertNotIn("继续重跑", result.reason)

    def test_quality_step_prompts_share_the_missing_return_anti_loop_rule(self):
        for name in ("build.md",):
            with self.subTest(name=name):
                with open(
                        os.path.join(ROOT, "flow", "steps", name),
                        encoding="utf-8") as stream:
                    content = stream.read()
                self.assertIn("禁止自动重派", content)
                self.assertNotIn("状态不确定就重启 agent", content)

    def test_returned_lifecycle_passes_regardless_of_declared_statuses(self):
        observation = {
            "kind": "COMPILE", "step": "build",
            "lifecycle": "returned", "at": "2026-07-29 10:01:00",
            "detail": "任意自然语言；甚至说 FAIL 也不由这里裁决",
        }
        rules = AgentEvidenceRules(make_ports(
            finished_observation=lambda _kind, _step, _since: observation,
            quality_execution=lambda _kind, _step, _state: {"succeeded": True}))
        self.assertTrue(rules.agent_ran(
            {"agent": "COMPILE", "statuses": ["OK"]},
            {"current": "build"},
        ).passed)

    def test_quality_rejection_names_the_unreadable_transcript_cause(self):
        """实战教训 x2:fail-closed 的拒绝必须说清'我看不到什么'。
        只写'检查命令与退出状态'会把模型引去挖假线索(固定字段错误理论)。"""
        rules = AgentEvidenceRules(make_ports(
            finished_observation=lambda _k, _s, _e: {"detail": "编译通过"}))
        result = rules.agent_ran(
            {"agent": "COMPILE"}, {"current": "build"})
        self.assertFalse(result.passed)
        self.assertIn("宿主未提供可读的子会话记录", result.reason)
        self.assertIn("改写报告没有用", result.reason)

    def test_quality_return_without_real_execution_is_not_enough(self):
        observation = {
            "kind": "UT", "step": "verify_ut", "lifecycle": "returned",
            "at": "2026-07-29 10:01:00",
        }
        result = AgentEvidenceRules(make_ports(
            finished_observation=lambda *_args: observation,
        )).agent_ran({"agent": "UT"}, {"current": "verify_ut"})
        self.assertFalse(result.passed)
        self.assertIn("返回文字不能替代机器执行", result.reason)

    def test_interrupted_or_timeout_does_not_count_as_returned(self):
        for lifecycle in ("interrupted", "timeout"):
            with self.subTest(lifecycle=lifecycle):
                rules = AgentEvidenceRules(make_ports(
                    finished_observation=lambda *_args: None))
                self.assertFalse(rules.agent_ran(
                    {"agent": "REVIEWER"}, {"current": "story"}).passed)

    def test_askuser_keeps_real_interaction_evidence(self):
        rules = AgentEvidenceRules(make_ports(
            askuser_tokens=lambda: {
                "ASKUSER": {"at": "2026-07-29 10:01:00"}}))
        self.assertTrue(rules.agent_ran(
            {"agent": "ASKUSER"}, {"current": "grill"}).passed)


class ReviewerCoverageTests(unittest.TestCase):
    """实战事故(2026-08-09):standards 卡自相矛盾,reviewer 正当拒绝并返回
    NEEDS_INPUT;另一路返回的是半途状态行。旧证据"任一 returned 即绿",
    预检没发生流程却进了人工检视——派发过不等于检视过。"""

    STATE = {
        "current": "build_agent_review",
        "role_tasks": {
            "code-review-standards": {"step": "build_agent_review",
                                      "at": "2026-07-29 10:01:00"},
            "code-review-spec": {"step": "build_agent_review",
                                 "at": "2026-07-29 10:01:00"},
        },
    }
    SPEC = {"agent": "REVIEWER", "stage_role": "code-review"}

    def _rules(self, rows):
        return AgentEvidenceRules(make_ports(
            finished_observations=lambda _k, _s, _e: rows))

    def test_refusal_only_blocks_with_reissue_guidance(self):
        result = self._rules([
            {"detail": "我已读取任务卡…结论：NEEDS_INPUT。"},
        ]).agent_ran(self.SPEC, self.STATE)
        self.assertFalse(result.passed)
        self.assertIn("NEEDS_INPUT", result.reason)
        self.assertIn("重新执行本步的 role-task", result.reason)

    def test_one_return_for_two_cards_blocks(self):
        result = self._rules([
            {"detail": "工程质量检视结论:两条 WARNING…"},
        ]).agent_ran(self.SPEC, self.STATE)
        self.assertFalse(result.passed)
        self.assertIn("派发过不等于检视过", result.reason)

    def test_two_effective_returns_pass(self):
        result = self._rules([
            {"detail": "需求符合性:三条结论…"},
            {"detail": "工程质量:两条 WARNING…"},
        ]).agent_ran(self.SPEC, self.STATE)
        self.assertTrue(result.passed)

    def test_refusal_plus_status_line_is_not_coverage(self):
        """事故原样:一路 NEEDS_INPUT + 一路半途状态——只算一份有效,拦。"""
        result = self._rules([
            {"detail": "任务卡权威输入缺失,返回 NEEDS_INPUT"},
            {"detail": "Reading .gitignore and tenant-channels.yaml"},
        ]).agent_ran(self.SPEC, self.STATE)
        self.assertFalse(result.passed)

    def test_steps_without_stage_role_keep_single_return_semantics(self):
        result = self._rules([
            {"detail": "story 检视结论…"},
        ]).agent_ran({"agent": "REVIEWER"}, {"current": "story"})
        self.assertTrue(result.passed)

    def test_legacy_ports_without_plural_observations_still_work(self):
        rules = AgentEvidenceRules(make_ports(
            finished_observation=lambda _k, _s, _e: {"detail": "结论…"}))
        result = rules.agent_ran({"agent": "REVIEWER"}, {"current": "story"})
        self.assertTrue(result.passed)


class IssuanceEvidenceSymmetryTests(unittest.TestCase):
    """通用不变式(2026-08-09 死锁后确立):发卡侧每说一句"无需任务卡,直接 done",
    证据侧就必须有一条同源的放行路径——否则没卡不能派 Agent、没 Agent 没证据,
    流程原地锁死,而用户只能 accept-risk 或弃单。

    这条不变式覆盖全部 kind,新增拒发卡分支必须同时给出放行依据。
    """

    ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

    def _read(self, relative):
        with open(os.path.join(self.ROOT, relative), encoding="utf-8") as fh:
            return fh.read()

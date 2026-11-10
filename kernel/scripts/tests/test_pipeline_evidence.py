#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""流水线证据口:宿主喂逐维度平台事实,内核绑 HEAD 裁决并落盘。

为什么有这一档:云端契约把编译/UT"推迟给流水线",此前那三个 deferred
标记只活在内存里——没人落盘、没人事后核销,"推迟"等于一句没人兑现的
承诺。pipeline record 补上兑现侧:事实绑当前 HEAD 裁决(旧绿灯不背书
新代码,mvp 设计 14.5),结论写进 .mae-flow.json 的 quality.pipeline。

新契约不接受一个笼统的 pipeline success 冒充所有质量项。COMPILE、
UT、CODECHECK 必须各有事实；缺项、红灯、旧 SHA 与未知维度都要明确
失败。旧 ``adjudicate`` 仅保留兼容诊断，本文件同时钉住它不回归。
"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import host_env  # noqa: E402
from mae_flow_core.cli_commands.pipeline_commands import adjudicate  # noqa: E402
from mae_flow_core.quality.external_verification import (  # noqa: E402
    DIMENSIONS,
    adjudicate_pipeline,
    apply_pipeline_decision,
    obligations_passed,
)
from mae_flow_core import command_dispatch  # noqa: E402
from mae_flow_core import cli_parser  # noqa: E402


HEAD = "a" * 40
OTHER = "b" * 40


def _typed_facts(sha=HEAD, overrides=None):
    statuses = {dimension: "success" for dimension in DIMENSIONS}
    statuses.update(overrides or {})
    return {
        "sha": sha,
        "status": "success",
        "source": "test-pipeline",
        "git_push": {
            "sha": sha,
            "ref": "refs/heads/feature/REQ-1",
            "remote": "origin",
        },
        "checks": [
            {
                "dimension": dimension,
                "status": statuses[dimension],
                "job": dimension.lower(),
            }
            for dimension in DIMENSIONS
            if statuses[dimension] is not None
        ],
    }


def _cloud_state():
    return {"execution_contract": {
        "schema": "mae-flow-execution/1",
        "host": "cloud",
        "compile": "pipeline",
        "ut_write": "agent",
        "ut_run": "pipeline",
        "codecheck": "pipeline",
        "source": "order",
    }}


class AdjudicateTests(unittest.TestCase):
    def test_success_bound_to_head_passes(self):
        verdict, reason = adjudicate({"sha": HEAD, "status": "success"}, HEAD)
        self.assertEqual(verdict, "PASS")
        self.assertIn("绑定当前 HEAD", reason)

    def test_stale_sha_never_endorses_new_code(self):
        # 红线 14.5:旧绿灯不背书新代码——status 哪怕是 success,
        # SHA 对不上就只能是 STALE,绝不许判 PASS。
        verdict, reason = adjudicate({"sha": OTHER, "status": "success"}, HEAD)
        self.assertEqual(verdict, "STALE")
        self.assertIn("不背书新代码", reason)

    def test_failed_pipeline_is_red_not_pass(self):
        verdict, _ = adjudicate({"sha": HEAD, "status": "failed"}, HEAD)
        self.assertEqual(verdict, "RED")

    def test_missing_or_unknown_facts_are_invalid_not_guessed(self):
        # 诚实纪律:形状不对拒绝登记,不把 running/None 猜成某个结论。
        for facts in ({}, {"sha": HEAD}, {"status": "success"},
                      {"sha": HEAD, "status": "running"},
                      {"sha": "", "status": "success"}):
            verdict, _ = adjudicate(facts, HEAD)
            self.assertEqual(verdict, "INVALID", facts)


class TypedAdjudicateTests(unittest.TestCase):
    def test_three_green_dimensions_pass_and_are_individually_persisted(self):
        facts = _typed_facts()
        decision = adjudicate_pipeline(facts, HEAD, DIMENSIONS)
        self.assertEqual("PASS", decision.verdict)
        self.assertEqual(
            {dimension: "passed" for dimension in DIMENSIONS},
            {
                dimension: decision.checks[dimension]["status"]
                for dimension in DIMENSIONS
            },
        )

        state = _cloud_state()
        apply_pipeline_decision(
            state, facts, decision, head=HEAD, at="2026-08-20 12:00:00")
        from mae_flow_core.quality.external_verification import (
            record_git_push_receipt)
        record_git_push_receipt(
            state, facts, head=HEAD, at="2026-08-20 12:00:00")
        passed, reason = obligations_passed(state, HEAD)
        self.assertTrue(passed, reason)
        self.assertEqual(
            set(DIMENSIONS),
            set(state["quality"]["external_verification"]["checks"]),
        )

    def test_missing_typed_dimension_uses_exact_sha_aggregate_coverage(self):
        decision = adjudicate_pipeline(
            _typed_facts(overrides={"CODECHECK": None}), HEAD, DIMENSIONS)
        self.assertEqual("PASS", decision.verdict)
        self.assertEqual("passed", decision.checks["CODECHECK"]["status"])
        self.assertEqual(
            "aggregate", decision.checks["CODECHECK"]["coverage"])
        self.assertIn("CODECHECK", decision.reason)

    def test_aggregate_success_without_typed_rows_covers_contract(self):
        decision = adjudicate_pipeline(
            {"sha": HEAD, "status": "success"}, HEAD, DIMENSIONS)
        self.assertEqual("PASS", decision.verdict)
        self.assertTrue(all(
            row == {"status": "passed", "jobs": [],
                    "coverage": "aggregate"}
            for row in decision.checks.values()))

    def test_explicit_pending_dimension_still_waits_on_host(self):
        decision = adjudicate_pipeline(
            _typed_facts(overrides={"UT": "running"}), HEAD, DIMENSIONS)
        self.assertEqual("INCOMPLETE", decision.verdict)
        self.assertEqual("pending", decision.checks["UT"]["status"])

    def test_any_red_dimension_makes_the_delivery_red(self):
        decision = adjudicate_pipeline(
            _typed_facts(overrides={"UT": "failed"}), HEAD, DIMENSIONS)
        self.assertEqual("RED", decision.verdict)
        self.assertEqual("failed", decision.checks["UT"]["status"])
        self.assertIn("UT", decision.reason)

    def test_overall_failure_is_red_even_if_typed_checks_are_green(self):
        facts = _typed_facts()
        facts["status"] = "failed"
        decision = adjudicate_pipeline(facts, HEAD, DIMENSIONS)
        self.assertEqual("RED", decision.verdict)
        self.assertIn("总体失败", decision.reason)
        self.assertIn("其他阶段", decision.reason)

    def test_cloud_git_push_receipt_must_bind_current_head(self):
        from mae_flow_core.quality.external_verification import (
            record_git_push_receipt)
        state = _cloud_state()
        facts = _typed_facts()
        facts["git_push"]["sha"] = OTHER
        passed, reason = record_git_push_receipt(
            state, facts, head=HEAD, at="2026-08-20 12:00:00")
        self.assertFalse(passed)
        self.assertIn("当前 HEAD", reason)

    def test_green_checks_for_an_old_sha_are_stale(self):
        decision = adjudicate_pipeline(_typed_facts(OTHER), HEAD, DIMENSIONS)
        self.assertEqual("STALE", decision.verdict)
        self.assertIn("不背书新代码", decision.reason)
        self.assertTrue(all(
            row["status"] == "stale" for row in decision.checks.values()))

    def test_unknown_dimension_is_invalid_not_silently_ignored(self):
        facts = _typed_facts()
        facts["checks"].append({
            "dimension": "SECURITY_SCAN", "status": "success"})
        decision = adjudicate_pipeline(facts, HEAD, DIMENSIONS)
        self.assertEqual("INVALID", decision.verdict)
        self.assertIn("不受支持", decision.reason)


class WiringTests(unittest.TestCase):
    def test_pipeline_route_registered(self):
        route = command_dispatch.flow_route("pipeline")
        self.assertIsNotNone(route)
        self.assertEqual(route.handler, "cmd_pipeline")

    def test_parser_accepts_record_and_show(self):
        parser = cli_parser.build_parser()
        args = parser.parse_args(["pipeline", "record", "--file", "f.json"])
        self.assertEqual((args.cmd, args.action, args.file),
                         ("pipeline", "record", "f.json"))
        args = parser.parse_args(["pipeline", "show"])
        self.assertEqual((args.cmd, args.action), ("pipeline", "show"))


class HostEnvTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(host_env.ENV)
        os.environ.pop(host_env.ENV, None)

    def tearDown(self):
        os.environ.pop(host_env.ENV, None)
        if self._saved is not None:
            os.environ[host_env.ENV] = self._saved

    def test_pipeline_adjudicates_only_in_cloud(self):
        # 本地的裁判是本地执行本身,没有第二个裁判。
        self.assertFalse(host_env.pipeline_adjudicates())
        os.environ[host_env.ENV] = "cloud"
        self.assertTrue(host_env.pipeline_adjudicates())


if __name__ == "__main__":
    unittest.main()

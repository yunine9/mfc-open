#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端形态:本地不编译、不跑 UT,机器把关移交流水线。

为什么有这一档:云端宿主(mae-flow-cloud)没有构建链——内网的 mcde/mvn
装在流水线那边,宿主机上没有,也不打算为此供养镜像。而 COMPILE/UT 契约
要的是"本地真跑过"的证据:transcript 里的编译命令、AutoUT/build-fix
Skill 调用、EXECUTED_UT 的真实执行。云端一样都给不出——pi 会话根本没有
Skill 工具——于是 agent 报什么都被打回,死循环。用户拍板:云端不做本地
编译,验证换执行者(交付点推分支、权威流水线绑 SHA 裁决、红灯专职修复)。

放开的只有"本地这一次执行"这一类证据。作弊守卫一条不减:删代码换通过
仍然拦,带着待答问题/已知失败仍然不许报 PASS,没跑就不许报数字。
本地 CLI 一字不变——每个用例都配一条本地形态的对照。
"""

import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import host_env  # noqa: E402
from mae_flow_core.quality.agent_contracts import (  # noqa: E402
    AgentContractContext,
)
from mae_flow_core.quality.compile_contract import (  # noqa: E402
    evaluate_compile_contract,
)
from mae_flow_core.quality.unit_test_contract import (  # noqa: E402
    evaluate_unit_test_contract,
)


class CloudHostCase(unittest.TestCase):
    """MAE_FLOW_HOST 的存取由基类兜住,免得漏还原污染别的用例。"""

    def setUp(self):
        self._saved = os.environ.get(host_env.ENV)
        os.environ.pop(host_env.ENV, None)

    def tearDown(self):
        os.environ.pop(host_env.ENV, None)
        if self._saved is not None:
            os.environ[host_env.ENV] = self._saved

    def cloud(self):
        os.environ[host_env.ENV] = "cloud"


class HostEnvSwitchTests(CloudHostCase):
    def test_local_is_the_default_for_build_and_ut(self):
        # 本地 CLI 是主场景:不设环境变量时两条都必须为真。
        self.assertTrue(host_env.build_runs_locally())
        self.assertTrue(host_env.unit_tests_run_locally())

    def test_cloud_moves_build_and_ut_off_this_machine(self):
        self.cloud()
        self.assertFalse(host_env.build_runs_locally())
        self.assertFalse(host_env.unit_tests_run_locally())

    def test_unknown_host_still_counts_as_local(self):
        os.environ[host_env.ENV] = "kubernetes"
        self.assertTrue(host_env.build_runs_locally())
        self.assertTrue(host_env.unit_tests_run_locally())


def compile_context(report="", calls=(), net=0, build="mcde build -i",
                    status="OK"):
    return AgentContractContext(
        kind="COMPILE",
        status=status,
        report=report,
        task={"step": "build"},
        config={"编译方式": build},
        calls=tuple(calls),
        changed_paths=(),
        compile_net=net,
    )


class CompileContractCloudTests(CloudHostCase):
    def test_local_rejects_ok_without_any_build_evidence(self):
        # 对照组:本地形态下没有编译证据就是打回(老行为一字不变)。
        decision = evaluate_compile_contract(compile_context(
            report="EXECUTED_BUILD: mcde build -i\nBUILD_ERRORS: 0"))
        self.assertFalse(decision.accepted)

    def test_cloud_accepts_without_local_build_evidence(self):
        # 云端:没有 Skill 调用、没有编译命令,照样过——这正是死循环的解。
        self.cloud()
        decision = evaluate_compile_contract(compile_context(
            report="本地未编译,交付后由流水线裁决"))
        self.assertTrue(decision.accepted, decision.reason)
        self.assertTrue(decision.details.get("deferred_to_pipeline"))

    def test_cloud_still_blocks_deleting_code_to_pass(self):
        # 作弊守卫必须活着:净删 40 行又不声明 SHRINK_EXEMPT,云端照拦。
        self.cloud()
        decision = evaluate_compile_contract(compile_context(
            report="本地未编译", net=-40))
        self.assertFalse(decision.accepted)
        self.assertIn("SHRINK_EXEMPT", decision.reason)

    def test_cloud_shrink_exemption_still_works(self):
        self.cloud()
        decision = evaluate_compile_contract(compile_context(
            report="本地未编译\nSHRINK_EXEMPT:\n- 删除重复的空实现,逐项说明",
            net=-40))
        self.assertTrue(decision.accepted, decision.reason)


def ut_context(report, status="PASS", calls=()):
    return AgentContractContext(
        kind="UT",
        status=status,
        report=report,
        task={"step": "verify_ut"},
        config={"UT生成方式": "java-autout", "UT运行命令": "mvn -q test"},
        calls=tuple(calls),
        changed_paths=("src/main/java/A.java",),
        compile_net=0,
    )


class UnitTestContractCloudTests(CloudHostCase):
    HONEST_CLOUD_REPORT = (
        "本地未运行 UT(云端形态),测试已生成,运行交流水线。\n"
        "PENDING_QUESTIONS:\n- 无\n"
    )

    def test_local_rejects_pass_without_execution_evidence(self):
        # 对照组:本地形态要 Skill 调用与真实执行,给不出就打回。
        decision = evaluate_unit_test_contract(ut_context(
            "GENERATOR_USED: java-autout\nEXECUTED_UT: mvn -q test\n"
            "TESTS_TOTAL: 3\nTESTS_PASSED: 3\nTESTS_FAILED: 0"))
        self.assertFalse(decision.accepted)

    def test_cloud_accepts_generated_tests_without_running_them(self):
        self.cloud()
        decision = evaluate_unit_test_contract(
            ut_context(self.HONEST_CLOUD_REPORT))
        self.assertTrue(decision.accepted, decision.reason)
        self.assertTrue(decision.details.get("run_deferred_to_pipeline"))

    def test_cloud_still_refuses_pass_with_open_problems(self):
        # 诚实检查不随形态放开:带着已知失败报 PASS 仍然是谎。
        self.cloud()
        decision = evaluate_unit_test_contract(ut_context(
            "本地未运行 UT\nKNOWN_FAILURES:\n- OrderServiceTest 挂了没修"))
        self.assertFalse(decision.accepted)
        self.assertIn("KNOWN_FAILURES", decision.reason)

    def test_cloud_keeps_honest_nonpass_paths(self):
        self.cloud()
        decision = evaluate_unit_test_contract(
            ut_context("写不下去,缺依赖", status="NEEDS_INPUT"))
        self.assertTrue(decision.accepted, decision.reason)


if __name__ == "__main__":
    unittest.main()

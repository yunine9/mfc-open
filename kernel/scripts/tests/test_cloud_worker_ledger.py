#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cloud 只外置机器执行，不能外置真正的工作 Agent。

COMPILE 在 Cloud 没有本机构建链，因此登记成待流水线核销的义务；UT
编写、Story、Reviewer、Grill 仍是内核流程里的真实工作，必须收到子
Agent 返回。UT 的本地运行虽然外置，编写批本身仍要推进到明确的
``external + complete`` 状态，不能再用宿主类型整批放行。

ASKUSER 继续是人工闸；本地宿主行为保持不变。
"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import host_env


class _CloudEnv(object):
    """用例级别切宿主形态;用完必还原,别把云端状态漏给别的测试。"""

    def __init__(self, value):
        self.value = value

    def __enter__(self):
        self.saved = os.environ.get(host_env.ENV)
        if self.value is None:
            os.environ.pop(host_env.ENV, None)
        else:
            os.environ[host_env.ENV] = self.value

    def __exit__(self, *_exc):
        if self.saved is None:
            os.environ.pop(host_env.ENV, None)
        else:
            os.environ[host_env.ENV] = self.saved


class _AgentPorts(object):
    """一个"什么台账都取不到"的宿主:观察记录、质量执行、风险确认全空。

    本地模式下它必然被拦——这正是要对照的基线。
    """

    moonlight = staticmethod(lambda state: False)
    step_entered = staticmethod(lambda state: "2026-08-15 00:00:00")
    risk_acceptance = staticmethod(lambda kind, state: (False, ""))
    script_path = staticmethod(lambda: "mae-flow.py")
    risk_labels = {}
    finished_observation = staticmethod(lambda *a, **k: None)
    quality_execution = staticmethod(lambda *a, **k: None)
    askuser_tokens = staticmethod(lambda: {})
    changed_source_files = staticmethod(
        lambda state: (["service/src/A.java"], ""))
    shell_output = staticmethod(lambda *a, **k: "")
    argv_output = staticmethod(lambda *a, **k: "")
    blocking_dirty_source_paths = staticmethod(lambda *a, **k: [])
    open_observation = None
    finished_observations = None
    step_scoped_source_files = None


class _ReturnedAgentPorts(_AgentPorts):
    """宿主记录到了一次真实返回；legacy 只跳过本地命令对账。"""

    finished_observation = staticmethod(
        lambda *a, **k: {"detail": "子 Agent 已正常返回", "legacy": True})


def _agent_rules(ports=None):
    from mae_flow_core.workflow.agent_evidence import AgentEvidenceRules
    return AgentEvidenceRules(ports or _AgentPorts())


class _QualityPorts(object):
    def business_changed_files(self, _state):
        return ["service/src/A.java"], ""

    def risk_acceptance(self, _kind, _state):
        return False, ""

    def agent_ran(self, spec, state):
        return _agent_rules().agent_ran(spec, state)


def _quality_rules():
    from mae_flow_core.quality.evidence import QualityEvidenceRules
    return QualityEvidenceRules(_QualityPorts())


def _state(phase="generate", complete=False):
    session = {"step": "verify_ut", "phase": phase}
    if complete:
        session["complete"] = True
    return {"current": "verify_ut", "ut_session": session}


class CloudKeepsWorkerLedger(unittest.TestCase):
    def test_only_compile_is_released_without_a_child_return(self):
        """外部 COMPILE 不是假 Agent；其余工作不能借 Cloud 身份免证。"""
        with _CloudEnv(host_env.CLOUD):
            compile_result = _agent_rules().agent_ran(
                {"agent": "COMPILE"}, _state())
            self.assertTrue(compile_result.passed, compile_result.reason)
            self.assertIn("流水线", compile_result.reason)

            for kind in ("UT", "REVIEWER", "STORY", "GRILL_PREP",
                         "GRILL_FINAL", "CODECHECK"):
                result = _agent_rules().agent_ran(
                    {"agent": kind}, _state())
                self.assertFalse(
                    result.passed,
                    "%s 不得被 Cloud 宿主无台账放行: %s"
                    % (kind, result.reason),
                )
                self.assertIn("子 Agent", result.reason)

    def test_work_agents_pass_after_a_real_return(self):
        """Cloud 不是永远拦截：真实返回到达后，工作 Agent 正常核销。"""
        with _CloudEnv(host_env.CLOUD):
            rules = _agent_rules(_ReturnedAgentPorts())
            for kind in ("UT", "REVIEWER", "STORY", "GRILL_PREP",
                         "GRILL_FINAL", "CODECHECK"):
                result = rules.agent_ran({"agent": kind}, _state())
                self.assertTrue(result.passed, "%s: %s" % (kind, result.reason))

    def test_askuser_still_gates_in_cloud(self):
        """人工闸不随台账放开:云端决定卡走得通,放开它等于把人踢出局。"""
        with _CloudEnv(host_env.CLOUD):
            result = _agent_rules().agent_ran(
                {"agent": "ASKUSER"}, _state())
            self.assertFalse(result.passed)
            self.assertIn("AskUserQuestion", result.reason)


class TestsNeverPopDesktop(unittest.TestCase):
    def test_desktop_popup_refuses_to_fire_under_test_runner(self):
        """测试进程绝不弹真通知——跑全量把用户桌面弹一串,就是测试泄漏。

        闸在 _popup(真副作用),不在 desktop_enabled(判定逻辑):
        "全新仓默认弹"的契约另有用例在钉,两者不打架。
        """
        from mae_flow_core.panel import notify
        self.assertFalse(notify._popup("标题", "正文"))


class LocalHostUnchanged(unittest.TestCase):
    def test_worker_kinds_still_gate_locally(self):
        """不设 MAE_FLOW_HOST:一字不变,取不到台账照样拦。"""
        with _CloudEnv(None):
            result = _agent_rules().agent_ran({"agent": "UT"}, _state())
            self.assertFalse(result.passed)

if __name__ == "__main__":
    unittest.main()

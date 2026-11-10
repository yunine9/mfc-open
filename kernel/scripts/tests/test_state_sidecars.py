#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""退出与开新单必须把旁路状态收干净——漏一个就是给新流程留旧证据。

用户实战反馈:手动退出流程后再单独让补个 UT,结果又被拽回上一单的流程里。
查下去发现 `exit` 和"开新单前清理"用的是同一份白名单,而这份名单漏了三个
本该在内的文件:

- `.mae-flow.json.quality-executions` —— 编译/UT 的执行台账
- `.mae-flow.json.agent-observations` —— Agent 派发与返回的生命周期证据
- `.mae-flow.json.advisories` —— 上一单的非阻断提示

前两个是**证据来源**。退出不删、开新单不清,新一单就可能拿上一单的执行
记录充数;第三个会让早已处理完的旧提示重新冒出来。

所以名单的完整性不能靠人记:凡是代码里会写出的 `.mae-flow.json.*`,
都必须出现在白名单里。
"""

import io
import os
import re
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

# 这几个不属于"流程旁路状态",不该被退出清理波及:
# .exited 是退出记录本身(删了就不知道退过);.last 是上一单的留档,
# 独立任务专门靠它继承运行方式(编译命令/UT 命令),清掉反而要重问用户。
NOT_SIDECARS = {".exited", ".last"}

WRITTEN = re.compile(
    r'(?:STATE_PATH|state_path\)?)\s*\+\s*"(\.[a-z][a-z0-9-]*)"'
    r'|"\.mae-flow\.json(\.[a-z][a-z0-9-]*)"')


def _suffixes_written_by_code():
    found = set()
    for here, _dirs, names in os.walk(os.path.join(SCRIPTS, "mae_flow_core")):
        for name in sorted(names):
            if not name.endswith(".py"):
                continue
            with io.open(os.path.join(here, name), encoding="utf-8") as stream:
                for direct, quoted in WRITTEN.findall(stream.read()):
                    found.add(direct or quoted)
    return {item for item in found if item not in NOT_SIDECARS}


class SidecarCoverageTests(unittest.TestCase):
    def test_whitelist_covers_every_sidecar_the_code_writes(self):
        from mae_flow_core.cli_commands.shared import STATE_PATH
        from mae_flow_core.cli_commands.standalone_core import _state_sidecars
        listed = {
            path[len(STATE_PATH):]
            for path in _state_sidecars()
            if path.startswith(STATE_PATH) and path != STATE_PATH
        }
        missing = sorted(_suffixes_written_by_code() - listed)
        self.assertEqual(
            [], missing,
            "这些旁路状态代码会写,但退出/开新单不会收走——旧证据会留给新流程: %s"
            % missing)

    def test_the_three_that_bit_us_are_on_the_list(self):
        from mae_flow_core.cli_commands.standalone_core import _state_sidecars
        listed = set(_state_sidecars())
        for suffix in (".quality-executions", ".agent-observations",
                       ".advisories"):
            self.assertIn(".mae-flow.json" + suffix, listed)

    def test_exit_record_and_last_round_are_deliberately_kept(self):
        """.exited 是退出记录本身,.last 是独立任务继承运行方式的来源。"""
        from mae_flow_core.cli_commands.standalone_core import _state_sidecars
        listed = set(_state_sidecars())
        self.assertNotIn(".mae-flow.json.exited", listed)
        self.assertNotIn(".mae-flow.json.last", listed)




class RoundResidueTests(unittest.TestCase):
    """过程区里按步骤命名的东西,换单会同名撞上——旧内容被当成本单产物。

    `agent-tasks/build-compile.md`、`role-tasks/story-story-review.md` 这些
    只带步骤名不带单号,而任务卡正是模型要"原样转交给子 Agent"的话术;
    `lightcheck/latest.md` 更直接——面板和 current 都把它当当前结论,
    而它连生成时间都没有。
    """

    def _workspace(self, root):
        base = os.path.join(root, ".mae-flow-work")
        for name in ("agent-tasks", "role-tasks", "lightcheck",
                     "REQ-OLD", "codecheck-logs", "spec",
                     "plugin-resources", "bin"):
            os.makedirs(os.path.join(base, name), exist_ok=True)
        for rel in ("agent-tasks/build-compile.md",
                    "role-tasks/story-story-review.md",
                    "lightcheck/latest.md",
                    "REQ-OLD/story.md",
                    "codecheck-logs/REQ-OLD-verify.md",
                    "spec/config.yaml",
                    "plugin-resources/keep.md",
                    "bin/mae-flow.py",
                    "moonlight-report.md", ".notify-ack", ".panel-cost"):
            path = os.path.join(base, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with io.open(path, "w", encoding="utf-8") as stream:
                stream.write("x")
        return base

    def test_new_round_drops_step_named_residue_and_keeps_the_rest(self):
        import shutil as _shutil
        import tempfile
        from mae_flow_core.cli_commands.standalone_core import (
            _clear_round_workspace)
        room = tempfile.mkdtemp(prefix="residue-")
        self.addCleanup(_shutil.rmtree, room, True)
        base = self._workspace(room)
        dropped = _clear_round_workspace(room)
        for gone in ("agent-tasks", "role-tasks", "lightcheck"):
            self.assertFalse(os.path.exists(os.path.join(base, gone)),
                             "按步骤命名的残留应当清掉: %s" % gone)
            self.assertIn(gone, dropped)
        for kept in ("REQ-OLD/story.md", "codecheck-logs/REQ-OLD-verify.md",
                     "spec/config.yaml", "plugin-resources/keep.md",
                     "bin/mae-flow.py"):
            self.assertTrue(os.path.exists(os.path.join(base, kept)),
                            "带单号/属于运行时的不该被清: %s" % kept)

    def test_lightcheck_report_can_prove_it_is_fresh(self):
        from mae_flow_core.lightcheck_runtime import render_markdown
        body = render_markdown(
            {"status": "CLEAN", "files": ["a.py"],
             "at": "2026-08-10 09:30:00", "head": "abc123def4567890"},
            "提交前")
        self.assertIn("生成时间：2026-08-10 09:30:00", body)
        self.assertIn("绑定版本：abc123def456", body)
        # 拿不到就写"未记录",不许编
        blank = render_markdown({"status": "CLEAN", "files": []}, "")
        self.assertIn("生成时间：未记录", blank)

if __name__ == "__main__":
    unittest.main()

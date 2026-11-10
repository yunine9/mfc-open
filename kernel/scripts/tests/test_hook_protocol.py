#!/usr/bin/env python3
"""Protocol adapter tests kept at the Hook process boundary."""

import importlib.util
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HOOK = os.path.join(ROOT, "hooks", "dispatch.py")


def load_dispatch():
    name = "mae_flow_hook_protocol_test"
    spec = importlib.util.spec_from_file_location(name, HOOK)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class HookProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dispatch = load_dispatch()

    def test_decodes_utf8_bom_and_gb18030_without_replacement(self):
        payload = {"prompt": "中文确认", "tool_name": "Edit"}
        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(
            payload,
            self.dispatch._decode_hook_json(
                b"\xef\xbb\xbf" + encoded.encode("utf-8")),
        )
        with mock.patch.object(
                self.dispatch.locale,
                "getpreferredencoding",
                return_value="ascii"):
            self.assertEqual(
                payload,
                self.dispatch._decode_hook_json(encoded.encode("gb18030")),
            )

    def test_invalid_payload_is_rejected_by_decoder(self):
        with self.assertRaises(ValueError):
            self.dispatch._decode_hook_json(b"\xff\xfe\x00not-json")

    def test_missing_maeflow_script_fails_open(self):
        original = self.dispatch.MAEFLOW
        try:
            self.dispatch.MAEFLOW = os.path.join(ROOT, "missing.py")
            self.assertEqual(0, self.dispatch.maeflow("gate", "edit", "x"))
        finally:
            self.dispatch.MAEFLOW = original

    def test_production_task_card_ports_construct_with_build_path_policy(self):
        """Production dispatch must wire every required task-card dependency."""
        try:
            ports = self.dispatch._task_card_ports()
        except TypeError as exc:
            self.fail("生产 Hook 任务卡端口装配不完整: %s" % exc)
        self.assertTrue(ports.build_like("CMakeLists.txt"))

    def test_cloud_access_root_accepts_only_repo_or_direct_task_parent(self):
        with tempfile.TemporaryDirectory() as task:
            project = os.path.join(task, "project")
            os.makedirs(project)
            before = os.getcwd()
            os.chdir(project)
            try:
                self.assertEqual(
                    os.path.realpath(task),
                    self.dispatch._file_access_root(
                        {"workspace_root": task}),
                )
                self.assertEqual(
                    os.path.realpath(project),
                    self.dispatch._file_access_root(
                        {"workspace_root": os.path.dirname(task)}),
                )
                self.assertEqual(
                    os.path.realpath(project),
                    self.dispatch._file_access_root({}),
                )
            finally:
                os.chdir(before)

    def test_project_launcher_uses_codeagent_plugin_root(self):
        from mae_flow_core.adapters.project_launcher import (
            install_project_launcher,
        )
        with tempfile.TemporaryDirectory() as root:
            plugin = os.path.join(root, "plugin")
            os.makedirs(os.path.join(plugin, "scripts"))
            entry = os.path.join(plugin, "scripts", "mae-flow.py")
            with open(entry, "w", encoding="utf-8") as stream:
                stream.write("raise SystemExit(0)\n")
            with mock.patch.dict(
                    os.environ,
                    {"CODEAGENT3_PLUGIN_ROOT": plugin},
                    clear=False):
                launcher = install_project_launcher(root)
            self.assertEqual(
                os.path.join(root, ".mae-flow-work", "bin", "mae-flow.py"),
                launcher,
            )
            with open(launcher, encoding="utf-8") as stream:
                content = stream.read()
            self.assertIn(repr(entry), content)
            self.assertNotIn("CLAUDE_PLUGIN_ROOT", content)

    def test_userprompt_hook_event_installs_project_launcher(self):
        from mae_flow_core.adapters.project_launcher import (
            install_launcher_for_event,
        )
        with tempfile.TemporaryDirectory() as root:
            original = os.getcwd()
            try:
                os.chdir(root)
                with open(".mae-flow.json", "w", encoding="utf-8") as stream:
                    json.dump({"current": "story"}, stream)
                launcher = install_launcher_for_event("userprompt")
            finally:
                os.chdir(original)
            self.assertEqual(
                os.path.join(
                    os.path.realpath(root),
                    ".mae-flow-work", "bin", "mae-flow.py"),
                launcher,
            )
            self.assertTrue(os.path.isfile(launcher))

    def test_project_without_mae_flow_state_is_left_untouched(self):
        """全局安装只提供能力：没启用过的项目不能被写进任何文件。"""
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(
                ["git", "init", "-q", project], check=True,
                capture_output=True)
            payload = json.dumps({
                "cwd": project, "prompt": "帮我看一下这个函数",
            }, ensure_ascii=False) + "\n"
            result = subprocess.run(
                [sys.executable, HOOK, "userprompt"],
                cwd=project, input=payload, text=True,
                capture_output=True, timeout=15)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertFalse(
                os.path.exists(os.path.join(project, ".mae-flow-work")),
                "未启用流程的项目不应出现 .mae-flow-work/")
            status = subprocess.run(
                ["git", "status", "--porcelain", "--untracked-files=all"],
                cwd=project, capture_output=True, text=True, check=True)
            self.assertEqual("", status.stdout.strip())

    def test_second_lifecycle_event_keeps_the_proven_quality_execution(self):
        """SubagentStop 证明成功后，PostToolUse 兜底不得把它改写成失败。"""
        from mae_flow_core.workflow.quality_executions import (
            quality_execution_path,
        )
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(
                ["git", "init", "-q", project], check=True,
                capture_output=True)
            head = "0" * 40
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            state_path = os.path.join(project, ".mae-flow.json")
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "current": "build",
                    "config": {"单号": "REQ-HOOK-E2E", "编译方式": "make all"},
                    "choices": {"workflow": "full"},
                    "history": [], "started": now,
                    "agent_tasks": {"COMPILE": {
                        "step": "build", "head": head,
                        "task_files": ["m.c"], "execution_roots": ["."],
                        "sha256": "task-sha",
                    }},
                }, stream, ensure_ascii=False)
            with open(state_path + ".agent-observations", "w",
                      encoding="utf-8") as stream:
                json.dump({"observations": [{
                    "kind": "COMPILE", "step": "build",
                    "invocation_id": "toolu-compile", "lifecycle": "started",
                    "at": now, "detail": "",
                }], "aliases": {}}, stream, ensure_ascii=False)
            transcript = os.path.join(project, "main.jsonl")
            subagents = os.path.join(project, "main", "subagents")
            os.makedirs(subagents)
            with open(os.path.join(subagents, "agent-AG1.jsonl"), "w",
                      encoding="utf-8") as stream:
                for line in (
                        {"type": "assistant", "message": {"content": [{
                            "type": "tool_use", "id": "tu1", "name": "Bash",
                            "input": {"command": "make all"}}]}},
                        {"type": "user", "message": {"content": [{
                            "type": "tool_result", "tool_use_id": "tu1",
                            "is_error": False, "content": "build ok"}]}}):
                    stream.write(json.dumps(line) + "\n")

            def run(event, payload):
                result = subprocess.run(
                    [sys.executable, HOOK, event], cwd=project,
                    input=json.dumps(payload, ensure_ascii=False) + "\n",
                    text=True, capture_output=True, timeout=15)
                self.assertEqual(0, result.returncode, result.stderr)

            run("subagentstop", {
                "cwd": project, "agent_id": "AG1",
                "transcript_path": transcript, "stop_reason": "end_turn",
            })
            # 宿主的 Task 返回体不带 agentId：兜底事件解析不到子 Agent transcript。
            run("posttooluse", {
                "cwd": project, "tool_name": "Task",
                "tool_use_id": "toolu-compile",
                "transcript_path": transcript,
                "tool_input": {"subagent_type": "compile-agent"},
                "tool_response": {"status": "completed", "content": [
                    {"type": "text", "text": "编译成功"}]},
            })
            with open(quality_execution_path(state_path),
                      encoding="utf-8") as stream:
                executions = json.load(stream)["executions"]

        self.assertEqual(1, len(executions))
        self.assertTrue(executions[0]["succeeded"])
        self.assertEqual("make all", executions[0]["command"])

    def test_production_active_hook_uses_the_user_repository_root(self):
        with tempfile.TemporaryDirectory() as project:
            original = os.getcwd()
            try:
                os.chdir(project)
                ports = self.dispatch._hook_event_ports()
            finally:
                os.chdir(original)

        active = ports.pretool.__self__.pretool_handler.__self__
        self.assertEqual(os.path.realpath(project), active.repository_root)
        self.assertEqual(ROOT, active.plugin_root)

    def test_production_pretool_agent_needs_no_prescribed_task_card(self):
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(
                ["git", "init", "-q", project], check=True,
                capture_output=True)
            with open(os.path.join(project, ".mae-flow.json"), "w",
                      encoding="utf-8") as stream:
                json.dump({
                    "current": "story",
                    "config": {"单号": "REQ-HOOK-E2E"},
                    "choices": {"workflow": "full"},
                    "history": [],
                    "started": time.strftime("%Y-%m-%d %H:%M:%S"),
                }, stream, ensure_ascii=False)
            payload = json.dumps({
                "cwd": project,
                "tool_name": "Agent",
                "tool_use_id": "toolu-story-e2e",
                "tool_input": {
                    "subagent_type": "story-generator-agent",
                },
            }, ensure_ascii=False) + "\n"

            result = subprocess.run(
                [sys.executable, HOOK, "pretooluse"],
                cwd=project, input=payload, text=True,
                capture_output=True, timeout=15)

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("派发前拦截", result.stderr)
        self.assertNotIn("TaskCardPorts.__init__", result.stderr)

    def test_production_pretool_records_started_story_lifecycle(self):
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(
                ["git", "init", "-q", project], check=True,
                capture_output=True)
            state_path = os.path.join(project, ".mae-flow.json")
            with open(state_path, "w", encoding="utf-8") as stream:
                json.dump({
                    "current": "story",
                    "config": {"单号": "REQ-HOOK-E2E"},
                    "choices": {"workflow": "full"},
                    "history": [],
                    "started": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "agent_tasks": {"STORY": {"step": "story"}},
                }, stream, ensure_ascii=False)
            payload = json.dumps({
                "cwd": project,
                "tool_name": "Agent",
                "tool_use_id": "toolu-story-started",
                "tool_input": {
                    "subagent_type": "story-generator-agent",
                },
            }, ensure_ascii=False) + "\n"

            result = subprocess.run(
                [sys.executable, HOOK, "pretooluse"],
                cwd=project, input=payload, text=True,
                capture_output=True, timeout=15)
            with open(state_path + ".agent-observations",
                      encoding="utf-8") as stream:
                observations = json.load(stream)["observations"]

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("started", observations[-1]["lifecycle"])
        self.assertEqual("STORY", observations[-1]["kind"])
        self.assertEqual("toolu-story-started",
                         observations[-1]["invocation_id"])

    def test_hook_manifest_is_codeagent_only_and_observes_agent_tool(self):
        with open(os.path.join(ROOT, "hooks", "hooks.json"),
                  encoding="utf-8") as stream:
            content = stream.read()
        self.assertIn("CODEAGENT3_PLUGIN_ROOT", content)
        self.assertNotIn("CLAUDE_PLUGIN_ROOT", content)
        self.assertIn("AskUserQuestion|Task|Agent", content)
        manifest = json.loads(content)
        posttool = "|".join(
            item.get("matcher", "")
            for item in manifest["hooks"]["PostToolUse"])
        self.assertIn("Task", posttool)
        self.assertIn("Agent", posttool)

    def test_unexpected_top_level_exception_fails_open(self):
        # 日志文件是整机共用的(临时目录下一份),真流程的 doctor 就读它。
        # 不隔离的话,本用例每跑一次就往别人的诊断里塞一条
        # "EXC RuntimeError: boom"——实战里真的把人骗去查了半天 hook。
        quiet = os.path.join(tempfile.mkdtemp(prefix="hooklog-"), "hook.log")
        with mock.patch.object(self.dispatch, "LOG", quiet), mock.patch.object(
                self.dispatch, "read_input", side_effect=RuntimeError("boom")):
            with mock.patch.object(self.dispatch, "_arm_watchdog"):
                with self.assertRaises(SystemExit) as caught:
                    self.dispatch.main()
        self.assertEqual(0, caught.exception.code)

    def test_subprocess_timeouts_share_one_invocation_budget(self):
        """一个事件可能连发多次子进程调用，各自计时会被看门狗在中途打死。"""
        from mae_flow_core.adapters import hook_budget

        try:
            hook_budget.arm(12)
            self.assertEqual(
                8.0, hook_budget.timeout_for(8), "预算充足时保持原上限")
            self.assertFalse(hook_budget.exhausted())

            hook_budget.arm(3)
            capped = hook_budget.timeout_for(8)
            self.assertLess(capped, 3.0)
            self.assertGreaterEqual(capped, 0.5)

            hook_budget.arm(0.2)
            self.assertTrue(hook_budget.exhausted())
            self.assertEqual(0.5, hook_budget.timeout_for(8), "仍有下限，不传 0")
        finally:
            hook_budget.clear()
        self.assertIsNone(hook_budget.remaining(), "未布防时不影响 CLI 调用")

    def test_exhausted_budget_fails_open_without_spawning_maeflow(self):
        from mae_flow_core.adapters import hook_budget

        calls = []
        with mock.patch.object(
                self.dispatch.subprocess, "run",
                side_effect=lambda *a, **k: calls.append(a)):
            try:
                hook_budget.arm(0.1)
                self.assertEqual(
                    0, self.dispatch.maeflow("gate", "bash", "git status"))
            finally:
                hook_budget.clear()
        self.assertEqual([], calls, "预算耗尽时不应再启动子进程")

    def test_document_write_is_recorded_without_template_feedback(self):
        """不同路径字段仍登记写入；逐次编辑不再触发模板补材料提示。"""
        from mae_flow_core.adapters.hook_active_events import (
            ActiveHookEventAdapter,
        )
        from types import SimpleNamespace

        with tempfile.TemporaryDirectory() as project:
            assets = os.path.join(
                project, ".mae-flow-work", "plugin-resources", "assets")
            os.makedirs(assets)
            with open(os.path.join(assets, "STORY-TEMPLATE.md"),
                      "w", encoding="utf-8") as stream:
                stream.write("# 必需章节\n")
            document = os.path.join(project, "docs", "story", "STORY-R1.md")
            os.makedirs(os.path.dirname(document))
            with open(document, "w", encoding="utf-8") as stream:
                stream.write("# 别的标题\n")
            writes = []
            adapter = ActiveHookEventAdapter(
                state=os.path.join(project, ".mae-flow.json"),
                maeflow_path=os.path.join(ROOT, "scripts", "mae-flow.py"),
                repository_root=project,
                maeflow=lambda *args: 0,
                runtime_adapter=SimpleNamespace(
                    _record_agent_write=writes.append),
                task_card_ports=lambda: None,
                log=lambda message: None,
            )
            for tool, field in (("Write", "path"), ("Edit", "file_path")):
                response = adapter.posttool({
                    "tool_name": tool, "tool_input": {field: document},
                })
                self.assertEqual(0, response.exit_code)
                self.assertEqual("", response.stderr)
            self.assertEqual([document, document], writes)
            self.assertFalse(os.path.exists(os.path.join(project, ".mae-flow.json.advisories")))


if __name__ == "__main__":
    unittest.main()


class CloudHookProtocolTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("cloud_hook_test", Path(ROOT) / "hooks/dispatch.py")
        self.dispatch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.dispatch)
        patch = mock.patch.dict(os.environ, {"MAE_FLOW_HOOK_STRICT": "1"})
        patch.start()
        self.addCleanup(patch.stop)

    def test_top_level_exception_and_bad_input_fail_closed(self):
        for input_mock in (mock.Mock(side_effect=RuntimeError("broken hook")), mock.Mock(return_value={})):
            with mock.patch.object(self.dispatch, "read_input", input_mock), \
                 mock.patch.object(self.dispatch, "_arm_watchdog"), \
                 mock.patch.object(self.dispatch, "_log"), \
                 self.assertRaises(SystemExit) as caught:
                self.dispatch.main()
            self.assertEqual(75, caught.exception.code)

    def test_watchdog_is_failure_in_cloud(self):
        with mock.patch.object(self.dispatch.threading, "Timer") as timer, \
             mock.patch.object(self.dispatch.os, "_exit") as exit_process, \
             mock.patch.object(self.dispatch, "_log"):
            self.dispatch._arm_watchdog()
            timer.call_args.args[1]()
            exit_process.assert_called_once_with(75)
        self.dispatch.hook_budget.clear()

    def test_missing_cli_fails_closed(self):
        with mock.patch.object(self.dispatch, "MAEFLOW", "/missing/mae-flow.py"), \
             mock.patch.object(self.dispatch, "_log"):
            self.assertEqual(75, self.dispatch.maeflow("gate", "bash"))

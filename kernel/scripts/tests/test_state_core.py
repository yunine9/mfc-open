#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression tests for the shared runtime/state core."""

import json
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from unittest import mock


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ROOT = os.path.abspath(os.path.join(SCRIPTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import (  # noqa: E402
    CURRENT_SCHEMA_VERSION,
    RuntimeMode,
    StateConflictError,
    StateStoreError,
    atomic_write_json,
    normalize_document,
    read_json,
    resolve_runtime,
    save_versioned_json,
    update_json,
)
from mae_flow_core.cli_commands.source_facts import (  # noqa: E402
    _archived_delivery_facts,
    _branch_adoption_requested,
)
from mae_flow_core.cli_commands import state_config  # noqa: E402


class RuntimeAndStateTests(unittest.TestCase):
    def test_cli_respects_cp936_stdout_selected_by_windows_host(self):
        with tempfile.TemporaryDirectory() as root:
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "cp936"
            result = subprocess.run(
                [sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
                 "current"],
                cwd=root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )

        output = result.stdout.decode("cp936", errors="replace")
        self.assertIn("流程未初始化", output)
        self.assertNotIn("娴佺▼", output)

    def test_active_current_is_readable_with_windows_cp936_stdout(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "mae-flow@test.invalid"],
                cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.name", "MAE Flow Test"],
                cwd=root, check=True)
            source = os.path.join(root, "biz.cpp")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-qm", "base"], cwd=root, check=True)
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, check=True,
                text=True, capture_output=True).stdout.strip()
            save_versioned_json(
                os.path.join(root, ".mae-flow.json"), {
                    "current": "build",
                    "config": {
                        "单号": "REQ-936", "基线分支": "master",
                        "分支名": "master",
                    },
                    "choices": {"workflow": "tweak"},
                    "history": [],
                    "step_heads": {"build": head},
                    "initial_dirty": [],
                    "started": "2026-08-06 10:00:00",
                }, "flow", project_root=root)
            env = dict(os.environ)
            env["PYTHONIOENCODING"] = "cp936"
            result = subprocess.run(
                [sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
                 "current"],
                cwd=root, env=env, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, check=False)

        output = result.stdout.decode("cp936", errors="replace")
        self.assertEqual(0, result.returncode, output)
        self.assertIn("当前步骤", output)
        self.assertIn("自由实现与定稿", output)
        for mojibake in ("鈺", "褰", "姝"):
            self.assertNotIn(mojibake, output)

    def test_branch_adoption_request_rejects_quoted_or_documentation_text(self):
        self.assertTrue(_branch_adoption_requested(
            "开启月光宝盒，继续当前分支完成开发"))
        self.assertTrue(_branch_adoption_requested(
            "开启月光宝盒，请“继续当前分支”完成开发"))
        self.assertTrue(_branch_adoption_requested(
            "需求文档确认无误后继续当前分支"))
        self.assertFalse(_branch_adoption_requested(
            "开启月光宝盒，把按钮文案改成“继续当前分支”"))
        self.assertFalse(_branch_adoption_requested(
            "需求文档里补充「使用当前分支」这个例子"))
        self.assertFalse(_branch_adoption_requested(
            "开启月光宝盒，把继续当前分支写进按钮文案"))
        self.assertFalse(_branch_adoption_requested(
            "将使用当前分支设为测试示例"))
        self.assertFalse(_branch_adoption_requested(
            "把继续当前分支添加到按钮上"))
        self.assertFalse(_branch_adoption_requested(
            "按钮文案是继续当前分支"))
        self.assertFalse(_branch_adoption_requested(
            "测试继续当前分支这句话的解析"))
        self.assertFalse(_branch_adoption_requested(
            "把按钮文案改成“修改后继续当前分支”"))
        self.assertFalse(_branch_adoption_requested(
            "测试“修改后继续当前分支”"))

    def test_archived_delivery_facts_fail_closed_on_bad_nested_json(self):
        self.assertEqual(
            ("", "", ""),
            _archived_delivery_facts({
                "current": "end",
                "config": [],
                "step_heads": [],
                "moonlight": "bad",
            }),
        )

    def test_moonlight_branch_create_continues_terminal_rollover_same_delivery(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "mae-flow@test.invalid"],
                cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.name", "MAE Flow Test"],
                cwd=root, check=True)
            subprocess.run(
                ["git", "branch", "-M", "main"], cwd=root, check=True)
            source = os.path.join(root, "biz.cpp")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-qm", "base"], cwd=root, check=True)
            subprocess.run(
                ["git", "checkout", "-qb", "feature/existing"],
                cwd=root, check=True)
            with open(source, "a", encoding="utf-8") as stream:
                stream.write("int first = 2;\n")
            subprocess.run(["git", "commit", "-qam", "first"], cwd=root, check=True)
            previous_head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, check=True,
                text=True, capture_output=True).stdout.strip()
            with open(source, "a", encoding="utf-8") as stream:
                stream.write("int second = 3;\n")
            subprocess.run(["git", "commit", "-qam", "second"], cwd=root, check=True)

            previous = {
                "current": "end",
                "config": {
                    "单号": "REQ-7",
                    "基线分支": "main",
                    "分支名": "feature/existing",
                },
                "choices": {"workflow": "tweak"},
                "history": [],
                "step_heads": {"end": previous_head},
                "started": "2026-07-31 01:00:00",
            }
            save_versioned_json(
                os.path.join(root, ".mae-flow.json.last"),
                previous, "flow", project_root=root)
            current = {
                "current": "branch_create",
                "config": {
                    "单号": "REQ-7",
                    "基线分支": "main",
                    "分支名": "main_u1_REQ-7",
                },
                "choices": {"workflow": "tweak"},
                "history": [],
                "moonlight": {
                    "enabled": True,
                    "request": "开启月光宝盒处理这个需求",
                    "issues": [],
                },
                "started": "2026-07-31 02:00:00",
            }
            save_versioned_json(
                os.path.join(root, ".mae-flow.json"),
                current, "flow", project_root=root)
            child_env = dict(os.environ)
            child_env["PYTHONPYCACHEPREFIX"] = os.path.join(root, "pycache")

            result = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"), "done"],
                cwd=root, text=True, capture_output=True,
                env=child_env, timeout=20)

            self.assertEqual(0, result.returncode, result.stderr)
            with open(
                    os.path.join(root, ".mae-flow.json"),
                    encoding="utf-8") as stream:
                updated = json.load(stream)
            self.assertEqual("tw_open", updated["current"])
            self.assertEqual(
                "feature/existing", updated["config"]["分支名"])
            self.assertEqual(
                "moonlight-continuation",
                updated["branch_resolution"]["source"])
            self.assertEqual(
                previous_head,
                updated["branch_resolution"]["previous_head"])

    def test_runtime_matrix_schema_and_corrupt_preservation(self):
        with tempfile.TemporaryDirectory() as td:
            flow_path = os.path.join(td, ".mae-flow.json")
            action_path = os.path.join(
                td, ".mae-flow-work", "standalone-action.json")
            exit_path = os.path.join(td, ".mae-flow.json.exited")
            os.makedirs(os.path.dirname(action_path), exist_ok=True)
            self.assertEqual(RuntimeMode.INACTIVE, resolve_runtime(td).mode)

            save_versioned_json(
                flow_path, {"current": "config_confirm"}, "flow", project_root=td)
            migrated = read_json(flow_path)
            self.assertEqual(CURRENT_SCHEMA_VERSION, migrated["schema_version"])
            self.assertEqual(1, migrated["revision"])

            action = {
                "kind": "ut", "id": "conflict-fixture",
                "expires_epoch": time.time() + 3600,
                "work_dir": os.path.join(
                    td, ".mae-flow-work", "standalone", "fixture"),
            }
            save_versioned_json(
                action_path, action, "action", project_root=td)
            atomic_write_json(exit_path, {"status": "exited"})
            mixed = resolve_runtime(td)
            self.assertEqual(RuntimeMode.FLOW, mixed.mode)
            self.assertEqual(
                {"flow_and_action", "flow_and_exit"}, set(mixed.conflicts))

            os.remove(flow_path)
            self.assertEqual(RuntimeMode.STANDALONE, resolve_runtime(td).mode)
            action["expires_epoch"] = time.time() - 1
            action.pop("revision", None)
            save_versioned_json(
                action_path, action, "action", project_root=td)
            expired = resolve_runtime(td)
            self.assertEqual(RuntimeMode.DIRECT, expired.mode)
            self.assertIn("expired_action", expired.ignored)

            os.remove(exit_path)
            with open(flow_path, "w", encoding="utf-8") as stream:
                stream.write("{broken")
            self.assertEqual(RuntimeMode.CORRUPT, resolve_runtime(td).mode)
            with self.assertRaises(StateStoreError):
                save_versioned_json(
                    flow_path, {"current": "build"}, "flow", project_root=td)
            with open(flow_path, encoding="utf-8") as stream:
                self.assertEqual("{broken", stream.read())

    def test_compare_and_swap_rejects_stale_snapshot(self):
        with tempfile.TemporaryDirectory() as td:
            state_path = os.path.join(td, ".mae-flow.json")
            save_versioned_json(
                state_path, {"current": "config_confirm"},
                "flow", project_root=td)
            first = normalize_document(read_json(state_path), "flow")
            stale = normalize_document(read_json(state_path), "flow")
            first["config"]["单号"] = "REQ-FIRST"
            save_versioned_json(state_path, first, "flow", project_root=td)
            stale["config"]["单号"] = "REQ-STALE"
            with self.assertRaises(StateConflictError):
                save_versioned_json(state_path, stale, "flow", project_root=td)

    def test_cli_emits_machine_readable_code_only_for_revision_conflict(self):
        stderr = io.StringIO()
        with mock.patch.object(
                state_config, "save_versioned_json",
                side_effect=StateConflictError(
                    "flow revision 已从 9 变为 10，拒绝用旧快照覆盖新状态")):
            with redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                state_config.save_state({"revision": 9})
        self.assertEqual(2, raised.exception.code)
        lines = stderr.getvalue().splitlines()
        self.assertEqual(
            '[mae-flow:error] {"code":"FLOW_REVISION_CONFLICT",'
            '"schema":"mae-flow-error/1"}', lines[0])

        stderr = io.StringIO()
        with mock.patch.object(
                state_config, "save_versioned_json",
                side_effect=StateStoreError(
                    "other failure mentions flow revision 已从 9 变为 10")):
            with redirect_stderr(stderr), self.assertRaises(SystemExit):
                state_config.save_state({"revision": 9})
        self.assertNotIn("FLOW_REVISION_CONFLICT", stderr.getvalue())

    def test_corrupt_sidecar_is_quarantined_not_deadlocked(self):
        with tempfile.TemporaryDirectory() as td:
            sidecar = os.path.join(td, ".mae-flow.json.tokens")
            with open(sidecar, "w", encoding="utf-8") as stream:
                stream.write("{broken-token")
            update_json(
                sidecar, lambda value: {"UT": {"status": "PASS"}},
                default={}, project_root=td, recover_corrupt=True)
            self.assertEqual("PASS", read_json(sidecar)["UT"]["status"])
            quarantined = [
                name for name in os.listdir(td)
                if name.startswith(".mae-flow.json.tokens.corrupt.")
            ]
            self.assertEqual(1, len(quarantined))

    def test_posttooluse_records_direct_agent_write_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            source = os.path.join(td, "src", "feature.cpp")
            os.makedirs(os.path.dirname(source), exist_ok=True)
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int feature() { return 1; }\n")
            save_versioned_json(
                os.path.join(td, ".mae-flow.json"),
                {"current": "build", "config": {}, "choices": {},
                 "history": [], "started": "2026-07-26 12:00:00"},
                "flow", project_root=td)
            atomic_write_json(
                os.path.join(td, ".mae-flow.json.agent-writes"),
                {"paths": {"legacy/write.cpp": {"tool": "file-write"}}},
            )
            payload = json.dumps({
                "cwd": td,
                "tool_name": "Edit",
                "tool_input": {"file_path": source},
                "tool_response": {"ok": True},
            }, ensure_ascii=False) + "\n"
            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
            hook = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "hooks", "dispatch.py"), "posttooluse"],
                cwd=td, input=payload, text=True, capture_output=True,
                env=env, timeout=15)
            self.assertEqual(0, hook.returncode, hook.stderr)
            with open(
                    os.path.join(td, ".mae-flow.json.agent-writes"),
                    encoding="utf-8") as stream:
                ledger = json.load(stream)
            self.assertIn("src/feature.cpp", ledger["paths"])
            self.assertIn("legacy/write.cpp", ledger["paths"])

    def test_standalone_posttooluse_captures_scope_confirmation(self):
        with tempfile.TemporaryDirectory() as td:
            action_path = os.path.join(
                td, ".mae-flow-work", "standalone-action.json")
            work_dir = os.path.join(
                td, ".mae-flow-work", "standalone", "scope-confirmation")
            os.makedirs(work_dir, exist_ok=True)
            save_versioned_json(action_path, {
                "kind": "ut",
                "id": "scope-confirmation",
                "status": "awaiting_scope_confirmation",
                "expires_epoch": time.time() + 3600,
                "scope_proposed_epoch": time.time() - 1,
                "work_dir": work_dir,
                "files": ["src/feature.py"],
                "sources": [],
                "config": {},
                "tokens": {},
                "rejections": {},
                "quality": {},
                "user_messages": [],
            }, "action", project_root=td)
            payload = json.dumps({
                "cwd": td,
                "tool_name": "AskUserQuestion",
                "tool_input": {},
                "tool_response": "确认以上范围",
            }, ensure_ascii=False) + "\n"
            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
            hook = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "hooks", "dispatch.py"), "posttooluse"],
                cwd=td, input=payload, text=True, capture_output=True,
                env=env, timeout=15)
            self.assertEqual(0, hook.returncode, hook.stderr)
            action = read_json(action_path)
            self.assertEqual(
                "确认以上范围",
                action["user_messages"][-1]["text"],
            )
            self.assertEqual(
                "CONFIRMED",
                action["tokens"]["ASKUSER"]["status"],
            )

    def test_terminal_flow_keeps_cli_state_but_all_hooks_bypass(self):
        with tempfile.TemporaryDirectory() as td:
            source = os.path.join(td, "src", "feature.cpp")
            os.makedirs(os.path.dirname(source), exist_ok=True)
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int feature() { return 1; }\n")
            save_versioned_json(
                os.path.join(td, ".mae-flow.json"),
                {"current": "end", "config": {"单号": "REQ-DONE"},
                 "choices": {}, "history": [],
                 "started": "2026-07-28 12:00:00",
                 "moonlight": {"enabled": True}},
                "flow", project_root=td)

            runtime = resolve_runtime(td)
            self.assertEqual(RuntimeMode.FLOW, runtime.mode)
            self.assertTrue(runtime.flow_terminal)

            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")

            def hook(event, payload):
                return subprocess.run(
                    [sys.executable, os.path.join(
                        ROOT, "hooks", "dispatch.py"), event],
                    cwd=td, input=json.dumps(
                        {"cwd": td, **payload}, ensure_ascii=False) + "\n",
                    text=True, capture_output=True, env=env, timeout=15)

            # 终态不是仍在运行的流程：六类 Hook 入口都不能继续使用旧步骤、
            # 旧月光设置或旧 Agent 任务卡接管普通开发。
            cases = [
                ("pretooluse", {
                    "tool_name": "Edit",
                    "tool_input": {"file_path": source},
                }),
                ("pretooluse", {
                    "tool_name": "Bash",
                    "tool_input": {"command": "git reset --hard"},
                }),
                ("pretooluse", {
                    "tool_name": "AskUserQuestion", "tool_input": {},
                }),
                ("pretooluse", {
                    "tool_name": "Task",
                    "tool_input": {
                        "subagent_type": "compile-agent",
                        "prompt": "run stale terminal task",
                    },
                }),
                ("posttooluse", {
                    "tool_name": "Write",
                    "tool_input": {"file_path": source},
                    "tool_response": {"ok": True},
                }),
                ("subagentstop", {}),
                ("stop", {}),
                ("userprompt", {"prompt": "流程结束后直接修改普通代码"}),
                ("sessionstart", {}),
            ]
            for event, payload in cases:
                result = hook(event, payload)
                self.assertEqual(
                    0, result.returncode,
                    "%s unexpectedly blocked:\n%s\n%s" % (
                        event, result.stdout, result.stderr))

            self.assertFalse(
                os.path.exists(os.path.join(
                    td, ".mae-flow.json.agent-writes")))
            self.assertFalse(
                os.path.exists(os.path.join(td, ".mae-flow.json.usermsg")))

            moonlight_intent = hook(
                "userprompt", {"prompt": "下一单开启月光宝盒继续"})
            self.assertEqual(
                0, moonlight_intent.returncode, moonlight_intent.stderr)
            with open(
                    os.path.join(td, ".mae-flow.json.usermsg"),
                    encoding="utf-8") as stream:
                messages = json.load(stream)
            self.assertEqual("end", messages[-1]["step"])
            self.assertIn("月光宝盒", messages[-1]["text"])

            # CLI 仍保留终态报告和下一单滚动所需的状态；只是门禁已解除。
            current = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"), "current"],
                cwd=td, text=True, capture_output=True, env=env, timeout=15)
            self.assertEqual(0, current.returncode, current.stderr)
            self.assertIn("流程已完成", current.stdout)

            direct_gate = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"),
                 "gate", "edit", source],
                cwd=td, text=True, capture_output=True, env=env, timeout=15)
            self.assertEqual(0, direct_gate.returncode, direct_gate.stderr)
            direct_bash_gate = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"),
                 "gate", "bash", "git reset --hard"],
                cwd=td, text=True, capture_output=True, env=env, timeout=15)
            self.assertEqual(
                0, direct_bash_gate.returncode, direct_bash_gate.stderr)

    def test_namespaced_slash_exit_and_terminal_exit_are_safe(self):
        env = dict(os.environ)

        def fixture(current):
            td = tempfile.TemporaryDirectory()
            root = td.name
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.email", "mae-flow@test.invalid"],
                cwd=root, check=True)
            subprocess.run(
                ["git", "config", "user.name", "MAE Flow Test"],
                cwd=root, check=True)
            source = os.path.join(root, "biz.cpp")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int value = 1;\n")
            subprocess.run(["git", "add", "biz.cpp"], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-qm", "fixture"], cwd=root, check=True)
            save_versioned_json(
                os.path.join(root, ".mae-flow.json"),
                {"current": current, "config": {"单号": "REQ-EXIT"},
                 "choices": {}, "history": [],
                 "started": "2026-07-29 10:00:00"},
                "flow", project_root=root)
            return td

        def hook(root, prompt="/mae-flow:mae-flow exit"):
            payload = json.dumps({
                "cwd": root,
                "prompt": prompt,
            }, ensure_ascii=False) + "\n"
            child_env = dict(env)
            child_env["PYTHONPYCACHEPREFIX"] = os.path.join(
                root, "pycache")
            return subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "hooks", "dispatch.py"), "userprompt"],
                cwd=root, input=payload, text=True, capture_output=True,
                env=child_env, timeout=15)

        # 公司宿主实际使用插件命名空间形式。它必须与短形式
        # `/mae-flow exit` 一样，由用户消息 Hook 直接完成退出。
        active = fixture("config_confirm")
        try:
            result = hook(active.name)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertFalse(
                os.path.exists(os.path.join(active.name, ".mae-flow.json")))
            with open(
                    os.path.join(active.name, ".mae-flow.json.exited"),
                    encoding="utf-8") as stream:
                record = json.load(stream)
            self.assertEqual("userprompt-hook", record["authorization"])
        finally:
            active.cleanup()

        # end 已经解除全部门禁。此时 exit 是幂等成功，不应转成需要下次
        # message-id 重入的 Direct 状态，更不能逼用户去真实终端输入 EXIT。
        terminal = fixture("end")
        try:
            result = hook(terminal.name)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertTrue(
                os.path.exists(os.path.join(terminal.name, ".mae-flow.json")))
            self.assertFalse(
                os.path.exists(os.path.join(
                    terminal.name, ".mae-flow.json.exited")))
            self.assertIn("无需再次退出", result.stdout)

            child_env = dict(env)
            child_env["PYTHONPYCACHEPREFIX"] = os.path.join(
                terminal.name, "pycache")
            raw_cli = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"), "exit"],
                cwd=terminal.name, text=True, capture_output=True,
                env=child_env, timeout=15)
            self.assertEqual(0, raw_cli.returncode, raw_cli.stderr)
            self.assertIn("无需再次退出", raw_cli.stdout)

            review_prompt = (
                "/mae-flow:mae-flow review-fix REQ-NEW "
                "继续现有 MR，清理无用 Markdown 并处理评审意见")
            review_hook = hook(terminal.name, review_prompt)
            self.assertEqual(
                0, review_hook.returncode, review_hook.stderr)
            with open(
                    os.path.join(terminal.name, ".mae-flow.json.usermsg"),
                    encoding="utf-8") as stream:
                messages = json.load(stream)
            message_id = messages[-1]["id"]
            rollover = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"),
                 "init", "--new", "--message-id", message_id],
                cwd=terminal.name, text=True, capture_output=True,
                env=child_env, timeout=20)
            self.assertEqual(0, rollover.returncode, rollover.stderr)
            self.assertIn("归一化为终态换轮", rollover.stdout)
            with open(
                    os.path.join(terminal.name, ".mae-flow.json"),
                    encoding="utf-8") as stream:
                next_round = json.load(stream)
            with open(
                    os.path.join(terminal.name, ".mae-flow.json.last"),
                    encoding="utf-8") as stream:
                previous = json.load(stream)
            with open(
                    os.path.join(terminal.name, ".mae-flow.json.usermsg"),
                    encoding="utf-8") as stream:
                carried = json.load(stream)
            self.assertEqual("config_confirm", next_round["current"])
            self.assertEqual("end", previous["current"])
            self.assertEqual(review_prompt, carried[-1]["text"])
            self.assertEqual("config_confirm", carried[-1]["step"])
        finally:
            terminal.cleanup()

        # end 只是完成记录，不是仍在途的完整流程。独立任务应在自身参数
        # 校验通过后自动归档终态，而不是要求用户先 exit。
        standalone = fixture("end")
        try:
            child_env = dict(env)
            child_env["PYTHONPYCACHEPREFIX"] = os.path.join(
                standalone.name, "pycache")
            invalid_action = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"),
                 "action", "start", "grill"],
                cwd=standalone.name, text=True, capture_output=True,
                env=child_env, timeout=20)
            self.assertEqual(2, invalid_action.returncode)
            self.assertTrue(os.path.exists(os.path.join(
                standalone.name, ".mae-flow.json")))
            self.assertFalse(os.path.exists(os.path.join(
                standalone.name, ".mae-flow.json.last")))

            action = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"),
                 "action", "start", "grill",
                 "--request", "澄清下一项需求边界"],
                cwd=standalone.name, text=True, capture_output=True,
                env=child_env, timeout=20)
            self.assertEqual(0, action.returncode, action.stderr)
            self.assertIn("无需 exit", action.stdout)
            self.assertFalse(os.path.exists(os.path.join(
                standalone.name, ".mae-flow.json")))
            self.assertTrue(os.path.exists(os.path.join(
                standalone.name, ".mae-flow.json.last")))
            self.assertTrue(os.path.exists(os.path.join(
                standalone.name, ".mae-flow-work",
                "standalone-action.json")))
        finally:
            standalone.cleanup()

        active_guard = fixture("config_confirm")
        try:
            child_env = dict(env)
            child_env["PYTHONPYCACHEPREFIX"] = os.path.join(
                active_guard.name, "pycache")
            wrong_new = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"), "init", "--new"],
                cwd=active_guard.name, text=True, capture_output=True,
                env=child_env, timeout=20)
            self.assertEqual(2, wrong_new.returncode)
            self.assertIn("不会覆盖", wrong_new.stderr)
            self.assertTrue(os.path.exists(os.path.join(
                active_guard.name, ".mae-flow.json")))
            self.assertFalse(os.path.exists(os.path.join(
                active_guard.name, ".mae-flow.json.last")))
        finally:
            active_guard.cleanup()

    def test_concurrent_read_modify_write_does_not_lose_updates(self):
        with tempfile.TemporaryDirectory() as td:
            counter = os.path.join(td, "counter.json")
            atomic_write_json(counter, {"count": 0})
            worker = (
                "from mae_flow_core import update_json\n"
                "p=" + repr(counter) + "\n"
                "for _ in range(30):\n"
                " update_json(p, lambda d: {'count': int(d.get('count', 0)) + 1},"
                " default={'count': 0}, project_root=" + repr(td) + ")\n"
            )
            env = dict(os.environ)
            env["PYTHONPATH"] = SCRIPTS + os.pathsep + env.get("PYTHONPATH", "")
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
            procs = [
                subprocess.Popen([sys.executable, "-c", worker], env=env)
                for _ in range(8)
            ]
            self.assertTrue(all(proc.wait(timeout=20) == 0 for proc in procs))
            self.assertEqual(240, read_json(counter)["count"])

    def test_cli_and_hook_share_conflict_precedence(self):
        with tempfile.TemporaryDirectory() as td:
            os.makedirs(os.path.join(td, ".mae-flow-work"), exist_ok=True)
            os.makedirs(os.path.join(td, "service"), exist_ok=True)
            source = os.path.join(td, "service", "Foo.cpp")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int value = 1;\n")
            save_versioned_json(
                os.path.join(td, ".mae-flow.json"),
                {"current": "config_confirm", "config": {}, "choices": {},
                 "history": [], "started": "2026-01-01 00:00:00"},
                "flow", project_root=td)
            save_versioned_json(
                os.path.join(
                    td, ".mae-flow-work", "standalone-action.json"),
                {"kind": "ut", "id": "stale-action",
                 "expires_epoch": time.time() + 3600,
                 "work_dir": os.path.join(
                     td, ".mae-flow-work", "standalone", "stale")},
                "action", project_root=td)
            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
            # 用"编辑流程状态账本"证明走的是完整流程门禁:独立任务模式只保护
            # 独立任务自己的文件，不会拦它。(本步不许改源码那条已退役,不能再当
            # 路由证据用。)
            payload = json.dumps({
                "cwd": td, "tool_name": "Edit",
                "tool_input": {
                    # Pi 的真实文件工具字段是 path；必须同样进入完整流程
                    # gate edit，不能因旧 Hook 的 file_path 接缝而绕过。
                    "path": os.path.join(td, ".mae-flow.json")},
            }) + "\n"
            hook = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "hooks", "dispatch.py"), "pretooluse"],
                cwd=td, input=payload, text=True, capture_output=True,
                env=env, timeout=15)
            self.assertEqual(2, hook.returncode, hook.stderr)

            atomic_write_json(
                os.path.join(td, ".mae-flow.json.exited"),
                {"status": "exited"})
            current = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"), "current"],
                cwd=td, text=True, capture_output=True, env=env, timeout=15)
            self.assertEqual(0, current.returncode, current.stderr)
            self.assertIn("config_confirm", current.stdout)
            self.assertNotIn("普通开发模式", current.stdout)

    def test_active_hook_source_writes_free_after_workflow_chosen(self):
        """真实 dispatch/CLI 路径钉住步骤级源码闸的退役口径。

        步骤级"本步禁改源码"2026-08-28 整体退役(用户拍板"编码阶段
        自由";实锤:流水线 RED 修复窗口 commit/add 有授权、edit 闸却
        拦死改码)。这条测试从"grill 必拦"翻面成"grill 必放",继续走
        真子进程——防的还是 4875f1e 型两套语义:纯函数改了口径,活跃
        Hook 却没跟上。只读资源的绝对保护不随退役松动。
        """
        with tempfile.TemporaryDirectory() as td:
            subprocess.run(["git", "init", "-q"], cwd=td, check=True)
            source = os.path.join(td, "service.cpp")
            with open(source, "w", encoding="utf-8") as stream:
                stream.write("int value = 1;\n")
            subprocess.run(["git", "add", "service.cpp"], cwd=td, check=True)
            env = dict(os.environ)
            env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = "test"
            env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = (
                "test@example.com")
            subprocess.run(
                ["git", "commit", "-qm", "base"], cwd=td, env=env,
                check=True)
            state_path = os.path.join(td, ".mae-flow.json")

            def set_step(step):
                save_versioned_json(state_path, {
                    "current": step,
                    "config": {"单号": "REQ-GATE", "基线分支": "master"},
                    "choices": {"workflow": "full"},
                    "history": [{"step": "workflow_select", "result": "done"}],
                    "started": "2026-08-25 10:00:00",
                }, "flow", project_root=td)

            def gate(*arguments):
                child_env = dict(env)
                child_env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
                return subprocess.run(
                    [sys.executable, os.path.join(
                        ROOT, "scripts", "mae-flow.py"), "gate", *arguments],
                    cwd=td, text=True, capture_output=True, env=child_env,
                    timeout=15)

            set_step("grill")
            edit = gate("edit", source)
            self.assertEqual(0, edit.returncode,
                             "workflow 已选定,grill 改源码不得再拦:%s"
                             % edit.stderr)
            bash = gate("bash", "sed -i s/1/2/ service.cpp")
            self.assertEqual(0, bash.returncode,
                             "Bash 写源码与 Edit 同一条自由:%s"
                             % bash.stderr)

            set_step("build")
            self.assertEqual(0, gate("edit", source).returncode,
                             "编码步骤照常放行")
            resource = os.path.join(
                td, ".mae-flow-work", "host-skills", "snapshot", "SKILL.md")
            os.makedirs(os.path.dirname(resource), exist_ok=True)
            with open(resource, "w", encoding="utf-8") as stream:
                stream.write("# projected skill\n")
            edit_resource = gate("edit", resource)
            self.assertEqual(2, edit_resource.returncode,
                             edit_resource.stderr)
            self.assertIn("只读资源", edit_resource.stderr)
            bash_resource = gate(
                "bash", "echo changed > .mae-flow-work/host-skills/"
                "snapshot/SKILL.md")
            self.assertEqual(2, bash_resource.returncode,
                             bash_resource.stderr)
            self.assertIn("只读 Skill/模板资源", bash_resource.stderr)
            self.assertEqual(
                0,
                gate("bash", "cat .mae-flow-work/host-skills/"
                     "snapshot/SKILL.md").returncode,
                "任务内投影必须可读，只禁止写入",
            )

    def test_statusline_uses_repository_boundary_and_runtime_precedence(self):
        with tempfile.TemporaryDirectory() as td:
            parent = os.path.join(td, "parent")
            child = os.path.join(parent, "child")
            os.makedirs(os.path.join(parent, ".git"))
            os.makedirs(os.path.join(child, ".git"))
            atomic_write_json(
                os.path.join(parent, ".mae-flow.json.exited"),
                {"status": "exited"})
            payload = json.dumps({"cwd": child}, ensure_ascii=False)
            env = dict(os.environ)
            env["PYTHONPATH"] = SCRIPTS + os.pathsep + env.get("PYTHONPATH", "")
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
            first = subprocess.run(
                [sys.executable, os.path.join(SCRIPTS, "statusline.py")],
                input=payload, text=True, capture_output=True, env=env, timeout=15)
            self.assertNotIn("已退出", first.stdout)

            save_versioned_json(
                os.path.join(child, ".mae-flow.json"),
                {"current": "config_confirm", "config": {}, "choices": {},
                 "history": [], "started": "2026-01-01 00:00:00"},
                "flow", project_root=child)
            atomic_write_json(
                os.path.join(child, ".mae-flow.json.exited"),
                {"status": "exited"})
            second = subprocess.run(
                [sys.executable, os.path.join(SCRIPTS, "statusline.py")],
                input=payload, text=True, capture_output=True, env=env, timeout=15)
            self.assertIn("配置确认", second.stdout)
            self.assertNotIn("已退出", second.stdout)

    def test_corrupt_exit_marker_has_deterministic_repair(self):
        with tempfile.TemporaryDirectory() as td:
            with open(
                    os.path.join(td, ".mae-flow.json.exited"),
                    "w", encoding="utf-8") as stream:
                stream.write("{broken-exit")
            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = os.path.join(td, "pycache")
            repaired = subprocess.run(
                [sys.executable, os.path.join(
                    ROOT, "scripts", "mae-flow.py"),
                 "doctor", "--repair-state"],
                cwd=td, text=True, capture_output=True, env=env, timeout=15)
            self.assertEqual(0, repaired.returncode, repaired.stderr)
            self.assertEqual(RuntimeMode.DIRECT, resolve_runtime(td).mode)
            bad_markers = [
                os.path.join(base, name)
                for base, _, names in os.walk(
                    os.path.join(td, ".mae-flow-work"))
                for name in names if name.endswith(".bad")
            ]
            self.assertEqual(1, len(bad_markers))


if __name__ == "__main__":
    unittest.main(verbosity=2)

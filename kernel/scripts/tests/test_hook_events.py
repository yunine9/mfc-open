#!/usr/bin/env python3
"""Tests for pure Hook event routing and policies."""

import os
import sys
import tempfile
import unittest
from types import SimpleNamespace


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import RuntimeMode  # noqa: E402
from mae_flow_core.adapters.hook_active_events import (  # noqa: E402
    ActiveHookEventAdapter,
)
from mae_flow_core.application.hooks.event_policies import (  # noqa: E402
    active_pretool_decision,
    agent_kind,
    standalone_pretool_decision,
    stop_decision,
)
from mae_flow_core.application.hooks.events import (  # noqa: E402
    HookEventPorts,
    handle_hook_event,
)
from mae_flow_core.application.hooks.models import HookResponse  # noqa: E402


class HookEventTests(unittest.TestCase):
    def runtime(self, mode, terminal=False, conflict=False):
        return SimpleNamespace(
            mode=mode,
            flow_terminal=terminal,
            has_conflict=conflict,
            conflicts=("flow+action",) if conflict else (),
            errors=("broken",) if mode == RuntimeMode.CORRUPT else (),
        )

    def ports(self):
        calls = []

        def handler(name):
            def call(*args):
                calls.append((name, args))
                return HookResponse(stdout=name + "\n")
            return call

        return HookEventPorts(
            conflict=handler("conflict"),
            corrupt=handler("corrupt"),
            terminal=handler("terminal"),
            standalone_pretool=handler("standalone_pretool"),
            standalone_inject=handler("standalone_inject"),
            direct=handler("direct"),
            inactive=handler("inactive"),
            pretool=handler("pretool"),
            inject=handler("inject"),
            subagentstop=handler("subagentstop"),
            posttool=handler("posttool"),
            stop=handler("stop"),
            log=handler("log"),
        ), calls

    def test_active_routes_every_public_event(self):
        expected = {
            "pretooluse": "pretool",
            "userprompt": "inject",
            "sessionstart": "inject",
            "subagentstop": "subagentstop",
            "posttooluse": "posttool",
            "stop": "stop",
        }
        for event, target in expected.items():
            with self.subTest(event=event):
                ports, calls = self.ports()
                response = handle_hook_event(
                    event, {}, self.runtime(RuntimeMode.FLOW), ports)
                self.assertEqual(target + "\n", response.stdout)
                self.assertIn(target, [name for name, _args in calls])

    def test_terminal_corrupt_direct_and_inactive_take_precedence(self):
        cases = (
            (RuntimeMode.FLOW, True, "pretooluse", "terminal"),
            (RuntimeMode.CORRUPT, False, "pretooluse", "corrupt"),
            (RuntimeMode.DIRECT, False, "posttooluse", "direct"),
            (RuntimeMode.INACTIVE, False, "stop", "inactive"),
        )
        for mode, terminal, event, target in cases:
            with self.subTest(mode=mode, event=event):
                ports, calls = self.ports()
                response = handle_hook_event(
                    event, {}, self.runtime(mode, terminal), ports)
                self.assertEqual(target + "\n", response.stdout)
                self.assertEqual(
                    target,
                    [name for name, _args in calls if name != "log"][-1],
                )

    def test_standalone_owns_answer_capture_and_active_events(self):
        expected = {
            "pretooluse": "standalone_pretool",
            "subagentstop": "subagentstop",
            "userprompt": "standalone_inject",
            "sessionstart": "standalone_inject",
            "posttooluse": "posttool",
            "stop": "inactive",
        }
        for event, target in expected.items():
            with self.subTest(event=event):
                ports, _calls = self.ports()
                response = handle_hook_event(
                    event, {}, self.runtime(RuntimeMode.STANDALONE), ports)
                self.assertEqual(target + "\n", response.stdout)

    def test_runtime_conflict_notice_is_prepended_without_changing_route(self):
        ports, calls = self.ports()
        response = handle_hook_event(
            "userprompt",
            {},
            self.runtime(RuntimeMode.FLOW, conflict=True),
            ports,
        )
        self.assertEqual("conflict\ninject\n", response.stdout)
        self.assertEqual(
            ["conflict", "inject"],
            [name for name, _args in calls if name != "log"],
        )

    def test_stop_policy_tracks_progress_and_fails_open_after_three_retries(self):
        state = {"current": "ut", "revision": 8, "moonlight": {"enabled": True}}
        first = stop_decision(state, False, {})
        progressed = stop_decision(state, True, {"revision": 7, "blocks": 3})
        exhausted = stop_decision(state, True, {"revision": 8, "blocks": 3})
        self.assertFalse(first.allow)
        self.assertEqual(1, first.blocks)
        self.assertFalse(progressed.allow)
        self.assertEqual(1, progressed.blocks)
        self.assertTrue(exhausted.allow)
        self.assertEqual("retry-limit", exhausted.reason)

    def test_stop_policy_allows_safe_points(self):
        for state in (
            {},
            {"moonlight": {"enabled": False}},
            {"current": "end", "moonlight": {"enabled": True}},
            {"current": "ut", "moonlight": {
                "enabled": True, "hard_blocked": True}},
            {"current": "push", "moonlight": {
                "enabled": True,
                "issues": [{"kind": "push"}],
            }},
        ):
            with self.subTest(state=state):
                self.assertTrue(stop_decision(state, False, {}).allow)

    def test_quality_agent_classification_is_application_policy(self):
        cases = (
            ("story-generator-agent", "STORY"),
            ("craft-reviewer-agent", "REVIEWER"),
            ("compile-agent", "COMPILE"),
            ("codecheck-fix-agent", "CODECHECK"),
            ("ut-generator-agent", "UT"),
            ("grill-critic-agent prep", "GRILL_PREP"),
            ("grill-critic-agent final", "GRILL_FINAL"),
            ("ordinary-agent", ""),
        )
        for name, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(
                    expected,
                    agent_kind({"subagent_type": name}),
                )

    def test_active_pretool_policy_preserves_gate_order(self):
        cases = (
            ("Task", {}, False, ("agent", "")),
            ("Agent", {}, False, ("agent", "")),
            ("AskUserQuestion", {}, True, ("block-question", "")),
            ("AskUserQuestion", {}, False, ("allow", "")),
            ("Edit", {"file_path": "src/a.py"}, False,
             ("gate-edit", "src/a.py")),
            ("Bash", {"command": "git commit"}, False,
             ("gate-bash", "git commit")),
        )
        for tool, value, moonlight, expected in cases:
            with self.subTest(tool=tool, moonlight=moonlight):
                decision = active_pretool_decision(
                    tool, value, moonlight)
                self.assertEqual(expected, (decision.action, decision.value))

    def test_pi_path_field_is_gated_and_repository_escape_is_blocked(self):
        with tempfile.TemporaryDirectory() as parent:
            project = os.path.join(parent, "project")
            os.makedirs(os.path.join(project, "src"))
            inside = os.path.join(project, "src", "inside.py")
            outside = os.path.join(parent, "outside.py")

            pi_write = active_pretool_decision(
                "Write", {"path": inside}, False, project)
            legacy_edit = active_pretool_decision(
                "Edit", {"file_path": "src/legacy.py"}, False, project)
            inside_read = active_pretool_decision(
                "Read", {"path": inside}, False, project)
            traversal = active_pretool_decision(
                "Write", {"path": "../outside.py"}, False, project)
            absolute_escape = active_pretool_decision(
                "Read", {"path": outside}, False, project)
            link_escape = None
            try:
                os.symlink(parent, os.path.join(project, "outside-link"))
                link_escape = active_pretool_decision(
                    "Write", {"path": "outside-link/secret.py"},
                    False, project)
            except (OSError, NotImplementedError):
                pass

        self.assertEqual(("gate-edit", inside),
                         (pi_write.action, pi_write.value))
        self.assertEqual(("gate-edit", "src/legacy.py"),
                         (legacy_edit.action, legacy_edit.value))
        self.assertEqual("allow", inside_read.action)
        self.assertEqual("block-path", traversal.action)
        self.assertEqual("block-path", absolute_escape.action)
        if link_escape is not None:
            self.assertEqual("block-path", link_escape.action)

    def test_cloud_task_access_root_allows_sibling_repair_material_only(self):
        with tempfile.TemporaryDirectory() as task:
            project = os.path.join(task, "project")
            pipeline = os.path.join(task, "pipeline")
            os.makedirs(project)
            os.makedirs(pipeline)
            sibling = active_pretool_decision(
                "Read", {"path": "../pipeline/compile.log"},
                False, project, task)
            reply = active_pretool_decision(
                "Write", {"path": "../review_replies.md"},
                False, project, task)
            escaped = active_pretool_decision(
                "Read", {"path": "../../other-task/secret"},
                False, project, task)
        self.assertEqual("allow", sibling.action)
        self.assertEqual(
            ("gate-edit", "../review_replies.md"),
            (reply.action, reply.value),
        )
        self.assertEqual("block-path", escaped.action)

    def test_active_adapter_routes_pi_path_to_gate_and_blocks_escape_first(self):
        calls = []
        runtime = SimpleNamespace(_contract_state=lambda: {})
        with tempfile.TemporaryDirectory() as parent:
            project = os.path.join(parent, "project")
            os.makedirs(project)
            adapter = ActiveHookEventAdapter(
                state=os.path.join(project, ".mae-flow.json"),
                maeflow_path=os.path.join(ROOT, "scripts", "mae-flow.py"),
                repository_root=project,
                maeflow=lambda *args: calls.append(args) or 2,
                runtime_adapter=runtime,
                task_card_ports=lambda: None,
                log=lambda message: None,
            )
            protected = adapter.pretool({
                "tool_name": "Write",
                "tool_input": {"path": ".mae-flow.json"},
            })
            escaped = adapter.pretool({
                "tool_name": "Read",
                "tool_input": {"path": "../secret.txt"},
            })

        self.assertEqual(2, protected.exit_code)
        self.assertEqual([("gate", "edit", ".mae-flow.json")], calls)
        self.assertEqual(2, escaped.exit_code)
        self.assertIn("当前任务工作区", escaped.stderr)

    def test_standalone_control_files_and_hook_commands_are_protected(self):
        edit = standalone_pretool_decision(
            "Write",
            {"file_path": ".mae-flow-work/standalone-action.json"},
        )
        command = standalone_pretool_decision(
            "Bash",
            {"command": "python hooks/dispatch.py stop"},
        )
        source = standalone_pretool_decision(
            "Edit", {"file_path": "src/main.py"})
        self.assertEqual("block-edit", edit.action)
        self.assertEqual("block-bash", command.action)
        self.assertEqual("allow", source.action)

    def test_template_upgrade_does_not_restart_document_review(self):
        """插件与任务模板不同也不触发新的模板诊断或重新检视。"""
        with tempfile.TemporaryDirectory() as project:
            with tempfile.TemporaryDirectory() as plugin:
                materialized = os.path.join(
                    project, ".mae-flow-work", "plugin-resources", "assets")
                built_in = os.path.join(
                    plugin, "skills", "mae-flow", "assets")
                for assets, heading in (
                        (materialized, "# 物化章节"),
                        (built_in, "# 插件升级后的新章节")):
                    os.makedirs(assets)
                    with open(
                            os.path.join(assets, "STORY-TEMPLATE.md"),
                            "w", encoding="utf-8") as stream:
                        stream.write(heading + "\n")
                document = os.path.join(project, "docs", "story",
                                        "STORY-REQ1.md")
                os.makedirs(os.path.dirname(document))
                with open(document, "w", encoding="utf-8") as stream:
                    stream.write("# 物化章节\n\n内容\n")
                adapter = ActiveHookEventAdapter(
                    state=os.path.join(project, ".mae-flow.json"),
                    maeflow_path=os.path.join(
                        plugin, "scripts", "mae-flow.py"),
                    repository_root=project,
                    maeflow=lambda *args: 0,
                    runtime_adapter=SimpleNamespace(
                        _record_agent_write=lambda path: None),
                    task_card_ports=lambda: None,
                    log=lambda message: None,
                )
                response = adapter.posttool({
                    "tool_name": "Write",
                    "tool_input": {"file_path": document},
                })
        self.assertEqual(0, response.exit_code, response.stderr)
        self.assertEqual("", response.stderr)


class MetaBoundTranscriptTests(unittest.TestCase):
    """实战事故:宿主 SubagentStop 给的 transcript 路径指向永不存在的文件
    (payload agent id 与落盘 id 错位),真实执行的编译被 fail-closed 判无证据。
    meta.json 的 toolUseId 提供确定性绑定;匹配不到照旧空返回,不猜最新文件。"""

    def test_missing_explicit_path_binds_via_meta_tooluseid(self):
        import json as jsonlib
        import tempfile, shutil
        from mae_flow_core.adapters.hook_transcript_paths import (
            resolve_agent_transcript)
        root = tempfile.mkdtemp(prefix="meta-bind-")
        self.addCleanup(shutil.rmtree, root, True)
        sub = os.path.join(root, "session", "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-real123.jsonl"), "w",
                  encoding="utf-8") as stream:
            stream.write("{}\n")
        with open(os.path.join(sub, "agent-real123.meta.json"), "w",
                  encoding="utf-8") as stream:
            jsonlib.dump({"agentType": "compile-agent",
                          "toolUseId": "toolu_ABC"}, stream)
        payload = {
            "agent_transcript_path": os.path.join(sub, "agent-wrong999.jsonl"),
            "transcript_path": os.path.join(root, "session.jsonl"),
        }
        resolved = resolve_agent_transcript(payload, "toolu_ABC")
        self.assertTrue(resolved.endswith("agent-real123.jsonl"))
        # 匹配不到 → 保持原显式路径(调用方 fail-closed 语义不变)
        miss = resolve_agent_transcript(payload, "toolu_NOPE")
        self.assertTrue(miss.endswith("agent-wrong999.jsonl"))
        # 同一 toolUseId 命中多份 → 拒绝猜测
        with open(os.path.join(sub, "agent-dup.meta.json"), "w",
                  encoding="utf-8") as stream:
            jsonlib.dump({"toolUseId": "toolu_ABC"}, stream)
        with open(os.path.join(sub, "agent-dup.jsonl"), "w",
                  encoding="utf-8") as stream:
            stream.write("{}\n")
        ambiguous = resolve_agent_transcript(payload, "toolu_ABC")
        self.assertTrue(ambiguous.endswith("agent-wrong999.jsonl"))

    def test_transcript_flush_race_is_absorbed_by_bounded_retry(self):
        """实测误差表:meta 启动即落盘,transcript 晚于 SubagentStop 0~8 秒。
        当场读取把真实执行过的编译判成无证据——重试等落盘,等到含最终
        tool_result 的匹配调用才收工。"""
        import json as jsonlib
        import tempfile, shutil
        from mae_flow_core.adapters.hook_transcript_paths import (
            transcript_quality_call)
        root = tempfile.mkdtemp(prefix="flush-race-")
        self.addCleanup(shutil.rmtree, root, True)
        sub = os.path.join(root, "s", "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-x.meta.json"), "w",
                  encoding="utf-8") as stream:
            jsonlib.dump({"toolUseId": "toolu_R"}, stream)
        jsonl = os.path.join(sub, "agent-x.jsonl")
        payload = {"transcript_path": os.path.join(root, "s.jsonl")}

        class Call:
            result_seen = True
        ticks = {"n": 0}

        def sleep(_seconds):
            ticks["n"] += 1
            if ticks["n"] == 2:            # 第三次尝试前文件才"刷盘"
                with open(jsonl, "w", encoding="utf-8") as stream:
                    stream.write("{}\n")

        call = transcript_quality_call(
            payload, "toolu_R",
            load_calls=lambda path: ["parsed"],
            pick_call=lambda calls: Call(),
            attempts=6, delay=0, sleep=sleep)
        self.assertIsNotNone(call)
        self.assertGreaterEqual(ticks["n"], 2)

    def test_partial_flush_and_never_arriving_transcript(self):
        import json as jsonlib
        import tempfile, shutil
        from mae_flow_core.adapters.hook_transcript_paths import (
            transcript_quality_call)
        root = tempfile.mkdtemp(prefix="flush-race2-")
        self.addCleanup(shutil.rmtree, root, True)
        sub = os.path.join(root, "s", "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-y.meta.json"), "w",
                  encoding="utf-8") as stream:
            jsonlib.dump({"toolUseId": "toolu_P"}, stream)
        with open(os.path.join(sub, "agent-y.jsonl"), "w",
                  encoding="utf-8") as stream:
            stream.write("{broken\n")
        attempts_seen = {"n": 0}

        def load(_path):
            attempts_seen["n"] += 1
            if attempts_seen["n"] < 3:
                raise ValueError("半行 JSON:还在刷盘")
            return ["ok"]

        class Call:
            result_seen = True
        call = transcript_quality_call(
            {"transcript_path": os.path.join(root, "s.jsonl")}, "toolu_P",
            load_calls=load, pick_call=lambda calls: Call(),
            attempts=6, delay=0, sleep=lambda _s: None)
        self.assertIsNotNone(call)         # 半行 JSON 重试后成功
        # 永远等不到 → None,fail-closed 语义交还调用方
        missing = transcript_quality_call(
            {"transcript_path": os.path.join(root, "s.jsonl")}, "toolu_NONE",
            load_calls=lambda p: [], pick_call=lambda c: None,
            attempts=3, delay=0, sleep=lambda _s: None)
        self.assertIsNone(missing)

    def test_sparse_payload_resolves_via_project_root_scan(self):
        """实测(第三次编译):后台代理的 SubagentStop 是贫载荷——无任何
        transcript 线索,而文件明明在窗口内已落盘。从项目根反推宿主目录
        (~/.claude/projects/<cwd 转义>/*/subagents),toolUseId 仍精确绑定。"""
        import json as jsonlib
        import tempfile, shutil
        from mae_flow_core.adapters.hook_transcript_paths import (
            resolve_agent_transcript)
        projects = tempfile.mkdtemp(prefix="projects-")
        self.addCleanup(shutil.rmtree, projects, True)
        cwd = os.getcwd()
        munged = cwd.replace(os.sep, "-").replace("/", "-")
        sub = os.path.join(projects, munged, "session-1", "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-z.jsonl"), "w",
                  encoding="utf-8") as stream:
            stream.write("{}\n")
        with open(os.path.join(sub, "agent-z.meta.json"), "w",
                  encoding="utf-8") as stream:
            jsonlib.dump({"toolUseId": "toolu_SPARSE"}, stream)
        resolved = resolve_agent_transcript(
            {}, "toolu_SPARSE", projects_base=projects)
        self.assertTrue(resolved.endswith("agent-z.jsonl"))
        self.assertEqual("", resolve_agent_transcript(
            {}, "toolu_MISSING", projects_base=projects))

    def test_project_root_wins_over_process_cwd(self):
        """实战第四次:反推依赖 cwd,而 hook 进程的 cwd 未必是项目根——
        同一份账本在正确目录下一次命中、在别处解析为空。取证必须用
        调用方确知的 repository_root,不看进程当时站在哪。"""
        import json as jsonlib
        import tempfile, shutil
        from mae_flow_core.adapters.hook_transcript_paths import (
            resolve_agent_transcript)
        projects = tempfile.mkdtemp(prefix="projects-root-")
        self.addCleanup(shutil.rmtree, projects, True)
        project_root = tempfile.mkdtemp(prefix="repo-root-")
        self.addCleanup(shutil.rmtree, project_root, True)
        munged = project_root.replace(os.sep, "-").replace("/", "-")
        sub = os.path.join(projects, munged, "s", "subagents")
        os.makedirs(sub)
        with open(os.path.join(sub, "agent-r.jsonl"), "w",
                  encoding="utf-8") as stream:
            stream.write("{}\n")
        with open(os.path.join(sub, "agent-r.meta.json"), "w",
                  encoding="utf-8") as stream:
            jsonlib.dump({"toolUseId": "toolu_ROOT"}, stream)
        # 进程 cwd 与项目根无关,照样解析得到
        resolved = resolve_agent_transcript(
            {}, "toolu_ROOT", projects_base=projects,
            project_root=project_root)
        self.assertTrue(resolved.endswith("agent-r.jsonl"))
        self.assertEqual("", resolve_agent_transcript(
            {}, "toolu_ROOT", projects_base=projects))

    def test_existing_explicit_path_wins_over_meta(self):
        import json as jsonlib
        import tempfile, shutil
        from mae_flow_core.adapters.hook_transcript_paths import (
            resolve_agent_transcript)
        root = tempfile.mkdtemp(prefix="meta-bind2-")
        self.addCleanup(shutil.rmtree, root, True)
        sub = os.path.join(root, "s", "subagents")
        os.makedirs(sub)
        explicit = os.path.join(sub, "agent-good.jsonl")
        with open(explicit, "w", encoding="utf-8") as stream:
            stream.write("{}\n")
        payload = {"agent_transcript_path": explicit,
                   "transcript_path": os.path.join(root, "s.jsonl")}
        self.assertEqual(explicit,
                         resolve_agent_transcript(payload, "toolu_X"))


if __name__ == "__main__":
    unittest.main()

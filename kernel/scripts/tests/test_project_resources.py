#!/usr/bin/env python3
"""Project-local launcher resources and readable work-package paths."""

import importlib
import importlib.util
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)


class ProjectResourceTests(unittest.TestCase):
    def test_plugin_resources_are_materialized_project_locally(self):
        runtime = importlib.import_module("mae_flow_core.cli_runtime")
        self.assertTrue(hasattr(runtime, "materialize_plugin_resources"))
        with tempfile.TemporaryDirectory() as root:
            paths = runtime.materialize_plugin_resources(root, ROOT)
            expected = os.path.join(
                root, ".mae-flow-work", "plugin-resources",
                "guidance", "grill.md")
            self.assertIn(expected, paths)
            self.assertTrue(os.path.isfile(expected))
            domain_template = os.path.join(
                root, ".mae-flow-work", "plugin-resources",
                "assets", "DOMAIN-SPEC-TEMPLATE.md")
            self.assertIn(domain_template, paths)
            self.assertTrue(os.path.isfile(domain_template))
            implementation_template = os.path.join(
                root, ".mae-flow-work", "plugin-resources",
                "assets", "IMPLEMENTATION-TEMPLATE.md")
            self.assertIn(implementation_template, paths)
            self.assertTrue(os.path.isfile(implementation_template))

    def test_current_hands_grill_agent_the_materialized_template(self):
        runtime = importlib.import_module("mae_flow_core.cli_runtime")
        current = importlib.import_module(
            "mae_flow_core.cli_commands.current")
        with tempfile.TemporaryDirectory() as root:
            runtime.materialize_plugin_resources(root, ROOT)
            before = os.getcwd()
            os.chdir(root)
            try:
                text = current._step_md_text("grill", {
                    "current": "grill",
                    "config": {"单号": "REQ-LOCAL-TEMPLATE"},
                    "choices": {"workflow": "full"},
                })
            finally:
                os.chdir(before)
            local = os.path.join(
                root, ".mae-flow-work", "plugin-resources", "assets",
                "GRILL-PREP-TEMPLATE.md")
            source = os.path.join(
                ROOT, "skills", "mae-flow", "assets",
                "GRILL-PREP-TEMPLATE.md")
            self.assertIn(local, text)
            self.assertNotIn(source, text)

    def test_template_command_returns_materialized_paths_for_every_kind(self):
        runtime = importlib.import_module("mae_flow_core.cli_runtime")
        commands = importlib.import_module(
            "mae_flow_core.cli_commands.codecheck_commands")
        names = {
            "story": "STORY-TEMPLATE.md",
            "chain": "CHAIN-TEMPLATE.md",
            "grill": "GRILL-PREP-TEMPLATE.md",
            "review": "REVIEW-TEMPLATE.md",
        }
        with tempfile.TemporaryDirectory() as root:
            runtime.materialize_plugin_resources(root, ROOT)
            before = os.getcwd()
            os.chdir(root)
            try:
                for kind, name in names.items():
                    output = io.StringIO()
                    with redirect_stdout(output):
                        commands.cmd_template(
                            None, SimpleNamespace(kind=kind))
                    self.assertEqual(
                        os.path.realpath(os.path.join(
                            root, ".mae-flow-work", "plugin-resources",
                            "assets", name)),
                        output.getvalue().strip(),
                    )
            finally:
                os.chdir(before)

    def test_standalone_grill_hands_out_project_local_template(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            env = dict(os.environ)
            env["PYTHONPYCACHEPREFIX"] = os.path.join(root, "pycache")
            result = subprocess.run(
                [sys.executable, os.path.join(ROOT, "scripts", "mae-flow.py"),
                 "action", "start", "grill", "--request", "澄清需求"],
                cwd=root, env=env, text=True, capture_output=True, timeout=15)
            self.assertEqual(0, result.returncode, result.stderr)
            local = os.path.join(
                root, ".mae-flow-work", "plugin-resources", "assets",
                "GRILL-PREP-TEMPLATE.md")
            source = os.path.join(
                ROOT, "skills", "mae-flow", "assets",
                "GRILL-PREP-TEMPLATE.md")
            self.assertIn(local, result.stdout)
            self.assertNotIn(source, result.stdout)
            self.assertTrue(os.path.isfile(local))

    def test_ordinary_ticket_keeps_readable_work_directory(self):
        self.assertIsNotNone(importlib.util.find_spec(
            "mae_flow_core.orchestration.work_package"))
        module = importlib.import_module(
            "mae_flow_core.orchestration.work_package")
        with tempfile.TemporaryDirectory() as root:
            package = module.ensure_work_package(root, "REQ-123")
            self.assertEqual("REQ-123", package.safe_ticket)
            self.assertEqual(
                os.path.join(root, ".mae-flow-work", "REQ-123"),
                package.root,
            )
            self.assertEqual("REQ-123", self._read(package.ticket_marker))
            self.assertEqual(
                os.path.join(package.root, "implementation.md"),
                package.implementation,
            )

    def test_case_collision_gets_short_stable_suffix(self):
        self.assertIsNotNone(importlib.util.find_spec(
            "mae_flow_core.orchestration.work_package"))
        module = importlib.import_module(
            "mae_flow_core.orchestration.work_package")
        with tempfile.TemporaryDirectory() as root:
            first = module.ensure_work_package(root, "REQ-123")
            second = module.ensure_work_package(root, "req-123")
            repeated = module.ensure_work_package(root, "req-123")
            self.assertEqual("REQ-123", first.safe_ticket)
            self.assertRegex(second.safe_ticket, r"^req-123-[0-9a-f]{8}$")
            self.assertEqual(second.safe_ticket, repeated.safe_ticket)

    def test_pre_marker_exact_directory_is_adopted_in_place(self):
        module = importlib.import_module(
            "mae_flow_core.orchestration.work_package")
        with tempfile.TemporaryDirectory() as root:
            existing = os.path.join(root, ".mae-flow-work", "REQ-123")
            os.makedirs(existing)
            with open(os.path.join(existing, "survey.md"), "w", encoding="utf-8") as stream:
                stream.write("legacy local context")
            package = module.ensure_work_package(root, "REQ-123")
            self.assertEqual(existing, package.root)
            self.assertEqual("REQ-123", self._read(package.ticket_marker))

    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8") as stream:
            return stream.read()


if __name__ == "__main__":
    unittest.main()


class MirrorCoverageTests(unittest.TestCase):
    """指到 plugin-resources 的路径,必须真的镜像过去。

    这类漏配没有任何报错:步骤文档写着"协议全文(必读): <路径>",
    模型去读,文件不在,于是当没读到——功能静默降级成一句口号。
    L3 的 build-fresh-context.md 就是这么漏的,而它恰恰是本轮要测的东西。
    """

    def _plugin_root(self):
        return os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", ".."))

    def _mirrored(self):
        from mae_flow_core.cli_runtime import _RESOURCE_FILES
        return {target for _, target in _RESOURCE_FILES}

    def _cited(self, text):
        return set(re.findall(r"plugin-resources/([A-Za-z0-9_./-]+\.\w+)",
                              text))

    def test_every_cited_resource_is_actually_mirrored(self):
        root = self._plugin_root()
        mirrored, missing = self._mirrored(), []
        for folder in ("flow/steps", "runtime/guidance", "skills/mae-flow"):
            base = os.path.join(root, *folder.split("/"))
            for here, _dirs, names in os.walk(base):
                for name in names:
                    if not name.endswith(".md"):
                        continue
                    path = os.path.join(here, name)
                    with io.open(path, encoding="utf-8") as stream:
                        for cited in self._cited(stream.read()):
                            if cited not in mirrored:
                                missing.append("%s → %s"
                                               % (os.path.relpath(path, root),
                                                  cited))
        self.assertEqual([], missing,
                         "步骤文档引用了未镜像的资源: %s" % missing)

    def test_prompt_code_cites_only_mirrored_resources(self):
        """指令是拼出来的,路径不在文档里——照样得核。"""
        from mae_flow_core.cli_commands import current as current_cmd
        room = tempfile.mkdtemp(prefix="mirror-")
        self.addCleanup(shutil.rmtree, room, True)
        before = os.getcwd()
        os.chdir(room)
        try:
            with io.open(".mae-flow-defaults.json", "w",
                         encoding="utf-8") as stream:
                stream.write('{"编码执行方式": "新上下文"}')
            banner = current_cmd._apply_build_execution_mode("build", "原文")
        finally:
            os.chdir(before)
        cited = self._cited(banner.replace(os.sep, "/"))
        self.assertTrue(cited, "L3 指令应当指向协议全文")
        self.assertEqual(set(), cited - self._mirrored())

    def test_materialized_guidance_and_standard_paths_are_fully_rooted(self):
        """裸 guidance/standards 路径会从业务仓根解析到错误位置。"""
        root = self._plugin_root()
        pattern = re.compile(
            r"(?<!plugin-resources/)(?<!runtime/)"
            r"\b(?:guidance|standards)/[A-Za-z0-9_.-]+\.md")
        offenders = []
        for folder in ("flow/steps", "runtime/guidance", "skills/mae-flow"):
            base = os.path.join(root, *folder.split("/"))
            for here, _dirs, names in os.walk(base):
                for name in names:
                    if not name.endswith(".md"):
                        continue
                    path = os.path.join(here, name)
                    with io.open(path, encoding="utf-8") as stream:
                        for match in pattern.findall(stream.read()):
                            offenders.append(
                                "%s → %s" % (
                                    os.path.relpath(path, root), match))
        self.assertEqual([], offenders)


class CitedArtifactsExistTests(unittest.TestCase):
    """指令里提到的东西,必须真的存在、而且看得见。

    L3 的协议全文漏配就是这么静默失效的。同一类还有另一头:步骤文档
    让用户去看 `.mae-flow-work/{单号}/review.md`,而面板的产物清单里
    根本没有这份文档——人被指去看一样面板上不存在的东西。
    """

    def _cited_ticket_docs(self):
        root = os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", ".."))
        pattern = re.compile(r"\.mae-flow-work/[{<]单号[}>]/([\w.-]+)\.md")
        found = set()
        for folder in ("flow", "runtime/guidance", "skills"):
            base = os.path.join(root, *folder.split("/"))
            for here, _dirs, names in os.walk(base):
                if "vendor" in here:
                    continue
                for name in names:
                    if not name.endswith(".md"):
                        continue
                    with io.open(os.path.join(here, name),
                                 encoding="utf-8") as stream:
                        found.update(pattern.findall(stream.read()))
        return found

    def test_every_cited_ticket_doc_is_shown_on_the_panel(self):
        from mae_flow_core.panel.snapshot import DOC_KINDS
        known = {stem for stem, _label in DOC_KINDS}
        missing = sorted(self._cited_ticket_docs() - known)
        self.assertEqual(
            [], missing,
            "步骤文档让人去看这些产物,面板却不展示: %s" % missing)

    def test_path_placeholder_syntax_is_uniform(self):
        """路径模板只许一种写法:两种并存,弱模型每见一次就多猜一次。
        (命令行取值仍用 `--ticket <单号>`,那是 CLI 惯例,不在此列。)"""
        root = os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", ".."))
        offenders = []
        for here, _dirs, names in os.walk(os.path.join(root, "flow")):
            for name in names:
                if not name.endswith(".md"):
                    continue
                path = os.path.join(here, name)
                with io.open(path, encoding="utf-8") as stream:
                    if ".mae-flow-work/<单号>" in stream.read():
                        offenders.append(os.path.relpath(path, root))
        self.assertEqual([], offenders)

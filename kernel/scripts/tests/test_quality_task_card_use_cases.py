#!/usr/bin/env python3
"""Quality task-card application use cases."""

import hashlib
import os
import sys
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from mae_flow_core.application.quality.task_cards import (  # noqa: E402
    ExecutionRootPorts,
    TaskCardStorePorts,
    append_execution_context,
    append_task_files,
    execution_roots,
    requirement_sources,
    standalone_task_record,
    store_task_card,
    task_file_groups,
)
from mae_flow_core.application.quality.task_card_documents import (  # noqa: E402
    build_full_task_document,
    build_standalone_task_document,
)
from mae_flow_core.quality.task_cards import TaskCardDocument  # noqa: E402


class QualityTaskCardUseCaseTests(unittest.TestCase):
    def test_file_groups_preserve_order_and_deduplicate_per_group(self):
        groups = task_file_groups(
            (
                "src/main.cpp",
                "tests/main_test.cpp",
                "CMakeLists.txt",
                "src/main.cpp",
            ),
            is_build=lambda path: path == "CMakeLists.txt",
            is_test=lambda path: path.startswith("tests/"),
        )

        self.assertEqual(("src/main.cpp",), groups.business)
        self.assertEqual(("tests/main_test.cpp",), groups.tests)
        self.assertEqual(("CMakeLists.txt",), groups.build)
        self.assertEqual(
            {
                "business": ["src/main.cpp"],
                "tests": ["tests/main_test.cpp"],
                "build": ["CMakeLists.txt"],
            },
            groups.as_legacy(),
        )

    def test_execution_roots_use_nearest_marker_and_never_guess_repo_root(self):
        directories = {
            "/repo",
            "/repo/services",
            "/repo/services/a",
            "/repo/services/a/src",
            "/repo/loose",
        }
        listings = {
            "/repo": ["README.md"],
            "/repo/services": [],
            "/repo/services/a": ["CMakeLists.txt", "src"],
            "/repo/services/a/src": ["main.cpp"],
            "/repo/loose": ["orphan.cpp"],
        }
        files = {
            "/repo/services/a/CMakeLists.txt",
            "/repo/services/a/src/main.cpp",
            "/repo/loose/orphan.cpp",
        }
        ports = ExecutionRootPorts(
            repository="/repo",
            absolute=lambda path: os.path.normpath(
                path if path.startswith("/") else "/repo/" + path),
            is_directory=lambda path: path in directories,
            list_directory=lambda path: listings[path],
            is_file=lambda path: path in files,
            is_build_path=lambda path: path.endswith("CMakeLists.txt"),
            relative=lambda path, root: os.path.relpath(path, root),
            dirname=os.path.dirname,
            join=os.path.join,
            separator="/",
            source_filenames=("cmakelists.txt",),
            descriptor_suffixes=(".gradle",),
        )

        plan = execution_roots(
            (
                "services/a/src/main.cpp",
                "services/a/CMakeLists.txt",
                "loose/orphan.cpp",
                "../outside.cpp",
            ),
            ports,
        )

        self.assertEqual(
            (("services/a", "检测到 CMakeLists.txt"),),
            plan.roots[:1],
        )
        self.assertIn(
            ("loose", "未找到构建入口，按相关源码所在目录定位"),
            plan.roots,
        )
        self.assertEqual(("../outside.cpp",), plan.unresolved)
        self.assertNotIn((".", "检测到 README.md"), plan.roots)

    def test_rendering_keeps_historical_execution_boundary_text(self):
        document = TaskCardDocument()
        append_task_files(document, "被测/业务源码", ("src/a.cpp",))
        append_task_files(document, "测试文件", ())
        append_execution_context(
            document,
            kind="UT",
            roots=(
                ("services/a", "检测到 CMakeLists.txt"),
                ("services/b", "检测到 pom.xml"),
            ),
            unresolved=(),
        )

        body = document.body()
        self.assertIn("被测/业务源码:\n- src/a.cpp", body)
        self.assertIn("测试文件:\n- （无）", body)
        self.assertIn("编译/UT执行目录:", body)
        self.assertIn("涉及多个模块", body)
        self.assertIn("禁止退回项目根", body)

    def test_requirement_sources_ignore_legacy_openspec_globs(self):
        config = {
            "需求文档": "docs/req.md",
            "CHANGE_NAME": "change-a",
        }
        seen = []

        def glob_paths(pattern):
            seen.append(pattern)
            return (
                ["openspec/changes/change-a/change.md"]
                if pattern.endswith("/change.md")
                else []
            )

        sources = requirement_sources(
            config,
            exists=lambda path: path == "docs/req.md",
            absolute=lambda path: "/repo/" + path,
            glob_paths=glob_paths,
        )

        self.assertEqual(("/repo/docs/req.md",), sources)
        self.assertEqual([], seen)

    def test_store_card_writes_plain_body_without_return_receipt(self):
        writes = []
        made = []
        document = TaskCardDocument(["# card", "line"])
        ports = TaskCardStorePorts(
            absolute=lambda path: "/repo/" + path.strip("/"),
            make_directory=lambda path: made.append(path),
            write_text=lambda path, body: writes.append((path, body)),
        )

        artifact = store_task_card(
            document,
            ".mae-flow-work/agent-tasks",
            "verify-ut.md",
            ports,
        )

        expected_body = "# card\nline\n"
        expected_digest = hashlib.sha256(
            expected_body.encode("utf-8")).hexdigest()
        self.assertEqual(expected_digest, artifact.digest)
        self.assertEqual(
            "/repo/.mae-flow-work/agent-tasks/verify-ut.md",
            artifact.path,
        )
        self.assertEqual(expected_body, writes[0][1])
        self.assertEqual(
            ["/repo/.mae-flow-work/agent-tasks"], made)

    def test_standalone_record_detaches_frozen_scope_and_snapshot(self):
        files = ["src/a.cpp"]
        roots = ["src"]
        snapshot = {"src/old.cpp": "fingerprint"}

        record = standalone_task_record(
            step="standalone_ut",
            path="/repo/task.md",
            head="deadbeef",
            scope="only a",
            allowed_files=files,
            task_files=files,
            execution_roots=roots,
            initial_source_fingerprints=snapshot,
            stage="",
            at="2026-07-30 01:00:00",
        )
        files.append("src/b.cpp")
        roots.append(".")
        snapshot["src/new.cpp"] = "later"

        self.assertEqual(["src/a.cpp"], record["task_files"])
        self.assertEqual(["src"], record["execution_roots"])
        self.assertEqual(
            None,
            record.get("initial_source_fingerprints"),
        )
        self.assertTrue(record["standalone"])

    def test_full_ut_document_renders_frozen_function_scope(self):
        document = build_full_task_document({
            "kind": "UT",
            "sid": "verify_ut",
            "project_root": "/repo",
            "head": "deadbeef",
            "config": {
                "单号": "REQ-1",
                "单号类型": "fix",
                "基线分支": "main",
                "编译方式": "build",
                "UT生成方式": "AutoUT",
                "UT运行命令": "test",
            },
            "diff": "main..HEAD",
            "scope": "",
            "precommit_review": False,
            "inherited_dirty": (),
            "sources": (),
            "groups": task_file_groups(
                ("src/a.cpp",), lambda _path: False,
                lambda _path: False),
            "change_count": 1,
            "task_file_count": 1,
            "execution_plan": type("Plan", (), {
                "roots": (("src", "检测到 CMakeLists.txt"),),
                "unresolved": (),
            })(),
            "lightcheck": None,
            "notes": (),
            "scan": {},
            "ut_targets": {
                "src/a.cpp": ({
                    "start": 7,
                    "end": 9,
                    "context": "changedFunction",
                    "deletion_only": False,
                },),
            },
        })

        body = document.body()
        self.assertIn("# Mae-Flow UT TASK CARD", body)
        self.assertIn(
            "- （未找到；UT agent 必须 FAIL，禁止对着实现猜测试）",
            body,
        )
        self.assertIn(
            "- src/a.cpp | 行 7-9 | changedFunction", body)
        self.assertIn("测试对象=本次修改的函数/行为", body)

    def test_standalone_codecheck_document_preserves_no_commit_boundary(self):
        document = build_standalone_task_document({
            "label": "CODECHECK",
            "action_id": "A-1",
            "kind": "codecheck",
            "stage": "",
            "project_root": "/repo",
            "head": "deadbeef",
            "request": "fix named warning",
            "files": ("src/a.cpp",),
            "config": {},
            "sources": (),
            "groups": task_file_groups(
                ("src/a.cpp",), lambda _path: False,
                lambda _path: False),
            "execution_plan": type("Plan", (), {
                "roots": (("src", "检测到 CMakeLists.txt"),),
                "unresolved": (),
            })(),
            "scan": {
                "count": 1,
                "files": ["src/a.cpp"],
                "pairs": [("RULE.ONE", "src/a.cpp", 4)],
            },
            "ut_targets": {},
        })

        body = document.body()
        self.assertIn(
            "# Mae-Flow Standalone CODECHECK TASK CARD", body)
        self.assertIn("提交策略: 禁止提交", body)
        self.assertIn(
            "Harness首检告警(规则|文件): "
            "RULE.ONE|src/a.cpp|4",
            body,
        )
        self.assertIn("禁止自动豁免", body)


if __name__ == "__main__":
    unittest.main()

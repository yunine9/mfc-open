#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规格工作区目录归一:openspec/ → .mae-flow-work/spec。

约束就两条,与门禁瘦身同款:**无残留、无阻塞**。

- 全新工程不再长出退役引擎名字的 openspec/,过程件统一进 .mae-flow-work/;
- 旧目录被 git 跟踪(老仓的历史领域真相、已提交在途单)时原地保留——
  搬走会在用户的 git status 里制造成片删除;
- 任何迁移失败都静默沿用旧根:引擎双根解析保证两种布局永远可用。
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

TESTS = os.path.abspath(os.path.dirname(__file__))
SCRIPTS = os.path.abspath(os.path.join(TESTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import specengine  # noqa: E402
from mae_flow_core.cli_commands.lean_migration import (  # noqa: E402
    migrate_legacy_spec_workspace,
)

NEW_RELATIVE = os.path.join(".mae-flow-work", "spec")


def git(root, *args):
    return subprocess.run(
        ["git", "-C", root, *args], check=True,
        capture_output=True, text=True)


class DualRootResolutionTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="spec-root-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_fresh_project_resolves_to_mae_flow_work(self):
        self.assertEqual(
            os.path.join(self.root, NEW_RELATIVE),
            specengine._openspec_dir(self.root))

    def test_legacy_dir_wins_while_it_exists(self):
        """在途旧单的 change 目录在旧根里——解析必须跟着旧根,否则
        _require_change_dir 找不到目录直接 SpecEngineError,流程卡死。"""
        os.makedirs(os.path.join(self.root, "openspec"))
        self.assertEqual(
            os.path.join(self.root, "openspec"),
            specengine._openspec_dir(self.root))

    def test_engine_writes_land_in_new_root_for_fresh_projects(self):
        specengine.ensure_config(self.root)
        self.assertTrue(os.path.isfile(
            os.path.join(self.root, NEW_RELATIVE, "config.yaml")))
        self.assertFalse(os.path.exists(os.path.join(self.root, "openspec")))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="spec-mig-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def seed_legacy(self):
        os.makedirs(os.path.join(self.root, "openspec", "changes", "req-x"))
        with open(os.path.join(self.root, "openspec", "config.yaml"),
                  "w", encoding="utf-8") as stream:
            stream.write("schema: spec-driven\n")

    def test_untracked_legacy_dir_is_relocated(self):
        git(self.root, "init", "-q")
        self.seed_legacy()
        moved, note = migrate_legacy_spec_workspace(self.root)
        self.assertTrue(moved)
        self.assertIn(".mae-flow-work/spec", note)
        self.assertFalse(os.path.exists(os.path.join(self.root, "openspec")))
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, NEW_RELATIVE, "config.yaml")))
        # 搬迁后引擎立即切到新根,change 目录原样可见
        self.assertIn("req-x", specengine._list_active_changes(self.root))

    def test_tracked_legacy_dir_stays_and_engine_keeps_working(self):
        """老仓的 openspec/specs 是已提交的历史真相:搬走 = git status 成片删除。"""
        git(self.root, "init", "-q")
        self.seed_legacy()
        git(self.root, "add", "openspec")
        git(self.root, "-c", "user.email=t@t", "-c", "user.name=t",
            "commit", "-qm", "legacy truth")
        moved, _ = migrate_legacy_spec_workspace(self.root)
        self.assertFalse(moved)
        self.assertTrue(os.path.isdir(os.path.join(self.root, "openspec")))
        # 引擎继续解析到旧根,在途旧单不断链
        self.assertIn("req-x", specengine._list_active_changes(self.root))

    def test_outside_git_repo_never_moves(self):
        """无 git 无法证明未跟踪——宁可保留旧布局也不冒险搬。"""
        self.seed_legacy()
        moved, _ = migrate_legacy_spec_workspace(self.root)
        self.assertFalse(moved)
        self.assertTrue(os.path.isdir(os.path.join(self.root, "openspec")))

    def test_existing_target_blocks_relocation(self):
        git(self.root, "init", "-q")
        self.seed_legacy()
        os.makedirs(os.path.join(self.root, NEW_RELATIVE))
        moved, _ = migrate_legacy_spec_workspace(self.root)
        self.assertFalse(moved)
        self.assertTrue(os.path.isdir(os.path.join(self.root, "openspec")))

    def test_idempotent_after_relocation(self):
        git(self.root, "init", "-q")
        self.seed_legacy()
        self.assertTrue(migrate_legacy_spec_workspace(self.root)[0])
        self.assertEqual((False, ""), migrate_legacy_spec_workspace(self.root))


if __name__ == "__main__":
    unittest.main()

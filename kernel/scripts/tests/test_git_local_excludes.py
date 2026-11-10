"""Runtime setup must not edit tracked ignore files, including in worktrees."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mae_flow_core.cli_commands import advancement, standalone_core


class LocalExcludesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        before = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, before)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        self.original = b"# user config \xff\n/build/\n"
        Path(".gitignore").write_bytes(self.original)
        self.git("add", ".gitignore")
        self.git("commit", "-qm", "baseline")
        for module in (advancement, standalone_core):
            patcher = mock.patch.object(module, "api", SimpleNamespace(
                sh=lambda command: subprocess.check_output(command, shell=True, text=True).strip()))
            patcher.start()
            self.addCleanup(patcher.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()

    def check_runtime_ignore(self):
        path = Path(self.git("rev-parse", "--git-path", "info/exclude"))
        path.parent.mkdir(parents=True, exist_ok=True)
        previous = b"# user local config \xfe\n# .mae-flow.json*\n/local-only"
        path.write_bytes(previous)
        for _ in range(2):
            advancement._gitignore()
            standalone_core._git_local_runtime_ignore()
        self.assertEqual(self.original, Path(".gitignore").read_bytes())
        self.assertTrue(path.read_bytes().startswith(previous + b"\n"))
        self.assertEqual(1, path.read_bytes().splitlines().count(b".mae-flow.json*"))
        Path(".mae-flow.json").write_text("{}")
        Path(".mae-flow-work").mkdir()
        Path(".mae-flow-work/runtime").write_text("runtime")
        Path("openspec").mkdir()
        Path("openspec/config.yaml").write_text("runtime")
        self.assertEqual("", self.git("status", "--porcelain"))
        self.assertEqual("", self.git("diff", "--cached", "--name-only"))

    def test_clone_preserves_user_files_and_ignores_runtime(self):
        self.check_runtime_ignore()

    def test_linked_worktree_uses_git_resolved_exclude(self):
        target = self.root / "linked"
        self.git("worktree", "add", "-q", "-b", "linked", str(target))
        os.chdir(target)
        self.assertTrue(Path(".git").is_file())
        self.check_runtime_ignore()

    def test_no_gitignore_is_created(self):
        self.git("rm", ".gitignore")
        self.git("commit", "-qm", "no user ignore file")
        advancement._gitignore()
        self.assertFalse(Path(".gitignore").exists())
        self.assertEqual("", self.git("status", "--porcelain"))


if __name__ == "__main__":
    unittest.main()

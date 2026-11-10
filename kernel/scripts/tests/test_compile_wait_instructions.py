#!/usr/bin/env python3
"""Regression coverage for compile waiting instructions and packaged Skill."""

import os
import re
import unittest
import zipfile


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

FORBIDDEN_WAIT_PATTERNS = (
    (r"(?m)^\s*(?:\$\s+)?sleep(?:\s|$)", "executable sleep"),
    (r"(?m)^\s*(?:\$\s+)?tail(?:\s|$)", "executable tail"),
    (r"(?m)^[^#\n]*\bmcde\s+build\s+-i[^\n]*\s&\s*$",
     "background build"),
    (r"(?m)^\s*[A-Z_]*PID\s*=", "PID assignment"),
    (r"\bkill\s+-0\b", "PID probing"),
    (r"/tmp/", "Unix temporary path"),
    (r"/home/claude(?:/|\b)", "host-specific home path"),
    (r"轮询日志尾部判断", "log-tail completion guessing"),
)


def repository_text(relative):
    with open(os.path.join(ROOT, relative), encoding="utf-8") as stream:
        return stream.read()


def forbidden_wait_primitives(content):
    return [
        label for pattern, label in FORBIDDEN_WAIT_PATTERNS
        if re.search(pattern, content)
    ]


class CompileWaitInstructionTests(unittest.TestCase):
    def test_compile_agents_use_one_synchronous_build_action(self):
        for relative in (
                "agents/codecheck-fix-agent.md",
                "agents/ut-generator-agent.md"):
            with self.subTest(relative=relative):
                content = repository_text(relative)
                self.assertNotIn("长间隔轮询", content)
                self.assertEqual([], forbidden_wait_primitives(content))
                compact = re.sub(r"\s+", "", content)
                for required in (
                        "单次同步", "最大超时", "返回就是完成信号",
                        "未变化", "timeout/transportfailure", "如实报告失败"):
                    self.assertIn(required, compact)

    def test_wait_primitive_scanner_rejects_known_regression_shapes(self):
        cases = {
            "sleep 60": "executable sleep",
            "tail -5 build.log": "executable tail",
            "mcde build -i > build.log 2>&1 &": "background build",
            "BUILD_PID=$!": "PID assignment",
            "kill -0 $BUILD_PID": "PID probing",
            "LOG=/tmp/build.log": "Unix temporary path",
            "find /home/claude -name '*.cpp'": "host-specific home path",
            "轮询日志尾部判断进度": "log-tail completion guessing",
        }
        for content, expected in cases.items():
            with self.subTest(content=content):
                self.assertIn(expected, forbidden_wait_primitives(content))

    def test_packaged_build_fix_uses_command_return_as_completion(self):
        with zipfile.ZipFile(
                os.path.join(ROOT, "build-fix.skill")) as archive:
            self.assertEqual(6, len(archive.infolist()))
            markdown = {
                name: archive.read(name).decode("utf-8")
                for name in archive.namelist()
                if name.endswith(".md")
            }
            skill = archive.read("build-fix/SKILL.md").decode("utf-8")
            locate = archive.read(
                "build-fix/references/step1_locate_build_dir.md").decode(
                    "utf-8")
            loop = archive.read(
                "build-fix/references/step2_build_loop.md").decode("utf-8")
        for name, content in markdown.items():
            with self.subTest(name=name):
                self.assertEqual([], forbidden_wait_primitives(content))
        self.assertIn("单次同步", skill)
        self.assertIn('cd "$BUILD_DIR" && mcde build -i', loop)
        self.assertIn("源码和构建输入未变化", loop)
        self.assertIn("属于 FAIL，不是 BLOCKED", loop)
        self.assertIn("Windows Git Bash", loop)
        self.assertNotIn("mapfile", locate)
        self.assertIn("while IFS= read -r -d '' file", locate)
        self.assertNotIn("后台执行+轮询", skill)
        self.assertNotIn("/tmp/build_output.txt", loop)
        self.assertNotRegex(loop, r"mcde build -i[^\n]*&")
        self.assertNotRegex(loop, r"\bsleep\s+\d")


if __name__ == "__main__":
    unittest.main()

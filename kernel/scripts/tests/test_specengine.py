#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""specengine 回归测试：纯单元测试 + 与内嵌 OpenSpec CLI 的差分对拍。

对拍原则：同一输入语料复制两份，一份交给内嵌 Node CLI（行为真相源），
一份交给纯 Python 引擎；比较 validate verdict 与 archive 之后整个
``openspec/`` 目录树（文件集合 + 逐文件内容，行尾统一后逐字节比较）。
发现不一致时改引擎服从 CLI，不改测试迁就引擎。

本机没有 node 时差分对拍用例整体 skip（并在 skip 理由里注明）；
纯单元测试不依赖 node，任何环境都必须全绿。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ROOT = os.path.abspath(os.path.join(SCRIPTS, ".."))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import specengine  # noqa: E402
from mae_flow_core.specengine import (  # noqa: E402
    SpecEngineError,
    archive,
    ensure_config,
    has_delta,
    instructions,
    new_change,
    status,
    tasks_source,
    validate,
)

OPENSPEC_MJS = os.path.join(
    ROOT, "runtime", "vendor", "openspec", "dist", "core", "artifact-graph",
    "openspec.mjs")
NODE = shutil.which("node")
GIT = shutil.which("git")
HAS_CLI = bool(NODE) and os.path.isfile(OPENSPEC_MJS)


# ---------------------------------------------------------------------------
# 语料构造与目录树快照
# ---------------------------------------------------------------------------

def write(root, rel, text):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as stream:
        stream.write(text)


def read_text(root, rel):
    path = os.path.join(root, *rel.split("/"))
    with open(path, encoding="utf-8") as stream:
        return stream.read()


def tree_snapshot(root):
    """openspec/ 下所有文件 → {相对 posix 路径: 内容 bytes}（\r\n 统一为 \n）。"""
    snapshot = {}
    base = os.path.join(root, "openspec")
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            with open(full, "rb") as stream:
                snapshot[rel] = stream.read().replace(b"\r\n", b"\n")
    return snapshot


def norm_slash(text):
    """对拍前的路径归一:引擎强制正斜杠是刻意差异,不算不一致。"""
    return text.replace("\\", "/")


def git_init(path):
    """语料放进临时 git 目录（git 不可用时静默跳过——OpenSpec 不依赖 git）。"""
    if not GIT:
        return
    subprocess.run(
        [GIT, "init", "-q", path], capture_output=True, text=True,
        encoding="utf-8", check=False)


MAIN_AUTH_SPEC = (
    "# user-auth Specification\n"
    "\n"
    "## Purpose\n"
    "Authentication behaviors for the whole platform, written long enough.\n"
    "\n"
    "## Requirements\n"
    "### Requirement: User login\n"
    "The system SHALL allow users to log in with email and password.\n"
    "\n"
    "#### Scenario: Successful login\n"
    "- **WHEN** user submits valid credentials\n"
    "- **THEN** system creates a session\n"
    "\n"
    "### Requirement: Session expiry\n"
    "The system SHALL expire sessions after 30 minutes.\n"
    "\n"
    "#### Scenario: Timeout\n"
    "- **WHEN** session idle 30 minutes\n"
    "- **THEN** system logs the user out\n"
    "\n"
    "### Requirement: Logout\n"
    "The system MUST allow logout at any time.\n"
    "\n"
    "#### Scenario: Manual logout\n"
    "- **WHEN** user clicks logout\n"
    "- **THEN** session ends\n"
    "\n"
    "## Notes\n"
    "Trailing free-form section kept as-is.\n"
)


def seed_project(root, with_main_spec=False):
    """最小工程骨架：config + changes/archive（可选：既有 user-auth 主 spec）。"""
    write(root, "openspec/config.yaml", "schema: spec-driven\n")
    os.makedirs(os.path.join(root, "openspec", "changes", "archive"),
                exist_ok=True)
    os.makedirs(os.path.join(root, "openspec", "specs"), exist_ok=True)
    if with_main_spec:
        write(root, "openspec/specs/user-auth/spec.md", MAIN_AUTH_SPEC)


def seed_change(root, name, delta_files=None, proposal=True, tasks=None,
                created="2026-07-20"):
    """构造一个 change 目录；delta_files = {域: delta spec 内容}。"""
    base = "openspec/changes/%s" % name
    write(root, base + "/.openspec.yaml",
          "schema: spec-driven\ncreated: %s\n" % created)
    if proposal:
        write(root, base + "/proposal.md",
              "## Why\n\nThis change is needed for a clearly explained reason "
              "that is long enough.\n\n## What Changes\n\n- adjust behavior\n")
    if tasks is not None:
        write(root, base + "/tasks.md", tasks)
    for domain, content in (delta_files or {}).items():
        write(root, "%s/specs/%s/spec.md" % (base, domain), content)


ADDED_OK = (
    "## ADDED Requirements\n"
    "\n"
    "### Requirement: Data export\n"
    "The system SHALL allow users to export their data as CSV.\n"
    "\n"
    "#### Scenario: Successful export\n"
    "- **WHEN** user clicks Export\n"
    "- **THEN** a CSV file downloads\n"
)


# ---------------------------------------------------------------------------
# 差分对拍
# ---------------------------------------------------------------------------

@unittest.skipUnless(
    HAS_CLI,
    "本机缺少 node（shutil.which 未找到）或内嵌 openspec.mjs 缺失，"
    "差分对拍无法真实执行，整组 skip；纯单元测试仍然覆盖引擎全部分支")
class DifferentialTests(unittest.TestCase):
    """CLI（真相源）与引擎的对拍：verdict 一致 + archive 后目录树逐字节一致。"""

    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="specengine-diff-")
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self._home = os.path.join(self._tmp, "home")
        os.makedirs(self._home, exist_ok=True)

    def _mk_root(self, tag):
        path = os.path.join(self._tmp, tag)
        os.makedirs(path, exist_ok=True)
        path = os.path.realpath(path)  # macOS /tmp 软链归一，保证与 CLI 路径可比
        git_init(path)
        return path

    def _cli_env(self):
        env = dict(os.environ)
        env.update({
            "DO_NOT_TRACK": "1",
            "OPENSPEC_TELEMETRY": "0",
            "NO_COLOR": "1",
            # 全局配置/数据目录隔离到测试临时区，避免污染真实环境
            "HOME": self._home,
            "XDG_CONFIG_HOME": os.path.join(self._home, ".config"),
            "XDG_DATA_HOME": os.path.join(self._home, ".local", "share"),
        })
        return env

    def _run_cli(self, root, *args):
        return subprocess.run(
            [NODE, OPENSPEC_MJS] + list(args), cwd=root, env=self._cli_env(),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=120, stdin=subprocess.DEVNULL)

    def _cli_validate_ok(self, root, change):
        result = self._run_cli(root, "validate", change, "--json")
        payload = json.loads(result.stdout)
        return bool(payload["items"][0]["valid"])

    def _pair(self, builder, change, expect_valid, expect_archive_ok):
        """一轮对拍；跨 UTC 午夜时（归档目录名会翻天）整轮重来一次。"""
        for attempt in (0, 1):
            day_before = specengine._utc_today()
            cli_root = self._mk_root("cli-%s-%d" % (change, attempt))
            eng_root = self._mk_root("eng-%s-%d" % (change, attempt))
            builder(cli_root)
            builder(eng_root)

            cli_valid = self._cli_validate_ok(cli_root, change)
            eng_valid, eng_messages = validate(eng_root, change)
            self.assertEqual(
                cli_valid, eng_valid,
                "validate verdict 与 CLI 不一致（change=%s）；引擎消息：%s"
                % (change, eng_messages))
            if not eng_valid:
                self.assertTrue(
                    any(message.startswith("[错误]") for message in eng_messages),
                    "verdict 为 False 时必须有 [错误] 级消息")

            cli_archive = self._run_cli(cli_root, "archive", change, "--yes")
            eng_error = None
            try:
                eng_result = archive(eng_root, change)
            except SpecEngineError as exc:
                eng_result = None
                eng_error = str(exc)

            if specengine._utc_today() != day_before and attempt == 0:
                continue  # 撞上 UTC 换日，语料重建重跑

            self.assertEqual(
                cli_archive.returncode == 0, eng_result is not None,
                "archive 成败与 CLI 不一致（change=%s）\nCLI stdout:\n%s\n"
                "CLI stderr:\n%s\n引擎错误：%s"
                % (change, cli_archive.stdout, cli_archive.stderr, eng_error))
            self.assertEqual(
                expect_valid, eng_valid,
                "场景预期 validate=%s，实际 %s" % (expect_valid, eng_valid))
            self.assertEqual(
                expect_archive_ok, eng_result is not None,
                "场景预期 archive=%s，实际相反；引擎错误：%s"
                % (expect_archive_ok, eng_error))
            self.assertEqual(
                tree_snapshot(cli_root), tree_snapshot(eng_root),
                "archive 后 openspec/ 目录树与 CLI 不一致（change=%s）" % change)
            return eng_result
        self.fail("连续两轮都撞上 UTC 换日，请重跑测试")

    # —— 场景 1：纯 ADDED，新建单域（主 spec 骨架生成） ——
    def test_added_single_new_domain(self):
        def builder(root):
            seed_project(root)
            seed_change(root, "add-export", {"data-export": ADDED_OK})
        result = self._pair(builder, "add-export", True, True)
        self.assertEqual(["openspec/specs/data-export/spec.md"], result["merged"])
        self.assertEqual(1, result["totals"]["added"])

    # —— 场景 2：ADDED 多域（一个已有域 + 一个新域） ——
    def test_added_multi_domain(self):
        def builder(root):
            seed_project(root, with_main_spec=True)
            seed_change(root, "add-two", {
                "data-export": ADDED_OK,
                "user-auth": (
                    "## ADDED Requirements\n\n"
                    "### Requirement: Password rules\n"
                    "The system MUST enforce a minimum password length of 12.\n\n"
                    "#### Scenario: Short password rejected\n"
                    "- **WHEN** password is shorter than 12\n"
                    "- **THEN** signup is rejected\n"),
            })
        result = self._pair(builder, "add-two", True, True)
        self.assertEqual(
            ["openspec/specs/data-export/spec.md",
             "openspec/specs/user-auth/spec.md"], result["merged"])

    # —— 场景 3：MODIFIED 整段替换 ——
    def test_modified_replace(self):
        def builder(root):
            seed_project(root, with_main_spec=True)
            seed_change(root, "tighten-expiry", {"user-auth": (
                "## MODIFIED Requirements\n\n"
                "### Requirement: Session expiry\n"
                "The system SHALL expire sessions after 15 minutes.\n\n"
                "#### Scenario: Timeout\n"
                "- **WHEN** session idle 15 minutes\n"
                "- **THEN** system logs the user out\n\n"
                "#### Scenario: Extended by activity\n"
                "- **WHEN** user acts before timeout\n"
                "- **THEN** the timer resets\n")})
        result = self._pair(builder, "tighten-expiry", True, True)
        self.assertEqual(1, result["totals"]["modified"])

    # —— 场景 4：REMOVED ——
    def test_removed(self):
        def builder(root):
            seed_project(root, with_main_spec=True)
            seed_change(root, "drop-logout", {"user-auth": (
                "## REMOVED Requirements\n\n"
                "### Requirement: Logout\n"
                "**Reason**: replaced by global session manager\n"
                "**Migration**: use the session manager panel\n")})
        result = self._pair(builder, "drop-logout", True, True)
        self.assertEqual(1, result["totals"]["removed"])

    # —— 场景 5：RENAMED（带反引号的 FROM/TO 形态） ——
    def test_renamed(self):
        def builder(root):
            seed_project(root, with_main_spec=True)
            seed_change(root, "rename-login", {"user-auth": (
                "## RENAMED Requirements\n\n"
                "- FROM: `### Requirement: User login`\n"
                "- TO: `### Requirement: Sign in`\n")})
        result = self._pair(builder, "rename-login", True, True)
        self.assertEqual(1, result["totals"]["renamed"])

    # —— 场景 6：同一文件多 requirement + 四段混用 + 前言保留 ——
    def test_multi_requirement_single_file(self):
        def builder(root):
            seed_project(root, with_main_spec=True)
            seed_change(root, "big-sweep", {"user-auth": (
                "## MODIFIED Requirements\n\n"
                "### Requirement: Session expiry\n"
                "The system SHALL expire sessions after 20 minutes.\n\n"
                "#### Scenario: Timeout\n"
                "- **WHEN** idle 20 minutes\n"
                "- **THEN** logged out\n\n"
                "## REMOVED Requirements\n\n"
                "- `### Requirement: Logout`\n\n"
                "## RENAMED Requirements\n\n"
                "- FROM: `### Requirement: User login`\n"
                "- TO: `### Requirement: Sign in`\n\n"
                "## ADDED Requirements\n\n"
                "### Requirement: Password reset\n"
                "The system SHALL allow password reset via email link.\n\n"
                "#### Scenario: Reset link\n"
                "- **WHEN** user requests reset\n"
                "- **THEN** an email is sent\n\n"
                "### Requirement: Account lockout\n"
                "The system MUST lock accounts after 5 failed attempts.\n\n"
                "#### Scenario: Lockout\n"
                "- **WHEN** 5 consecutive failures\n"
                "- **THEN** account locks for 15 minutes\n")})
        result = self._pair(builder, "big-sweep", True, True)
        self.assertEqual(
            {"added": 2, "modified": 1, "removed": 1, "renamed": 1},
            result["totals"])

    # —— 场景 7：中文正文（SHALL/MUST 与汉字混写，ASCII 词边界语义） ——
    def test_chinese_mixed_shall(self):
        def builder(root):
            seed_project(root, with_main_spec=True)
            seed_change(root, "cn-billing", {
                "billing": (
                    "## ADDED Requirements\n\n"
                    "### Requirement: 计费开关\n"
                    "系统SHALL支持按域开关计费，默认关闭。\n\n"
                    "#### Scenario: 开关立即生效\n"
                    "- **WHEN** 管理员切换计费开关\n"
                    "- **THEN** 新配置MUST在下一次请求生效\n"),
                "user-auth": (
                    "## MODIFIED Requirements\n\n"
                    "### Requirement: Session expiry\n"
                    "系统SHALL在会话闲置 30 分钟后使其过期（中文改写正文）。\n\n"
                    "#### Scenario: Timeout\n"
                    "- **WHEN** 会话闲置 30 分钟\n"
                    "- **THEN** 系统登出该用户\n"),
            })
        result = self._pair(builder, "cn-billing", True, True)
        self.assertEqual(
            ["openspec/specs/billing/spec.md",
             "openspec/specs/user-auth/spec.md"], result["merged"])

    # —— 场景 8：非法格式（三井号场景）应拒 ——
    def test_invalid_three_hash_scenario(self):
        def builder(root):
            seed_project(root)
            seed_change(root, "bad-hash", {"dom": (
                "## ADDED Requirements\n\n"
                "### Requirement: Login\n"
                "The system SHALL allow login.\n\n"
                "### Scenario: Wrong hash count\n"
                "- **WHEN** x\n"
                "- **THEN** y\n")})
        self._pair(builder, "bad-hash", False, False)

    # —— 场景 9：非法格式（正文缺 SHALL/MUST）应拒 ——
    def test_invalid_missing_shall(self):
        def builder(root):
            seed_project(root)
            seed_change(root, "no-shall", {"dom": (
                "## ADDED Requirements\n\n"
                "### Requirement: Login\n"
                "The system allows login without normative keyword.\n\n"
                "#### Scenario: ok\n"
                "- **WHEN** x\n"
                "- **THEN** y\n")})
        self._pair(builder, "no-shall", False, False)

    # —— 场景 10：MODIFIED 无目标：validate 放行（CLI 同款），archive 拒绝 ——
    def test_modified_without_target(self):
        def builder(root):
            seed_project(root)  # 没有任何主 spec
            seed_change(root, "mod-ghost", {"dom": (
                "## MODIFIED Requirements\n\n"
                "### Requirement: Ghost\n"
                "The system SHALL behave differently now.\n\n"
                "#### Scenario: s\n"
                "- **WHEN** x\n"
                "- **THEN** y\n")})
        self._pair(builder, "mod-ghost", True, False)

    # —— 场景 11：无 specs 的 change：validate 否决但 archive 放行（CLI 不对称行为） ——
    def test_change_without_specs_archives(self):
        def builder(root):
            seed_project(root)
            seed_change(root, "docs-only", None,
                        tasks="## 1. Docs\n\n- [x] 1.1 update docs\n")
        result = self._pair(builder, "docs-only", False, True)
        self.assertEqual([], result["merged"])

    # —— 场景 12：全流程（init/new change/instructions/archive 全链路对拍） ——
    def test_full_workflow_parity(self):
        for attempt in (0, 1):
            day_before = specengine._utc_today()
            cli_root = self._mk_root("cli-flow-%d" % attempt)
            eng_root = self._mk_root("eng-flow-%d" % attempt)

            init = self._run_cli(cli_root, "init", ".", "--tools", "none",
                                 "--profile", "core")
            self.assertEqual(0, init.returncode, init.stdout + init.stderr)
            # 对拍基准是 CLI 的 openspec/ 布局:先落空旧根,让引擎双根解析选它
            os.makedirs(os.path.join(eng_root, "openspec"), exist_ok=True)
            created = ensure_config(eng_root)
            self.assertTrue(created["created"])

            newc = self._run_cli(cli_root, "new", "change", "wf-change")
            self.assertEqual(0, newc.returncode, newc.stdout + newc.stderr)
            new_change(eng_root, "wf-change")
            if specengine._utc_today() != day_before and attempt == 0:
                continue
            self.assertEqual(tree_snapshot(cli_root), tree_snapshot(eng_root),
                             "init + new change 后目录树与 CLI 不一致")

            # instructions 对拍：同一棵树（CLI 侧），引擎只读，逐制品比较全文
            for artifact in ("proposal", "specs", "design", "tasks"):
                cli_out = self._run_cli(
                    cli_root, "instructions", artifact, "--change", "wf-change")
                self.assertEqual(0, cli_out.returncode)
                # 路径归一后比较:引擎按 Windows 军规强制正斜杠(模块级
                # 刻意差异),CLI 的 path.join 在 Windows 产反斜杠
                self.assertEqual(
                    norm_slash(cli_out.stdout),
                    norm_slash(instructions(cli_root, artifact, "wf-change")),
                    "instructions(%s) 文本与 CLI 不一致" % artifact)

            # 写齐四类制品后归档（两侧同字节输入）
            for root in (cli_root, eng_root):
                base = "openspec/changes/wf-change"
                write(root, base + "/proposal.md",
                      "## Why\n\nWorkflow parity fixture with sufficiently long "
                      "reasoning text.\n\n## What Changes\n\n- add export\n")
                write(root, base + "/design.md",
                      "## Context\n\nSmall.\n\n## Decisions\n\n- keep simple\n")
                write(root, base + "/tasks.md",
                      "## 1. Build\n\n- [x] 1.1 implement\n- [x] 1.2 verify\n")
                write(root, base + "/specs/data-export/spec.md", ADDED_OK)
            # proposal 完成后 specs 的依赖状态应翻转，再对拍一次 instructions
            cli_out = self._run_cli(
                cli_root, "instructions", "specs", "--change", "wf-change")
            self.assertEqual(
                norm_slash(cli_out.stdout),
                norm_slash(instructions(cli_root, "specs", "wf-change")),
                "依赖齐备后的 instructions(specs) 与 CLI 不一致")

            cli_archive = self._run_cli(cli_root, "archive", "wf-change", "--yes")
            self.assertEqual(0, cli_archive.returncode,
                             cli_archive.stdout + cli_archive.stderr)
            archive(eng_root, "wf-change")
            if specengine._utc_today() != day_before and attempt == 0:
                continue
            self.assertEqual(tree_snapshot(cli_root), tree_snapshot(eng_root),
                             "全流程归档后目录树与 CLI 不一致")
            return
        self.fail("连续两轮都撞上 UTC 换日，请重跑测试")

    # —— 场景 13：config 带 context/rules 时 instructions 注入块的对拍 ——
    def test_instructions_with_context_and_rules(self):
        cli_root = self._mk_root("cli-ctx")
        seed_project(cli_root, with_main_spec=True)
        write(cli_root, "openspec/config.yaml",
              "schema: spec-driven\n"
              "\n"
              "context: |\n"
              "  Tech stack: Python 3.8\n"
              "  内部约定：注释写中文\n"
              "\n"
              "rules:\n"
              "  proposal:\n"
              "    - Keep proposals under 500 words\n"
              "    - 提案必须包含风险小节\n")
        seed_change(cli_root, "ctx-change", {"user-auth": (
            "## ADDED Requirements\n\n"
            "### Requirement: Audit log\n"
            "The system SHALL keep an audit log.\n\n"
            "#### Scenario: Log written\n"
            "- **WHEN** any change happens\n"
            "- **THEN** an audit entry is written\n")}, proposal=False)
        for artifact in ("proposal", "specs", "tasks"):
            cli_out = self._run_cli(
                cli_root, "instructions", artifact, "--change", "ctx-change")
            self.assertEqual(0, cli_out.returncode)
            self.assertEqual(
                norm_slash(cli_out.stdout),
                norm_slash(instructions(cli_root, artifact, "ctx-change")),
                "带 context/rules 的 instructions(%s) 与 CLI 不一致" % artifact)


# ---------------------------------------------------------------------------
# 纯单元测试（不依赖 node）
# ---------------------------------------------------------------------------

class EngineBasicsTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="specengine-unit-")
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.root = os.path.realpath(self._tmp)

    def test_ensure_config_creates_full_template_and_is_idempotent(self):
        first = ensure_config(self.root)
        self.assertTrue(first["created"])
        # 全新工程:规格工作区落在 .mae-flow-work/spec(目录归一后的新根)
        content = read_text(self.root, ".mae-flow-work/spec/config.yaml")
        self.assertTrue(content.startswith("schema: spec-driven\n"))
        self.assertIn("# Project context (optional)", content)
        self.assertIn('#       - Always include a "Non-goals" section', content)
        self.assertTrue(os.path.isdir(os.path.join(
            self.root, ".mae-flow-work", "spec", "changes", "archive")))
        self.assertTrue(os.path.isdir(os.path.join(
            self.root, ".mae-flow-work", "spec", "specs")))
        second = ensure_config(self.root)
        self.assertFalse(second["created"])
        self.assertEqual(first["path"], second["path"])
        self.assertEqual(content, read_text(
            self.root, ".mae-flow-work/spec/config.yaml"))

    def test_new_change_products_and_duplicate_rejection(self):
        result = new_change(self.root, "first-change")
        self.assertEqual("spec-driven", result["schema"])
        metadata = read_text(
            self.root, ".mae-flow-work/spec/changes/first-change/.openspec.yaml")
        self.assertEqual(
            "schema: spec-driven\ncreated: %s\n" % result["created"], metadata)
        # 没跑过 ensure_config 时按 CLI 同款写最小 config
        self.assertEqual("schema: spec-driven\n",
                         read_text(self.root, ".mae-flow-work/spec/config.yaml"))
        with self.assertRaises(SpecEngineError):
            new_change(self.root, "first-change")

    def test_legacy_tasks_bad_encoding_readable_and_tolerant(self):
        """legacy tasks.md 坏编码:引擎报带 UTF-8 指引的错误(不裸 traceback),
        计数展示路径保持 CLI 同款宽容——与 v5 change.md 的收口对称。"""
        seed_project(self.root)
        seed_change(self.root, "enc", {"dom": ADDED_OK})
        path = os.path.join(self.root, "openspec", "changes", "enc", "tasks.md")
        with open(path, "wb") as stream:
            stream.write("- [ ] 1. 任务".encode("gbk") + b"\xff\n")
        with self.assertRaises(SpecEngineError) as ctx:
            tasks_source(self.root, "enc")
        self.assertIn("UTF-8", str(ctx.exception))
        self.assertEqual({"total": 0, "completed": 0},
                         status(self.root, "enc")["tasks"])

    def test_new_change_keeps_existing_full_config(self):
        ensure_config(self.root)
        full = read_text(self.root, ".mae-flow-work/spec/config.yaml")
        new_change(self.root, "second-change")
        self.assertEqual(
            full, read_text(self.root, ".mae-flow-work/spec/config.yaml"))

    def test_change_name_validation(self):
        for bad in ("", "a b", "../evil", "a/../b", "a.b", "a/b", "a\\b",
                    "名字", "x..y"):
            with self.assertRaises(SpecEngineError, msg=repr(bad)):
                new_change(self.root, bad)
        # 接口契约允许（比 CLI 宽）：下划线与大写——见 specengine 模块注释差异 2
        new_change(self.root, "Hotfix_20260725")
        self.assertTrue(os.path.isdir(os.path.join(
            specengine._changes_dir(self.root), "Hotfix_20260725")))

    def test_instructions_four_artifacts_from_vendored_sources(self):
        new_change(self.root, "instr-change")
        schema_dir = os.path.join(specengine.VENDOR_SCHEMAS_DIR, "spec-driven")
        for artifact in ("proposal", "specs", "design", "tasks"):
            text = instructions(self.root, artifact, "instr-change")
            self.assertTrue(text.startswith(
                '<artifact id="%s" change="instr-change" schema="spec-driven">'
                % artifact))
            self.assertTrue(text.endswith("</artifact>\n"))
            # 模板与指令必须来自 vendored 文件（防硬编码回归）
            template_name = {"proposal": "proposal.md", "specs": "spec.md",
                             "design": "design.md", "tasks": "tasks.md"}[artifact]
            with open(os.path.join(schema_dir, "templates", template_name),
                      encoding="utf-8") as stream:
                self.assertIn(stream.read().strip(), text)
        # proposal 无依赖不出 warning；specs 依赖缺失要有 warning + missing 列表
        self.assertNotIn("<warning>",
                         instructions(self.root, "proposal", "instr-change"))
        specs_text = instructions(self.root, "specs", "instr-change")
        self.assertIn("<warning>", specs_text)
        self.assertIn("Missing: proposal", specs_text)
        tasks_text = instructions(self.root, "tasks", "instr-change")
        self.assertIn("Missing: specs, design", tasks_text)  # requires 原始顺序
        self.assertNotIn("<unlocks>", tasks_text)
        self.assertIn("Completing this artifact enables: design, specs",
                      instructions(self.root, "proposal", "instr-change"))

    def test_instructions_bad_artifact_and_bad_change(self):
        new_change(self.root, "instr-err")
        with self.assertRaises(SpecEngineError):
            instructions(self.root, "bogus", "instr-err")
        with self.assertRaises(SpecEngineError):
            instructions(self.root, "proposal", "missing-change")

    def test_status_lifecycle(self):
        seed_project(self.root, with_main_spec=True)
        seed_change(self.root, "st-change", proposal=False)
        report = status(self.root, "st-change")
        self.assertEqual("spec-driven", report["schema"])
        self.assertEqual(["user-auth"], report["specs"])
        self.assertFalse(report["is_complete"])
        by_id = {item["id"]: item for item in report["artifacts"]}
        self.assertEqual("ready", by_id["proposal"]["status"])
        self.assertEqual("blocked", by_id["specs"]["status"])
        self.assertEqual(["proposal"], by_id["specs"]["missing_deps"])
        self.assertEqual(["design", "specs"], by_id["tasks"]["missing_deps"])
        # 制品顺序 = 拓扑序（proposal → design → specs → tasks）
        self.assertEqual(["proposal", "design", "specs", "tasks"],
                         [item["id"] for item in report["artifacts"]])
        base = "openspec/changes/st-change"
        write(self.root, base + "/proposal.md", "## Why\n\nx\n")
        write(self.root, base + "/specs/user-auth/spec.md", ADDED_OK)
        write(self.root, base + "/design.md", "## Context\n\nx\n")
        write(self.root, base + "/tasks.md",
              "- [x] 1.1 a\n- [ ] 1.2 b\n* [X] 1.3 c\n  - [ ] 缩进的不算\n")
        report = status(self.root, "st-change")
        self.assertTrue(report["is_complete"])
        self.assertEqual({"total": 3, "completed": 2}, report["tasks"])

    def test_status_missing_change_raises(self):
        seed_project(self.root)
        with self.assertRaises(SpecEngineError):
            status(self.root, "nope")

    def test_yaml_subset_parses_config_context_and_rules(self):
        write(self.root, "openspec/config.yaml",
              "schema: spec-driven\n"
              "\n"
              "# 注释行要被忽略\n"
              "context: |\n"
              "  第一行\n"
              "\n"
              "  第三行（中间空行保留）\n"
              "rules:\n"
              "  proposal:\n"
              "    - 规则一\n"
              "    - 规则二\n")
        config = specengine._read_project_config(self.root)
        self.assertEqual("spec-driven", config["schema"])
        self.assertEqual("第一行\n\n第三行（中间空行保留）\n", config["context"])
        self.assertEqual({"proposal": ["规则一", "规则二"]}, config["rules"])


class ValidateUnitTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="specengine-val-")
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.root = os.path.realpath(self._tmp)
        seed_project(self.root)

    def _verdict(self, delta, domain="dom", change="val-change"):
        seed_change(self.root, change, {domain: delta})
        ok, messages = validate(self.root, change)
        shutil.rmtree(os.path.join(self.root, "openspec", "changes", change))
        return ok, messages

    def test_valid_added_passes(self):
        ok, messages = self._verdict(ADDED_OK)
        self.assertTrue(ok, messages)
        self.assertEqual([], messages)

    def test_three_hash_scenario_rejected_with_info(self):
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n### Requirement: Login\n"
            "The system SHALL allow login.\n\n"
            "### Scenario: Bad\n- **WHEN** x\n- **THEN** y\n")
        self.assertFalse(ok)
        self.assertTrue(any(m.startswith("[提示]") and "### Scenario: Bad" in m
                            for m in messages), messages)
        self.assertTrue(any(m.startswith("[错误]") and "Scenario" in m
                            for m in messages), messages)
        self.assertTrue(all("dom/spec.md" in m for m in messages), messages)

    def test_missing_shall_rejected(self):
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n### Requirement: Login\n"
            "The system allows login.\n\n#### Scenario: s\n- **WHEN** x\n"
            "- **THEN** y\n")
        self.assertFalse(ok)
        self.assertTrue(any("SHALL" in m for m in messages), messages)

    def test_shall_only_in_header_rejected_with_hint(self):
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n### Requirement: The system SHALL login\n"
            "It does login.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n")
        self.assertFalse(ok)
        self.assertTrue(any("头" in m and "正文" in m for m in messages), messages)

    def test_five_hash_scenario_not_counted(self):
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n### Requirement: Login\n"
            "The system SHALL allow login.\n\n##### Scenario: too deep\n"
            "- **WHEN** x\n- **THEN** y\n")
        self.assertFalse(ok)
        self.assertTrue(any("场景" in m for m in messages), messages)

    def test_any_four_hash_header_counts_as_scenario(self):
        # CLI 数场景只认「####+空白」，不要求 Scenario: 前缀——引擎必须同宽
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n### Requirement: Login\n"
            "The system SHALL allow login.\n\n#### 场景: 中文场景头\n"
            "- **WHEN** x\n- **THEN** y\n")
        self.assertTrue(ok, messages)

    def test_chinese_shall_ascii_word_boundary(self):
        ok, _ = self._verdict(
            "## ADDED Requirements\n\n### Requirement: 中文\n"
            "系统SHALL支持中文正文。\n\n#### Scenario: s\n- **WHEN** x\n"
            "- **THEN** y\n")
        self.assertTrue(ok)  # 汉字与 SHALL 相邻在 ASCII 词边界下算命中（同 CLI）
        ok, _ = self._verdict(
            "## ADDED Requirements\n\n### Requirement: 边界\n"
            "系统SHALLABC支持。\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n")
        self.assertFalse(ok)  # SHALLABC 连写不构成词边界（同 CLI）

    def test_modified_without_target_passes_validate(self):
        # CLI 的 validate 不做「MODIFIED 目标存在」跨检查——CLI 放过的不许拦；
        # 该错误由 archive 阶段拦（见 ArchiveUnitTests）
        ok, messages = self._verdict(
            "## MODIFIED Requirements\n\n### Requirement: Ghost\n"
            "The system SHALL do it differently.\n\n#### Scenario: s\n"
            "- **WHEN** x\n- **THEN** y\n")
        self.assertTrue(ok, messages)

    def test_duplicates_and_cross_section_conflicts(self):
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n"
            "### Requirement: Dup\nThe system SHALL a.\n\n#### Scenario: s\n"
            "- **WHEN** x\n- **THEN** y\n\n"
            "### Requirement: Dup\nThe system SHALL b.\n\n#### Scenario: t\n"
            "- **WHEN** x\n- **THEN** y\n\n"
            "## REMOVED Requirements\n\n### Requirement: Dup\n")
        self.assertFalse(ok)
        self.assertTrue(any("重复" in m for m in messages), messages)
        self.assertTrue(any("同时出现在 ADDED 和 REMOVED" in m for m in messages),
                        messages)

    def test_renamed_duplicate_from_rejected(self):
        ok, messages = self._verdict(
            "## RENAMED Requirements\n\n"
            "- FROM: `### Requirement: A`\n- TO: `### Requirement: B`\n"
            "- FROM: `### Requirement: A`\n- TO: `### Requirement: C`\n")
        self.assertFalse(ok)
        self.assertTrue(any("FROM" in m for m in messages), messages)

    def test_empty_sections_and_missing_headers_and_no_deltas(self):
        ok, messages = self._verdict(
            "## ADDED Requirements\n\n(这里忘了写 requirement)\n")
        self.assertFalse(ok)
        self.assertTrue(any("## ADDED Requirements" in m for m in messages),
                        messages)
        ok, messages = self._verdict("# 随便写的文件\n\n没有分节头。\n")
        self.assertFalse(ok)
        self.assertTrue(any("没有任何 delta 分节头" in m for m in messages),
                        messages)
        seed_change(self.root, "empty-change", None)
        ok, messages = validate(self.root, "empty-change")
        self.assertFalse(ok)
        self.assertTrue(any("至少要有一个 delta" in m for m in messages), messages)

    def test_missing_change_raises(self):
        with self.assertRaises(SpecEngineError):
            validate(self.root, "does-not-exist")


class ArchiveUnitTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="specengine-arc-")
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.root = os.path.realpath(self._tmp)

    def test_added_creates_skeleton_exact_bytes(self):
        # 期望字节以真实 CLI 输出为准（对拍场景 1 的固化快照，勿改动迁就引擎）
        seed_project(self.root)
        seed_change(self.root, "add-export", {"data-export": ADDED_OK})
        result = archive(self.root, "add-export", date="2026-01-02")
        self.assertEqual("2026-01-02-add-export", result["archive_name"])
        expected = (
            "# data-export Specification\n"
            "\n"
            "## Purpose\n"
            "TBD - created by archiving change add-export. "
            "Update Purpose after archive.\n"
            "## Requirements\n"
            "### Requirement: Data export\n"
            "The system SHALL allow users to export their data as CSV.\n"
            "\n"
            "#### Scenario: Successful export\n"
            "- **WHEN** user clicks Export\n"
            "- **THEN** a CSV file downloads\n"
            "\n")
        self.assertEqual(expected,
                         read_text(self.root, "openspec/specs/data-export/spec.md"))
        self.assertFalse(os.path.exists(
            os.path.join(self.root, "openspec", "changes", "add-export")))
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "openspec", "changes", "archive",
            "2026-01-02-add-export", "specs", "data-export", "spec.md")))

    def test_merge_order_modified_in_place_renamed_and_added_to_tail(self):
        seed_project(self.root, with_main_spec=True)
        seed_change(self.root, "sweep", {"user-auth": (
            "## MODIFIED Requirements\n\n"
            "### Requirement: Session expiry\n"
            "The system SHALL expire sessions after 15 minutes.\n\n"
            "#### Scenario: Timeout\n- **WHEN** idle 15\n- **THEN** out\n\n"
            "## REMOVED Requirements\n\n### Requirement: Logout\n\n"
            "## RENAMED Requirements\n\n"
            "- FROM: `### Requirement: User login`\n"
            "- TO: `### Requirement: Sign in`\n\n"
            "## ADDED Requirements\n\n"
            "### Requirement: Password reset\n"
            "The system SHALL allow password reset.\n\n"
            "#### Scenario: Reset\n- **WHEN** ask\n- **THEN** email\n")})
        archive(self.root, "sweep", date="2026-01-02")
        merged = read_text(self.root, "openspec/specs/user-auth/spec.md")
        # 顺序：MODIFIED 原位（Session expiry 仍在最前）→ 改名块 → 新增块；
        # Requirements 后的 ## Notes 原样保留
        order = [merged.index("### Requirement: Session expiry"),
                 merged.index("### Requirement: Sign in"),
                 merged.index("### Requirement: Password reset"),
                 merged.index("## Notes")]
        self.assertEqual(order, sorted(order))
        self.assertNotIn("### Requirement: Logout", merged)
        self.assertNotIn("### Requirement: User login", merged)
        self.assertIn("after 15 minutes", merged)
        self.assertNotIn("after 30 minutes", merged)

    def test_repeat_archive_rejected_without_half_success(self):
        seed_project(self.root)
        seed_change(self.root, "twice", {"data-export": ADDED_OK})
        archive(self.root, "twice", date="2026-01-02")
        first_merge = read_text(self.root, "openspec/specs/data-export/spec.md")
        # 同名 change 再来一轮、同日期归档：必须整体拒绝。第二轮的 delta 本身
        # 可干净合并（新 requirement 名），CLI 在这种输入下会先把它并进主 spec
        # 再报「归档目标已存在」，留下半成功现场（引擎已知差异 1：检查前移，
        # 不写任何文件）
        seed_change(self.root, "twice", {"data-export": ADDED_OK.replace(
            "Data export", "Data export v2").replace(
            "Successful export", "Second export")})
        before = tree_snapshot(self.root)
        with self.assertRaises(SpecEngineError) as ctx:
            archive(self.root, "twice", date="2026-01-02")
        self.assertIn("归档目标已存在", str(ctx.exception))
        self.assertEqual(before, tree_snapshot(self.root),
                         "重复归档失败后现场必须原样（半成功免疫）")
        self.assertEqual(first_merge,
                         read_text(self.root, "openspec/specs/data-export/spec.md"))

    def test_modified_without_target_rejected_at_archive(self):
        seed_project(self.root)
        seed_change(self.root, "mod-ghost", {"dom": (
            "## MODIFIED Requirements\n\n### Requirement: Ghost\n"
            "The system SHALL differ.\n\n#### Scenario: s\n- **WHEN** x\n"
            "- **THEN** y\n")})
        before = tree_snapshot(self.root)
        with self.assertRaises(SpecEngineError) as ctx:
            archive(self.root, "mod-ghost", date="2026-01-02")
        self.assertIn("MODIFIED", str(ctx.exception))
        self.assertEqual(before, tree_snapshot(self.root))

    def test_removed_not_found_rejected(self):
        seed_project(self.root, with_main_spec=True)
        seed_change(self.root, "rm-ghost", {"user-auth": (
            "## REMOVED Requirements\n\n### Requirement: Ghost req\n")})
        before = tree_snapshot(self.root)
        with self.assertRaises(SpecEngineError):
            archive(self.root, "rm-ghost", date="2026-01-02")
        self.assertEqual(before, tree_snapshot(self.root))

    def test_modified_dropping_scenario_rejected(self):
        seed_project(self.root, with_main_spec=True)
        seed_change(self.root, "drop-scene", {"user-auth": (
            "## MODIFIED Requirements\n\n### Requirement: Session expiry\n"
            "The system SHALL expire sessions after 10 minutes.\n\n"
            "#### Scenario: Different name\n- **WHEN** idle\n- **THEN** out\n")})
        with self.assertRaises(SpecEngineError) as ctx:
            archive(self.root, "drop-scene", date="2026-01-02")
        self.assertIn("Timeout", str(ctx.exception))  # 指出被丢的场景名

    def test_invalid_delta_rejected_before_any_write(self):
        seed_project(self.root, with_main_spec=True)
        seed_change(self.root, "bad-delta", {"user-auth": (
            "## ADDED Requirements\n\n### Requirement: NoScene\n"
            "The system SHALL x.\n")})
        before = tree_snapshot(self.root)
        with self.assertRaises(SpecEngineError):
            archive(self.root, "bad-delta", date="2026-01-02")
        self.assertEqual(before, tree_snapshot(self.root))

    def test_rebuilt_spec_validation_blocks_on_broken_target(self):
        # 目标主 spec 里存在缺场景的旧 requirement：重建结果过不了 spec 级校验，
        # 归档必须中止且不写盘（CLI 同款门）
        seed_project(self.root)
        write(self.root, "openspec/specs/legacy/spec.md",
              "# legacy Specification\n\n## Purpose\n"
              "Legacy domain with a scenario-less requirement kept long enough.\n\n"
              "## Requirements\n### Requirement: Old rule\n"
              "The system SHALL do old things.\n")
        seed_change(self.root, "touch-legacy", {"legacy": ADDED_OK.replace(
            "Data export", "New rule")})
        before = tree_snapshot(self.root)
        with self.assertRaises(SpecEngineError) as ctx:
            archive(self.root, "touch-legacy", date="2026-01-02")
        self.assertIn("Old rule", str(ctx.exception))
        self.assertEqual(before, tree_snapshot(self.root))

    def test_move_failure_rolls_back_written_specs(self):
        seed_project(self.root, with_main_spec=True)
        seed_change(self.root, "roll-back", {
            "user-auth": (
                "## MODIFIED Requirements\n\n### Requirement: Session expiry\n"
                "The system SHALL expire sessions after 5 minutes.\n\n"
                "#### Scenario: Timeout\n- **WHEN** idle 5\n- **THEN** out\n"),
            "fresh-dom": ADDED_OK,
        })
        before = tree_snapshot(self.root)
        original_move = specengine._move_directory

        def broken_move(src, dest):
            raise SpecEngineError("注入的移动失败")

        specengine._move_directory = broken_move
        try:
            with self.assertRaises(SpecEngineError):
                archive(self.root, "roll-back", date="2026-01-02")
        finally:
            specengine._move_directory = original_move
        self.assertEqual(before, tree_snapshot(self.root),
                         "移动失败后必须回滚：已改主 spec 复原、新建域文件删除、"
                         "change 目录原样")
        # 现场完好，修复后可重跑：这次放行
        result = archive(self.root, "roll-back", date="2026-01-02")
        self.assertEqual(
            ["openspec/specs/fresh-dom/spec.md",
             "openspec/specs/user-auth/spec.md"], result["merged"])

    def test_main_spec_leak_sweep_blocks_before_write(self):
        # 吸收 comet verify_main_specs_clean：无关域残留 delta 头 → 归档前拒绝
        seed_project(self.root, with_main_spec=True)
        write(self.root, "openspec/specs/polluted/spec.md",
              "# polluted Specification\n\n## Purpose\nBad.\n\n"
              "## ADDED Requirements\n\n### Requirement: Leak\nx\n")
        seed_change(self.root, "clean-change", {"data-export": ADDED_OK})
        before = tree_snapshot(self.root)
        with self.assertRaises(SpecEngineError) as ctx:
            archive(self.root, "clean-change", date="2026-01-02")
        self.assertIn("polluted", str(ctx.exception))
        self.assertEqual(before, tree_snapshot(self.root))

    def test_no_delta_change_archives_whole_dir(self):
        seed_project(self.root)
        seed_change(self.root, "docs-only", None,
                    tasks="## 1. D\n\n- [ ] 1.1 pending\n")
        result = archive(self.root, "docs-only", date="2026-01-02")
        self.assertEqual([], result["merged"])
        self.assertTrue(any("任务未完成" in w for w in result["warnings"]))
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "openspec", "changes", "archive", "2026-01-02-docs-only",
            "proposal.md")))

    def test_bad_date_and_missing_change(self):
        seed_project(self.root)
        seed_change(self.root, "dated", {"dom": ADDED_OK})
        with self.assertRaises(SpecEngineError):
            archive(self.root, "dated", date="2026/01/02")
        with self.assertRaises(SpecEngineError):
            archive(self.root, "never-created")


# ---------------------------------------------------------------------------
# v5 四合一布局
# ---------------------------------------------------------------------------

SWEEP_DELTA = (
    "## MODIFIED Requirements\n\n"
    "### Requirement: Session expiry\n"
    "The system SHALL expire sessions after 15 minutes.\n\n"
    "#### Scenario: Timeout\n- **WHEN** idle 15\n- **THEN** out\n\n"
    "## REMOVED Requirements\n\n### Requirement: Logout\n\n"
    "## RENAMED Requirements\n\n"
    "- FROM: `### Requirement: User login`\n"
    "- TO: `### Requirement: Sign in`\n\n"
    "## ADDED Requirements\n\n"
    "### Requirement: Password reset\n"
    "The system SHALL allow password reset.\n\n"
    "#### Scenario: Reset\n- **WHEN** ask\n- **THEN** email\n")


def seed_v5_change(root, name, why="Reason explained long enough.",
                   domains=None, design=None, tasks="- [ ] 1. do the work"):
    """构造 v5 四合一 change 目录（目录里只有一个 change.md）。"""
    parts = ["# 变更：%s" % name, "", "# 为什么", "", why, ""]
    for domain, delta in (domains or {}).items():
        parts += ["# 规格条目：%s" % domain, "", delta, ""]
    if design is not None:
        parts += ["# 方案", "", design, ""]
    if tasks is not None:
        parts += ["# 实现清单", "", tasks, ""]
    write(root, "openspec/changes/%s/change.md" % name, "\n".join(parts))


def specs_snapshot(root):
    """openspec/specs 子树 → {相对 posix 路径: 内容 bytes}（行尾归一）。"""
    snapshot = {}
    base = os.path.join(root, "openspec", "specs")
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            with open(full, "rb") as stream:
                snapshot[rel] = stream.read().replace(b"\r\n", b"\n")
    return snapshot


class V5LayoutTests(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="specengine-v5-")
        self.addCleanup(shutil.rmtree, self._tmp, True)
        self.root = os.path.realpath(self._tmp)

    # ---- new_change 档位与骨架 ----

    def test_new_change_tiers_write_single_file_skeleton(self):
        seed_project(self.root)
        for tier, has_design in (("full", True), ("hotfix", False),
                                 ("tweak", False)):
            name = "v5-%s" % tier
            info = new_change(self.root, name, tier=tier)
            self.assertEqual("v5", info["layout"])
            self.assertEqual(tier, info["tier"])
            change_dir = os.path.join(self.root, "openspec", "changes", name)
            # v5 单文件承诺：目录里只有 change.md，没有 .openspec.yaml
            self.assertEqual(["change.md"], sorted(os.listdir(change_dir)))
            skeleton = read_text(
                self.root, "openspec/changes/%s/change.md" % name)
            self.assertIn("# 为什么", skeleton)
            self.assertIn("# 实现清单", skeleton)
            self.assertIn("（待填", skeleton)
            if has_design:
                self.assertIn("# 方案", skeleton)
                self.assertIn("（待设计", skeleton)
            else:
                self.assertNotIn("# 方案", skeleton)
        with self.assertRaises(SpecEngineError):
            new_change(self.root, "v5-bad", tier="nonsense")

    # ---- validate ----

    def test_v5_validate_verdict_matches_legacy_for_same_delta(self):
        seed_project(self.root)
        seed_change(self.root, "leg", {"dom": ADDED_OK})
        seed_v5_change(self.root, "vee", domains={"dom": ADDED_OK})
        ok_legacy, _ = validate(self.root, "leg")
        ok_v5, messages = validate(self.root, "vee")
        self.assertTrue(ok_legacy)
        self.assertTrue(ok_v5, messages)

    def test_v5_validate_rejects_bad_delta_with_section_label(self):
        seed_project(self.root)
        seed_v5_change(self.root, "vee", domains={"dom": ADDED_OK.replace(
            "The system SHALL allow", "The system allows")})
        ok, messages = validate(self.root, "vee")
        self.assertFalse(ok)
        self.assertTrue(any("change.md 规格条目：dom" in m for m in messages),
                        messages)

    def test_v5_validate_no_delta_points_to_change_md(self):
        seed_project(self.root)
        seed_v5_change(self.root, "vee")
        ok, messages = validate(self.root, "vee")
        self.assertFalse(ok)
        self.assertTrue(any("change.md 里加" in m and "规格条目" in m
                            for m in messages), messages)

    def test_v5_structural_issues(self):
        seed_project(self.root)
        # 重复域
        write(self.root, "openspec/changes/dup/change.md",
              "# 为什么\n\nWhy text.\n\n# 规格条目：dom\n\n%s\n"
              "# 规格条目：dom\n\n%s\n# 实现清单\n\n- [ ] 1. x\n"
              % (ADDED_OK, ADDED_OK.replace("Data export", "Other")))
        ok, messages = validate(self.root, "dup")
        self.assertFalse(ok)
        self.assertTrue(any("规格条目域" in m and "重复" in m for m in messages),
                        messages)
        # 非法域名（含路径分隔符）
        write(self.root, "openspec/changes/bad/change.md",
              "# 为什么\n\nWhy.\n\n# 规格条目：../evil\n\n%s\n"
              "# 实现清单\n\n- [ ] 1. x\n" % ADDED_OK)
        ok, messages = validate(self.root, "bad")
        self.assertFalse(ok)
        self.assertTrue(any("路径分隔符" in m or "'..'" in m for m in messages),
                        messages)
        # 小节内的未知一级头切断小节 → INFO 提示
        write(self.root, "openspec/changes/stray/change.md",
              "# 变更：stray\n\n# 为什么\n\nWhy.\n\n# 背景补充\n\nlost.\n\n"
              "# 规格条目：dom\n\n%s\n# 实现清单\n\n- [ ] 1. x\n" % ADDED_OK)
        ok, messages = validate(self.root, "stray")
        self.assertTrue(ok, messages)
        self.assertTrue(any(m.startswith("[提示]") and "背景补充" in m
                            for m in messages), messages)

    def test_layout_mixing_rejected_everywhere(self):
        seed_project(self.root)
        seed_v5_change(self.root, "mixed", domains={"dom": ADDED_OK})
        write(self.root, "openspec/changes/mixed/tasks.md", "- [ ] 1. old\n")
        ok, messages = validate(self.root, "mixed")
        self.assertFalse(ok)
        self.assertTrue(any("布局混用" in m for m in messages), messages)
        with self.assertRaises(SpecEngineError):
            has_delta(self.root, "mixed")
        with self.assertRaises(SpecEngineError):
            archive(self.root, "mixed", date="2026-01-02")
        # 混用拒绝必须发生在任何写盘之前
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "openspec", "changes", "mixed", "change.md")))

    # ---- 等价性：v5 与 legacy 同一 delta 合并结果逐字节一致 ----

    def test_equivalence_legacy_vs_v5_archive_bytes(self):
        legacy_root = os.path.join(self.root, "legacy")
        v5_root = os.path.join(self.root, "v5")
        for base in (legacy_root, v5_root):
            os.makedirs(base)
            seed_project(base, with_main_spec=True)
        deltas = {"user-auth": SWEEP_DELTA, "data-export": ADDED_OK}
        seed_change(legacy_root, "same-change", deltas,
                    tasks="- [x] 1. done\n")
        seed_v5_change(v5_root, "same-change", domains=deltas,
                       design="Use builtin engine.", tasks="- [x] 1. done")
        result_legacy = archive(legacy_root, "same-change", date="2026-01-02")
        result_v5 = archive(v5_root, "same-change", date="2026-01-02")
        self.assertEqual(result_legacy["totals"], result_v5["totals"])
        self.assertEqual(result_legacy["merged"], result_v5["merged"])
        self.assertEqual(specs_snapshot(legacy_root), specs_snapshot(v5_root))

    # ---- archive ----

    def test_v5_archive_moves_single_file_and_merges(self):
        seed_project(self.root)
        seed_v5_change(self.root, "solo", domains={"data-export": ADDED_OK},
                       design="Plan.", tasks="- [x] 1. done")
        result = archive(self.root, "solo", date="2026-01-02")
        self.assertEqual({"added": 1, "modified": 0, "removed": 0,
                          "renamed": 0}, result["totals"])
        archive_dir = os.path.join(
            self.root, "openspec", "changes", "archive", "2026-01-02-solo")
        # 定稿移动 = 档案里只有一个 change.md
        self.assertEqual(["change.md"], sorted(os.listdir(archive_dir)))
        self.assertFalse(os.path.exists(
            os.path.join(self.root, "openspec", "changes", "solo")))
        merged = read_text(self.root, "openspec/specs/data-export/spec.md")
        self.assertIn("### Requirement: Data export", merged)
        self.assertNotIn("## ADDED Requirements", merged)

    def test_v5_archive_without_delta_moves_only(self):
        seed_project(self.root, with_main_spec=True)
        seed_v5_change(self.root, "tiny", tasks="- [x] 1. done")
        before = specs_snapshot(self.root)
        result = archive(self.root, "tiny", date="2026-01-02")
        self.assertEqual([], result["merged"])
        self.assertEqual({"added": 0, "modified": 0, "removed": 0,
                          "renamed": 0}, result["totals"])
        self.assertEqual(before, specs_snapshot(self.root))
        self.assertTrue(os.path.isfile(os.path.join(
            self.root, "openspec", "changes", "archive", "2026-01-02-tiny",
            "change.md")))

    # ---- 任务计数与状态 ----

    def test_v5_tasks_counting_and_source(self):
        seed_project(self.root)
        seed_v5_change(self.root, "tasked",
                       tasks="- [x] 1. done\n- [ ] 2. pending\n"
                             "  - [ ] indented not counted\n")
        label, text = tasks_source(self.root, "tasked")
        self.assertIn("change.md", label)
        self.assertIn("实现清单", label)
        self.assertIn("- [ ] 2. pending", text)
        info = status(self.root, "tasked")
        self.assertEqual({"total": 2, "completed": 1}, info["tasks"])
        # legacy 对照：同名结构走 tasks.md
        seed_change(self.root, "legacy-tasked", {"dom": ADDED_OK},
                    tasks="- [x] 1. a\n- [ ] 2. b\n")
        label, text = tasks_source(self.root, "legacy-tasked")
        self.assertIn("tasks.md", label)
        self.assertEqual(
            {"total": 2, "completed": 1}, status(self.root, "legacy-tasked")["tasks"])

    def test_v5_legacy_ut_only_tasks_are_not_implementation_progress(self):
        seed_project(self.root)
        seed_v5_change(
            self.root,
            "legacy-ut-task",
            tasks=(
                "- [x] 1. 实现业务分支\n"
                "- [ ] 2. 补充单元测试 PRACHCellObjImplTest.cpp\n"
            ),
        )
        self.assertEqual(
            {"total": 1, "completed": 1},
            status(self.root, "legacy-ut-task")["tasks"],
        )

    def test_v5_status_shape(self):
        seed_project(self.root, with_main_spec=True)
        seed_v5_change(self.root, "shaped", domains={"dom": ADDED_OK},
                       design="Plan.")
        info = status(self.root, "shaped")
        self.assertEqual("v5", info["layout"])
        self.assertEqual(["dom"], info["spec_domains"])
        self.assertTrue(info["sections"]["为什么"])
        self.assertTrue(info["sections"]["方案"])
        self.assertTrue(info["sections"]["实现清单"])
        self.assertTrue(info["is_complete"])
        self.assertIn("user-auth", info["specs"])
        self.assertTrue(has_delta(self.root, "shaped"))
        seed_v5_change(self.root, "no-spec")
        self.assertFalse(has_delta(self.root, "no-spec"))

    # ---- instructions ----

    def test_v5_instructions_change_artifact(self):
        seed_project(self.root)
        new_change(self.root, "guide", tier="full")
        text = instructions(self.root, "change", "guide", tier="full")
        self.assertIn('<artifact id="change" change="guide"', text)
        self.assertIn("<spec_format>", text)
        self.assertIn("#### Scenario:", text)
        self.assertIn("full（完整开发）", text)
        self.assertNotIn("hotfix（已定位修复）", text)
        tweak_text = instructions(self.root, "change", "guide", tier="tweak")
        self.assertIn("tweak（局部修改）", tweak_text)
        # 未知制品的报错要把 change 列进可选清单
        with self.assertRaises(SpecEngineError) as ctx:
            instructions(self.root, "nope", "guide")
        self.assertIn("change", str(ctx.exception))

    # ---- 审计补测:域名占位、布局门、必须节、坏编码、混用清单、零任务 ----

    def test_v5_domain_placeholder_rejected(self):
        seed_project(self.root)
        write(self.root, "openspec/changes/ph/change.md",
              "# 为什么\n\nWhy.\n\n# 规格条目：{域名}\n\n%s\n"
              "# 实现清单\n\n- [ ] 1. x\n" % ADDED_OK)
        ok, messages = validate(self.root, "ph")
        self.assertFalse(ok)
        self.assertTrue(any("占位符" in m for m in messages), messages)

    def test_instructions_layout_gate_both_directions(self):
        seed_project(self.root)
        new_change(self.root, "vee", tier="full")
        # v5 单取旧制品 → 拒并引导 change
        for legacy_artifact in ("proposal", "design", "tasks", "specs"):
            with self.assertRaises(SpecEngineError) as ctx:
                instructions(self.root, legacy_artifact, "vee")
            self.assertIn("spec instructions change", str(ctx.exception))
        # legacy 在途单取 change → 拒并引导旧制品
        seed_change(self.root, "leg", {"dom": ADDED_OK})
        with self.assertRaises(SpecEngineError) as ctx:
            instructions(self.root, "change", "leg")
        self.assertIn("旧布局在途单", str(ctx.exception))
        # tier=None 列全三档(无流程状态时的缺省视图)
        text = instructions(self.root, "change", "vee", tier=None)
        for tier_word in ("full（完整开发）", "hotfix（已定位修复）",
                          "tweak（局部修改）"):
            self.assertIn(tier_word, text)

    def test_check_required_sections_per_tier(self):
        seed_project(self.root)
        # 只有 为什么+实现清单:hotfix/tweak 合规,full 缺 规格条目+方案
        seed_v5_change(self.root, "lite")
        self.assertEqual([], specengine.check_required_sections(
            self.root, "lite", "hotfix"))
        self.assertEqual([], specengine.check_required_sections(
            self.root, "lite", "tweak"))
        missing = specengine.check_required_sections(self.root, "lite", "full")
        self.assertEqual(2, len(missing), missing)
        self.assertTrue(any("规格条目" in m for m in missing))
        self.assertIn("方案", missing)
        # 四节齐全:full 合规;legacy 布局与未知档位不查
        seed_v5_change(self.root, "fullc", domains={"dom": ADDED_OK},
                       design="Plan.")
        self.assertEqual([], specengine.check_required_sections(
            self.root, "fullc", "full"))
        seed_change(self.root, "leg", {"dom": ADDED_OK})
        self.assertEqual([], specengine.check_required_sections(
            self.root, "leg", "full"))
        self.assertEqual([], specengine.check_required_sections(
            self.root, "lite", "review"))

    def test_legacy_bad_encoding_is_readable_everywhere(self):
        """审计实锤:legacy delta/主 spec 坏编码曾裸 UnicodeDecodeError 穿透
        has_delta/validate/archive。统一收口后必须是带 UTF-8 指引的引擎错误。"""
        seed_project(self.root)
        seed_change(self.root, "enc", {"dom": ADDED_OK},
                    tasks="- [x] 1. done\n")
        bad = os.path.join(self.root, "openspec", "changes", "enc",
                           "specs", "dom", "spec.md")
        with open(bad, "wb") as stream:
            stream.write("## ADDED Requirements 坏编码".encode("gbk") + b"\xff\n")
        for api in (lambda: has_delta(self.root, "enc"),
                    lambda: validate(self.root, "enc"),
                    lambda: archive(self.root, "enc", date="2026-01-02")):
            with self.assertRaises(SpecEngineError) as ctx:
                api()
            self.assertIn("UTF-8", str(ctx.exception))
        # v5 单合并进坏编码主 spec 同样优雅报错且不动现场
        write(self.root, "openspec/changes/enc/specs/dom/spec.md", ADDED_OK)
        os.makedirs(os.path.join(self.root, "openspec", "specs", "dom"),
                    exist_ok=True)
        with open(os.path.join(self.root, "openspec", "specs", "dom",
                               "spec.md"), "wb") as stream:
            stream.write("# dom Specification 坏".encode("gbk") + b"\xfe\n")
        with self.assertRaises(SpecEngineError) as ctx:
            archive(self.root, "enc", date="2026-01-02")
        self.assertIn("UTF-8", str(ctx.exception))
        self.assertTrue(os.path.isdir(os.path.join(
            self.root, "openspec", "changes", "enc")))

    def test_tasks_source_rejects_mixed_layout(self):
        seed_project(self.root)
        seed_v5_change(self.root, "mixed")
        write(self.root, "openspec/changes/mixed/tasks.md", "- [ ] 1. old\n")
        with self.assertRaises(SpecEngineError) as ctx:
            tasks_source(self.root, "mixed")
        self.assertIn("布局混用", str(ctx.exception))

    def test_v5_empty_task_list_semantics(self):
        """实现清单节存在但零任务:与 legacy 空 tasks.md 同语义(0/0=全勾),
        固化该边界防止未来无意改动。"""
        seed_project(self.root)
        seed_v5_change(self.root, "zero", tasks="(本单无需实现任务)")
        label, text = tasks_source(self.root, "zero")
        self.assertIsNotNone(text)
        self.assertEqual({"total": 0, "completed": 0},
                         status(self.root, "zero")["tasks"])

    # ---- 围栏内一级头不是小节边界 ----

    def test_code_fence_h1_is_not_section_boundary(self):
        seed_project(self.root)
        write(self.root, "openspec/changes/fenced/change.md",
              "# 为什么\n\nWhy.\n\n# 规格条目：dom\n\n%s\n"
              "# 方案\n\n```bash\n# this comment must not split the section\n"
              "echo done\n```\n方案继续。\n\n"
              "# 实现清单\n\n- [x] 1. done\n" % ADDED_OK)
        info = status(self.root, "fenced")
        self.assertTrue(info["sections"]["方案"])
        self.assertEqual({"total": 1, "completed": 1}, info["tasks"])
        ok, messages = validate(self.root, "fenced")
        self.assertTrue(ok, messages)


if __name__ == "__main__":
    unittest.main(verbosity=2)

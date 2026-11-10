#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression tests for Mae-Flow's self-contained capability runtime.

换轨说明(为什么这些断言和旧版长得不一样):

- v3 摘掉了第二状态机:交付阶段与产物指针从外部 `.comet.yaml` 收归
  `.mae-flow.json` 的 `spec` 段,`mae-flow spec <init|new|instructions|validate|
  set|phase|verify-pass|archive>` 取代了 comet-state/guard/handoff/archive;
- v4 摘掉了 Node:规格引擎换成纯 Python 的 `mae_flow_core.specengine`,
  Node 从"宿主必需"降级为"开发期对拍可选件",`prepare_project` 不再调外部 CLI、
  不再写 `.comet/config.yaml`。

所以原来"用 run_openspec/run_comet 驱动外部引擎跑一遍生命周期"的用例换轨成
"用内置引擎 + spec 子命令驱动真实 CLI 跑一遍生命周期":关键覆盖(中文与空格路径下
完整生命周期真实跑通)一条不少,并且补上了旧版结构上做不到的断言 ——
阶段不可跳跃/回退/直达 archived、产物指针登记时必须真实存在、
`verify_result` 不可直写(旧 comet 时代 `state set verify_result pass` 的伪造通道)。
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPTS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ROOT = os.path.abspath(os.path.join(SCRIPTS, ".."))
MAE_FLOW = os.path.join(SCRIPTS, "mae-flow.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core import (  # noqa: E402
    CAPABILITY_PACKS,
    prepare_project,
    render_pack,
)
from mae_flow_core import capabilities  # noqa: E402


# 宿主必需项:v4 起 Node 已不在其中(见 _optional_runtime_checks)。
REQUIRED_RUNTIMES = ("Python", "Git", "Git Bash")
# v4 删除的诊断项。任何一项复活都意味着外部引擎/Node 重新变成宿主前置,
# 属于架构回退,必须让测试红。
RETIRED_DIAGNOSTIC_ITEMS = (
    "内嵌 OpenSpec", "内嵌 Comet 脚本", "OpenSpec 可执行", "Node.js")
# prepare_project 的返回契约(v4):不再有 openspec/comet/node 三个键。
PREPARED_KEYS = {
    "spec_engine", "project", "python", "git", "bash",
    "created_project_skills",
}
RETIRED_PREPARED_KEYS = ("openspec", "comet", "node")

CHANGE = "embedded-smoke"
DELTA_SPEC = (
    "# Runtime Specification\n\n"
    "## ADDED Requirements\n\n"
    "### Requirement: Embedded runtime\n"
    "The system SHALL execute the bundled runtime.\n\n"
    "#### Scenario: Runtime starts\n"
    "- **WHEN** a project starts Mae-Flow\n"
    "- **THEN** the embedded runtime is available\n")
# v5 四合一 change.md:同一份 delta 内容嵌进「# 规格条目：runtime」节
# (节体=delta spec 原格式,但没有旧文件那行 "# ... Specification" 一级文档标题
# ——v5 里一级标题是小节边界)。
CHANGE_DOC = (
    "# 变更：%s\n\n"
    "# 为什么\n\n"
    "冒烟验证 v5 四合一布局的完整生命周期。\n\n"
    "# 规格条目：runtime\n\n"
    "## ADDED Requirements\n\n"
    "### Requirement: Embedded runtime\n"
    "The system SHALL execute the bundled runtime.\n\n"
    "#### Scenario: Runtime starts\n"
    "- **WHEN** a project starts Mae-Flow\n"
    "- **THEN** the embedded runtime is available\n\n"
    "# 方案\n\n"
    "直接使用内置引擎,不引入外部依赖。\n\n"
    "# 实现清单\n\n"
    "- [ ] 1. Builtin engine works\n") % CHANGE


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)


def read_json(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def which_in(name, path):
    return shutil.which(name, path=path) or shutil.which(name + ".exe", path=path)


class EmbeddedCapabilityTests(unittest.TestCase):
    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _spec(self, root, *arguments, **kwargs):
        """真实跑一条 `mae-flow spec ...`(子进程,含 argparse 与状态存储全链路)。"""
        env = kwargs.pop("env", None)
        self.assertFalse(kwargs, "未知参数: %s" % sorted(kwargs))
        return subprocess.run(
            [sys.executable, MAE_FLOW, "spec", *arguments],
            cwd=root, text=True, capture_output=True, timeout=180, env=env)

    def _spec_ok(self, root, *arguments, **kwargs):
        result = self._spec(root, *arguments, **kwargs)
        self.assertEqual(
            0, result.returncode,
            "spec %s 应成功: %s" % (
                " ".join(arguments), (result.stdout or "") + (result.stderr or "")))
        return result

    def _spec_rejected(self, root, *arguments, **kwargs):
        needle = kwargs.pop("needle", "")
        result = self._spec(root, *arguments, **kwargs)
        self.assertEqual(
            2, result.returncode,
            "spec %s 应被拒绝: %s" % (
                " ".join(arguments), (result.stdout or "") + (result.stderr or "")))
        if needle:
            self.assertIn(
                needle, (result.stderr or "") + (result.stdout or ""))
        return result

    @staticmethod
    def _spec_state(root):
        return read_json(os.path.join(root, ".mae-flow.json")).get("spec", {})

    @staticmethod
    def _env_without_node():
        """PATH 里保证没有 node、但仍留着 git 的一份环境;做不到就返回 None。

        v4 承诺"整条规格生命周期不需要 Node"。子进程看不见父进程的 mock,
        只能靠 PATH 隔离来在 CLI 层真实证明这一点。"""
        separator = os.pathsep
        entries = [
            item for item in os.environ.get("PATH", "").split(separator) if item]
        path = separator.join(
            item for item in entries if not which_in("node", item))
        if which_in("node", path) or not which_in("git", path):
            return None
        env = os.environ.copy()
        env["PATH"] = path
        # Windows 下 _node() 还会读这几个环境变量兜底,隔离必须一并清掉。
        for variable in ("CODEAGENT_NODE_PATH", "NODE_EXE", "NVM_SYMLINK"):
            env.pop(variable, None)
        return env

    # ------------------------------------------------------------------
    # 能力包与内嵌资源
    # ------------------------------------------------------------------
    def test_vendor_tree_hash_ignores_python_bytecode_cache(self):
        with tempfile.TemporaryDirectory() as root:
            source = os.path.join(root, "analyzer.py")
            write(source, "VALUE = 1\n")
            expected = capabilities._tree_sha256(root)

            write(
                os.path.join(
                    root, "__pycache__", "analyzer.cpython-313.pyc"),
                "runtime cache")
            write(os.path.join(root, "legacy.pyc"), "legacy runtime cache")

            self.assertEqual(expected, capabilities._tree_sha256(root))

            write(source, "VALUE = 2\n")
            self.assertNotEqual(expected, capabilities._tree_sha256(root))

    def test_all_phase_packs_are_pinned_and_host_safe(self):
        expected = {
            "open", "hotfix-open", "tweak-open", "design", "build",
            "review-fix", "tweak-build", "ponytail-review", "verify",
            "archive",
        }
        self.assertEqual(expected, set(CAPABILITY_PACKS))
        forbidden = (
            "/comet-open", "/comet-design", "/comet-build",
            "/comet-verify", "/comet-archive", "/comet-hotfix",
            "/comet-tweak", "/opsx:", "COMET_ENV", "$COMET_",
            "使用 Skill 工具加载", "comet/reference/", "/<SKILL>",
            "superpowers:", "安装或启用 Superpowers",
        )
        for name in sorted(CAPABILITY_PACKS):
            with self.subTest(pack=name):
                text = render_pack(name)
                self.assertGreater(len(text), 1000)
                for needle in forbidden:
                    self.assertNotIn(needle, text)
                self.assertNotRegex(text, r"(?m)^\s*openspec\s+")
                self.assertIn("mae-flow.py", text)

        self.assertIn("PRD 拆分预检", render_pack("open"))
        self.assertIn("根因分析", render_pack("hotfix-open"))
        self.assertIn("升级条件", render_pack("tweak-open"))
        self.assertIn("OpenSpec → Superpowers 交接包", render_pack("design"))
        self.assertIn("Spec 增量更新", render_pack("build"))
        self.assertIn("根因消除检查", render_pack("build"))
        self.assertIn("验证失败决策", render_pack("verify"))
        self.assertIn("生命周期闭环", render_pack("archive"))
        checks = capabilities.diagnostics(ROOT)
        integrity = [
            item for item in checks
            if item["name"].startswith("源码完整性 ")]
        self.assertEqual(
            {"源码完整性 comet", "源码完整性 lizard", "源码完整性 openspec",
             "源码完整性 ponytail", "源码完整性 superpowers"},
            {item["name"] for item in integrity})
        self.assertTrue(all(item["ok"] for item in integrity), integrity)

    # ------------------------------------------------------------------
    # 生命周期:内置引擎 + spec 子命令,中文与空格路径
    # ------------------------------------------------------------------
    def test_full_spec_lifecycle_in_unicode_path(self):
        """中文+空格路径下,用内置引擎跑完 open→design→build→verify→archive。

        换轨:旧版这里跑的是 run_openspec/run_comet(外部 Node + bash 状态机),
        阶段真相源是 `.comet.yaml`;v3/v4 之后阶段与产物指针都在 `.mae-flow.json`
        的 spec 段,引擎是纯 Python。断言强度不降反升 —— 每个"不许"都真跑一遍。

        v5 换轨:新单产物从四件套(proposal/design/tasks/delta spec + .openspec.yaml)
        换成单个四合一 change.md,本用例跟着走 v5 布局——并且把"v5 单在档案里
        只有一个文件"作为硬断言;旧四件套的在途兼容由
        test_legacy_layout_change_still_flows 独立守护,覆盖一条不少。

        旧版对 configure_comet_build 六项构建约定(isolation/build_mode/
        subagent_dispatch/tdd_mode/direct_override/review_mode)的对账断言随
        `.comet.yaml` 一起消失:那六个字段是第二状态机的私有配置,v3 之后不存在
        对应概念。等价强度的替代是下面的阶段机与 verify-pass 三条硬校验 ——
        它们守的是同一件事:机器结论只能由真实动作产生,不能被直写伪造。"""
        with tempfile.TemporaryDirectory(prefix="mae flow 中文 ") as base:
            root = os.path.join(base, "仓库 根 目录")
            os.makedirs(root)
            subprocess.run(
                ["git", "init", "-q", root],
                check=True, capture_output=True, text=True)
            prepared = prepare_project(root)
            self.assertEqual("builtin", prepared["spec_engine"])
            # 子进程用不到 node 才算真的"去 Node";隔离不成立时退回继承环境,
            # 精确的 node 缺失守护在 test_prepare_and_diagnostics_survive... 里。
            env = self._env_without_node()
            write(os.path.join(root, ".mae-flow.json"), json.dumps({
                "current": "design",
                "config": {"CHANGE_NAME": CHANGE, "单号": "REQ中文 1"},
                "choices": {"workflow": "full"},
                "history": [],
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            }, ensure_ascii=False))
            change = os.path.join(
                root, ".mae-flow-work", "spec", "changes", CHANGE)

            # --- 变更目录由内置引擎创建(v5:只有 change.md 骨架),重复创建被拒 ---
            created = self._spec_ok(root, "new", CHANGE, env=env)
            created_info = json.loads(created.stdout)
            self.assertEqual("spec-driven", created_info["schema"])
            self.assertEqual("v5", created_info["layout"])
            self.assertEqual("full", created_info["tier"])
            self.assertTrue(os.path.isfile(os.path.join(change, "change.md")))
            # v5 单文件承诺:不再产 .openspec.yaml(它会让"每单一个文件"变两个)
            self.assertFalse(os.path.exists(
                os.path.join(change, ".openspec.yaml")))
            with open(os.path.join(change, "change.md"), encoding="utf-8") as stream:
                skeleton = stream.read()
            self.assertIn("# 为什么", skeleton)
            self.assertIn("# 方案", skeleton)      # full 档才有方案节
            self.assertIn("# 实现清单", skeleton)
            self.assertIn("（待设计", skeleton)
            self._spec_rejected(root, "new", CHANGE, env=env, needle="已存在")

            # --- 登记初始化:阶段真相源落在 .mae-flow.json ---
            self._spec_ok(root, "init", env=env)
            self.assertEqual("open", self._spec_state(root)["phase"])
            self.assertEqual(CHANGE, self._spec_state(root)["change"])
            # 定稿只能在定稿阶段(取代 comet archive 的阶段前置校验)
            self._spec_rejected(root, "archive", env=env, needle="定稿只能在")

            # --- 产物格式指令来自 vendored schema,而不是外部 CLI ---
            instructions = self._spec_ok(
                root, "instructions", "change", env=env).stdout
            self.assertIn('<artifact id="change" change="%s"' % CHANGE,
                          instructions)
            self.assertIn("<spec_format>", instructions)   # 规格条目格式合同
            self.assertIn("# 规格条目：<域名>", instructions)
            self.assertIn("change.md", instructions)
            # 布局门:v5 单上取旧制品被拒并引导 change(引擎不亲口指示制造
            # 它自己随后会拒绝的布局混用现场)
            self._spec_rejected(root, "instructions", "proposal", env=env,
                                needle="spec instructions change")
            self._spec_rejected(root, "instructions", "不存在的制品", env=env)

            # --- 阶段机:不可跳跃、不可回退(archived 不可直达在 archive 阶段验证) ---
            self._spec_rejected(root, "phase", "verify", env=env, needle="跳跃")
            self._spec_rejected(root, "phase", "archived", env=env, needle="跳跃")
            self._spec_ok(root, "phase", "design", env=env)
            self.assertEqual("design", self._spec_state(root)["phase"])
            self._spec_rejected(root, "phase", "open", env=env, needle="回退")

            # --- 指针登记:文件必须真实存在;非指针字段不许直写 ---
            self._spec_rejected(
                root, "set", "design_doc", "docs/不存在的设计.md",
                env=env, needle="不存在")
            self.assertNotIn("design_doc", self._spec_state(root))
            self._spec_rejected(
                root, "set", "verify_result", "pass", env=env,
                needle="只能登记这些产物指针")
            self.assertNotIn("verify_result", self._spec_state(root))
            write(os.path.join(root, "docs", "设计 doc.md"),
                  "# Embedded Design\n\n内置引擎驱动。\n")
            self._spec_ok(root, "set", "design_doc", "docs/设计 doc.md", env=env)
            self.assertEqual(
                "docs/设计 doc.md", self._spec_state(root)["design_doc"])

            # --- 规格结构校验真的会拦(内置引擎,无 Node;v5 校验 change.md) ---
            broken = CHANGE_DOC.replace(
                "The system SHALL execute the bundled runtime.",
                "The system executes the bundled runtime.")
            write(os.path.join(change, "change.md"), broken)
            self._spec_rejected(root, "validate", env=env, needle="未通过")
            write(os.path.join(change, "change.md"), CHANGE_DOC)
            self._spec_ok(root, "validate", env=env)

            # --- 推进到验证阶段 ---
            self._spec_ok(root, "phase", "build", env=env)
            self._spec_ok(root, "phase", "verify", env=env)

            # --- verify-pass 三条硬校验:阶段、报告存在、任务全勾 ---
            self._spec_rejected(root, "verify-pass", env=env, needle="验证报告")
            write(os.path.join(root, "docs", "验证 report.md"),
                  "# Verification\n\nAll checks passed.\n")
            self._spec_ok(
                root, "set", "verification_report", "docs/验证 report.md",
                env=env)
            # 任务清单在 v5 是 change.md 的「# 实现清单」节
            self._spec_rejected(root, "verify-pass", env=env, needle="未完成")
            write(os.path.join(change, "change.md"),
                  CHANGE_DOC.replace("- [ ] 1. Builtin engine works",
                                     "- [x] 1. Builtin engine works"))
            self._spec_ok(root, "verify-pass", env=env)
            data = self._spec_state(root)
            self.assertEqual("pass", data["verify_result"])
            self.assertEqual("handled", data["branch_status"])
            self.assertEqual("archive", data["phase"])
            # archived 只能由真实定稿产生,不接受直接推进(此时它是合法的 +1 步,
            # 所以拦它的是专门的守卫而不是跳跃检查)
            self._spec_rejected(root, "phase", "archived", env=env,
                                needle="不接受直接推进")
            self.assertEqual("archive", self._spec_state(root)["phase"])

            # --- 定稿:delta 合并进真相源 + 目录移动(不是复制) ---
            archived = self._spec_ok(root, "archive", env=env)
            self.assertIn(
                ".mae-flow-work/spec/specs/runtime/spec.md", archived.stdout)
            archived_state = self._spec_state(root)
            self.assertEqual("archived", archived_state["phase"])
            self.assertEqual([
                ".mae-flow-work/spec/changes/" + CHANGE,
                ".mae-flow-work/spec/changes/archive/"
                + archived_state["archived_to"],
                ".mae-flow-work/spec/specs/runtime/spec.md",
            ], archived_state["archive_paths"])
            self.assertFalse(os.path.exists(change))
            archived_dirs = glob.glob(os.path.join(
                root, ".mae-flow-work", "spec", "changes", "archive",
                "*-" + CHANGE))
            self.assertEqual(1, len(archived_dirs))
            self.assertEqual(
                os.path.basename(archived_dirs[0]),
                self._spec_state(root)["archived_to"])
            # v5 目标本身:每单入库档案 = 一个 change.md,再无其他文件
            self.assertEqual(["change.md"], sorted(os.listdir(archived_dirs[0])))
            main_spec = os.path.join(
                root, ".mae-flow-work", "spec", "specs", "runtime", "spec.md")
            self.assertTrue(os.path.isfile(main_spec))
            with open(main_spec, encoding="utf-8") as stream:
                merged = stream.read()
            self.assertIn("### Requirement: Embedded runtime", merged)
            # delta 分节字样不得泄漏进真相源
            self.assertNotIn("## ADDED Requirements", merged)
            # 重复定稿被拒(阶段已 archived)
            self._spec_rejected(root, "archive", env=env, needle="定稿只能在")

            # --- 第二状态机确实不存在了(旧版在这里读 .comet.yaml 的 archived: true;
            #     等价强度的替代断言 = 阶段落在 .mae-flow.json 且全仓无 comet 状态文件) ---
            comet_leftovers = []
            for dirpath, dirnames, filenames in os.walk(root):
                if ".git" in dirnames:
                    dirnames.remove(".git")
                comet_leftovers.extend(
                    os.path.join(dirpath, name) for name in
                    list(filenames) + list(dirnames)
                    if name in (".comet.yaml", ".comet"))
            self.assertEqual([], comet_leftovers)

    def test_legacy_layout_change_still_flows(self):
        """v5 兼容承诺:在途旧布局单(四件套)在新代码下照原样走完。

        手工构造旧布局(spec new 已只产 v5,在途单不会再 new),然后走
        validate → verify-pass → archive 全链:tasks.md 计数生效、delta 从
        specs/<域>/spec.md 合并、四件套全部随目录进档案。"""
        with tempfile.TemporaryDirectory(prefix="mae legacy ") as base:
            root = os.path.join(base, "legacy 仓库")
            os.makedirs(os.path.join(root, "openspec"))
            subprocess.run(
                ["git", "init", "-q", root],
                check=True, capture_output=True, text=True)
            prepare_project(root)
            env = self._env_without_node()
            write(os.path.join(root, ".mae-flow.json"), json.dumps({
                "current": "build",
                "config": {"CHANGE_NAME": CHANGE, "单号": "REQ legacy"},
                "choices": {"workflow": "full"},
                "history": [],
                "started": time.strftime("%Y-%m-%d %H:%M:%S"),
            }, ensure_ascii=False))
            change = os.path.join(root, "openspec", "changes", CHANGE)
            write(os.path.join(change, ".openspec.yaml"),
                  "schema: spec-driven\ncreated: 2026-07-25\n")
            write(os.path.join(change, "proposal.md"),
                  "# Proposal\n\n## Why\n\nLegacy smoke.\n")
            write(os.path.join(change, "design.md"),
                  "# Design\n\nKeep the pinned engine.\n")
            write(os.path.join(change, "tasks.md"),
                  "# Tasks\n\n- [ ] 1. Legacy flow works\n")
            write(os.path.join(change, "specs", "runtime", "spec.md"),
                  DELTA_SPEC)
            self._spec_ok(root, "init", env=env)
            self._spec_ok(root, "validate", env=env)
            for phase in ("design", "build", "verify"):
                self._spec_ok(root, "phase", phase, env=env)
            write(os.path.join(root, "docs", "report.md"),
                  "# Verification\n\nAll checks passed.\n")
            self._spec_ok(
                root, "set", "verification_report", "docs/report.md", env=env)
            # 任务计数仍来自 tasks.md(旧语义分毫不变)
            self._spec_rejected(root, "verify-pass", env=env, needle="未完成")
            write(os.path.join(change, "tasks.md"),
                  "# Tasks\n\n- [x] 1. Legacy flow works\n")
            self._spec_ok(root, "verify-pass", env=env)
            self._spec_ok(root, "archive", env=env)
            self.assertFalse(os.path.exists(change))
            archived_dirs = glob.glob(os.path.join(
                root, "openspec", "changes", "archive", "*-" + CHANGE))
            self.assertEqual(1, len(archived_dirs))
            for name in ("proposal.md", "design.md", "tasks.md",
                         ".openspec.yaml"):
                self.assertTrue(os.path.isfile(
                    os.path.join(archived_dirs[0], name)), name)
            with open(os.path.join(
                    root, "openspec", "specs", "runtime", "spec.md"),
                    encoding="utf-8") as stream:
                merged = stream.read()
            self.assertIn("### Requirement: Embedded runtime", merged)
            self.assertNotIn("## ADDED Requirements", merged)

    # ------------------------------------------------------------------
    # prepare_project 契约
    # ------------------------------------------------------------------
    def test_prepare_project_contract_and_untouched_project(self):
        with tempfile.TemporaryDirectory(prefix="mae flow 中文 ") as base:
            root = os.path.join(base, "准备 项目")
            os.makedirs(root)
            subprocess.run(
                ["git", "init", "-q", root],
                check=True, capture_output=True, text=True)
            prepared = prepare_project(root)
            self.assertEqual(PREPARED_KEYS, set(prepared))
            for retired in RETIRED_PREPARED_KEYS:
                self.assertNotIn(retired, prepared)
            self.assertEqual("builtin", prepared["spec_engine"])
            self.assertEqual(os.path.abspath(root), prepared["project"])
            self.assertIn("Python ", prepared["python"])
            self.assertIn("git version", prepared["git"].lower())
            self.assertIn(" — ", prepared["bash"])
            self.assertFalse(prepared["created_project_skills"])

            # 目录归一:全新仓的规格工作区落 .mae-flow-work/spec,
            # 项目根不再长出退役引擎名字的 openspec/
            workspace = os.path.join(root, ".mae-flow-work", "spec")
            config = os.path.join(workspace, "config.yaml")
            self.assertTrue(os.path.isfile(config))
            self.assertFalse(os.path.exists(os.path.join(root, "openspec")))
            with open(config, encoding="utf-8") as stream:
                config_text = stream.read()
            self.assertIn("schema: spec-driven", config_text)
            self.assertTrue(os.path.isdir(os.path.join(workspace, "specs")))
            self.assertTrue(os.path.isdir(
                os.path.join(workspace, "changes", "archive")))
            # v4:交付阶段收归 .mae-flow.json,comet 的项目级配置不再产生
            self.assertFalse(os.path.exists(os.path.join(root, ".comet")))
            self.assertFalse(os.path.exists(
                os.path.join(root, ".comet", "config.yaml")))
            self.assertFalse(os.path.exists(os.path.join(root, ".cac")))
            self.assertFalse(os.path.exists(os.path.join(root, ".claude")))
            # prepare 早于流程激活:状态文件必须还不存在(Hook 保持 fail-open)
            self.assertFalse(os.path.exists(
                os.path.join(root, ".mae-flow.json")))

            # 幂等:重跑不动已有配置
            write(config, config_text + "\n# 用户注释保持不变\n")
            again = prepare_project(root)
            self.assertEqual(PREPARED_KEYS, set(again))
            with open(config, encoding="utf-8") as stream:
                self.assertIn("# 用户注释保持不变", stream.read())

    def test_prepare_and_diagnostics_survive_missing_node(self):
        """v4 的核心承诺:宿主没有 Node 也能准备项目、诊断也不报红。

        用 PATH 级隔离模拟 node 缺失(比直接 mock `_node` 更接近生产:
        任何"换个地方找 node"的隐式回退都会被这条测试抓到)。"""
        real_which = capabilities.shutil.which

        def which_without_node(name, *args, **kwargs):
            if os.path.basename(str(name)).lower() in ("node", "node.exe"):
                return None
            return real_which(name, *args, **kwargs)

        # ProgramFiles/LOCALAPPDATA 也是 _node() 的 Windows 兜底候选——
        # CI 的 windows runner 真有 ProgramFiles\nodejs,不清空隔离就漏
        windows_hints = {
            key: "" for key in
            ("CODEAGENT_NODE_PATH", "NODE_EXE", "NVM_SYMLINK",
             "ProgramFiles", "LOCALAPPDATA")}
        with tempfile.TemporaryDirectory(prefix="mae flow 无 node ") as root:
            subprocess.run(
                ["git", "init", "-q", root],
                check=True, capture_output=True, text=True)
            with mock.patch.object(
                    capabilities.shutil, "which",
                    side_effect=which_without_node), \
                    mock.patch.dict(capabilities.os.environ, windows_hints):
                # 隔离本身有效(否则下面的断言会因为仍能找到 node 而变成空跑)
                with self.assertRaises(capabilities.CapabilityError):
                    capabilities._node()
                required = capabilities._host_runtime_checks()
                optional = capabilities._optional_runtime_checks()
                prepared = prepare_project(root)
                checks = capabilities.diagnostics(ROOT)

            self.assertEqual({"python", "git", "bash"},
                             {item["key"] for item in required})
            self.assertTrue(all(item["ok"] for item in required), required)
            self.assertEqual(["node"], [item["key"] for item in optional])
            self.assertTrue(optional[0]["ok"], optional)
            self.assertIn("未安装", optional[0]["detail"])
            self.assertEqual(PREPARED_KEYS, set(prepared))
            self.assertEqual("builtin", prepared["spec_engine"])
            self.assertTrue(os.path.isfile(os.path.join(
                root, ".mae-flow-work", "spec", "config.yaml")))
            self.assertFalse(os.path.exists(os.path.join(root, ".comet")))
            self.assertEqual(
                [], [item for item in checks if not item["ok"]],
                "Node 缺失不得让任何诊断项变红")
            self.assertTrue(any(
                item["name"] == "内置规格引擎" and item["ok"] for item in checks))

    # ------------------------------------------------------------------
    # 诊断契约
    # ------------------------------------------------------------------
    def test_host_runtime_diagnostics_show_versions_and_paths(self):
        checks = capabilities.diagnostics(ROOT)
        by_name = {item["name"]: item for item in checks}
        for name in REQUIRED_RUNTIMES:
            with self.subTest(runtime=name):
                self.assertIn(name, by_name)
                self.assertTrue(by_name[name]["ok"], by_name[name])
                self.assertIn(" — ", by_name[name]["detail"])
        # 必需项就是这三条:Node 不在其中(v4 去 Node 的核心契约)
        self.assertEqual(
            set(REQUIRED_RUNTIMES),
            {item["name"] for item in capabilities._host_runtime_checks()})

        # Node 只作为可选参考件出现:在场则报版本,缺失也 ok(生产上允许没有)
        node_items = [item for item in checks
                      if item["name"].startswith("Node.js")]
        self.assertEqual(1, len(node_items), node_items)
        self.assertIn("可选", node_items[0]["name"])
        self.assertTrue(node_items[0]["ok"], node_items[0])

        # 内置规格引擎必须被真实加载过一次
        self.assertIn("内置规格引擎", by_name)
        self.assertTrue(by_name["内置规格引擎"]["ok"], by_name["内置规格引擎"])

        # 防回退:这些项属于外部引擎时代,复活即架构回退
        for retired in RETIRED_DIAGNOSTIC_ITEMS:
            self.assertNotIn(retired, by_name)

        # 内嵌规则包与 vendored 目录完整性仍逐项体检
        self.assertEqual(
            {"内嵌规则 " + pack for pack in CAPABILITY_PACKS},
            {item["name"] for item in checks
             if item["name"].startswith("内嵌规则 ")})
        self.assertEqual(
            [], [item for item in checks if not item["ok"]],
            "健康宿主上 capability status 必须全绿")

    # ------------------------------------------------------------------
    # 宿主适配(与 v3/v4 无关,保持原样)
    # ------------------------------------------------------------------
    def test_windows_plugin_path_is_literal_in_embedded_commands(self):
        windows_script = (
            r"C:\Users\l00000000\.cac\plugins\cache\aimarket"
            r"\mae-flow\current\scripts\mae-flow.py")
        source = "\n".join((
            "openspec status",
            '"$COMET_BASH" "$COMET_STATE" init demo full',
            '"$COMET_BASH" "$COMET_GUARD" demo open --apply',
            '"$COMET_BASH" "$COMET_HANDOFF" demo design --write',
            '"$COMET_BASH" "$COMET_ARCHIVE" demo',
        ))
        adapted = capabilities._adapt_embedded_method(source, windows_script)
        self.assertEqual(5, adapted.count(windows_script))
        for command in (
                "openspec", "comet-state", "comet-guard",
                "comet-handoff", "comet-archive"):
            self.assertIn("capability %s" % command, adapted)

    def test_prepare_accepts_git_worktree_dot_git_file(self):
        with tempfile.TemporaryDirectory(prefix="mae worktree ") as base:
            repository = os.path.join(base, "main")
            worktree = os.path.join(base, "分支 worktree")
            subprocess.run(
                ["git", "init", "-q", repository],
                check=True, capture_output=True, text=True)
            write(os.path.join(repository, "README.md"), "runtime test\n")
            subprocess.run(
                ["git", "-C", repository, "add", "README.md"],
                check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "-C", repository, "-c", "user.name=Mae Flow",
                 "-c", "user.email=mae-flow@example.invalid",
                 "commit", "-q", "-m", "init"],
                check=True, capture_output=True, text=True)
            subprocess.run(
                ["git", "-C", repository, "worktree", "add", "-q",
                 "-b", "runtime-test", worktree],
                check=True, capture_output=True, text=True)
            self.assertTrue(os.path.isfile(os.path.join(worktree, ".git")))
            prepared = prepare_project(worktree)
            self.assertEqual(os.path.abspath(worktree), prepared["project"])

    def test_missing_host_dependency_fails_before_project_files_are_written(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(
                ["git", "init", "-q", root],
                check=True, capture_output=True, text=True)
            with mock.patch.object(
                    capabilities, "_git",
                    side_effect=capabilities.CapabilityError("找不到 Git")):
                with self.assertRaisesRegex(
                        capabilities.CapabilityError, "基础依赖不可用.*Git"):
                    prepare_project(root)
            self.assertFalse(os.path.exists(os.path.join(root, "openspec")))
            self.assertFalse(os.path.exists(os.path.join(root, ".comet")))
            self.assertFalse(os.path.exists(
                os.path.join(root, ".mae-flow.json")))

    def test_codecheck_install_is_one_shot_and_does_not_mutate_npm_config(self):
        with tempfile.TemporaryDirectory() as root:
            state_path = os.path.join(root, "capabilities.json")
            completed = mock.Mock(stdout="installed", stderr="", returncode=0)
            with mock.patch.object(
                    capabilities, "_capability_state_path",
                    return_value=state_path), mock.patch.object(
                        capabilities, "locate_codecheck",
                        side_effect=[
                            ("", ""),
                            ("C:\\npm\\codecheck.cmd", "fullcheck"),
                        ]), mock.patch.object(
                            capabilities.shutil, "which",
                            side_effect=lambda name: (
                                "C:\\npm\\npm.cmd"
                                if name in ("npm", "npm.cmd") else None)), \
                    mock.patch.object(
                        capabilities.subprocess, "run",
                        return_value=completed) as runner:
                result = capabilities.ensure_codecheck(install=True)
            self.assertTrue(result["available"])
            command = runner.call_args.args[0]
            # Windows 真机走 shell=True 字符串命令行(cmd 语义),其余平台列表
            # ——断言按形态分支,两种都必须是同一条一次性安装命令
            if isinstance(command, str):
                self.assertIn("npm", command)
                self.assertIn("install", command)
                self.assertIn("-g", command)
                self.assertIn("codecheckcli", command)
                self.assertIn("--registry=", command)
                self.assertNotIn(" config ", command)
            else:
                self.assertEqual(
                    ["C:\\npm\\npm.cmd", "install", "-g",
                     "codecheckcli"],
                    command[:4])
                self.assertTrue(
                    any(item.startswith("--registry=") for item in command))
                self.assertNotIn("config", command)

            write(
                state_path,
                json.dumps({
                    "available": False,
                    "attempted_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "detail": "registry unavailable",
                }, ensure_ascii=False))
            with mock.patch.object(
                    capabilities, "_capability_state_path",
                    return_value=state_path), mock.patch.object(
                        capabilities, "locate_codecheck",
                        return_value=("", "")), mock.patch.object(
                            capabilities.subprocess, "run") as runner:
                cooled = capabilities.ensure_codecheck(install=True)
            self.assertTrue(cooled["cooldown"])
            runner.assert_not_called()

    def test_windows_cmd_launch_uses_pathex_compatible_shell(self):
        completed = mock.Mock(stdout="ok", stderr="", returncode=0)
        with mock.patch.object(
                capabilities.subprocess, "run",
                return_value=completed) as runner:
            result = capabilities._run_host_cli(
                [r"C:\Users\dev\AppData\Roaming\npm\npm.cmd",
                 "prefix", "-g"],
                windows=True)
        self.assertIs(result, completed)
        command = runner.call_args.args[0]
        self.assertIsInstance(command, str)
        self.assertIn("npm.cmd", command)
        self.assertTrue(runner.call_args.kwargs["shell"])

    def test_windows_runtime_discovers_git_bash_and_node_off_path(self):
        env = {
            "ProgramFiles": r"C:\Program Files",
            "NVM_SYMLINK": r"C:\tools\node",
        }
        expected_bash = os.path.join(
            env["ProgramFiles"], "Git", "bin", "bash.exe")
        expected_git = os.path.join(
            env["ProgramFiles"], "Git", "cmd", "git.exe")
        expected_node = os.path.join(env["NVM_SYMLINK"], "node.exe")
        existing = {
            os.path.normpath(expected_bash),
            os.path.normpath(expected_git),
            os.path.normpath(expected_node),
        }
        with mock.patch.object(
                capabilities.shutil, "which", return_value=None), \
                mock.patch.dict(capabilities.os.environ, env, clear=True), \
                mock.patch.object(
                    capabilities.os.path, "isfile",
                    side_effect=lambda value: os.path.normpath(value) in existing):
            self.assertEqual(
                os.path.normpath(expected_bash),
                os.path.normpath(capabilities._bash(windows=True)))
            self.assertEqual(
                os.path.normpath(expected_node),
                os.path.normpath(capabilities._node(windows=True)))
            self.assertEqual(
                os.path.normpath(expected_git),
                os.path.normpath(capabilities._git(windows=True)))


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""依赖目录不能被当成交付内容灌进任务卡与面板。

内网实战:grill-critic 的任务卡里出现"### 未跟踪文件:
node_modules/@fission-ai/openspec/dist/cli/index.js"无穷重复,Agent 当场卡死。

根因是 `git ls-files --others --exclude-standard` 只认 .gitignore——仓里没忽略
node_modules 是很常见的事,于是几千个依赖文件被逐个整段(每个上限 10 万字符)
塞进卡片。总量 20 万字符的上限是**事后截断**,拼完才切,卡片早爆了。

同一个洞有**三个**出口,而我先只堵了两个:任务卡(role_task)、面板的未跟踪增量
(snapshot),漏了独立任务的范围自动推导(standalone_core._action_files——用户没点名
文件时取整棵工作树的脏源码)。用户报的文件名恰恰是 grill-prep-task.md,那正是独立
任务这条路的卡片命名,我却按完整交付那条路去找,得出"不是我们生成的"这个错判。

教训写在这儿:同一个概念(什么是"我们的源码")散在三处各自过滤,就一定会漏第三处。
现在口径统一在 foundation/source_paths(is_tool_managed_path / is_derived_path),
本文件对三个出口分别验证,任何一处绕开共用口径都会在这里失败。
"""

import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

FLOOD = (
    "node_modules/@fission-ai/openspec/dist/cli/index.js",
    "web/node_modules/react/index.js",
    "target/classes/A.class",
    "build/libs/app.jar",
    ".venv/lib/python3.13/site-packages/x.py",
    "__pycache__/m.cpython-313.pyc",
    ".gradle/caches/x.bin",
)
# 按扩展名认的产物。与上面按目录认的分开,是因为两个消费点问的不是同一件事:
# "是不是源码"(门禁/范围推导)必须排除它们——flow 默认源码模式含 `(^|/)lib/`,
# pyenv 的 python3.13/lib/*.pyc 正好命中,跑全量测试时一个沙箱凭空多出 68 个
# "改动源码";而"是不是待检视增量"(面板)不能排除——本单新加的 logo.bin
# 不是源码,却确实要让人看见(列出、不出 diff)。
ARTIFACTS = (
    "opt/python3.13/lib/__future__.cpython-313.pyc",
    "service/lib/App.class",
    "src/libapp.so",
    "app/release/app.jar",
)
DELIVERY = (
    "service/src/main/java/A.java",
    "docs/se/REQ2026081101.md",
    "src/vendors.py",          # 名字里带 vendor 但不是目录,不能误伤
    "tests/test_a.py",
)


class PanelFloodTests(unittest.TestCase):
    def test_panel_skips_dependency_dirs(self):
        from mae_flow_core.panel.snapshot import _dependency_path
        for path in FLOOD:
            self.assertTrue(_dependency_path(path), "该排除: %s" % path)
        for path in DELIVERY:
            self.assertFalse(_dependency_path(path), "不该排除: %s" % path)

    def test_panel_still_shows_new_binary_assets(self):
        """面板问的是"这次要检视什么",不是"这是不是源码"。本单新加的
        logo.bin 不是源码,却确实要让人看见——按扩展名排会把它吞掉,
        那是"显示与现场不符"(用户红线)。"""
        from mae_flow_core.panel.snapshot import _dependency_path
        for path in ("assets/logo.bin", "res/icon.png", "libs/vendor.jar"):
            self.assertFalse(_dependency_path(path), "不该排除: %s" % path)

    def test_panel_caps_and_says_so(self):
        """截断必须说出来,否则面板看起来完整、实则少了一半。"""
        import io as _io
        from mae_flow_core.panel import snapshot
        self.assertLessEqual(snapshot._UNTRACKED_FILE_CAP, 200)
        with _io.open(os.path.join(SCRIPTS, "mae_flow_core", "panel",
                                   "snapshot.py"), encoding="utf-8") as s:
            source = s.read()
        self.assertIn("未展示", source)
        self.assertIn(".gitignore", source, "要告诉人怎么根治")


class SharedVerdictTests(unittest.TestCase):
    """口径只有一份:三个出口都必须由 foundation/source_paths 说了算。"""

    def test_tool_managed_dirs_are_never_source(self):
        from mae_flow_core.foundation.source_paths import (
            known_source_classification)
        # node_modules 里全是 .js,光看后缀就成了"业务源码"——排除必须抢在
        # 扩展名判定之前,这条断言就是钉住那个顺序的。
        self.assertIs(False, known_source_classification(
            "node_modules/@fission-ai/openspec/dist/cli/index.js"))
        self.assertIs(False, known_source_classification(
            ".venv/lib/python3.13/site-packages/x.py"))

    def test_artifacts_are_never_source_whatever_the_repo_configures(self):
        """产物按扩展名硬判:目录模式会把它们捞进来(flow 默认含 `(^|/)lib/`,
        pyenv 的 lib/*.pyc 正好命中),仓库配置不该有翻案余地。"""
        from mae_flow_core.foundation.source_paths import (
            is_source_path, known_source_classification)
        for path in ARTIFACTS:
            self.assertIs(False, known_source_classification(path), path)
            # 连仓库显式配了模式也翻不了案
            self.assertFalse(is_source_path(path, [r".*"]), path)

    def test_lock_files_are_not_mistaken_for_artifacts(self):
        """.lock 不在产物表里:cargo.lock/yarn.lock 是构建描述文件,
        它们的变更恰恰是要检视的。"""
        from mae_flow_core.foundation.source_paths import is_source_path
        for path in ("Cargo.lock", "yarn.lock", "poetry.lock"):
            self.assertTrue(is_source_path(path, []), path)

    def test_build_output_defers_to_repo_config(self):
        """构建产物不硬判:默认不是源码,但仓库显式配了就仍然算——
        确有仓库把源码放在 build/ 下,硬判会把真源码误杀成不用检视。"""
        from mae_flow_core.foundation.source_paths import (
            is_source_path, known_source_classification)
        self.assertIsNone(known_source_classification("build/libs/App.java"))
        self.assertFalse(is_source_path("build/libs/App.java", []))
        self.assertTrue(is_source_path("build/libs/App.java", [r"^build/"]))

    def test_vendor_dir_defers_to_repo_config(self):
        """vendor/ 不能硬判。我起初把它归进"谁都不会放自己代码"那一档,
        selftest 当场打脸:确有仓库把 `vendor/private/` 配成自己的源码路径
        (Go 的 vendor/ 又确实是机器管的)。有歧义就交给仓库自己说了算——
        默认不是源码(挡住洪水),配了就仍然是(不误杀真源码)。"""
        from mae_flow_core.foundation.source_paths import is_source_path
        self.assertFalse(is_source_path("vendor/private/schema", []))
        self.assertTrue(is_source_path(
            "vendor/private/schema", [r"(^|/)vendor/private/"]))

    def test_real_source_unaffected(self):
        from mae_flow_core.foundation.source_paths import is_source_path
        for path in DELIVERY:
            if path.endswith(".md"):
                continue
            self.assertTrue(is_source_path(path, []), "不该排除: %s" % path)


class StandaloneScopeFloodTests(unittest.TestCase):
    """第三个出口:独立任务的范围推导。用户实际撞的就是这条路。"""

    def test_inferred_scope_is_bounded(self):
        """有界即可。这条线是拦病态(几千个)而不是拦大改动(几十个)——
        卡住正常改动等于凭空多一步返工。"""
        from mae_flow_core.cli_commands import standalone_core
        self.assertGreaterEqual(standalone_core._MAX_INFERRED_FILES, 100,
                                "太低会误伤正常的大改动")
        self.assertLessEqual(standalone_core._MAX_INFERRED_FILES, 500,
                             "太高就等于没有防线")

    def test_over_cap_refusal_tells_the_way_out(self):
        """拒绝必须给出路——否则就是把人堵死在这儿。"""
        import io as _io
        with _io.open(os.path.join(SCRIPTS, "mae_flow_core", "cli_commands",
                                   "standalone_core.py"),
                      encoding="utf-8") as stream:
            source = stream.read()
        head = source.split("def _action_files", 1)[1][:1200]
        self.assertIn("--files", head, "要告诉人怎么明确范围")
        self.assertIn(".gitignore", head, "要告诉人怎么根治")

    def test_card_scope_line_would_not_explode(self):
        """任务卡把范围拼成一行「本次子任务范围: a、b、c」。
        上限乘以典型路径长度必须还在 Agent 读得动的量级(实战爆的是几十万字符)。"""
        from mae_flow_core.cli_commands import standalone_core
        self.assertLess(standalone_core._MAX_INFERRED_FILES * 80, 30000)


class LateralSweepTests(unittest.TestCase):
    """横向排查:同一个洞在别处的出口。

    洞的形状是"从仓库枚举出来的清单,不设上限地进了给 Agent 或用户看的文本"。
    _dirty_paths() 用的是 --untracked-files=all,仓里没忽略 node_modules 时它
    返回几千条——下面三处都实测过后果。
    """

    def test_symbol_refs_excludes_tool_managed_dirs(self):
        """实测:3000 文件的 node_modules 里搜一个普通符号命中 2400 处,
        排除后 0 处。而这份清单要求 Agent"每一处要么适配、要么写明为何不需要",
        2400 条等于当场压死它。"""
        import io as _io
        with _io.open(os.path.join(SCRIPTS, "mae_flow_core", "cli_commands",
                                   "symbol_refs.py"), encoding="utf-8") as s:
            source = s.read()
        self.assertIn("tool_managed_exclude_pathspecs", source,
                      "必须复用共用口径,不许再抄一份目录清单")

    def test_symbol_refs_truncation_forbids_false_closure(self):
        """这份清单的用途是"逐条对钩才算收口",静默截断=假收口。
        所以截断时必须明说不能据此判定收口。"""
        import io as _io
        from mae_flow_core.cli_commands import symbol_refs
        self.assertLessEqual(symbol_refs._MAX_LISTED_HITS, 500)
        with _io.open(os.path.join(SCRIPTS, "mae_flow_core", "cli_commands",
                                   "symbol_refs.py"), encoding="utf-8") as s:
            source = s.read()
        self.assertIn("不能据这份清单判定收口", source)

    def test_exit_preview_does_not_print_one_giant_line(self):
        """实测 3000 个未跟踪文件会拼成一行 105000 字符。"""
        from mae_flow_core.cli_commands import lifecycle
        self.assertLessEqual(lifecycle._MAX_LISTED_DIRTY, 100)
        self.assertLess(lifecycle._MAX_LISTED_DIRTY * 80, 10000)

    def test_initial_dirty_skips_tool_managed_dirs(self):
        """initial_dirty 记的是"用户现场"。工具自管目录不是现场——没人手写
        node_modules,也不需要保护它不被改。实测 3000 个文件被逐个算指纹
        写进 .mae-flow.json,单这一项 422 KB,而状态每推进一步整份重写。"""
        import io as _io
        with _io.open(os.path.join(SCRIPTS, "mae_flow_core", "cli_commands",
                                   "init_capability.py"), encoding="utf-8") as s:
            source = s.read()
        self.assertIn("is_tool_managed_path", source,
                      "必须复用共用口径,不许再抄一份目录清单")
        # 过滤必须发生在算指纹之前,否则省不掉那几千次文件读
        self.assertLess(source.index("is_tool_managed_path"),
                        source.index("initial_dirty_fingerprints"))

    def test_search_exclusions_are_narrower_than_source_verdict(self):
        """搜索类命令只排第一档:漏掉一处真引用的代价是"编译全绿功能坏",
        而 build/ vendor/ 里确实可能有仓库自己的代码。方向与"判定源码"相反。"""
        from mae_flow_core.foundation.source_paths import (
            DERIVED_DIRS, tool_managed_exclude_pathspecs)
        specs = " ".join(tool_managed_exclude_pathspecs())
        self.assertIn("node_modules", specs)
        for item in DERIVED_DIRS:
            self.assertNotIn(item.rstrip("/"), specs.split(),
                             "第二档不该进搜索排除: %s" % item)


class OneVerdictPerConceptTests(unittest.TestCase):
    """同义清单不许有第二份——这正是漏掉第三个出口的根因。"""

    def test_lightcheck_reuses_the_shared_dependency_verdict(self):
        """lightcheck 的 _generated_path 曾是第四份手抄清单,而且抄漏一档:
        没有 .venv/site-packages/__pycache__,于是虚拟环境里的三方代码
        会被当成本单源码去报复杂度告警。"""
        from mae_flow_core.lightcheck_source import _generated_path
        for path in (".venv/lib/python3.13/site-packages/x.py",
                     "node_modules/a/b.js", "__pycache__/m.pyc",
                     "build/out.js", "vendor/lib.go"):
            self.assertTrue(_generated_path(path), "该跳过: %s" % path)
        for path in ("src/app.py", "service/src/main/java/A.java"):
            self.assertFalse(_generated_path(path), "不该跳过: %s" % path)

    def test_code_extension_list_has_exactly_one_home(self):
        """CODE_EXTS 与 SUPPORTED_EXTENSIONS 曾是逐字节相同的两份副本。
        两份同义清单迟早各改各的——用 is 断言它们是同一个对象。"""
        from mae_flow_core.cli_commands.shared import CODE_EXTS
        from mae_flow_core.foundation import source_paths
        from mae_flow_core.lightcheck_source import SUPPORTED_EXTENSIONS
        self.assertIs(CODE_EXTS, source_paths.CODE_EXTENSIONS)
        self.assertIs(SUPPORTED_EXTENSIONS, source_paths.CODE_EXTENSIONS)

    def test_no_module_hand_rolls_a_dependency_dir_list(self):
        """任何模块再抄一份 node_modules 目录清单都会在这里失败。
        允许出现的只有 foundation/source_paths 那一份定义。"""
        import io as _io
        import glob as _glob
        offenders = []
        pattern = os.path.join(SCRIPTS, "mae_flow_core", "**", "*.py")
        for path in _glob.glob(pattern, recursive=True):
            if path.endswith(os.path.join("foundation", "source_paths.py")):
                continue
            with _io.open(path, encoding="utf-8") as stream:
                text = stream.read()
            # 判据是"清单":同一处既写 node_modules 又写另外两个依赖目录名
            for line in text.splitlines():
                if line.lstrip().startswith("#"):
                    continue
                if "node_modules" in line and sum(
                        item in line for item in
                        ("vendor", "site-packages", ".venv", "third_party",
                         "bower_components")) >= 1:
                    offenders.append("%s: %s" % (
                        os.path.relpath(path, SCRIPTS), line.strip()[:70]))
        self.assertEqual([], offenders,
                         "又抄了一份依赖目录清单,应改用 source_paths 的判据")


if __name__ == "__main__":
    unittest.main()

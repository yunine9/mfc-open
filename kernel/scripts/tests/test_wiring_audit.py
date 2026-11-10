#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""接线审计:跨模块的调用点必须真的接上了。

为什么单独立一类:今天四个 bug(面板 dx() 从未定义、hook 铺桥挂错分支、
判据用错函数、通知默认定反)全是**接线错误**——每段代码单独看都对,接口上
错了位。而绝大多数测试在测函数本身,照不出"函数是对的但没接上"。

有前科的两处:
- acd904b:编译任务卡把每次提交都拦死,因为读的是**未注册**的 api.* 属性,
  被吞掉的 AttributeError 变成了永久拦截;
- 今天:面板折叠行 onclick="dx(this)",而 dx 一次都没定义过——点了没反应,
  这个功能自始至终没工作过。

api 用 __getattr__ 从 _values 取值,dir() 看不见它;必须用 exports() 内省,
而且要先按真实入口加载(cli_runtime 会注册 shared 与全部命令模块)。
我审计时先后错过两次:注册前内省、以及用 dir() 内省——都得出"176 个缺失"
的假警报。留个记号:内省动态对象要用它自己的视图。
"""

import ast
import io
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

# CliApi 自己的方法走普通属性查找,不进 _values——不是"未注册"。
_OWN = frozenset({"exports", "register", "register_values"})


def _api_attribute_uses():
    """→ {属性名: [出处]}，所有 api.<name> 静态访问点。"""
    found = {}
    base = os.path.join(SCRIPTS, "mae_flow_core")
    for here, _dirs, names in os.walk(base):
        for name in sorted(names):
            if not name.endswith(".py"):
                continue
            path = os.path.join(here, name)
            with io.open(path, encoding="utf-8") as stream:
                tree = ast.parse(stream.read())
            for node in ast.walk(tree):
                if (isinstance(node, ast.Attribute)
                        and isinstance(node.value, ast.Name)
                        and node.value.id == "api"):
                    found.setdefault(node.attr, []).append(
                        "%s:%d" % (os.path.relpath(path, ROOT), node.lineno))
    return found


class ApiWiringTests(unittest.TestCase):
    def test_every_api_attribute_is_registered(self):
        import mae_flow_core.cli_runtime  # noqa: F401 —— 触发注册
        from mae_flow_core.cli_commands.wiring import api
        registered = set(api.exports()) | _OWN
        dangling = sorted(
            name for name in _api_attribute_uses() if name not in registered)
        uses = _api_attribute_uses()
        self.assertEqual(
            [], dangling,
            "这些 api.* 没有注册,调用会抛 AttributeError(历史上被吞掉后变成"
            "永久拦截): %s" % [(n, uses[n][0]) for n in dangling])

    def test_the_audit_itself_can_see_the_registry(self):
        """审计方法自身要有效:注册数明显大于访问数,否则说明我又内省错了对象
        (dir() 看不见 __getattr__ 提供的属性,注册前内省也一样)。"""
        import mae_flow_core.cli_runtime  # noqa: F401
        from mae_flow_core.cli_commands.wiring import api
        self.assertGreater(len(api.exports()), 300,
                           "internal registry 应当已装载;数目太少=内省错了")
        self.assertNotIn("_ack_verified", set(dir(api)),
                         "dir() 看不见动态属性——这正是当初误判的原因")


class PanelHandlerWiringTests(unittest.TestCase):
    """面板里被 HTML 调到的函数,必须在页面自己的 JS 里定义得出来。"""

    def _page(self):
        from mae_flow_core.panel import page, snapshot
        state = {"current": "build", "config": {"单号": "REQ-1"},
                 "history": [], "started": "2026-08-11 00:00:00"}
        flow = {"steps": {"build": {"title": "编码"}}}
        data = snapshot.build(ROOT, state, flow)
        return page.render(data, (), ROOT)

    def test_inline_handlers_all_have_definitions(self):
        import re
        html = self._page()
        called = set()
        for attribute in ("onclick", "onchange", "oninput", "onsubmit"):
            called |= set(re.findall(
                attribute + r'="(\w+)\(', html))
        self.assertTrue(called, "页面总得有几个交互入口")
        for name in sorted(called):
            self.assertRegex(
                html, r"function\s+%s\s*\(" % name,
                "页面调用了 %s() 却没有定义它(dx 就是这么假了很久)" % name)


class HookBranchReachabilityTests(unittest.TestCase):
    """铺桥的代码必须住在"全新仓真会走到"的那个分支上。

    今天的 bug 正是这个形状:铺桥被放进 corrupt(状态文件损坏)分支,而全新仓
    (INACTIVE)的 userprompt 走的是 inject——那条路上代码根本不存在,于是内网
    首战完全没生效。路由表是客观的,直接拿它断言,不靠人记得住。
    """

    def _route(self, mode, event, terminal=False):
        from mae_flow_core.application.hooks.events import handle_hook_event
        from mae_flow_core.application.hooks.models import HookResponse
        seen = []

        class Runtime(object):
            def __init__(self):
                self.mode = mode
                self.flow_terminal = terminal
                self.has_conflict = False

        class Ports(object):
            def __getattr__(self, name):
                def record(*args, **kwargs):
                    seen.append(name)
                    return HookResponse()
                return record

        handle_hook_event(event, {}, Runtime(), Ports())
        return seen[0] if seen else ""

    def test_fresh_repo_prompts_land_on_inject(self):
        from mae_flow_core import RuntimeMode
        for event in ("userprompt", "sessionstart"):
            self.assertEqual(
                "inject", self._route(RuntimeMode.INACTIVE, event),
                "全新仓的 %s 落在 inject——铺桥必须挂这里" % event)

    def test_bridge_code_lives_on_that_branch(self):
        import ast as _ast
        with io.open(os.path.join(SCRIPTS, "mae_flow_core", "adapters",
                                  "hook_events.py"), encoding="utf-8") as s:
            source = s.read()
        tree = _ast.parse(source)
        owners = {}
        for node in _ast.walk(tree):
            if isinstance(node, _ast.FunctionDef):
                body = _ast.get_source_segment(source, node) or ""
                if "_offer_first_entry(" in body and node.name != (
                        "_offer_first_entry"):
                    owners[node.name] = True
        self.assertIn("inject", owners,
                      "铺桥调用必须由 inject 发起(它是全新仓的落点)")
        self.assertNotIn("corrupt", owners,
                         "corrupt 只在状态文件损坏时走,全新仓永远到不了")

    def test_corrupt_never_serves_a_fresh_repo(self):
        from mae_flow_core import RuntimeMode
        self.assertEqual("corrupt",
                         self._route(RuntimeMode.CORRUPT, "userprompt"))
        self.assertNotEqual("corrupt",
                            self._route(RuntimeMode.INACTIVE, "userprompt"))


class ManifestWiringTests(unittest.TestCase):
    """清单声明的每个 hook,都要真能被 dispatch 处理。

    这是最外层的一段线:宿主照 hooks.json 调命令,命令把事件名传给 dispatch。
    名字错一个字母就是整条事件静默失效——而它不会报错,只是什么都不做。
    """

    def _declared(self):
        import json as _json
        import re
        with io.open(os.path.join(ROOT, "hooks", "hooks.json"),
                     encoding="utf-8") as stream:
            manifest = _json.load(stream)
        hooks = manifest.get("hooks") or manifest
        pairs = []
        for event, entries in hooks.items():
            for entry in entries:
                for item in (entry.get("hooks") or []):
                    command = str(item.get("command", ""))
                    found = re.search(r"dispatch\.py\"?\s+(\w+)", command)
                    pairs.append((event, found.group(1) if found else ""))
        return pairs

    def test_every_declared_hook_passes_a_handled_event_name(self):
        from mae_flow_core.application.hooks.events import handle_hook_event
        from mae_flow_core.application.hooks.models import HookResponse
        from mae_flow_core import RuntimeMode
        pairs = self._declared()
        self.assertTrue(pairs, "清单里总得有 hook")
        for event, passed in pairs:
            self.assertTrue(passed, "%s 的命令里读不出事件名" % event)
            seen = []

            class Runtime(object):
                mode = RuntimeMode.INACTIVE
                flow_terminal = False
                has_conflict = False

            class Ports(object):
                def __getattr__(self, name):
                    def record(*args, **kwargs):
                        seen.append(name)
                        return HookResponse()
                    return record

            handle_hook_event(passed, {}, Runtime(), Ports())
            self.assertTrue(
                seen,
                "清单声明了 %s → dispatch %s,但没有任何处理器接它"
                "(名字错一个字母就是整条事件静默失效)" % (event, passed))

    def test_timeout_leaves_room_for_the_watchdog(self):
        """hook 超时必须给看门狗留余量,否则进程被宿主掐断在半路。"""
        import json as _json
        with io.open(os.path.join(ROOT, "hooks", "hooks.json"),
                     encoding="utf-8") as stream:
            manifest = _json.load(stream)
        hooks = manifest.get("hooks") or manifest
        for event, entries in hooks.items():
            for entry in entries:
                for item in (entry.get("hooks") or []):
                    self.assertLessEqual(
                        int(item.get("timeout", 0)), 60,
                        "%s 的 timeout 过长,宿主会先失去耐心" % event)


if __name__ == "__main__":
    unittest.main()

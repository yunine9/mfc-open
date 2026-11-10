"""panel 命令:交付现场的只读快照与单文件面板。

为什么不做成 `status --json`:`status` 已经在打印原始状态 JSON,再加一个
--json 会撞语义。panel 是全新的只读命令,既有路径一行没动。

它永不写状态、永不触发重活(不调 CodeCheck/npm/编译),取不到的东西写进
快照的 warnings——看现场不能改变现场,更不能变成新卡点。
"""

import json
import os

from mae_flow_core import host_env

from mae_flow_core.panel import page, snapshot

from .shared import STATE_PATH
from .wiring import api

PANEL_PATH = os.path.join(".mae-flow-work", "panel.html")


def _flow():
    try:
        return api.load_flow()
    except Exception:                      # noqa: BLE001 —— 缺流程图也要能看
        return {}


def _write_page(data, changes, target):
    return page.write_page(target, data, changes, os.getcwd())


def refresh(flow, st):
    """通知响的时刻自动同步面板——人被叫来时,看到的必须是最新现场。

    只在这两种时刻刷新(需要裁决/跨阶段):其余时刻没人看,刷了也是白刷;
    失败即放弃返回 None,面板永远不能反过来影响推进。
    """
    try:
        root = os.getcwd()
        data = snapshot.build(root, st, flow or {})
        changes = snapshot.changes(
            root, (st or {}).get("implementation_base_head", ""))
        _write_page(data, changes, PANEL_PATH)
        return os.path.abspath(PANEL_PATH)
    except Exception:                      # noqa: BLE001
        return None


def cmd_panel(st, args):
    """生成只读面板;--json 只打印结构化快照,不落地文件。"""
    root = os.getcwd()
    data = snapshot.build(root, st, _flow())
    if getattr(args, "json", False):
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return None
    changes = snapshot.changes(
        root, (st or {}).get("implementation_base_head", ""))
    target = getattr(args, "out", None) or PANEL_PATH
    try:
        size = _write_page(data, changes, target)
    except OSError as exc:
        print("[mae-flow] 面板写入失败(不影响流程): %s" % exc)
        return None
    # 面板重生成时把脉冲也按当前词表重写:老任务(阶段词表升级前留下的
    # 脉冲)靠宿主跑一次 panel 就能自愈,不用等下一个 Hook 事件。旁路,
    # 失败静默。
    try:
        from mae_flow_core.panel import pulse
        pulse.write_pulse(STATE_PATH, root=root, force=True)
    except Exception:                      # noqa: BLE001
        pass
    print("[mae-flow] 交付现场面板已生成: %s (%.1f KB)"
          % (os.path.abspath(target), size / 1024.0))
    if host_env.user_on_this_machine():
        print("  用浏览器打开即可;它是只读快照,不含任何推进入口。")
    else:
        print("  只读快照,由宿主界面呈现;别把这条本机路径告诉用户。")
    if not os.path.exists(STATE_PATH):
        print("  当前没有在途交付,面板只展示仓库信息。")
    for warning in data["warnings"]:
        print("  · " + warning)
    return None

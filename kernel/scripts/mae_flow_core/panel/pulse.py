"""状态脉冲:让面板的轻量区实时,而不必全量重生成。

为什么单独一层:全量重生成要渲染全部文档与全量 diff(200KB、几百毫秒),
编码期间 hook 每次工具调用都触发,每次都算会实打实拖慢流程。
而用户真正需要"随时最新"的只是轻量事实——现在到哪一步、要不要我出场、
改了几个文件。这些从状态文件直接读,写一次几毫秒。

页面用 <script src> 加载本文件(file:// 拦 fetch 但不拦 script),
每两秒一次,就地更新页眉、阶段轨道与待裁决提示;文档与 diff 这类重内容
仍按关键节点重生成——反正它们只在检视时看。

三条自律与面板同源:只读、软失败、不知道就不写(宁可让页面显示旧值,
也不写一个编出来的新值)。
"""

import json
import os
import time

PULSE_NAME = "panel-pulse.js"
_MIN_INTERVAL = 2.0


def pulse_path(root="."):
    return os.path.join(root, ".mae-flow-work", PULSE_NAME)


def _recent(path):
    try:
        return (time.time() - os.path.getmtime(path)) < _MIN_INTERVAL
    except OSError:
        return False


def build_pulse(state, flow):
    """只取从状态文件直接读得到的轻量事实,不跑 git、不读文档。"""
    from . import notify
    current = str((state or {}).get("current", "") or "")
    step = ((flow or {}).get("steps", {}) or {}).get(current) or {}
    waiting = bool(step.get("user_ack") or step.get("choice_key"))
    return {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "step": current,
        "step_title": str(step.get("title", "") or ""),
        "phase": notify.phase_of(current),
        "revision": (state or {}).get("revision") or 0,
        "waiting": waiting,
        "ticket": str(((state or {}).get("config") or {}).get("单号", "") or ""),
    }


def write_pulse(state_path, flow=None, root=None, force=False):
    """写一次脉冲;两秒内已写过就跳过。失败一律静默——它绝不能影响流程。

    force:宿主命令(流水线登记、反馈开批/落结果、MR 合入收口)推进的是
    Agent 不在场的阶段跃迁,没有 Hook 事件会来补写脉冲;两秒节流在这里
    等于"合入后进度条永远停在上一段",所以它们必须强制写。
    """
    try:
        root = root or os.getcwd()
        target = pulse_path(root)
        if not force and _recent(target):
            return False
        with open(state_path, encoding="utf-8") as stream:
            state = json.load(stream)
        if flow is None:
            from mae_flow_core.workflow import definition
            plugin_root = os.path.abspath(os.path.join(
                os.path.dirname(__file__), "..", "..", ".."))
            flow = definition.load_definition(
                os.path.join(plugin_root, "flow", "flow.json"))
        payload = build_pulse(state, flow)
        folder = os.path.dirname(target)
        if folder and not os.path.isdir(folder):
            os.makedirs(folder, exist_ok=True)
        with open(target, "w", encoding="utf-8") as stream:
            stream.write("window.__panelPulse=%s;\n"
                         % json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:                      # noqa: BLE001 —— 软失败铁律
        return False

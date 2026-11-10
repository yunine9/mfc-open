"""阶段推进与"需要你确认"的主动通知。

两个真实痛点:交付常常跨小时甚至跨天,用户不可能一直盯着终端;
而流程真正需要人的时刻只有那么几个——错过它们,时间就白白躺在等待里。

三条自律:

- **只在两种时刻响**:到了需要用户裁决的步骤、进入了新阶段。其余一律安静,
  否则通知本身会变成噪声,而噪声化的通知等于没有通知。
- **绝不阻塞、绝不抛错**:通知失败就是没通知,不许影响流程一分一毫。
- **桌面弹窗按仓库预设开关**:默认只打印一行(模型会转述给用户),
  弹窗要在 .mae-flow-defaults.json 写「桌面通知": true」才启用——
  不问自取地弹系统通知是打扰,不是服务。
"""

import json
import os
import subprocess
import sys

from mae_flow_core.file_io import load_json

DEFAULTS_PATH = ".mae-flow-defaults.json"
FIELD = "桌面通知"
ENV_OFF = "MAE_FLOW_NO_NOTIFY"

# 步骤 → 阶段。flow.json 里没有阶段字段,flow/phases.json 是唯一来源;
# 漏掉任何步骤都会被 test_panel_notify 的覆盖断言拦下,不会静默错标。
# 阶段名是给人看的,说人话:描述这一段在干什么,不用流程内部代号。
#
# 2026-09-02 从本文件的字面量搬进 flow/phases.json:Cloud 的进度条、
# 占位进度和"点阶段弹方案"都要同一份词表,而 Cloud 按宪法一行映射都不许
# 在 TS 侧抄——那就让它读同一个文件。此前 Cloud 自带两套阶段词表(进入
# 持续检视后强行换成五段,没内核进度时又是七段),老任务停在哪套显示哪套,
# 点阶段名因为名字对不上内核方案词表退底版告警。环节不减:只把「交付」
# 改叫「检视与验证」,加一段终态「已合入」(用户拍板)。
# playbooks.json 的 phase 与这里必须同一词表,由 test_execution_plan 钉死。
_PHASES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "..", "..", "flow", "phases.json")


def _load_phases(path=_PHASES_PATH):
    with open(path, encoding="utf-8") as stream:
        document = json.load(stream)
    if document.get("schema") != "mae-flow-phases/1":
        raise ValueError("flow/phases.json schema 不是 mae-flow-phases/1")
    phases = {}
    for entry in document.get("phases") or ():
        name = str(entry.get("name") or "").strip()
        steps = tuple(str(step) for step in entry.get("steps") or ())
        if not name or not steps or name in phases:
            raise ValueError("flow/phases.json 阶段名缺失、重复或没有步骤: %r" % name)
        phases[name] = steps
    return phases


PHASES = _load_phases()
_STEP_PHASE = {step: phase for phase, steps in PHASES.items()
               for step in steps}


def phase_of(step_id):
    return _STEP_PHASE.get(step_id, "")


def desktop_enabled(root="."):
    """默认开启;要静音就把「桌面通知」预设写成 false,或设 MAE_FLOW_NO_NOTIFY。

    原来默认关闭,理由是"不问自取地弹通知是打扰"。这条顾虑放在这里不成立:
    它只在"需要你裁决"和"跨入新阶段"两种时刻响,一单几次而已;而这个流程真正
    的痛点恰恰是"你不知道它什么时候需要你"——通知就是为解决它而生的。
    更要紧的是,要用户先知道有这功能、再去建一个 JSON 文件才生效的贴心功能,
    等于没有(内网反馈"Windows 下通知未生效",真因就是它压根没开)。
    """
    if os.environ.get(ENV_OFF):
        return False
    try:
        defaults = load_json(os.path.join(root, DEFAULTS_PATH),
                             encoding="utf-8-sig") or {}
    except Exception:                      # noqa: BLE001 —— 读不到预设按默认开
        return True
    value = defaults.get(FIELD)
    return True if value is None else bool(value)


def _command(title, body):
    if sys.platform == "darwin":
        return ["osascript", "-e",
                'display notification %s with title %s sound name "Ping"'
                % (_applescript(body), _applescript(title))]
    if os.name == "nt":
        # 先走 WinRT toast:Win10/11 上 NotifyIcon.ShowBalloonTip 已被系统当作
        # 过时接口,常常直接不显示(内网实测"通知未生效")。toast 用 PowerShell
        # 自己的 AppId,无需注册应用。失败再退回气泡提示——两条都不成也无所谓,
        # 正文那一行始终会打印,通知只是加强,从不承担告知责任。
        #
        # 2026-08-12 内网真机确认可弹(此前一直挂着"未证实"标记)。真因是两条:
        # ShowBalloonTip 不显示,以及桌面通知当时默认关闭——后者才是主因。
        safe_title = title.replace("'", " ")
        safe_body = body.replace("'", " ")
        script = (
            "$ErrorActionPreference='Stop';"
            "try{"
            "[Windows.UI.Notifications.ToastNotificationManager,"
            "Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;"
            "$t=[Windows.UI.Notifications.ToastNotificationManager]::"
            "GetTemplateContent("
            "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
            "$x=$t.GetElementsByTagName('text');"
            "$x.Item(0).AppendChild($t.CreateTextNode('%(t)s'))>$null;"
            "$x.Item(1).AppendChild($t.CreateTextNode('%(b)s'))>$null;"
            "[Windows.UI.Notifications.ToastNotificationManager]::"
            "CreateToastNotifier("
            "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell"
            "\\v1.0\\powershell.exe').Show("
            "[Windows.UI.Notifications.ToastNotification]::new($t))"
            "}catch{"
            "Add-Type -AssemblyName System.Windows.Forms;"
            "Add-Type -AssemblyName System.Drawing;"
            "$n=New-Object System.Windows.Forms.NotifyIcon;"
            "$n.Icon=[System.Drawing.SystemIcons]::Information;"
            "$n.Visible=$true;"
            "$n.ShowBalloonTip(8000,'%(t)s','%(b)s',"
            "[System.Windows.Forms.ToolTipIcon]::Info);"
            "Start-Sleep -Seconds 6;$n.Dispose()}"
            % {"t": safe_title, "b": safe_body})
        return [_windows_shell(), "-NoProfile", "-WindowStyle", "Hidden",
                "-Command", script]
    return ["notify-send", title, body]


def _windows_shell():
    """powershell 不在 PATH 时退到绝对路径:内网机器的 PATH 常被裁剪。"""
    import shutil
    for name in ("powershell", "powershell.exe", "pwsh"):
        if shutil.which(name):
            return name
    fallback = os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"),
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return fallback if os.path.isfile(fallback) else "powershell"


def _applescript(text):
    return '"%s"' % text.replace("\\", "").replace('"', "'")


def _popup(title, body):
    """弹窗进程发射后不管:通知永远不能拖慢流程推进。"""
    # 测试进程绝不弹真桌面通知。用例路过通知路径是常态,弹到开发者桌面
    # 就是测试泄漏(2026-08-15 实锤:跑内核全量,用户的 mac 被弹了一串
    # "需要你确认");靠每个用例自觉设 MAE_FLOW_NO_NOTIFY 不可靠——这次
    # 就是忘了才漏的。闸设在真副作用这一步,不动 desktop_enabled 的判定
    # 逻辑,"全新仓默认弹"的契约照常可测。生产 CLI 不导入 unittest/pytest
    # (grep 过 mae_flow_core 全目录,一处都没有),真用户路径不受影响。
    if "unittest" in sys.modules or "pytest" in sys.modules:
        return False
    try:
        subprocess.Popen(_command(title, body), shell=False,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    except Exception:                      # noqa: BLE001 —— 通知失败=没通知
        return False
    return True


def deferred_ack(step_id):
    """这一步要你确认的东西,是进门之后才产出的吗?

    进门就喊"请检视 Story"是错的——那会儿 Story 还没开始写。要确认的
    产物落地了才叫到人,和面板那条"不显示与当前阶段不符的信息"同源。
    """
    from . import snapshot
    return step_id in snapshot.ACK_REVIEW_DOCS or step_id == "config_confirm"


def _reason(flow, step_id, at_entry=True):
    """→ (标题, 详情) 或 None。只认两种时刻,其余安静。"""
    step = ((flow or {}).get("steps", {}) or {}).get(step_id) or {}
    title = step.get("title", step_id)
    if step.get("choice_key"):
        return "需要你选择", "%s（%s）" % (title, step_id)
    if step.get("user_ack"):
        if at_entry and deferred_ack(step_id):
            return None                    # 等产物落地那一刻再叫人
        return "需要你确认", "%s（%s）" % (title, step_id)
    return None


_ACK_MARK = ".notify-ack"


def _rang_before(root, token):
    """同一份产物可能被改写多次,人只该被叫一次。失败一律当作"没响过"。"""
    path = os.path.join(root, ".mae-flow-work", _ACK_MARK)
    try:
        with open(path, encoding="utf-8") as stream:
            if stream.read().strip() == token:
                return True
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as stream:
            stream.write(token)
    except OSError:
        pass
    return False


def announce_ready(flow, step_id, root=".", ticket="", token=""):
    """待确认的产物已经落地——现在才是叫人的时刻。返回打印出的行。"""
    reason = _reason(flow, step_id, at_entry=False)
    if not reason:
        return []
    if _rang_before(root, token or step_id):
        return []
    return _ring(["🔔 %s: %s" % reason], root, ticket)


def announce(flow, previous_step, next_step, root=".", ticket=""):
    """在推进落地后调用。返回要打印的行(空表示这次不该响)。"""
    lines = []
    reason = _reason(flow, next_step)
    if reason:
        lines.append("🔔 %s: %s" % reason)
    before, after = phase_of(previous_step), phase_of(next_step)
    if after and after != before:
        lines.append("🔔 进入「%s」阶段" % after)
    return _ring(lines, root, ticket)


def _ring(lines, root, ticket):
    if not lines:
        return []
    label = ("%s · " % ticket) if ticket else ""
    for line in lines:
        print("[mae-flow] " + line)
    try:
        sys.stderr.write("\a")             # 终端响一下,不占正文
        sys.stderr.flush()
    except Exception:                      # noqa: BLE001
        pass
    if desktop_enabled(root):
        if not _popup("Mae-Flow · " + label.rstrip(" ·· ").strip(),
                      "；".join(item.replace("🔔 ", "") for item in lines)):
            # 弹窗失败要说一声。静默失败的后果是用户以为功能坏了却查不到原因
            # (内网实测"Windows 下通知未生效",而真因可能只是没开开关)。
            print("[mae-flow] （桌面通知这次没弹出来;上面这行才是正文,"
                  "不影响流程。反复不弹可把「桌面通知」预设关掉免打扰。）",
                  file=sys.stderr)
    elif _notice_due(root):
        print("[mae-flow] 桌面通知已静音(预设或 MAE_FLOW_NO_NOTIFY);"
              "需要裁决的时刻只会打印上面这行。", file=sys.stderr)
    return lines


_NOTICE_MARK = ".notify-hint"


def _notice_due(root):
    """开关提示每单只说一次——每次响铃都念一遍就成了新的噪声。"""
    path = os.path.join(root, ".mae-flow-work", _NOTICE_MARK)
    if os.path.exists(path):
        return False
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as stream:
            stream.write("said\n")
    except OSError:
        return False
    return True

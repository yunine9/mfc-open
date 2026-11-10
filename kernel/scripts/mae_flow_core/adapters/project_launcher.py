"""Install a stable project-local bridge to the CodeAgent plugin entry."""

import os
import re
import time

from ..runtime import ACTION_FILE, EXIT_FILE, FLOW_FILE

# 转发壳的内容。它必须在插件入口失踪时自己把话说明白——内网实战反馈
# "明显报错了,不知道从哪来的",因为原来只会甩一句
# `python: can't open file '...'`:既不说这是谁铺的文件,也不说怎么修。
_BRIDGE_LINES = (
    "# 本文件由 Mae-Flow 自动生成:把项目内的固定路径转发到插件入口。",
    "# 生成于 %(at)s,插件根 %(root)s。删掉它下次会话会自动重铺。",
    "import os",
    "import subprocess",
    "import sys",
    "",
    "ENTRY = %(entry)r",
    "if not os.path.isfile(ENTRY):",
    "    sys.stderr.write(",
    '        "[mae-flow] 插件入口不在这个路径了: " + ENTRY + "\\n"',
    '        "这个文件(.mae-flow-work/bin/mae-flow.py)是 Mae-Flow 自动铺的"',
    '        "转发壳。插件换了目录、换了机器或被卸载都会这样;"',
    '        "流程状态没坏,代码没事。\\n"',
    '        "两种修法:\\n"',
    '        "  1) 用插件自身路径跑一次任意命令(如 current),会自动重铺;\\n"',
    '        "  2) 设 CODEAGENT3_PLUGIN_ROOT 指向插件目录后重开会话。\\n")',
    "    raise SystemExit(3)",
    "raise SystemExit(subprocess.call([sys.executable, ENTRY] + sys.argv[1:]))",
    "",
)


def bridge_source(entry, plugin_root, at=None):
    """转发壳源码。单独成函数,好让测试直接盯住"它会不会自我解释"。"""
    return "\n".join(_BRIDGE_LINES) % {
        "at": at or time.strftime("%Y-%m-%d %H:%M:%S"),
        "root": plugin_root,
        "entry": entry,
    }


def plugin_entry_path(plugin_root=None):
    """插件入口的绝对路径。全新仓里桥还没铺,这是唯一能给模型的起点。"""
    root = (
        str(plugin_root or "").strip()
        or os.environ.get("CODEAGENT3_PLUGIN_ROOT", "").strip()
        or os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", "..", ".."))
    )
    return os.path.join(root, "scripts", "mae-flow.py")


_DELIVERY = re.compile(
    r"/mae-flow|mae[- ]?flow|月光宝盒|moonlight|"
    r"交付|开发需求|落地|提\s*MR|走流程|"
    r"\b(?:REQ|DTS)\d{4,}", re.I)


def wants_delivery(prompt):
    """这条用户消息像不像"要在这个仓开工"。

    宽判是有意的:铺一个转发壳的代价是过程目录多一个文件(已在 .gitignore 内),
    判严的代价是用户开不了工——内网首战正是判据永远 False,模型只好自己去找
    python 和插件路径。真正的"不写脏仓"由 install_launcher_when_active 那条
    铁律守着(它只在真有流程状态时铺);这里额外放宽的仅限"用户点名要交付"。
    """
    return bool(_DELIVERY.search(str(prompt or "")))


def project_has_runtime_state(project_root=None):
    """Whether this project ever enabled Mae-Flow.

    A global plugin install only offers capability; it must not leave files in
    repositories that never started a delivery. Without this check the bridge
    reappears in ``git status`` of every project on the first message, and
    comes back immediately after the user deletes it.
    """
    root = os.path.abspath(project_root or os.getcwd())
    return any(
        os.path.isfile(os.path.join(root, marker))
        for marker in (FLOW_FILE, EXIT_FILE, ACTION_FILE)
    )


def install_project_launcher(project_root=None, plugin_root=None):
    project_root = os.path.abspath(project_root or os.getcwd())
    plugin_root = (
        str(plugin_root or "").strip()
        or os.environ.get("CODEAGENT3_PLUGIN_ROOT", "").strip()
        or os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", "..", ".."))
    )
    entry = os.path.join(plugin_root, "scripts", "mae-flow.py")
    target = os.path.join(
        project_root, ".mae-flow-work", "bin", "mae-flow.py")
    temporary = target + ".tmp-%s" % os.getpid()
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(temporary, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(bridge_source(entry, plugin_root))
        os.replace(temporary, target)
        try:
            os.chmod(target, 0o755)
        except OSError:
            pass
        return target
    except (OSError, UnicodeError):
        try:
            if os.path.exists(temporary):
                os.unlink(temporary)
        except OSError:
            pass
        return ""


def install_launcher_when_active(project_root=None, plugin_root=None):
    """Materialize the bridge only for projects that already use Mae-Flow."""
    if not project_has_runtime_state(project_root):
        return ""
    return install_project_launcher(project_root, plugin_root)


def launcher_health(project_root=None):
    """→ (该不该有, 有没有, 目标路径)。铺失败原来完全静默,没人拿得到线索。"""
    root = os.path.abspath(project_root or os.getcwd())
    target = os.path.join(root, ".mae-flow-work", "bin", "mae-flow.py")
    return (project_has_runtime_state(root), os.path.isfile(target), target)


def install_launcher_for_event(event):
    normalized = "".join(
        character for character in str(event).casefold()
        if character.isalnum())
    if normalized in {"sessionstart", "userprompt", "userpromptsubmit"}:
        return install_launcher_when_active()
    return ""

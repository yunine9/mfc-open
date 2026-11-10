"""检视文档落盘 → 面板刷新:第四个感知时机。

前三个时机(init/裁决点/跨阶段)都拍在**进步的瞬间**,但 open/story 这类
步骤是"进了步才生成文档、同一步内请用户确认"——进步瞬间的快照拍不到
文档,用户被请去确认 spec 时,面板上却没有 spec.md(实战反馈原文)。

文档落盘即重新生成面板。失败一律静默:hook 绝不因面板受伤。
"""

import json
import os
import time

REVIEW_DOC_NAMES = frozenset({
    "spec.md", "story.md", "implementation.md", "grill.md",
    "grill-prep.md", "survey.md", "decisions.md", "review.md",
})


def is_review_doc(written_path):
    normalized = "/" + str(written_path or "").replace("\\", "/")
    return (normalized.rsplit("/", 1)[-1] in REVIEW_DOC_NAMES
            and "/.mae-flow-work/" in normalized)


def _rebuild(state_path):
    from mae_flow_core.panel import page, snapshot
    from mae_flow_core.workflow import definition
    root = os.getcwd()
    with open(state_path, encoding="utf-8") as stream:
        state = json.load(stream)
    plugin_root = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", ".."))
    flow = definition.load_definition(
        os.path.join(plugin_root, "flow", "flow.json"))
    data = snapshot.build(root, state, flow)
    changes = snapshot.changes(
        root, state.get("implementation_base_head", ""))
    page.write_page(
        os.path.join(root, ".mae-flow-work", "panel.html"),
        data, changes, root)
    return True


def refresh_on_commit(state_path, command):
    """提交落地即重生成面板:第五个感知时机。

    实战反馈:领域归档提交后,面板仍把 docs/specs 显示在"未提交"——
    提交发生在步内,既不跨阶段也不是检视文档落盘,四个时机都不覆盖,
    用户看到的是提交前的旧快照。而"刚提交完"恰恰是最想复核的时刻之一。
    """
    text = str(command or "")
    if "git" not in text or "commit" not in text:
        return False
    try:
        return _rebuild(state_path)
    except Exception:                      # noqa: BLE001 —— 软失败铁律
        return False


def refresh_on_doc_write(state_path, written_path):
    """写的是检视文档才动手;返回是否真的重生成了面板。"""
    if not is_review_doc(written_path):
        return False
    try:
        done = _rebuild(state_path)
    except Exception:                      # noqa: BLE001 —— 软失败铁律
        return False
    try:
        ring_when_ready(state_path)
    except Exception:                      # noqa: BLE001 —— 通知失败=没通知
        pass
    try:
        note_scope_drift(state_path, written_path)
    except Exception:                      # noqa: BLE001 —— 提示失败绝不挡流程
        pass
    return done


def note_scope_drift(state_path, written_path):
    """规格刚落盘就比一次:哪些主题在规格里反复出现、需求原文里一次都没有。

    放在写盘这一刻而不是进步骤时:进 open 那会儿 spec.md 还不存在,读不到就
    只能静默——实测就是这么没打出来的。记成非阻断提示,current 与面板都会带出来,
    由人判断是"澄清阶段拍板的新增"还是"凭空发明"。
    """
    import time as _time
    from mae_flow_core.workflow.advisories import record_advisory
    from mae_flow_core.workflow.scope_drift import (
        drift_notice, invented_topics)
    if os.path.basename(str(written_path or "")) != "spec.md":
        return False
    with open(state_path, encoding="utf-8") as stream:
        state = json.load(stream)
    config = (state.get("config") or {})
    want = str(config.get("需求文档", "") or "")
    if not want:
        return False
    with open(want, encoding="utf-8", errors="replace") as stream:
        requirement = stream.read()
    with open(written_path, encoding="utf-8", errors="replace") as stream:
        drafted = stream.read()
    # 用户在澄清阶段亲口说过的词算合法新增,一并排除
    approved = ""
    try:
        with open(state_path + ".usermsg", encoding="utf-8") as stream:
            approved = " ".join(
                str(item.get("text", ""))
                for item in (json.load(stream).get("messages") or [])
                if isinstance(item, dict))
    except Exception:                      # noqa: BLE001 —— 取不到就只比需求
        approved = ""
    said = drift_notice(invented_topics(requirement, drafted,
                                        approved=approved))
    if not said:
        return False
    record_advisory(state_path, str(state.get("current", "")), "scope-drift",
                    said, _time.strftime("%Y-%m-%d %H:%M:%S"))
    return True


def ring_when_ready(state_path, root=None):
    """待检视的产物全都落盘了,才叫人过来。

    进入步骤就喊"请检视 Story"是错的:那一刻文档还没写。等齐(story 步
    要 story + 附录两份都在)再响,人过来就有东西看。
    """
    from mae_flow_core.panel import notify, snapshot
    from mae_flow_core.workflow import definition
    root = root or os.getcwd()
    with open(state_path, encoding="utf-8") as stream:
        state = json.load(stream)
    current = str(state.get("current", "") or "")
    kinds = snapshot.ACK_REVIEW_DOCS.get(current)
    if not kinds:
        return False
    ticket = str((state.get("config") or {}).get("单号", "") or "")
    folder = os.path.join(root, ".mae-flow-work", ticket)
    paths = [os.path.join(folder, kind + ".md") for kind in kinds]
    if not all(os.path.isfile(path) for path in paths):
        return False                       # 还没齐,再等等
    plugin_root = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", ".."))
    flow = definition.load_definition(
        os.path.join(plugin_root, "flow", "flow.json"))
    token = "%s@%s" % (current, max(os.path.getmtime(p) for p in paths))
    return bool(notify.announce_ready(flow, current, root, ticket, token))


# 整页重生成的节流窗口。实测(fieldtest,7 份文档 + 全量 diff)约 72ms:
# 快照 29ms + 变更 39ms + 渲染 3ms,比预估的"几百毫秒"便宜得多,
# 所以密集刷新负担得起。但内网 Java 大仓的 git diff 会慢得多,
# 因此窗口按上一次实测耗时自适应:花得越久,下次等得越久。
_MIN_PAGE_INTERVAL = 8.0
_MAX_PAGE_INTERVAL = 90.0
_COST_MULTIPLIER = 40          # 花 72ms → 约 8s 一次;花 1s → 40s 一次


def _page_path(root):
    return os.path.join(root, ".mae-flow-work", "panel.html")


def _due(root):
    """离上次整页重生成是否已过节流窗口(窗口由上次耗时自适应)。"""
    try:
        marker = os.path.join(root, ".mae-flow-work", ".panel-cost")
        cost = 0.072
        if os.path.isfile(marker):
            with open(marker, encoding="utf-8") as stream:
                cost = float(stream.read().strip() or cost)
        window = min(max(cost * _COST_MULTIPLIER, _MIN_PAGE_INTERVAL),
                     _MAX_PAGE_INTERVAL)
        return (time.time() - os.path.getmtime(_page_path(root))) >= window
    except OSError:
        return True
    except ValueError:
        return True


def _remember_cost(root, seconds):
    try:
        with open(os.path.join(root, ".mae-flow-work", ".panel-cost"),
                  "w", encoding="utf-8") as stream:
            stream.write("%.3f" % seconds)
    except OSError:
        pass


def on_tool_event(state_path, root, written_path="", command=""):
    """Hook 侧面板同步的唯一入口。

    三档:脉冲每次都写(几毫秒);检视文档落盘与提交落地立刻整页重生成
    (那是用户马上要看的);其余工具事件按自适应节流也重生成——
    实测 72ms 的代价换"面板始终是当前现场",值。
    """
    from mae_flow_core.panel import pulse
    pulse.write_pulse(state_path, root=root)
    if written_path and refresh_on_doc_write(state_path, written_path):
        return
    if command and refresh_on_commit(state_path, command):
        return
    if not _due(root):
        return
    started = time.time()
    try:
        _rebuild(state_path)
    except Exception:                      # noqa: BLE001 —— 软失败铁律
        return
    _remember_cost(root, time.time() - started)


def archive_panel(root, ticket):
    """把交付完成时的面板存进本单过程件目录,作为永久留痕。

    面板是自包含单文件:文档、双排 diff、证据、执行记录全在里面,
    多久之后打开都完整——它就是这一单最好的交付现场快照。
    而 panel.html 只有一份,下一单 init 一刷就没了,不留等于白丢。

    返回归档路径;没有面板或写不进去都静默返回空串(留痕失败绝不挡开单)。
    """
    try:
        if not ticket:
            return ""
        source = os.path.join(root, ".mae-flow-work", "panel.html")
        if not os.path.isfile(source):
            return ""
        folder = os.path.join(root, ".mae-flow-work", str(ticket))
        os.makedirs(folder, exist_ok=True)
        target = os.path.join(folder, "panel.html")
        with open(source, encoding="utf-8") as reader:
            body = reader.read()
        # 归档件不再自动重载:它是定格的历史,去掉探测逻辑免得它
        # 读到新一单的 stamp 就把自己刷成"过期"。
        body = body.replace("setInterval(probe, 5000);", "")
        body = body.replace("setInterval(pulse, 2000);", "")
        body = body.replace("<body data-born=",
                            "<body data-archived=\"1\" data-born=")
        with open(target, "w", encoding="utf-8") as writer:
            writer.write(body)
        return target
    except OSError:
        return ""


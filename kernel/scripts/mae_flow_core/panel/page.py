"""快照 → 自包含单文件 HTML。

页面是快照的**消费者**,不是第二个真相源:所有事实都来自 snapshot.build();
页面自己不读状态、不写状态、不提供任何"推进到下一步"的入口——那种按钮
是绕过证据的官方通道,看起来还完全合法。
"""

import io
import os

from . import (annotate, assets, banners, diffview, markdown,
               notes_drawer, notify, plantuml)
from .external_quality import display_external
from .markdown import escape

def _fence_hook(language, body):
    """md 里的 plantuml 块就地出图;出不了就显示源码并说清为什么。"""
    if language != "plantuml":
        return None
    drawn, kind = plantuml.render(body)
    source = ('<details class="pumls"><summary>PlantUML 源码</summary>'
              '<pre><code>%s</code></pre></details>' % escape(body))
    if drawn:
        return ('<figure class="pfig">%s<figcaption>%s · 内置轻渲染</figcaption>'
                '%s</figure>'
                % (drawn, plantuml.KIND_LABEL.get(kind, kind), source))
    why = "识别不出图类型" if not kind else "%s 解析失败" % kind
    return ('<figure class="pfig bad"><span class="fn">未出图：%s —— '
            '源码原样保留</span><pre class="praw"><code>%s</code></pre>'
            '</figure>' % (why, escape(body)))


def _document_panes(documents):
    rows, tabs, panes = [], [], []
    for doc in documents:
        key = "doc-" + doc["kind"]
        # 显示名只有一个来源(snapshot 的 DOC_KINDS):第二张标签表必漂移,
        # 而且上游术语(Grill/openspec)不进用户视野——封装原则。
        display_label = doc["label"]
        try:
            with io.open(doc["path"], encoding="utf-8", errors="replace") as fh:
                body = markdown.render(fh.read(), _fence_hook,
                                       line_marks=True)
        except OSError as exc:
            body = '<p>读取失败：%s</p>' % escape(str(exc))
        rows.append(
            '<div class="asset"><span class="asset-kind">%s</span>'
            '<button class="asset-open" onclick="show(\'%s\')" title="%s">'
            '<b>%s</b><span>%s · %s</span></button>'
            '<a class="asset-raw" href="file://%s" title="打开源文件">↗</a>'
            '</div>'
            % (escape(display_label), key, escape(doc["relative"]),
               escape(doc["relative"].rpartition("/")[2]),
               _size(doc["bytes"]), escape(doc["updated_at"]),
               escape(doc["path"])))
        tabs.append('<button data-group="doc" data-key="%s" '
                    'onclick="show(\'%s\')">%s</button>'
                    % (key, key, escape(display_label)))
        panes.append(
            '<div class="pane" data-group="doc" data-key="%s" '
            'data-title="%s" data-raw="file://%s" data-rel="%s">'
            '<div class="md">%s</div></div>'
            % (key, escape(display_label), escape(doc["path"]),
               escape(doc["relative"]), body))
    return rows, tabs, panes


def _size(count):
    return "%.1fk" % (count / 1024.0) if count >= 1024 else "%dB" % count


def _bar(added, removed):
    total = max(1, added + removed)
    green = 46.0 * added / total
    return ('<span class="bar"><i class="g" style="width:%.1fpx"></i>'
            '<i class="r" style="width:%.1fpx"></i></span>'
            % (green, 46.0 - green))


def _change_sections(groups, root):
    blocks, tabs, panes, index = [], [], [], 0
    for group in groups:
        added = sum(item["added"] for item in group["files"])
        removed = sum(item["removed"] for item in group["files"])
        blocks.append('<div class="gtitle"><b>%s</b><span>%s · %d 个文件 · '
                      '+%d / −%d</span></div><div class="chg list">'
                      % (escape(group["title"]), escape(group["note"]),
                         len(group["files"]), added, removed))
        for item in group["files"]:
            key = "chg-%d" % index
            index += 1
            folder, _, base = item["path"].rpartition("/")
            blocks.append(
                '<button class="f" onclick="show(\'%s\')">'
                '<span class="p"><i>%s</i>%s</span>'
                '<span class="n"><span class="a">+%d</span> '
                '<span class="d">−%d</span></span>%s'
                '<span class="go">diff ›</span></button>'
                % (key, escape(folder + "/" if folder else ""), escape(base),
                   item["added"], item["removed"],
                   _bar(item["added"], item["removed"])))
            tabs.append('<button data-group="diff" data-key="%s" '
                        'onclick="show(\'%s\')">%s</button>'
                        % (key, key, escape(base)))
            panes.append(
                '<div class="pane" data-group="diff" data-key="%s" '
                'data-title="%s" data-raw="file://%s" data-rel="%s（%s）">'
                '<div class="dwrap">%s</div></div>'
                % (key, escape(base),
                   escape(os.path.join(root, item["path"])),
                   escape(item["path"]), escape(group["title"]),
                   diffview.render(item["patch"]) if item["patch"]
                   else '<p>这份 patch 取不到（可能是二进制文件）。</p>'))
        blocks.append("</div>")
    return "".join(blocks), tabs, panes


def _pending_section(pending, doc_key_by_path, progress):
    """卡片内容必须与步骤对得上:确认 Story 的卡里就是 Story,点开即读。"""
    if not pending:
        current = progress.get("step_title") or progress.get("step") or "未知步骤"
        return ('<section class="current-action"><h2>现在需要你看什么</h2>'
                '<div class="action-card">'
                '<div class="quiet"><span class="dot"></span>'
                '<span class="quiet-label">正在执行</span>'
                '<strong class="quiet-step">%s</strong>'
                '<span class="quiet-note">当前无需你处理</span></div>'
                '</div></section>' % escape(current))
    cards = []
    for item in pending:
        body = ""
        if item["items"]:
            body += '<dl class="kv">%s</dl>' % "".join(
                "<dt>%s</dt><dd>%s</dd>"
                % (escape(entry["label"]), escape(entry["value"]))
                for entry in item["items"])
        if item["paths"]:
            links = []
            for path in item["paths"]:
                key = doc_key_by_path.get(path)
                name = escape(os.path.basename(path))
                if key:      # 面板里有渲染版,点开就地读
                    links.append('<li><button class="open" '
                                 'onclick="show(\'%s\')">%s</button></li>'
                                 % (key, name))
                else:
                    links.append('<li><a href="file://%s">%s</a></li>'
                                 % (escape(path), name))
            body += ('<div class="ask-sub">要检视的文件（点开就地阅读）：'
                     '</div><ul class="paths">%s</ul>' % "".join(links))
        expected = [name for name in item.get("expected", ())]
        if expected:
            body += ('<div class="ask-sub">生成中：%s —— 落盘后自动出现'
                     '在这里，切回本页即可看到。</div>'
                     % escape("、".join(expected)))
        # 不放命令占位符:用户从不敲 CLI,是模型在会话里问、用户在会话里答。
        # "面板不提供执行按钮"是设计自辩,写给维护者看的话不进用户视野。
        cards.append(
            '<div class="ask-title">%s</div>'
            '<div class="ask-sub">%s · 需要你逐项过目后确认</div>%s'
            '<div class="ask-sub">看完后回到会话窗口回复即可。</div>'
            % (escape(item["title"] or item["step"]), escape(item["step"]),
               body))
    return ('<section class="current-action has"><h2>现在需要你看什么</h2>'
            '<div class="action-card">%s</div></section>' % "".join(cards))


def _born_epoch():
    """页面出生时刻:自动重载与陈旧自检共用的基准。"""
    import time as _time
    return int(_time.time())


def _hm(stamp):
    """"2026-08-08 16:35:28" → "16:35"。整页都是今天前后的事,日期是噪声。"""
    return stamp[11:16] if len(stamp) >= 16 else stamp


def _history_result(result):
    """状态内部码只用于恢复;面板用短中文说明人能观察到的含义。"""
    value = str(result or "")
    if value == "done":
        return "已完成"
    for prefix, label in (
            ("choice:", "已选择"), ("goto:", "已回退"),
            ("accept-risk:", "风险已确认"), ("resumed:", "已恢复"),
            ("source-recheck:", "已重新检查"), ("unlock:", "已解锁")):
        if value.startswith(prefix):
            return label
    return "已记录"


def _history_section(progress):
    """最近执行记录:只展示快照投影,不从页面反读状态。"""
    rows = []
    for item in progress.get("history", [])[-7:]:
        title = item.get("title") or item.get("step") or "未知步骤"
        result = _history_result(item.get("result"))
        rows.append(
            '<div class="history-row"><time>%s</time><span class="history-step">'
            '%s</span><span class="history-result">%s</span></div>'
            % (escape(_hm(item.get("at", "")) or "—"), escape(title),
               escape(result)))
    return ('<section class="panel-section history"><div class="section-head">'
            '<h2>执行记录</h2><span>最近 %d 条</span></div>'
            '<div class="history-table">%s</div></section>'
            % (len(rows), "".join(rows)))


def _summary(snapshot, changes):
    """首屏现场摘要:只计算传入快照和精确变更组里的事实。"""
    files = [item for group in changes for item in group.get("files", [])]
    added = sum(item.get("added", 0) for item in files)
    removed = sum(item.get("removed", 0) for item in files)
    # 同一文件常同时出现在"已提交"与"未提交"两组——文件数必须去重,
    # 否则首屏第一个数字就在撒谎(实测 11 vs 真实 8)。
    distinct = len({item.get("path", "") for item in files})
    cells = (
        ("当前分支", snapshot["repo"].get("branch") or "—", "mono"),
        ("代码增量", "%d 个文件 · +%d / −%d" %
         (distinct, added, removed), ""),
        ("提交位置", snapshot["repo"].get("head") or "—", "mono"),
        ("状态修订", "rev %s" % (snapshot.get("state_revision") or 0), "mono"),
    )
    return '<div class="summary-grid">%s</div>' % "".join(
        '<div class="summary-item"><span>%s</span><b class="%s">%s</b></div>'
        % (escape(label), cls, escape(str(value)))
        for label, value, cls in cells)


def _asset_chain(documents):
    """说明过程产物的消费关系;存在性仍以实际资产卡片为准。"""
    empty = "" if documents else '<span class="chain-empty">本单尚无过程产物</span>'
    # 链条节点名与资产卡片的显示名一字不差(都来自 snapshot 的 DOC_KINDS);
    # 上游术语(Grill)不进用户视野——用户话术封装原则。
    return ('<div class="asset-chain"><b>需求澄清 / 决策</b><i>→</i>'
            '<b>规格条目</b><i>→</i><b>Story</b><i>→</i>'
            '<b>实现记录 / 代码</b>%s</div>' % empty)


def _evidence_rows(evidence, steps_done):
    """质量检查:只列需要注意的。

    过了的关不值得占一行——全部压成一行小字;出问题的、在跑的才有自己的行,
    并且用人话说清"发生了什么、缺了什么"。
    """
    fine, rows, degraded = [], [], False

    def row(name, tag, cls, why):
        rows.append('<div class="row"><span class="name">%s</span>'
                    '<span><i class="tag %s">%s</i></span>'
                    '<span class="why">%s</span></div>'
                    % (escape(name), cls, escape(tag), escape(why)))

    # 唯一的绿灯判据:该检查所属的步骤已经走完(工具门禁放行过)。
    # 有任务卡/尝试记录只说明"派发过",不说明"通过"——误绿比不显示更坏。
    def gate(item, name, running_why):
        if item.get("step", "") in steps_done:
            fine.append(name)
        else:
            row(name, "进行中", "t-run", running_why)

    passed, attention = display_external(evidence)
    fine.extend(passed)
    for item in attention:
        row(*item)

    compile_ev = evidence.get("compile")
    if compile_ev:
        gate(compile_ev, "编译",
             "%s 派发 · 覆盖 %d 个文件" % (_hm(compile_ev["at"]),
                                           compile_ev["files"]))
    reviewer = evidence.get("reviewer")
    if reviewer:
        gate(reviewer, "Agent 预检", "检视中 · 派发于 " + _hm(reviewer["at"]))
    ponytail = evidence.get("ponytail")
    if ponytail:
        gate(ponytail, "代码精简", "第 %s 轮进行中" % ponytail["rounds"])
    check = evidence.get("codecheck")
    if check:
        degraded = check["degraded"]
        if degraded:
            row("CodeCheck", "没跑成", "t-deg",
                "工具装不上，%d 个文件一次都没扫过 · %s"
                % (check["files"], _hm(check["at"])))
        elif isinstance(check["count"], int) and check["count"] > 0:
            row("CodeCheck", "%d 项待修" % check["count"], "t-bad",
                "扫了 %d 个文件 · %s" % (check["files"], _hm(check["at"])))
        elif check["status"] == "CLEAN":     # 明确成功只有这一种
            fine.append("CodeCheck")
        else:
            row("CodeCheck", "没确认过", "t-deg",
                "记录状态 %s、告警数 %s——不当作通过 · %s"
                % (check["status"] or "空", check["count"], _hm(check["at"])))
    unit = evidence.get("ut")
    if unit:
        if unit["complete"]:
            fine.append("UT 编写")
        else:
            total = max(unit["batches"], 1)
            row("UT 编写", "进行中", "t-run",
                "正在生成用例 · 第 %d/%d 批"
                % (min(unit["completed_batches"] + 1, total), total))
    if fine:
        rows.append('<div class="fineline"><span class="dot"></span>'
                    '已过关：%s</div>' % escape(" · ".join(fine)))
    note = ('<div class="deg-note"><b>「没跑成」不是通过。</b>'
            'CodeCheck 工具未就绪，这些文件至今没有被静态检查扫过——'
            '工具恢复前，这一格不能当绿灯。</div>') if degraded else ""
    return "".join(rows), note


def _phase_rail(step):
    """页眉的阶段轨道:离散事实,不是百分比。

    阶段来自 notify.PHASES(step→阶段的唯一来源)。过去的段灰、当前段高亮、
    未来段虚——它回答"你在哪",不宣称"完成了多少"。百分比条被契约禁止:
    有分支有回退的图上,百分比必然是编的。
    """
    order = list(notify.PHASES)
    current = notify.phase_of(step)
    if current not in order:
        return ""
    index = order.index(current)
    cells = []
    for slot, name in enumerate(order):
        cls = "past" if slot < index else (
            "current" if slot == index else "future")
        cells.append('<span class="phase-node %s">%s</span>'
                     % (cls, escape(name)))
    return '<div class="phase-track">%s</div>' % "".join(cells)


def _progress_section(progress):
    """一行字,不是一面墙——那串步骤药丸是全页最大的杂乱源,退役。"""
    total = progress["steps_total_estimate"]
    current = escape(progress["step"])
    if progress["step_title"]:
        current += " · " + escape(progress["step_title"])
    return ('<section class="panel-section prog"><div class="section-head">'
            '<h2>流程细节</h2><span>只陈述事实</span></div><div class="line">'
            '<span>第 <b>%d</b> 步%s</span>'
            '<span>当前 <span class="cur">%s</span></span>'
            '<span>起始 <b>%s</b></span>'
            '<span>回退 <b>%d</b> 次</span></div></section>'
            % (len(progress["steps_done"]) + 1,
               (" / 约 <b>%d</b> 步" % total) if total else "",
               current,
               escape(progress["started_at"]),
               progress["revisits"]["goto"]))


def render(snapshot, changes=(), root=".", born=None):
    """快照(+变更组) → 完整 HTML 文本。"""
    changes = tuple(changes)  # 既给摘要统计,也给 diff 渲染;生成器不能只消费一次
    doc_rows, doc_tabs, doc_panes = _document_panes(
        snapshot["artifacts"]["documents"])
    change_html, change_tabs, change_panes = _change_sections(changes, root)
    evidence_rows, degraded_note = _evidence_rows(
        snapshot["evidence"], set(snapshot["progress"]["steps_done"]))
    advisories = snapshot["advisories"]
    doc_key_by_path = {doc["path"]: "doc-" + doc["kind"]
                       for doc in snapshot["artifacts"]["documents"]}
    context = {
        "css": assets.CSS + plantuml.SVG_CSS + annotate.CSS + notes_drawer.CSS,
        "js": assets.JS + annotate.JS + notes_drawer.JS,
        "rail": _phase_rail(snapshot["progress"]["step"]),
        "born": born or _born_epoch(),
        "pulse": escape(pulse_marker(snapshot)),
        "ticket": escape(snapshot["delivery"]["ticket"] or "（无在途单）"),
        "branch": escape(snapshot["repo"]["branch"]),
        "baseline": escape(snapshot["repo"]["baseline"]),
        "head": escape(snapshot["repo"]["head"]),
        "stamp": escape(snapshot["generated_at"]),
        "revision": snapshot["state_revision"] or 0,
        "summary": _summary(snapshot, changes),
        "pending": (banners.standalone_section(snapshot.get("standalone"))
                    or _pending_section(snapshot["pending"], doc_key_by_path,
                                        snapshot["progress"])),
        "asset_chain": _asset_chain(snapshot["artifacts"]["documents"]),
        "docs": "".join(doc_rows) or
                '<div class="asset empty"><span class="asset-kind">—</span>'
                '<span>本单尚无过程产物</span></div>',
        "commits": "".join(
            '<div class="commit"><code>%s</code><span>%s</span>'
            '<span class="t">%s</span></div>'
            % (escape(item["sha"]), escape(item["subject"]),
               escape(item["at"]))
            for item in snapshot["artifacts"]["commits"]) or "<div>（无提交）</div>",
        "changes": change_html or "<div>（本单暂无代码变更）</div>",
        "logs": "".join('<li><a href="file://%s">%s</a></li>'
                        % (escape(path), escape(name))
                        for name, path in
                        sorted(snapshot["artifacts"]["logs"].items())),
        "evidence": evidence_rows or "<div class=\"row\"><span>（暂无证据）</span></div>",
        "degraded": degraded_note,
        "advisories": "".join(
            "<li><code>%s</code> %s</li>"
            % (escape(item.get("kind", "")), escape(item.get("message", "")))
            for item in advisories) or
            '<li class="quiet"><span class="dot"></span>本轮无待处理建议。</li>',
        "progress": _progress_section(snapshot["progress"]),
        "history": _history_section(snapshot["progress"]),
        "warnings": "".join("<li>%s</li>" % escape(text)
                            for text in snapshot["warnings"]),
        "tabs": "".join(doc_tabs + change_tabs),
        "panes": "".join(doc_panes + change_panes),
    }
    return TEMPLATE % context


def write_page(target, snapshot, changes=(), root="."):
    """写面板,并在同目录留一个 stamp 文件供页面自动发现更新。

    file:// 页面不能 fetch 自己所在目录的文件(浏览器拦),但可以用
    <script src> 加载同目录脚本——于是页面每几秒探一次 stamp,
    发现比自己新就自动重载。手动"重读"按钮因此退役:它只在
    "文件刚被重生成、而你恰好没切走"这一种情况下有用,其余时候
    点了没反应,反而制造"我刷新过了"的错觉。
    """
    born = _born_epoch()
    html = render(snapshot, changes, root, born=born)
    folder = os.path.dirname(target)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    with io.open(target, "w", encoding="utf-8") as stream:
        stream.write(html)
    stamp = os.path.join(folder or ".", "panel-stamp.js")
    with io.open(stamp, "w", encoding="utf-8") as stream:
        stream.write("window.__panelStamp=%d;\n" % born)
    return len(html.encode("utf-8"))


def pulse_marker(snapshot):
    """页面自带的脉冲基准:与心跳文件比对,不同即说明现场已经变了。"""
    progress = snapshot.get("progress") or {}
    return "%s|%s" % (progress.get("step", ""),
                      snapshot.get("state_revision") or 0)


TEMPLATE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mae-Flow 交付工作台 · %(ticket)s</title>
<style>%(css)s</style></head><body data-born="%(born)s" data-pulse="%(pulse)s"
 data-ticket="%(ticket)s">
<div id="live" hidden></div><div id="stale" hidden></div><div class="workbench">
<header><div class="header-top"><div><span class="eyebrow">MAE FLOW / %(ticket)s</span>
<h1>交付工作台</h1></div><div class="header-state"><span id="age"></span>%(stamp)s · rev %(revision)s</div>
</div><div class="hd-meta"><span>分支 %(branch)s</span><span>基线 %(baseline)s</span>
<span>HEAD %(head)s</span></div>%(rail)s</header>
%(summary)s
%(pending)s
<section class="asset-section"><div class="section-head asset-head">
<h2>需求与设计资产</h2><span>本次实现的依据 · 点开就地阅读</span></div>
<div class="asset-grid">%(docs)s</div>%(asset_chain)s</section>
<div class="workspace"><main>
%(history)s
<section class="panel-section changes"><div class="section-head">
<h2>代码变更</h2><span>点文件查看完整双排 diff</span></div>
<div class="commit-list">%(commits)s</div>%(changes)s</section>
</main><aside>
<section class="panel-section"><div class="section-head">
<h2>质量事实</h2><span>未知不算通过</span></div>
<div class="list">%(evidence)s</div>%(degraded)s</section>
<section class="panel-section"><div class="section-head">
<h2>本轮建议</h2><span>非阻断</span></div>
<ul class="adv">%(advisories)s</ul></section>
%(progress)s
</aside></div>
<div class="low-frequency"><details class="note"><summary>日志与任务卡</summary>
<ul class="paths">%(logs)s</ul></details>
<details class="note"><summary>出口自述（快照自己的降级说明）</summary>
<ul>%(warnings)s<li>百分比故意留空：flow 有分支和回退，算出来必然是编的。</li>
<li>图形为内置轻渲染，与公司评审工具的 PlantUML 输出可能有差异。</li></ul></details></div>
<footer>只读快照 · 由 <code>mae-flow.py panel</code> 生成 ·
数据源 <code>panel --json</code>；本页不含任何写入入口。</footer>
</div>
<div id="viewer"><div class="vbox"><div class="vbar">
<span class="vt" id="vtitle">文档</span><span class="vp" id="vpath"></span>
<span class="sp"><a id="vraw" href="#">源文件 ↗</a>
<button onclick="hide()">关闭 Esc</button></span></div>
<div class="vtabs">%(tabs)s</div>%(panes)s</div></div>
<div id="notes-drawer"><header><b id="notes-title">检视批注</b>
<button id="notes-copy" class="primary">复制给 Agent</button>
<button id="notes-close">收起</button></header>
<div id="notes-list"></div></div>
<button id="notes-badge">检视批注<span>0</span></button>
<div id="notes-toast"></div>
<script>%(js)s</script></body></html>
"""

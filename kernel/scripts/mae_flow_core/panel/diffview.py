"""统一 diff → 左右双排对照 HTML。

双排的理由:改写型变更(把 A 换成 B)在单排里是两条相隔很远的红绿行,
左右并排才能一眼看出"换了什么"。删除与新增按出现顺序在同一行配对,
多出来的一侧留空——于是"纯新增"和"改写"在版面上天然可分。

截断必须报数:显示不全却看着像全部,是最坏的一种"通过"。
"""

import re

from .markdown import escape

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
NOISE = ("index ", "--- ", "+++ ", "new file mode", "deleted file mode",
         "similarity index", "rename from", "rename to", "old mode",
         "new mode")
MAX_LINES = 700
# 折叠参数:改动两侧各留 VISIBLE_CTX 行,更长的未改动段折叠成"展开"行;
# 超过 GAP_EMBED_CAP 的段不内嵌(明说"看源文件"),否则大文件会把页面撑爆。
VISIBLE_CTX = 3
GAP_EMBED_CAP = 300


def _cell(number, body, kind):
    if kind == "nil":
        return '<span class="ln"></span><code class="c nil"></code>'
    return ('<span class="ln">%s</span><code class="c %s">%s</code>'
            % (number, kind, escape(body)))


def _hunk_row(match):
    tail = (match.group(5) or "").strip()
    return ('<div class="dr hk"><code class="c span">@@ %s</code></div>'
            % escape("-%s,%s +%s,%s%s" % (
                match.group(1), match.group(2) or "1",
                match.group(3), match.group(4) or "1",
                ("  " + tail) if tail else "")))


class _Renderer(object):
    """攒着三种行(删除/新增/未改动),在边界处配对与折叠落地。

    patch 用全量上下文生成(-U999999),整个文件都在里面;默认只显示改动
    两侧各 VISIBLE_CTX 行,中间的长段折叠成"展开 N 行"——内容已埋在页面里,
    点开只是翻个 hidden,file:// 页面没有运行时读文件的能力。
    """

    def __init__(self):
        self.rows, self.shown, self.cut = [], 0, 0
        self.removed, self.added, self.context = [], [], []
        self.any_content = False

    def _visible(self, html):
        if self.shown >= MAX_LINES:
            self.cut += 1
            return
        self.rows.append(html)
        self.shown += 1
        self.any_content = True

    def flush_changes(self):
        for index in range(max(len(self.removed), len(self.added))):
            left = self.removed[index] if index < len(self.removed) else None
            right = self.added[index] if index < len(self.added) else None
            self._visible(
                '<div class="dr">%s%s</div>'
                % (_cell(left[0], left[1], "del") if left
                   else _cell("", "", "nil"),
                   _cell(right[0], right[1], "add") if right
                   else _cell("", "", "nil")))
        del self.removed[:]
        del self.added[:]

    def flush_context(self, at_end=False):
        run, self.context = self.context, []
        if not run:
            return
        head = VISIBLE_CTX if self.any_content else 0
        tail = 0 if at_end else VISIBLE_CTX
        if len(run) <= head + tail + 3:      # 折叠三五行不值得一个按钮
            for old, new, body in run:
                self._visible(_ctx_row(old, new, body))
            return
        for old, new, body in run[:head]:
            self._visible(_ctx_row(old, new, body))
        middle = run[head:len(run) - tail] if tail else run[head:]
        if len(middle) > GAP_EMBED_CAP:
            self.rows.append(
                '<div class="dr cut"><code class="c span">⋯ %d 行未改动'
                '（过长未内嵌，完整内容看源文件）</code></div>' % len(middle))
        else:
            self.rows.append(
                '<div class="dr exp" onclick="dx(this)">'
                '<code class="c span">⋯ 展开 %d 行未改动</code></div>'
                % len(middle))
            self.rows.append('<div hidden>%s</div>' % "".join(
                _ctx_row(old, new, body) for old, new, body in middle))
        for old, new, body in (run[-tail:] if tail else ()):
            self._visible(_ctx_row(old, new, body))


def _ctx_row(old, new, body):
    return ('<div class="dr">%s%s</div>'
            % (_cell(old, body, "ctx"), _cell(new, body, "ctx")))


def render(patch):
    """一份文件的 patch → 双排 HTML(未改动长段默认折叠,点开就地展开)。"""
    state, old, new = _Renderer(), 0, 0
    lines = (patch or "").split("\n")
    if lines and lines[-1] == "":
        del lines[-1]          # patch 末尾换行不是一行上下文,别凭空多一行空白
    for body in lines:
        if body.startswith(NOISE) or body.startswith("\\"):
            continue
        hunk = HUNK_RE.match(body)
        if hunk:
            state.flush_changes()
            state.flush_context()
            state.rows.append(_hunk_row(hunk))
            old, new = int(hunk.group(1)), int(hunk.group(3))
        elif body.startswith("+"):
            state.flush_context()
            state.added.append((new, body))
            new += 1
        elif body.startswith("-"):
            state.flush_context()
            state.removed.append((old, body))
            old += 1
        else:
            state.flush_changes()
            state.context.append((old, new, body))
            old += 1
            new += 1
    state.flush_changes()
    state.flush_context(at_end=True)
    if state.cut:
        state.rows.append(
            '<div class="dr cut"><code class="c span">… 还有 %d 行未显示'
            '（面板上限 %d 行，完整内容看源文件）</code></div>'
            % (state.cut, MAX_LINES))
    return ('<div class="diff"><div class="dhead"><span>变更前</span>'
            '<span>变更后</span></div>%s</div>' % "".join(state.rows))


def split_patch(text):
    """整份 patch → {路径: 该文件的 patch}。"""
    files, path, buffer = {}, None, []
    for body in (text or "").splitlines():
        if body.startswith("diff --git "):
            if path:
                files[path] = "\n".join(buffer)
            match = re.search(r" b/(.+)$", body)
            path, buffer = (match.group(1) if match else body), []
            continue
        if path is not None:
            buffer.append(body)
    if path:
        files[path] = "\n".join(buffer)
    return files


def numstat(text):
    """`git diff --numstat` → {路径: (新增, 删除)};二进制文件记 0。"""
    stats = {}
    for body in (text or "").splitlines():
        columns = body.split("\t")
        if len(columns) == 3:
            added = 0 if columns[0] == "-" else int(columns[0])
            removed = 0 if columns[1] == "-" else int(columns[1])
            stats[columns[2]] = (added, removed)
    return stats

"""markdown 子集 → HTML。

不是通用 markdown 渲染器,只渲染**我们自己的模板**用得到的语法——模板的
语法面由我们钉死(STORY/SPEC/DECISIONS 等),所以这个子集是可枚举的,
也就不必往仓里塞第三方 JS:

    标题 · 有序/无序列表(含嵌套) · 表格 · 围栏代码块 · 粗体 · 行内代码
    · 链接 · 分隔线 · 段落

超出子集的写法退化成段落原文,绝不吞内容。plantuml 围栏交给调用方处理
(见 panel.plantuml),因为它要出图而不是出代码块。
"""

import re

LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
HR_RE = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")
HEAD_RE = re.compile(r"^(#{1,6})\s+(.*)$")
BREAK_RE = re.compile(r"^(#{1,6}\s|```|\s*\||\s*([-*+]|\d+[.)])\s)")
SEP_CELL_RE = re.compile(r"^:?-{2,}:?$")


def escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def inline(text):
    """行内标记;先转义再替换,顺序不能反,否则会把用户内容当标签。"""
    out = escape(text)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', out)
    return out


def _table(block):
    rows = [[cell.strip() for cell in line.strip().strip("|").split("|")]
            for line in block]
    head, start = rows[0], 1
    if len(rows) > 1 and all(
            SEP_CELL_RE.match(cell.replace(" ", ""))
            for cell in rows[1] if cell):
        start = 2
    parts = ['<div class="tbl"><table><thead><tr>']
    parts += ["<th>%s</th>" % inline(cell) for cell in head]
    parts.append("</tr></thead><tbody>")
    for row in rows[start:]:
        parts.append("<tr>%s</tr>" % "".join(
            "<td>%s</td>" % inline(cell) for cell in row))
    parts.append("</tbody></table></div>")
    return "".join(parts)


def _kind(marker):
    return "ol" if marker[0].isdigit() else "ul"


def _emit_items(items, index, indent, out, marks=False):
    """渲染同一层级的列表项;子列表写在父 li 内部(合法嵌套,不是浏览器容错)。"""
    kind = _kind(items[index][1])
    out.append("<%s>" % kind)
    while index < len(items) and items[index][0] >= indent:
        if items[index][0] > indent or _kind(items[index][1]) != kind:
            index = _emit_items(items, index, items[index][0], out, marks)
            continue
        # 逐条打行号:检视意见常常只针对某一条,整段列表当一个靶子太粗。
        out.append("<li%s>%s"
                   % (_attr(items[index][3], marks), inline(items[index][2])))
        index += 1
        if index < len(items) and items[index][0] > indent:
            index = _emit_items(items, index, items[index][0], out, marks)
        out.append("</li>")
    out.append("</%s>" % kind)
    return index


def _list(items, marks=False):
    out = []
    _emit_items(items, 0, items[0][0], out, marks)
    return "".join(out)


def _attr(line, marks):
    return (' data-l="%d"' % line) if marks else ""


def _stamp(html, line, marks):
    """把源文件行号打在块级元素上——批注要能说出"story.md 第 42 行"。

    只在开标签里插一个 data-l;不开 marks 时输出与从前逐字节相同。
    """
    if not marks or not html.startswith("<"):
        return html
    cut = html.find(">")
    if cut < 0:
        return html
    return html[:cut] + _attr(line, True) + html[cut:]


def _collect_list(lines, index):
    """吃掉一整段列表;续行并入上一项,不另起段落。"""
    items = []
    while index < len(lines):
        match = LIST_RE.match(lines[index])
        if match:
            items.append((len(match.group(1)), match.group(2),
                          match.group(3), index + 1))
            index += 1
        elif lines[index].strip() and lines[index][:1] in (" ", "\t"):
            last = items[-1]
            items[-1] = (last[0], last[1],
                         last[2] + " " + lines[index].strip(), last[3])
            index += 1
        else:
            break
    return items, index


def _collect_fence(lines, index):
    language = lines[index][3:].strip()
    index += 1
    buffer = []
    while index < len(lines) and not lines[index].startswith("```"):
        buffer.append(lines[index])
        index += 1
    return language, "\n".join(buffer), index + 1


def _fence_html(language, body):
    label = ('<span class="fl">%s</span>' % escape(language)) if language else ""
    return ('<div class="fence">%s<pre><code>%s</code></pre></div>'
            % (label, escape(body)))


def render(text, fence_hook=None, line_marks=False):
    """markdown → HTML。

    fence_hook(language, body) 可接管围栏块(面板用它把 plantuml 变成图);
    返回 None 表示不接管,按普通代码块渲染。

    line_marks=True 时每个块级元素带上源文件行号(data-l),面板据此把
    "这段写得不对"落成 `story.md:42`。默认关闭,输出与从前完全一致。
    """
    lines = (text or "").replace("\r\n", "\n").split("\n")
    out, index = [], 0
    while index < len(lines):
        line = lines[index]
        start = index + 1                  # 源文件行号,1 起
        if line.startswith("```"):
            language, body, index = _collect_fence(lines, index)
            taken = fence_hook(language, body) if fence_hook else None
            out.append(_stamp(taken if taken is not None
                              else _fence_html(language, body),
                              start, line_marks))
            continue
        head = HEAD_RE.match(line)
        if head:
            level = len(head.group(1))
            out.append("<h%d%s>%s</h%d>"
                       % (level, _attr(start, line_marks),
                          inline(head.group(2).strip()), level))
            index += 1
            continue
        if line.lstrip().startswith("|"):
            block = []
            while index < len(lines) and lines[index].lstrip().startswith("|"):
                block.append(lines[index].strip())
                index += 1
            out.append(_stamp(_table(block), start, line_marks))
            continue
        if HR_RE.match(line):
            out.append(_stamp("<hr>", start, line_marks))
            index += 1
            continue
        if LIST_RE.match(line):
            items, index = _collect_list(lines, index)
            out.append(_list(items, line_marks))
            continue
        if not line.strip():
            index += 1
            continue
        buffer = []
        while (index < len(lines) and lines[index].strip()
               and not BREAK_RE.match(lines[index])
               and not HR_RE.match(lines[index])):
            buffer.append(lines[index].strip())
            index += 1
        out.append("<p%s>%s</p>"
                   % (_attr(start, line_marks), inline(" ".join(buffer))))
    return "\n".join(out)

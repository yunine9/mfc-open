"""PlantUML 子集 → 内联 SVG:识别、基元与入口。

为什么自己画:内网没有 plantuml 时,面板也得让人看见图。图形一律带渲染
来源标注,用户永远知道这张图是谁画的;真 plantuml 可用时应优先用它,
本渲染器只是保底。

覆盖 Story 4+1 视图实际会用到的三类(时序/活动/组件类图),识别不了的块
交回调用方按源码显示——**绝不猜**:画错的图比不画更坏。
"""

import re

FS = 12.5
FS_S = 11.0

SEQ_MSG = re.compile(
    r"^(?P<a>[\w一-鿿\"]+)\s*"
    r"(?P<arrow><-{1,2}|-{1,2}>>?|<->|-{1,2}\|>)\s*"
    r"(?P<b>[\w一-鿿\"]+)\s*(?::\s*(?P<text>.*))?$")
GRAPH_EDGE = re.compile(
    r"^(?P<a>\[?[\w一-鿿\.\"/]+\]?)\s*"
    r"(?P<arrow>[-.]{1,2}(?:up|down|left|right)?[-.]{0,2}(?:\|>|>|\*|o)?|"
    r"<\|[-.]{1,2}|\*[-.]{1,2}|o[-.]{1,2})\s*"
    r"(?P<b>\[?[\w一-鿿\.\"/]+\]?)\s*(?::\s*(?P<text>.*))?$")
SEQ_DECL_RE = re.compile(
    r"^(participant|actor|boundary|control|entity)\s", re.I)
GRAPH_DECL_RE = re.compile(
    r"^(class|component|interface|node|rectangle|package|folder|database|"
    r"abstract|enum)\s", re.I)
ACT_STRONG = re.compile(r"^(start|stop|:.*;|if\s*\(|while\s*\()", re.I)
_SKIP = re.compile(
    r"^(skinparam|hide\b|show\b|autonumber|scale\b|!|@start|@end|'|/')", re.I)

KIND_LABEL = {"sequence": "时序图", "activity": "活动图", "graph": "组件/类图"}


def escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def text_width(text, size=FS):
    """像素宽估算:CJK 按全宽,拉丁约 0.55 宽。布局全靠它,宁可估大不估小。"""
    width = 0.0
    for char in text:
        width += size * (1.0 if ord(char) > 0x2E80 else 0.55)
    return width


def clean(lines):
    """去掉注释与皮肤指令,顺带取出 title。"""
    out, title = [], ""
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.lower().startswith("title "):
            title = line[6:].strip()
            continue
        if _SKIP.match(line):
            continue
        out.append(line)
    return out, title


def detect(lines):
    """按"最不含糊的信号优先"判型。

    alt/else/end 三类图都有,不能用来判型——早期版本正是栽在这里,把带
    alt 的时序图判成了活动图。
    """
    body, _title = clean(lines)
    if not body:
        return ""
    if any(SEQ_DECL_RE.match(line) for line in body):
        return "sequence"
    if any(GRAPH_DECL_RE.match(line) for line in body):
        return "graph"
    if sum(1 for line in body if ACT_STRONG.match(line)) >= 2:
        return "activity"
    if any(SEQ_MSG.match(line) and ":" in line for line in body):
        return "sequence"
    if any(GRAPH_EDGE.match(line) for line in body):
        return "graph"
    return ""


def unquote(name):
    """顺带把参与者名里的字面 \n 折成空格——它是 plantuml 的换行记号,
    照抄进 SVG 会变成两个可见字符(实战里 handler\n(sms/email/push) 就这么露的)。"""
    return name.strip().strip('"').replace("\\n", " ")


# ─────────────────────────── SVG 基元 ───────────────────────────

_DEFS = ('<defs>'
         '<marker id="ah" markerWidth="9" markerHeight="7" refX="8.5" '
         'refY="3.5" orient="auto"><path d="M0,0 L9,3.5 L0,7 z" class="pf"/>'
         '</marker>'
         '<marker id="ao" markerWidth="11" markerHeight="9" refX="10" '
         'refY="4.5" orient="auto"><path d="M0.5,0.5 L10,4.5 L0.5,8.5" '
         'class="ps"/></marker>'
         '<marker id="ai" markerWidth="13" markerHeight="11" refX="12" '
         'refY="5.5" orient="auto"><path d="M0.5,0.5 L12,5.5 L0.5,10.5 z" '
         'class="pw"/></marker>'
         '</defs>')


def svg(width, height, parts, title=""):
    head = ('<svg class="puml" viewBox="0 0 %d %d" width="%d" '
            'preserveAspectRatio="xMinYMin meet" '
            'xmlns="http://www.w3.org/2000/svg">' % (width, height, width))
    caption = ('<text x="12" y="20" class="pt-title">%s</text>'
               % escape(title)) if title else ""
    return head + _DEFS + caption + "".join(parts) + "</svg>"


def text(x, y, content, cls="pt", anchor="start", size=None):
    style = ' font-size="%.1f"' % size if size else ""
    return ('<text x="%.1f" y="%.1f" class="%s" text-anchor="%s"%s>%s</text>'
            % (x, y, cls, anchor, style, escape(content)))


def rect(x, y, width, height, cls="pb", radius=3):
    return ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%d" '
            'class="%s"/>' % (x, y, width, height, radius, cls))


def line(x1, y1, x2, y2, cls="ps", marker="ah", dash=False):
    extra = ' stroke-dasharray="5,4"' if dash else ""
    end = ' marker-end="url(#%s)"' % marker if marker else ""
    return ('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" class="%s"%s%s/>'
            % (x1, y1, x2, y2, cls, extra, end))


def render(source):
    """成功返回 (svg, kind);渲染不了返回 (None, kind)。渲染器自己出错不冒泡。"""
    from . import plantuml_flow, plantuml_sequence
    lines = (source or "").replace("\r\n", "\n").split("\n")
    kind = detect(lines)
    painters = {
        "sequence": plantuml_sequence.render,
        "activity": plantuml_flow.render_activity,
        "graph": plantuml_flow.render_graph,
    }
    painter = painters.get(kind)
    if painter is None:
        return None, kind
    try:
        drawn = painter(lines)
    except Exception:      # noqa: BLE001 —— 出图失败退回源码,不能变成卡点
        return None, kind
    return (drawn or None), kind


# 颜色全部走面板的 CSS 变量,所以图跟着深浅色主题一起变。
SVG_CSS = r"""
.puml{max-width:100%;height:auto;display:block;margin:2px 0}
.puml .pb{fill:var(--card);stroke:var(--ink);stroke-width:1.1}
.puml .pa{fill:var(--code-bg);stroke:var(--dim);stroke-width:1.1}
.puml .pd{fill:var(--card);stroke:var(--dim);stroke-width:1.1}
.puml .pn{fill:var(--warn-bg);stroke:var(--warn);stroke-width:.9}
.puml .pfr{fill:none;stroke:var(--line);stroke-width:1.1}
.puml .ptab{fill:var(--bg);stroke:var(--line);stroke-width:1}
.puml .pl{stroke:var(--faint);stroke-width:1;stroke-dasharray:4,4;fill:none}
.puml .ps{stroke:var(--ink);stroke-width:1.15;fill:none}
.puml .pf{fill:var(--ink);stroke:none}
.puml .pw{fill:none;stroke:var(--ink);stroke-width:1.4}
.puml text{fill:var(--ink);font-family:-apple-system,"PingFang SC",sans-serif;
  font-size:12.5px}
.puml .pt-m,.puml .pt-n{fill:var(--dim)}
.puml .pt-k{fill:var(--faint);font-weight:600}
.puml .pt-title{fill:var(--ink);font-weight:650;font-size:13.5px}
"""

"""时序图渲染:参与者、消息、自调用、note、alt/else/loop/opt 帧。"""

import re

from .plantuml import (
    FS, FS_S, SEQ_MSG, clean, line, rect, svg, text, text_width, unquote)

DECL = re.compile(r"^(participant|actor|boundary|control|entity|database)\s+"
                  r"(?P<name>\"[^\"]+\"|\S+)(\s+as\s+(?P<alias>\S+))?", re.I)
NOTE = re.compile(r"^note\s+(?P<pos>left|right|over)\s*(of\s+)?"
                  r"(?P<who>[^:]*)?:\s*(?P<text>.*)$", re.I)
GROUP = re.compile(r"^(?P<kind>alt|else|loop|opt|group|par)\s*(?P<label>.*)$",
                   re.I)

HEAD_H = 30
ROW_H = 34
SELF_H = 42


def _parse(body):
    """→ (参与者顺序, 行序列)。行是 (类型, 载荷, 文本, 标记) 四元组。"""
    order, alias, rows = [], {}, []

    def use(name):
        key = alias.get(unquote(name), unquote(name))
        if key not in order:
            order.append(key)
        return key

    for raw in body:
        decl = DECL.match(raw)
        if decl:
            name = unquote(decl.group("name"))
            if decl.group("alias"):
                alias[decl.group("alias")] = name
            use(name)
            continue
        note = NOTE.match(raw)
        if note:
            who = (note.group("who") or "").split(",")[0].strip()
            anchor = use(who) if who else (order[0] if order else "")
            rows.append(("note", anchor, note.group("text").strip(),
                         note.group("pos").lower()))
            continue
        group = GROUP.match(raw)
        if group and not SEQ_MSG.match(raw):
            rows.append(("grp", group.group("kind").lower(),
                         group.group("label").strip(), ""))
            continue
        if raw.lower() == "end" or raw.lower().startswith("end "):
            rows.append(("endgrp", "", "", ""))
            continue
        message = SEQ_MSG.match(raw)
        if message:
            left, right = use(message.group("a")), use(message.group("b"))
            arrow = message.group("arrow")
            if arrow.startswith("<"):
                left, right = right, left
            rows.append(("msg", (left, right),
                         (message.group("text") or "").strip(),
                         "dash" if "--" in arrow else ""))
    return order, rows


def _columns(order, rows):
    """列位置:相邻列的间距由跨越它的消息文本决定,文字压不到别人身上。"""
    gaps = [96.0] * max(1, len(order) - 1)
    for kind, payload, body, _flag in rows:
        if kind != "msg":
            continue
        left, right = order.index(payload[0]), order.index(payload[1])
        if left == right:
            continue
        span = abs(right - left)
        need = (text_width(body, FS_S) + 34) / span
        for slot in range(min(left, right), max(left, right)):
            gaps[slot] = max(gaps[slot], need)
    heads = [max(84.0, text_width(name) + 26) for name in order]
    positions, cursor = [], 24.0
    for index, width in enumerate(heads):
        if index == 0:
            cursor += width / 2
        positions.append(cursor)
        if index < len(gaps):
            cursor += max(gaps[index],
                          (width + heads[index + 1]) / 2 + 12)
    return positions, heads, positions[-1] + heads[-1] / 2 + 24


def _draw_note(parts, anchor_x, total, body, side, y):
    width = text_width(body, FS_S) + 22
    x = anchor_x + 22 if side != "left" else anchor_x - 22 - width
    x = max(6, min(x, total - width - 6))
    parts.append(rect(x, y - 4, width, 24, "pn", 2))
    parts.append(text(x + 11, y + 12, body, "pt-n", "start", FS_S))


def _draw_self(parts, x, body, dash, y):
    parts.append(
        '<path d="M%.1f,%.1f h34 v22 h-30" class="ps"%s '
        'marker-end="url(#%s)"/>'
        % (x, y, ' stroke-dasharray="5,4"' if dash else "",
           "ao" if dash else "ah"))
    parts.append(text(x + 40, y + 4, body, "pt-m", "start", FS_S))


def _draw_rows(rows, order, positions, total, top):
    parts, frames, depth, y = [], [], 0, top + HEAD_H + 22
    for kind, payload, body, flag in rows:
        if kind == "grp":
            frames.append([y - 12, payload, body, depth])
            depth += 1
            y += 24
        elif kind == "endgrp":
            for frame in reversed(frames):
                if len(frame) == 4:
                    frame.append(y + 6)
                    depth = max(0, depth - 1)
                    break
            y += 10
        elif kind == "note":
            anchor = payload if payload in order else order[0]
            _draw_note(parts, positions[order.index(anchor)], total, body,
                       flag, y)
            y += ROW_H
        else:
            left, right = payload
            x_left = positions[order.index(left)]
            x_right = positions[order.index(right)]
            if left == right:
                _draw_self(parts, x_left, body, flag == "dash", y)
                y += SELF_H
                continue
            parts.append(line(x_left, y, x_right, y, "ps",
                              "ao" if flag == "dash" else "ah",
                              flag == "dash"))
            parts.append(text((x_left + x_right) / 2, y - 7, body, "pt-m",
                              "middle", FS_S))
            y += ROW_H
    return parts, frames, y + 6


def _draw_frames(frames, total, bottom):
    parts = []
    for frame in frames:
        if len(frame) == 4:
            frame.append(bottom)
        start, kind, label, level, stop = frame
        inset = 8 + level * 7
        parts.append(rect(inset, start, total - inset * 2, stop - start,
                          "pfr", 3))
        tab = text_width(kind, FS_S) + 16
        parts.append(rect(inset, start, tab, 17, "ptab", 0))
        parts.append(text(inset + 8, start + 13, kind, "pt-k", "start", FS_S))
        if label:
            parts.append(text(inset + tab + 8, start + 13, label, "pt-n",
                              "start", FS_S))
    return parts


def _draw_lifelines(order, positions, heads, top, bottom):
    parts = []
    for index, name in enumerate(order):
        center, width = positions[index], heads[index]
        parts.append(line(center, top + HEAD_H, center, bottom, "pl", None))
        for box_y in (top, bottom):
            parts.append(rect(center - width / 2, box_y, width, HEAD_H, "pb"))
            parts.append(text(center, box_y + 20, name, "pt", "middle"))
    return parts


def render(lines):
    body, title = clean(lines)
    order, rows = _parse(body)
    if not order:
        return ""
    positions, heads, total = _columns(order, rows)
    top = 34 if title else 14
    parts, frames, bottom = _draw_rows(rows, order, positions, total, top)
    return svg(int(total), int(bottom + HEAD_H + 14),
               _draw_frames(frames, total, bottom)
               + _draw_lifelines(order, positions, heads, top, bottom)
               + parts, title)

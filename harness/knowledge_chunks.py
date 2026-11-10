"""Lossless Markdown section ranges. Index chunks are views, never new authority.

Keep a whole topic (including examples and exceptions) when it fits the soft
budget. Recurse through headings only for long topics, then split at blank
paragraph boundaries outside fences. Oversized indivisible blocks stay intact.
All positions are one-based lines in the unchanged source.
"""
import re
from dataclasses import dataclass


@dataclass
class Section:
    start_line: int
    end_line: int
    heading: str
    content: str


def split_markdown(text, max_chars=6000):
    lines = text.splitlines()
    if not lines:
        return []
    first = 0
    if lines[0].strip() == '---':
        for i in range(1, len(lines)):
            if lines[i].strip() in ('---', '...'):
                first = i + 1
                break
    headings = []
    breaks = set()
    fence = None
    indented = False
    for i in range(first, len(lines)):
        line = lines[i]
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= fence[1] and not marker[2].strip():
                fence = None
            continue
        if line.startswith(("    ", "\t")):
            indented = True
            continue
        if indented and not line.strip():
            continue
        indented = False
        if marker:
            fence = (marker[1][0], len(marker[1]))
            continue
        if not line.strip():
            breaks.add(i + 1)
        atx = re.match(r'^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$', line)
        if atx:
            headings.append((i, len(atx[1]), atx[2]))
        elif i > first and re.fullmatch(r' {0,3}(=+|-+)\s*', line) and lines[i-1].strip():
            # Setext headings, not list items or horizontal rules.
            if not re.match(r'^\s*(?:[-*+]\s|\d+[.)]\s| {4})', lines[i-1]):
                headings.append((i-1, 1 if line.lstrip()[0] == '=' else 2, lines[i-1].strip()))
    output = []

    def emit(start, end, trail):
        if start >= end or not any(line.strip() for line in lines[start:end]):
            return
        output.append(Section(start + 1, end, ' > '.join(trail), '\n'.join(lines[start:end])))

    def divide(start, end, trail, level=0):
        inside = [h for h in headings if start <= h[0] < end and h[1] > level]
        size = sum(len(line) + 1 for line in lines[start:end])
        if not inside:
            if size <= max_chars:
                emit(start, end, trail)
                return
            cursor = start
            length = 0
            for i in range(start, end):
                length += len(lines[i]) + 1
                if length >= max_chars and i + 1 in breaks:
                    emit(cursor, i + 1, trail)
                    cursor, length = i + 1, 0
            emit(cursor, end, trail)
            return
        minimum = min(h[1] for h in inside)
        children = [h for h in inside if h[1] == minimum]
        # Root/title must expose its individual topics even if the manual is short.
        if level >= 2 and size <= max_chars:
            emit(start, end, trail)
            return
        if start < children[0][0]:
            divide(start, children[0][0], trail, minimum)
        for index, (pos, depth, title) in enumerate(children):
            stop = children[index+1][0] if index+1 < len(children) else end
            topic(pos, stop, trail + [title], depth)

    def topic(start, end, trail, depth):
        # Exclude this heading from recursive discovery, but retain it in output.
        size = sum(len(line) + 1 for line in lines[start:end])
        children = [h for h in headings if start < h[0] < end and h[1] > depth]
        if size <= max_chars and (depth >= 2 or not children):
            emit(start, end, trail)
        else:
            divide(start, end, trail, depth)

    divide(first, len(lines), [])
    return output


def index_sections(text, max_chars=6000):
    """Do not rank a structural parent heading separately from its child topics.

    Source ranges remain lossless in split_markdown. A heading-only leaf may
    itself be a rule, so only ancestors repeated in the next section's heading
    trail are omitted. Never filter by text length or strip code-like headings.
    """
    sections = split_markdown(text, max_chars)
    result = []
    for i, section in enumerate(sections):
        lines = [line for line in section.content.splitlines() if line.strip()]
        title_only = (len(lines) == 1 and re.fullmatch(r' {0,3}#{1,6}\s+.+', lines[0]) is not None
                      or len(lines) == 2 and not lines[0].startswith(('    ', '\t'))
                      and re.fullmatch(r' {0,3}(=+|-+)\s*', lines[1]) is not None)
        def heading_level(content):
            content_lines = [line for line in content.splitlines() if line.strip()]
            if not content_lines:
                return 0
            marker = re.match(r'^ {0,3}(#{1,6})\s+', content_lines[0])
            if marker:
                return len(marker[1])
            if len(content_lines) > 1 and re.fullmatch(r' {0,3}(=+|-+)\s*', content_lines[1]):
                return 1 if content_lines[1].lstrip()[0] == '=' else 2
            return 0
        has_child = (i + 1 < len(sections) and bool(section.heading)
                     and heading_level(sections[i + 1].content) > heading_level(section.content)
                     and sections[i + 1].heading.startswith(section.heading + ' > '))
        if not (title_only and has_child):
            result.append(section)
    return result

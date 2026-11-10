"""Scope textual evidence to the configured Markdown sections, preserving source."""

import re


def _title_key(title):
    return re.sub(r"\s+", "", title).casefold()


def without_sections(text, excluded):
    """Ignore only exact configured headings through their section boundary.

    A heading inside a fenced example is content, not a section boundary.
    Unknown headings and all unconfigured documents remain subject to checks.
    """
    if not excluded:
        return text
    names = set(map(_title_key, excluded))
    depth = None
    fence = None
    result = []
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line.rstrip("\r\n"))
        if fence:
            if (marker and marker[1][0] == fence[0]
                    and len(marker[1]) >= len(fence) and not marker[2].strip()):
                fence = None
        elif marker:
            fence = marker[1]
        else:
            heading = re.match(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$", line)
            if heading:
                level = len(heading[1])
                if depth is not None and level <= depth:
                    depth = None
                title = _title_key(heading[2])
                if depth is None and title in names:
                    depth = level
        if depth is None:
            result.append(line)
    return "".join(result)

"""Shared pure validation for business commit-message prefixes."""

import re


def valid_business_commit_message(ticket, message):
    """Return whether ``message`` starts with the exact required prefix."""
    if (
            not isinstance(ticket, str)
            or not ticket
            or "[" in ticket
            or "]" in ticket):
        return False
    if not isinstance(message, str):
        return False
    return bool(re.match(
        r"^\[" + re.escape(ticket) + r"\]\[(?:feat|fix)\](?=\S)",
        message,
    ))


_HEREDOC = re.compile(
    r"^\$\(\s*cat\s*<<-?\s*['\"]?(?P<tag>\w+)['\"]?\s*\n"
    r"(?P<body>.*?)\n?(?P=tag)\s*\)?\s*$", re.S)


def unwrap_heredoc(message):
    """`git commit -m "$(cat <<'EOF' … EOF)"` 取出真正的提交信息。

    不拆的话拿到的是 `$(cat <<'EOF'\n…` 整串,格式校验一看开头不是
    [单号][feat] 就判不合规——把一条完全正确的提交拦了下来(实战撞过)。
    与编译证据那次同源:拿 shell 原文去比对语义值,迟早误伤。
    """
    found = _HEREDOC.match(message.strip())
    return found.group("body") if found else message


def message_from_tokens(tokens):
    """从 git commit 的参数里取出提交信息。→ (是否带信息, 信息原文)"""
    for index, token in enumerate(tokens):
        raw = None
        if token in ("-m", "--message"):
            raw = tokens[index + 1] if index + 1 < len(tokens) else ""
        elif token.startswith("--message="):
            raw = token.split("=", 1)[1]
        elif token.startswith("-m") and token != "-m":
            raw = token[2:]
        if raw is not None:
            return True, unwrap_heredoc(raw)
    return False, ""

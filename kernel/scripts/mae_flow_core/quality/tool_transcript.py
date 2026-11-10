"""Pure interpretation of Hook transcript tool evidence."""

from dataclasses import dataclass
import json
import re
from typing import Any, Iterable, Optional, Sequence, Tuple


_RESULT_MARKER = re.compile(
    r"^\s*(ENV|UT|CODECHECK|STORY|GRILL|COMPILE)_RESULT:\s*(\S+)",
    re.M,
)
_FAILED_BASH_RESULT = re.compile(
    r"(?:^|\n)\s*(?:(?:process|command)\s+)?exited?\s+with\s+"
    r"(?:exit\s+)?code\s*[:= ]\s*[1-9]\d*|"
    r"(?:^|\n)\s*(?:exit[_ ]code|return[_ ]?code|errorlevel)"
    r"\s*[:= ]\s*[1-9]\d*|"
    r"(?:^|\n)\s*(?:process|command)\s+failed\s+with\s+"
    r"(?:exit\s+)?code\s*[:= ]\s*[1-9]\d*|"
    r"returned\s+non-zero\s+exit\s+status\s+[1-9]\d*|"
    r"(?:exit(?:ed)?\s*(?:code|status)?|return\s+code)"
    r"\s*[:= ]\s*[1-9]\d*",
    re.I,
)


@dataclass(frozen=True)
class ToolCall:
    """One tool invocation joined to its host result, if present."""

    call_id: str
    name: str
    input: Any
    result_seen: bool = False
    is_error: bool = False
    result: str = ""

    def to_legacy(self):
        """Return the mapping shape used by the migration adapter."""
        return {
            "id": self.call_id,
            "name": self.name,
            "input": self.input,
            "result_seen": self.result_seen,
            "is_error": self.is_error,
            "result": self.result,
        }


@dataclass(frozen=True)
class Transcript:
    user_texts: Tuple[str, ...]
    assistant_texts: Tuple[str, ...]
    tool_calls: Tuple[ToolCall, ...]


@dataclass(frozen=True)
class ContractMarker:
    kind: str = ""
    status: str = ""
    error: str = ""


def _message_content(entry):
    message = entry.get("message", {}) or {}
    return message.get("content", entry.get("content", ""))


def _role_texts(lines, role):
    result = []
    for entry in lines:
        message = entry.get("message", {}) or {}
        if entry.get("type") != role and message.get("role") != role:
            continue
        content = message.get("content", entry.get("content", ""))
        if isinstance(content, list):
            result.append("".join(
                block.get("text", "")
                for block in content
                if isinstance(block, dict)
            ))
        elif isinstance(content, str):
            result.append(content)
    return tuple(result)


def _result_text(content):
    if not isinstance(content, list):
        return str(content)
    return "\n".join(
        str(item.get("text", item)) if isinstance(item, dict)
        else str(item)
        for item in content
    )


def parse_transcript(lines: Iterable[dict]) -> Transcript:
    """Join JSONL transcript calls/results without consulting runtime state."""
    rows = tuple(lines)
    calls = []
    by_id = {}
    for entry in rows:
        content = _message_content(entry)
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") in ("tool_use", "tool_call"):
                call = {
                    "call_id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "input": block.get("input", {}),
                    "result_seen": False,
                    "is_error": False,
                    "result": "",
                }
                calls.append(call)
                if call["call_id"]:
                    by_id[call["call_id"]] = call
            if block.get("type") in ("tool_result", "tool_response"):
                call = by_id.get(
                    block.get("tool_use_id")
                    or block.get("tool_call_id")
                    or block.get("id")
                )
                if call is None:
                    continue
                call["result_seen"] = True
                call["is_error"] = bool(
                    block.get("is_error") or block.get("isError"))
                call["result"] = _result_text(block.get("content", ""))
    return Transcript(
        user_texts=_role_texts(rows, "user"),
        assistant_texts=_role_texts(rows, "assistant"),
        tool_calls=tuple(ToolCall(**call) for call in calls),
    )


def select_contract_marker(text: str) -> ContractMarker:
    """Select the unique final-result claim using the historical tolerance."""
    value = str(text or "")
    first_line = value.splitlines()[0] if value else ""
    matches = list(_RESULT_MARKER.finditer(value))
    first = re.match(
        r"^(ENV|UT|CODECHECK|STORY|GRILL|COMPILE)_RESULT:\s*(\S+)",
        first_line,
    )
    if len(matches) > 1:
        kinds = {match.group(1) + "/" + match.group(2)
                 for match in matches}
        if len(kinds) != 1:
            return ContractMarker(error=(
                "最终回复包含互相矛盾的结果标记(%s)，无法判断本轮真实结论。"
                "重新输出时整个回复只保留一行顶行的 XXX_RESULT: 标记"
                "(本轮真实结果)；引用历史结论或格式说明时不要顶行书写标记。"
                % "、".join(sorted(kinds))
            ))
        match = first or matches[-1]
        return ContractMarker(match.group(1), match.group(2))
    if first:
        return ContractMarker(first.group(1), first.group(2))
    if len(matches) == 1:
        return ContractMarker(matches[0].group(1), matches[0].group(2))
    return ContractMarker()


def call_failed(call: Optional[ToolCall]) -> bool:
    if call is None:
        return False
    if not call.result_seen or call.is_error:
        return True
    if call.name.lower() != "bash":
        return False
    return bool(_FAILED_BASH_RESULT.search(call.result or ""))


def skill_call(
        calls: Sequence[ToolCall], wanted: str) -> Optional[ToolCall]:
    if not wanted:
        return None
    for call in reversed(calls or ()):
        if call.name.lower() != "skill":
            continue
        try:
            raw = json.dumps(call.input, ensure_ascii=False).lower()
        except Exception:
            raw = str(call.input).lower()
        if wanted in raw:
            return call
    return None


def exact_skill_call(
        calls: Sequence[ToolCall], wanted: str) -> Optional[ToolCall]:
    """Match one Skill identifier token without substring aliases."""
    for call in reversed(calls or ()):
        if call.name.lower() != "skill":
            continue
        raw = json.dumps(call.input, ensure_ascii=False).lower()
        if wanted in re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", raw):
            return call
    return None


_TRAILING_NOTE = re.compile(r"[（(][^()（）]*[)）]\s*$")


def _normalized_command(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def command_core(value):
    """去掉配置里跟在命令后面的括号说明,得到真正要执行的命令。

    实战根因(fieldtest 五连败):用户把「编译方式」填成
    `make build (python3 -m compileall 语法检查 …各 src)`——命令 + 中文注解。
    匹配拿整串去 startswith,而真实执行的是 `make build; echo ...`,
    永远匹配不上;五次编译全被判无证据,却让人以为是宿主 transcript 问题。
    配置里写清楚意图是好习惯,机器必须容得下。
    """
    text = str(value or "").strip()
    previous = None
    while text and text != previous:            # 允许多层括号注解
        previous = text
        text = _TRAILING_NOTE.sub("", text).strip()
    return text or str(value or "").strip()


def _command_of(call):
    value = call.input
    return value.get("command", "") if isinstance(value, dict) else str(value)


def bash_call(
        calls: Sequence[ToolCall], expected: str) -> Optional[ToolCall]:
    wanted = _normalized_command(command_core(expected))
    if not wanted:
        return None
    for call in reversed(calls or ()):
        if call.name.lower() != "bash":
            continue
        segments = re.split(
            r"&&|\|\||[;\n]",
            _normalized_command(_command_of(call)),
        )
        if any(segment.strip().startswith(wanted) for segment in segments):
            return call
    return None


def bash_calls(calls: Sequence[ToolCall], expected: str):
    wanted = _normalized_command(command_core(expected))
    found = []
    if not wanted:
        return found
    for call in calls or ():
        if call.name.lower() != "bash":
            continue
        segments = re.split(
            r"&&|\|\||[;\n]",
            _normalized_command(_command_of(call)),
        )
        count = sum(
            1 for segment in segments
            if segment.strip().startswith(wanted)
        )
        if count:
            found.append((call, count))
    return found


def reported_bash_call(
        calls: Sequence[ToolCall], reported: str) -> Optional[ToolCall]:
    wanted = _normalized_command(str(reported or "").strip("`"))
    if not wanted:
        return None
    exact = bash_call(calls, wanted)
    if exact:
        return exact
    for call in reversed(calls or ()):
        if call.name.lower() != "bash":
            continue
        for segment in re.split(
                r"&&|\|\||[;\n]",
                _normalized_command(_command_of(call))):
            segment = segment.strip()
            if not segment or not wanted.startswith(segment):
                continue
            tail = wanted[len(segment):].lstrip()
            if not tail or tail[0] in "([（，,;；—":
                return call
    return None

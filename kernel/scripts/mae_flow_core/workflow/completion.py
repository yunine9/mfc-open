"""Pure policy for completing the current Mae-Flow step."""

from dataclasses import dataclass
import re

from ..moonlight import enabled as moonlight_enabled
from ..moonlight import step_kind as moonlight_step_kind
from .evidence import EvidenceRegistry, evaluate_step_evidence


@dataclass(frozen=True)
class CompletionEvent:
    kind: str
    value: str = ""
    note: str = ""


def resolve_choice(step, state, requested):
    """Supply the legacy in-flight Moonlight choice when it is omitted."""
    if (
        moonlight_enabled(state)
        and step.get("skip_in_moonlight")
        and not requested
    ):
        return step.get("moonlight_choice")
    return requested


def choice_error(step, choice):
    if (
        step.get("choice_key")
        and choice not in step.get("choices", [])
    ):
        return "--choice 必须为: %s" % "|".join(
            step["choices"])
    return ""


def choice_config(step, choice):
    selected = (
        (step.get("choice_sets") or {}).get(choice, {})
        or {}
    )
    return {
        key: str(value)
        for key, value in selected.items()
    }


def natural_binary_choice(step, value, is_positive):
    """Resolve free-text fallback only for the safe continue/revise shape."""
    if set(step.get("choices") or []) != {"continue", "revise"}:
        return ""
    if is_positive(value):
        return "continue"
    compact = re.sub(r"[\s,，。；;：:、!！]+", "", value or "")
    if not compact or re.search(r"[?？]", compact):
        return ""
    if re.search(
            r"需要(?:重新)?(?:调整|修改|补充|完善|修正)|"
            r"(?:有|存在)(?:遗漏|缺口|问题|错误)|"
            r"遗漏|漏了|缺少|不完整|不正确|不对|暂不|先别|拒绝",
            compact, re.I):
        return "revise"
    return ""


def _receipt_norm(value):
    out = re.sub(r"[\s,，。；;：:、!！]+", "", str(value or ""))
    return re.sub(r"[（(]推荐[）)]", "", out).lower()


_NEGATION_RE = re.compile(r"(不|否|跳过|无需)")


def _alias_hits(normalized, answer_aliases):
    return {
        key for key, alias in answer_aliases
        if normalized == alias
        or (not re.fullmatch(r"[a-z0-9_-]+", alias)
            and (normalized.startswith(alias) or alias.startswith(normalized)))
    }


def _binary_negation_key(choices, answer_aliases, normalized):
    """二选一的否定锚:一侧标准文本以"不/否/跳过"开头,另一侧不带否定——
    "需要,先预检"与"不需要,我直接检视"即使全改写也能可靠区分。"""
    negated = {key for key, alias in answer_aliases
               if _NEGATION_RE.match(alias)}
    if len(negated) != 1:
        return ""
    negative_key = next(iter(negated))
    positive_key = next(key for key in choices if key != negative_key)
    return (negative_key if _NEGATION_RE.match(normalized)
            else positive_key)


def _label_affinity(label, choices, answer_aliases):
    """展示标签 → choice key,只认文本亲和,与展示顺序无关。

    实测事故:模型把推荐项排到第一位并改写了标签,按位置映射直接把用户的
    选择判反(需要预检 → disabled),机器反过来指控模型"替用户改选"。
    位置从来不是证据,文字才是。
    """
    normalized = _receipt_norm(label)
    if not normalized:
        return ""
    hits = _alias_hits(normalized, answer_aliases)
    if len(hits) == 1:
        return next(iter(hits))
    if hits or len(choices) != 2:
        return ""
    return _binary_negation_key(choices, answer_aliases, normalized)


def _option_mapping(options, choices, answer_aliases):
    """全部展示选项必须构成到 choice key 的双射,任何一个映射不出来
    就放弃整题——宁可打回重问,不做无声的猜测。"""
    mapping = {}
    for label in options:
        key = _label_affinity(label, choices, answer_aliases)
        if not key or key in mapping.values():
            return {}
        mapping[_receipt_norm(label)] = key
    return mapping if len(mapping) == len(choices) else {}


def receipt_choice(step, item, value):
    """Resolve a structured AskUserQuestion selection by label affinity."""
    choices = list(step.get("choices") or [])
    if not choices:
        return ""
    answer_aliases = []
    for key, values in (step.get("choice_answers") or {}).items():
        for alias in [key] + list(values or []):
            normalized = _receipt_norm(alias)
            if normalized:
                answer_aliases.append((key, normalized))
    normalized_value = _receipt_norm(value)
    selected = set()
    for question in (
            ((item.get("askuser") or {}).get("questions") or [])):
        options = question.get("options") or []
        if len(options) != len(choices):
            continue
        mapping = _option_mapping(options, choices, answer_aliases)
        if normalized_value in mapping:
            selected.add(mapping[normalized_value])
    return next(iter(selected)) if len(selected) == 1 else ""


def evidence_failures(step, state, evaluators):
    registry = (
        evaluators
        if isinstance(evaluators, EvidenceRegistry)
        else EvidenceRegistry(evaluators)
    )
    return evaluate_step_evidence(step, state, registry)


def evidence_error(
    failures,
    failure_count,
    moonlight,
    target,
    script_path,
):
    message = "证据不足,拒绝推进:\n  - " + "\n  - ".join(
        failures)
    if failure_count < 2 or moonlight:
        return message
    goto_hint = (
        '先执行 messages 取得该回答 ID，再执行 python3 "%s" goto %s '
        "--force --message-id <ID>"
        % (script_path, target)
        if target else
        "先按 current 完成本步选择；目标确定后再执行 goto <目标步骤> "
        "--force --message-id <messages输出的ID>"
    )
    return message + (
        "\n⚠ 本步证据已连续 %d 次不满足。机器事实不能由口头确认替代;"
        "但若**用户已明确表示**接受现状/跳过本步(如“跳过吧/我认为可以了”),"
        "这是用户的风险裁决,%s "
        "整步跳过并留痕审计;缺的是 COMPILE/CODECHECK/UT 等 Agent 令牌时,"
        "优先用报错里的 accept-risk(只放当前令牌,其他证据照查)。"
        "没有用户原话时 Agent 不得自行跳过。"
        % (failure_count, goto_hint)
    )


def _story_is_local(state):
    mode = str(
        (state.get("config") or {}).get("STORY入库", "")
    ).lower()
    return any(
        value in mode
        for value in (
            "不生成",
            "不入库",
            "不提交",
            "no",
            "false",
        )
    )


def completion_events(
    step_id,
    step,
    state,
    choice,
    ack,
):
    """Yield ordered adapter actions after Evidence has succeeded."""
    kind = moonlight_step_kind(step_id)
    if kind:
        yield CompletionEvent("resolve_moonlight", kind)

    if step_id == "story" and _story_is_local(state):
        ticket = str(
            (state.get("config") or {}).get("单号", "")
        )
        yield CompletionEvent("localize_story", ticket)

    note = ack or (
        "月光宝盒自动决策"
        if (
            moonlight_enabled(state)
            and step.get("user_ack")
        )
        else ""
    )
    yield CompletionEvent("advance", note=note)

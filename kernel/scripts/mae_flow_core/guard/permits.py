"""Pure policies for Gate strike tracking and one-shot permits."""

import copy
from dataclasses import dataclass
import hashlib

from ..foundation.source_paths import normalize_path


@dataclass(frozen=True)
class PermitCheck:
    kind: str
    signed_head: str = ""


def block_id(rule, subject):
    payload = rule + "\n" + normalize_path(subject)
    return hashlib.sha256(
        payload.encode("utf-8", errors="replace")).hexdigest()[:10]


def check_permit(permits, permit_id, step, head):
    record = (permits or {}).get(permit_id)
    if (
        not record
        or record.get("used")
        or record.get("step") != step
    ):
        return PermitCheck("missing")
    signed_head = record.get("head", "")
    if signed_head and signed_head != head:
        return PermitCheck("stale", signed_head)
    return PermitCheck("valid", signed_head)


def record_strike(data, rule, step, permit_id, subject, now):
    result = copy.deepcopy(data or {})
    counts = result.setdefault("counts", {})
    entry = counts.get(rule) or {}
    if entry.get("step") != step:
        entry = {"step": step, "count": 0}
    entry["count"] = int(entry.get("count", 0) or 0) + 1
    entry["last_at"] = now
    counts[rule] = entry
    recent = result.setdefault("recent", {})
    recent[permit_id] = {
        "rule": rule,
        "step": step,
        "sample": subject[:200],
        "at": now,
    }
    while len(recent) > 20:
        oldest = min(
            recent, key=lambda key: recent[key].get("at", ""))
        recent.pop(oldest, None)
    return result, entry["count"]


def strike_escalation(
        count, limit, moonlight, permit_id, script_path):
    if moonlight:
        return (
            "\n⚠ 本规则已在本步骤拦截 %d 次。月光宝盒无人值守中"
            "不可放行:这属于客观阻塞,按 current 给出的 moonlight blocked"
            "(质量步骤用 defer)留痕停止,把拦截编号 %s 写进 reason,早晨由用户裁决。"
            % (count, permit_id)
        )
    # 原来这段让 Agent 去"找用户明确授权 exact 动作/path/commit 的原话"——
    # 于是它拿别处的同意来试,再瞎猜参数(实战撞过 allow --paths,这参数不存在)。
    # 现在只说一件事:把编号写进问用户的那句话。验真只认这个,别的都不比。
    return (
        "\n⚠ 本规则本次拦截编号 %s。不要重试写法变体。放行办法:\n"
        "  1) 用 AskUserQuestion 把本次动作和风险摆给用户,"
        "**问题正文里原样带上编号 %s**(选项照旧简短,如「允许」「不允许」);\n"
        "  2) messages 取到那条回答的 ID;\n"
        "  3) python3 \"%s\" allow %s --message-id <ID>。\n"
        "验真只看两条:这条回答里有本次编号、且不是拒绝——不必让用户复述路径,"
        "也不要替他补写或概括。放行只对这个动作生效一次,绑定当前步骤与代码版本;"
        "Git exact 授权消费后会留下 delivery 收据,push/done 不会重复否定。"
        "若动作确属违规,回到 current 指引。"
        % (permit_id, permit_id, script_path, permit_id)
    )

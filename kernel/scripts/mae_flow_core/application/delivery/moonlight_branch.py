"""Moonlight policy for safely resolving an existing delivery branch."""

from copy import deepcopy
from dataclasses import dataclass

from mae_flow_core.delivery.models import DeliveryEffect, DeliveryResult

from .moonlight import record_blocker


@dataclass(frozen=True)
class MoonlightBranchFacts:
    """Git and archived-delivery facts used by the branch policy."""

    current_branch: str
    head: str
    base_branch: str
    base_head: str
    base_is_ancestor: bool
    explicit_continue: bool
    request_sha256: str
    last_state_sha256: str = ""
    previous_ticket: str = ""
    previous_branch: str = ""
    previous_head: str = ""
    previous_head_is_ancestor: bool = False
    dirty_paths: tuple = ()


def _result(effects=(), stdout=()):
    return DeliveryResult(
        effects=tuple(effects),
        stdout=tuple(stdout),
        stderr=(),
        exit_code=0,
    )


def _adoption_source(state, facts):
    current = facts.current_branch
    if (
        not current
        or current == facts.base_branch
        or not facts.base_is_ancestor
    ):
        return ""
    if facts.explicit_continue:
        return "moonlight-request"
    ticket = str(((state or {}).get("config") or {}).get("单号", "") or "")
    if (
        ticket
        and facts.previous_ticket == ticket
        and facts.previous_branch == current
        and bool(facts.previous_head)
        and facts.previous_head_is_ancestor
    ):
        return "moonlight-continuation"
    return ""


def _adoption_result(state, facts, source, now):
    updated = deepcopy(state)
    wanted = str((updated.get("config") or {}).get("分支名", "") or "")
    continuation = source == "moonlight-continuation"
    updated.setdefault("config", {})["分支名"] = facts.current_branch
    updated["branch_resolution"] = {
        "mode": "adopt-current",
        "source": source,
        "branch": facts.current_branch,
        "head": facts.head,
        "base": facts.base_branch,
        "base_head": facts.base_head,
        "configured_branch": wanted,
        "request_sha256": facts.request_sha256,
        "ack_sha256": facts.request_sha256,
        "last_state_sha256": (
            facts.last_state_sha256 if continuation else ""),
        "previous_ticket": facts.previous_ticket if continuation else "",
        "previous_branch": facts.previous_branch if continuation else "",
        "previous_head": facts.previous_head if continuation else "",
        "at": now,
    }
    return _result(
        effects=(DeliveryEffect("set_state", updated),),
        stdout=(
            "[mae-flow] 🌙 已根据%s安全沿用现有分支 %s@%s。"
            % (
                "上一轮同单交付记录" if continuation else "启动请求",
                facts.current_branch,
                facts.head[:10],
            ),
        ),
    )


def _block_reason(facts):
    if (
        facts.current_branch
        and facts.current_branch != facts.base_branch
        and not facts.base_is_ancestor
    ):
        return (
            "当前非基线分支 %s@%s 不包含当前基线 %s@%s；"
            "月光模式不能自动 merge、cherry-pick 或 reset，已停止等待人工处理。"
            % (
                facts.current_branch,
                facts.head[:10],
                facts.base_branch or "未知",
                facts.base_head[:10],
            )
        )
    return (
        "当前非基线分支 %s@%s 已含工作，但启动请求未明确要求沿用，"
        "且上一轮状态不能同时证明同单号、同分支和旧 HEAD 为当前 HEAD 祖先；"
        "月光模式拒绝猜测代码归属。"
        % (
            facts.current_branch or "未知",
            facts.head[:10] if facts.head else "未知",
        )
    )


def resolve_moonlight_branch(state, facts, now):
    """Adopt a proven continuation, block ambiguity, or keep the fresh path."""
    enabled = bool(((state or {}).get("moonlight") or {}).get("enabled"))
    if not enabled or (state or {}).get("current") != "branch_create":
        return _result()
    if facts.head and facts.head == facts.base_head:
        return _result()
    source = _adoption_source(state, facts)
    if source:
        return _adoption_result(state, facts, source, now)
    return record_blocker(
        state,
        can_block=True,
        reason=_block_reason(facts),
        head=facts.head,
        dirty_paths=facts.dirty_paths,
        now=now,
    )

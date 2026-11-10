"""Moonlight quality-defer orchestration."""

from copy import deepcopy
from dataclasses import dataclass
from typing import Callable

from mae_flow_core.application.delivery.moonlight import (
    record_deferred_quality,
    validate_deferred_quality,
)
from mae_flow_core.delivery.models import (
    DeliveryEffect,
    DeliveryResult,
    thaw,
)


@dataclass(frozen=True)
class MoonlightDeferPorts:
    build_boundary: Callable[[], object]
    dirty_paths: Callable[[], object]
    head: Callable[[], str]
    now: Callable[[], str]
    persist_issue: Callable[[object], object]
    ensure_step_entry: Callable[[], str]
    source_changes: Callable[[], object]
    state_after_entry: Callable[[], object] = lambda: {}


def _failure(message):
    return DeliveryResult(
        effects=(), stdout=(), stderr=(message,), exit_code=2)


def _preflight_failure(state, kind, reason, ports):
    validation = validate_deferred_quality(state, kind, reason)
    if validation.exit_code:
        return validation
    current = (state or {}).get("current", "")
    if current == "build":
        ok, why = ports.build_boundary()
        if not ok:
            return _failure(
                "build 尚未达到“实现完成、仅编译遗留”的边界，"
                "不能 defer: " + why
                + "。继续完成实现；若需求/权限/外部依赖客观缺失，"
                "改用 moonlight blocked 留痕停止。")
    dirty = tuple(ports.dirty_paths())
    if dirty:
        return _failure(
            "带遗留推进前必须先提交当前有效源码/测试/构建改动，"
            "否则 push 会漏文件: " + "、".join(dirty[:8]))
    return None


def _advance_result(recorded, advance):
    return DeliveryResult(
        effects=(advance,),
        stdout=recorded.stdout,
        stderr=(),
        exit_code=0,
    )


def defer_moonlight_quality(
        state, kind, reason, rejection, recheck, ports):
    """Record a deferred quality issue and choose advance or source recheck."""
    failure = _preflight_failure(
        state, kind, reason, ports)
    if failure is not None:
        return failure
    current = (state or {}).get("current", "")
    recorded = record_deferred_quality(
        state, kind, reason, rejection,
        ports.head(), ports.now())
    if recorded.exit_code:
        return recorded
    updated = thaw(recorded.effects[0].payload)
    ports.persist_issue(updated)
    advance = next(
        effect for effect in recorded.effects
        if effect.kind == "advance_deferred")
    if not recheck:
        return _advance_result(recorded, advance)
    entry_error = ports.ensure_step_entry()
    if entry_error:
        return _failure(
            "defer 前无法核对本步是否修改过被测源码:"
            + entry_error
            + "。为避免推送未复验的源码，拒绝直接推进；"
            "先解决核对问题或走 moonlight blocked。")
    changed, error = ports.source_changes()
    if error:
        return _failure(
            "defer 前无法核对本步是否修改过被测源码:" + error
            + "。为避免推送未复验的源码，拒绝直接推进；"
            "先解决核对问题或走 moonlight blocked。")
    if not changed:
        return _advance_result(recorded, advance)
    persisted = ports.state_after_entry()
    updated = deepcopy(persisted) if persisted else updated
    unlock = (
        (updated.get("unlock") or {}).get("step") == current)
    updated.setdefault("history", []).append({
        "step": current,
        "result": "source-recheck:" + recheck,
        "note": (
            "defer 时检测到步内源码变更(unlock=%s):"
            % ("有" if unlock else "无")
        ) + "、".join(list(changed)[:10]),
        "at": ports.now(),
    })
    updated["current"] = recheck
    updated.setdefault("step_heads", {})[
        recheck] = ports.head()
    updated.pop("unlock", None)
    tasks = updated.setdefault("agent_tasks", {})
    for key in ("COMPILE", "CODECHECK", "UT"):
        tasks.pop(key, None)
    quality = updated.setdefault("quality", {})
    quality.pop("codecheck_scan", None)
    quality.pop("codecheck_verify", None)
    effects = (
        DeliveryEffect("set_state", updated),
        DeliveryEffect("write_report", {}),
        DeliveryEffect("print_current", {}),
    )
    return DeliveryResult(
        effects=effects,
        stdout=(
            "[mae-flow] 遗留已登记,但本步修改过被测源码,"
            "自动回流 %s 重新编译/CodeCheck/UT;"
            "不重新验证不得推送。" % recheck,
        ),
        stderr=(),
        exit_code=0,
    )

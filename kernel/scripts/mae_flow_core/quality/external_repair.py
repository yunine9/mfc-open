"""Narrow Core-owned authorization for Cloud pipeline repair commits.

The original delivery manifest remains the human-approved delivery scope.  A
pipeline RED can legitimately require an additional test or source file, but
asking for another human Diff approval would turn the lightweight repair loop
back into the heavyweight workflow.

2026-08-28 勘误:窗口原来绑 "HEAD == failed_sha",第一笔修复提交改变
HEAD 即静默失效——Agent 漏提交一个文件想补第二刀时,直接摔进按旧清单
判定的交付清单闸(排查实锤的"能编辑不能提交"反向死角)。现在窗口以
"宿主登记的 RED 判决还指着 failed_sha"为生命期:同一轮修复允许多笔
本地提交;宿主取回新 SHA 的流水线结果重新登记时,窗口自然关闭或换发。
"""

from mae_flow_core.foundation.source_paths import repository_path_identity
from mae_flow_core.guard.manifest import (
    is_process_document, validate_delivery_document_boundary)


def _exact_paths(paths):
    return list(dict.fromkeys(str(path) for path in paths if str(path)))


def issue_feedback_authorization(state, *, batch_id, base_sha, at,
                                 dirty_paths=(), allowed_paths=()):
    """Issue the same exact-scope commit authority for a feedback batch."""
    existing = (state or {}).get("delivery_repair_authorization") or {}
    if (
        existing.get("schema") == "mae-flow-feedback-repair/1"
        and existing.get("status") == "ready"
        and existing.get("batch_id") == str(batch_id or "")
        and existing.get("base_sha") == str(base_sha or "")
    ):
        return existing
    authorization = {
        "schema": "mae-flow-feedback-repair/1",
        "status": "ready",
        "batch_id": str(batch_id or ""),
        "base_sha": str(base_sha or ""),
        "issued_at": str(at or ""),
        "baseline_dirty": _exact_paths(dirty_paths),
        # Conflict/scope feedback may deliberately name files that are already
        # dirty when the trusted host opens the batch. Only those exact paths
        # may cross the baseline-dirty exclusion; everything else stays out.
        "allowed_paths": _exact_paths(allowed_paths),
    }
    state["delivery_repair_authorization"] = authorization
    return authorization


def clear_feedback_authorization(state, batch_id=""):
    authorization = (state or {}).get("delivery_repair_authorization") or {}
    if not batch_id or authorization.get("batch_id") == batch_id:
        state.pop("delivery_repair_authorization", None)


def issue_repair_authorization(state, decision, *, head, at, dirty_paths=()):
    """Issue/clear a failed-SHA-bound repair window from a pipeline verdict."""
    if getattr(decision, "verdict", "") != "RED":
        state.pop("external_repair_authorization", None)
        return None
    existing = (state or {}).get("external_repair_authorization") or {}
    if (
        existing.get("schema") == "mae-flow-external-repair/1"
        and existing.get("status") == "ready"
        and existing.get("failed_sha") == str(head or "")
    ):
        # 宿主轮询对同一 SHA 重复登记 RED 时不许重取 baseline_dirty:
        # Agent 改到一半的文件会被划成"登记前已有改动"永久排除,修完
        # 反被告知"先产生真实修复"(排查实锤的吞修复死角)。原授权原样续用。
        return existing
    authorization = {
        "schema": "mae-flow-external-repair/1",
        "status": "ready",
        "failed_sha": str(head or ""),
        "issued_at": str(at or ""),
        # Anything already dirty when RED was registered is not attributable
        # to the repair Agent and may not hitch a ride in its automatic commit.
        "baseline_dirty": list(dict.fromkeys(
            str(path) for path in dirty_paths if str(path))),
    }
    state["external_repair_authorization"] = authorization
    return authorization


def _active_feedback_authorization(state):
    authorization = (state or {}).get("delivery_repair_authorization") or {}
    delivery = (state or {}).get("delivery_loop") or {}
    active_batch_id = str(delivery.get("active_batch_id") or "")
    active_batch = next((
        item for item in delivery.get("batches") or ()
        if isinstance(item, dict) and item.get("batch_id") == active_batch_id
    ), {})
    status_ok = active_batch.get("status") in (
        "repairing", "addressed", "awaiting_verification")
    step_ok = (state or {}).get("current") in (
        "feedback_triage", "build", "domain_archive",
        "delivery_review", "push", "external_verify")
    active = bool(
        authorization.get("schema") == "mae-flow-feedback-repair/1"
        and authorization.get("status") == "ready"
        and authorization.get("batch_id") == active_batch_id
        and status_ok and step_ok)
    return active, authorization


def _active_external_authorization(state):
    authorization = (state or {}).get("external_repair_authorization") or {}
    external = (((state or {}).get("quality") or {}).get(
        "external_verification") or {})
    failed_sha = authorization.get("failed_sha") or ""
    active = bool(
        (state or {}).get("current") == "external_verify"
        and authorization.get("schema") == "mae-flow-external-repair/1"
        and authorization.get("status") == "ready"
        and failed_sha
        and external.get("verdict") == "RED"
        and external.get("sha") == failed_sha)
    return active, authorization


def active_repair_authorization(state, head):
    """窗口生命期 = 登记在案的 RED 判决仍指着签发时的 failed_sha。

    刻意不再比对当前 HEAD(见模块 docstring 勘误):第一笔修复提交后
    HEAD 前移,窗口保持打开,允许补提交;宿主对新 SHA 登记结果时授权
    被换发或清除,窗口随之关闭。head 参数保留是给调用方对账用的,
    判活本身不看它。"""
    del head
    delivery_active, delivery_authorization = (
        _active_feedback_authorization(state))
    if delivery_active:
        return True, delivery_authorization
    return _active_external_authorization(state)


def _identity(path):
    return repository_path_identity(path, case_insensitive=True)


def _repair_path_sets(state, authorization):
    excluded = {
        _identity(path) for path in (
            list((state or {}).get("initial_dirty") or ())
            + list(authorization.get("baseline_dirty") or ()))
        if isinstance(path, str)
    }
    allowed = {
        _identity(path) for path in authorization.get("allowed_paths") or ()
        if isinstance(path, str)
    }
    archive = (state or {}).get("domain_archive") or {}
    archive_paths = tuple(
        path for path in archive.get("applied_paths") or ()
        if archive.get("status") == "applied" and isinstance(path, str)
    )
    return excluded, allowed, archive_paths


def _eligible_path(path, excluded, allowed, archive_ids, archive_paths):
    if not isinstance(path, str):
        return False
    identity = _identity(path)
    if (identity in excluded and identity not in allowed
            and identity not in archive_ids):
        return False
    try:
        validate_delivery_document_boundary((path,), archive_paths)
    except ValueError:
        return False
    return True


def eligible_repair_paths(state, head, dirty_paths, repository_root=None):
    """Return exact business paths attributable to the active RED repair."""
    active, authorization = active_repair_authorization(state, head)
    if not active:
        return ()
    excluded, allowed, archive_paths = _repair_path_sets(state, authorization)
    archive_ids = {_identity(path) for path in archive_paths}
    # 领域归档是当前修复轮由内核事务刚应用的正式交付输出。只有精确
    # applied_paths 收据可跨 baseline_dirty，不能把整个 docs/specs 放开。
    eligible = [path for path in dirty_paths if _eligible_path(
        path, excluded, allowed, archive_ids, archive_paths)]
    return tuple(dict.fromkeys(eligible))

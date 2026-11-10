"""Core-owned obligations executed by an external authoritative pipeline.

The Cloud host has no build toolchain.  That does *not* turn COMPILE, UT and
CodeCheck into successful local work; it turns them into durable obligations
which a pipeline must satisfy for the exact delivery SHA.  This module owns the
small state model used by both ``done`` and ``pipeline record``.
"""

from dataclasses import dataclass

from .. import host_env


DIMENSIONS = ("COMPILE", "UT", "CODECHECK")
_CONTRACT_KEYS = {
    "COMPILE": "compile",
    "UT": "ut_run",
    "CODECHECK": "codecheck",
}
_SUCCESS = {"success", "passed", "pass"}
_FAILED = {"failed", "failure", "error", "canceled", "cancelled"}
_PENDING = {"running", "pending", "manual", "skipped", "not_run"}


@dataclass(frozen=True)
class PipelineDecision:
    verdict: str
    reason: str
    checks: dict


def required_dimensions(state):
    """Return pipeline dimensions required by this task's execution contract."""
    contract = host_env.execution_contract(state)
    return tuple(
        dimension for dimension in DIMENSIONS
        if str(contract.get(_CONTRACT_KEYS[dimension], "")).lower()
        == "pipeline"
    )


def record_git_push_receipt(state, facts, *, head, at):
    """Record Cloud-owned Git transport without exposing credentials to Pi."""
    if host_env.git_push_runs_locally(state):
        return True, ""
    receipt = facts.get("git_push")
    if not isinstance(receipt, dict):
        return False, "缺少 Cloud Git 推送收据"
    sha = str(receipt.get("sha") or "")
    ref = str(receipt.get("ref") or "")
    if sha != head or sha != str(facts.get("sha") or ""):
        return False, "Git 推送收据未绑定当前 HEAD"
    if not ref:
        return False, "Git 推送收据缺少远端分支 ref"
    action = {
        "status": "passed", "executor": "host", "sha": sha,
        "ref": ref, "remote": str(receipt.get("remote") or "origin"),
        "url": str(receipt.get("url") or ""), "updated_at": at,
    }
    state.setdefault("host_actions", {})["git_push"] = action
    return True, ""


def _external(state):
    quality = state.setdefault("quality", {})
    record = quality.setdefault("external_verification", {})
    record.setdefault("executor", "pipeline")
    record.setdefault("required", [])
    record.setdefault("checks", {})
    record.setdefault("attempts", [])
    return record


def register_pending(state, dimension, *, step, head, at, reason=""):
    """Register or invalidate one external obligation without claiming success."""
    dimension = str(dimension or "").upper()
    if dimension not in DIMENSIONS:
        raise ValueError("unknown external verification dimension: %s" % dimension)
    record = _external(state)
    if dimension not in record["required"]:
        record["required"].append(dimension)
        record["required"] = [
            item for item in DIMENSIONS if item in record["required"]]
    previous = record["checks"].get(dimension) or {}
    origins = list(previous.get("origins") or ())
    if step and step not in origins:
        origins.append(step)
    record["checks"][dimension] = {
        "status": "pending",
        "executor": "pipeline",
        "registered_at": at,
        "registered_head": head,
        "origins": origins,
        "reason": reason or "等待权威流水线执行",
    }
    record["verdict"] = "PENDING"
    record["reason"] = "存在尚未由权威流水线核销的质量义务"
    return record["checks"][dimension]


def _normalized_checks(facts):
    rows = facts.get("checks")
    # Some authoritative CI adapters expose only the aggregate run result.
    # The execution contract already says that run covers COMPILE/UT/CODECHECK;
    # typed rows improve diagnosis but their absence must not create a forever
    # wait after an exact-SHA aggregate success.
    if rows is None:
        return {dimension: [] for dimension in DIMENSIONS}, ""
    if not isinstance(rows, list):
        return None, "事实中的 checks 必须是数组"
    grouped = {dimension: [] for dimension in DIMENSIONS}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            return None, "checks[%d] 不是对象" % index
        dimension = str(row.get("dimension") or "").upper()
        if dimension not in DIMENSIONS:
            return None, "checks[%d] 的 dimension 不受支持: %s" % (
                index, dimension or "(empty)")
        status = str(row.get("status") or "").strip().lower()
        if status not in _SUCCESS | _FAILED | _PENDING:
            return None, "checks[%d] 的 status 不受支持: %s" % (
                index, status or "(empty)")
        grouped[dimension].append({
            "status": status,
            "job": str(row.get("job") or ""),
            "url": str(row.get("url") or ""),
        })
    return grouped, ""


def _dimension_result(jobs):
    statuses = {job["status"] for job in jobs}
    if not jobs:
        return "missing"
    if statuses & _FAILED:
        return "failed"
    if statuses <= _SUCCESS:
        return "passed"
    return "pending"


def _pipeline_inputs(facts, required):
    sha = str(facts.get("sha") or "")
    if not sha:
        return None, PipelineDecision("INVALID", "事实缺 sha", {})
    overall = str(facts.get("status") or "").strip().lower()
    if overall not in _SUCCESS | _FAILED | _PENDING:
        return None, PipelineDecision(
            "INVALID", "事实缺少或不支持总体 status: "
            + (overall or "空"), {})
    grouped, error = _normalized_checks(facts)
    if error:
        return None, PipelineDecision("INVALID", error, {})
    dimensions = tuple(dict.fromkeys(
        str(item).upper() for item in required))
    if not dimensions:
        return None, PipelineDecision(
            "INVALID", "当前任务没有登记外部验证义务", {})
    return (sha, overall, grouped, dimensions), None


def _stale_pipeline_decision(sha, head, grouped, required):
    return PipelineDecision(
        "STALE",
        "流水线绑的是 %s,当前 HEAD 是 %s——旧结果不背书新代码"
        % (sha[:12], head[:12]),
        {
            dimension: {
                "status": "stale", "jobs": grouped.get(dimension, [])}
            for dimension in required
        })


def _dimension_results(grouped, required):
    results, failed, incomplete = {}, [], []
    for dimension in required:
        jobs = grouped.get(dimension) or []
        status = _dimension_result(jobs)
        if status == "failed":
            failed.append(dimension)
        elif status != "passed":
            incomplete.append(dimension)
        results[dimension] = {"status": status, "jobs": jobs}
    return results, failed, incomplete


def _aggregate_covered(results, incomplete):
    """Use an exact-SHA aggregate success only for entirely missing rows."""
    still_pending = []
    covered = []
    for dimension in incomplete:
        if results[dimension]["status"] == "missing":
            results[dimension].update({
                "status": "passed", "coverage": "aggregate"})
            covered.append(dimension)
        else:
            still_pending.append(dimension)
    return covered, still_pending


def _pipeline_verdict(overall, results, failed, incomplete):
    if overall in _FAILED:
        detail = "、".join(failed) if failed else "其他阶段、告警或环境检查"
        return PipelineDecision("RED", "流水线总体失败: " + detail, results)
    if overall in _PENDING:
        return PipelineDecision(
            "INCOMPLETE", "流水线总体尚未结束: " + overall, results)
    if failed:
        return PipelineDecision(
            "RED", "流水线失败: " + "、".join(failed), results)
    covered, incomplete = _aggregate_covered(results, incomplete)
    if incomplete:
        return PipelineDecision(
            "INCOMPLETE", "流水线未提供可核销结果: "
            + "、".join(incomplete), results)
    if covered:
        return PipelineDecision(
            "PASS", "权威流水线总体通过并绑定当前 HEAD；未拆分的 "
            + "、".join(covered) + " 由总体结果聚合核销", results)
    return PipelineDecision(
        "PASS", "编译、UT 运行与 CodeCheck 均通过且绑定当前 HEAD", results)


def adjudicate_pipeline(facts, head, required):
    """Adjudicate typed pipeline facts for one exact Git SHA.

    Typed rows are diagnostic detail.  An authoritative aggregate success may
    cover dimensions for which the platform exposes no row; an explicit typed
    failure/pending result still wins and is never guessed green.
    """
    inputs, invalid = _pipeline_inputs(facts, required)
    if invalid:
        return invalid
    sha, overall, grouped, required = inputs
    if sha != head:
        return _stale_pipeline_decision(sha, head, grouped, required)
    return _pipeline_verdict(
        overall, *_dimension_results(grouped, required))


def _project_check(facts, decision, dimension, at):
    result = dict((decision.checks or {}).get(dimension) or {})
    result.update({
        "executor": "pipeline",
        "sha": str(facts.get("sha") or ""),
        "updated_at": at,
        "source": str(facts.get("source") or ""),
    })
    return result


def _attempt_record(facts, decision, head, at):
    return {
        "at": at,
        "head": head,
        "sha": str(facts.get("sha") or ""),
        "verdict": decision.verdict,
        "reason": decision.reason,
        "source": str(facts.get("source") or ""),
        "url": str(facts.get("url") or ""),
        "checks": decision.checks,
    }


def apply_pipeline_decision(state, facts, decision, *, head, at):
    """Persist an adjudication attempt and its per-dimension projection."""
    record = _external(state)
    required = required_dimensions(state) or tuple(record.get("required") or ())
    record["required"] = [item for item in DIMENSIONS if item in required]
    record["checks"].update({
        dimension: _project_check(facts, decision, dimension, at)
        for dimension in record["required"]
    })
    attempt = _attempt_record(facts, decision, head, at)
    record["attempts"] = (list(record.get("attempts") or ()) + [attempt])[-20:]
    record.update({
        "head": head,
        "sha": str(facts.get("sha") or ""),
        "verdict": decision.verdict,
        "reason": decision.reason,
        "updated_at": at,
        "source": str(facts.get("source") or ""),
        "url": str(facts.get("url") or ""),
    })
    return record


def _obligation_failure(record, required, head):
    if not required:
        return "当前任务没有可核对的外部验证义务"
    if record.get("verdict") != "PASS" or record.get("sha") != head:
        return str(record.get("reason") or "权威流水线尚未全部通过")
    checks = record.get("checks") or {}
    missing = [
        item for item in required
        if (checks.get(item) or {}).get("status") != "passed"
    ]
    return "尚未通过: " + "、".join(missing) if missing else ""


def _host_push_failure(state, head):
    if host_env.git_push_runs_locally(state):
        return ""
    pushed = ((state.get("host_actions") or {}).get("git_push") or {})
    return (
        "" if pushed.get("status") == "passed" and pushed.get("sha") == head
        else "Cloud Git 推送尚未绑定当前 HEAD")


def obligations_passed(state, head):
    record = ((state.get("quality") or {}).get("external_verification") or {})
    required = required_dimensions(state) or tuple(record.get("required") or ())
    failure = _obligation_failure(record, required, head)
    if failure:
        return False, failure
    push_failure = _host_push_failure(state, head)
    return (False, push_failure) if push_failure else (True, "")

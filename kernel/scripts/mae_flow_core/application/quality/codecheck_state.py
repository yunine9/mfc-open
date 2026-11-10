"""CodeCheck scan, scope-decision, and manual-cache state use cases."""

from collections.abc import Mapping
from dataclasses import dataclass
import copy
import re
from types import MappingProxyType


def _freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({
            key: _freeze(item)
            for key, item in value.items()
        })
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value):
    if isinstance(value, Mapping):
        return {
            key: _thaw(item)
            for key, item in value.items()
        }
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


@dataclass(frozen=True)
class CompletedScan:
    record: object
    event: object
    moonlight_included: int = 0
    classification_unknown: bool = False

    def __post_init__(self):
        object.__setattr__(
            self, "record", _freeze(self.record))
        object.__setattr__(
            self, "event", _freeze(self.event))

    def as_record(self):
        record = _thaw(self.record)
        record["pairs"] = [
            tuple(pair)
            for pair in record.get("pairs", [])
        ]
        return record

    def event_record(self):
        return _thaw(self.event)


@dataclass(frozen=True)
class ScopeDecision:
    record: object = None
    event: object = None
    included: tuple = ()
    excluded: tuple = ()
    error: str = ""

    def __post_init__(self):
        if self.record is not None:
            object.__setattr__(
                self, "record", _freeze(self.record))
        if self.event is not None:
            object.__setattr__(
                self, "event", _freeze(self.event))
        object.__setattr__(
            self, "included", tuple(self.included))
        object.__setattr__(
            self, "excluded", tuple(self.excluded))

    def as_record(self):
        if self.record is None:
            return None
        record = _thaw(self.record)
        record["pairs"] = [
            tuple(pair)
            for pair in record.get("pairs", [])
        ]
        return record

    def event_record(self):
        return (
            _thaw(self.event)
            if self.event is not None else None
        )


@dataclass(frozen=True)
class ManualRecords:
    manual: object
    scan: object
    event: object

    def __post_init__(self):
        for name in ("manual", "scan", "event"):
            object.__setattr__(
                self, name, _freeze(getattr(self, name)))

    def manual_record(self):
        return _thaw(self.manual)

    def scan_record(self):
        return _thaw(self.scan)

    def event_record(self):
        return _thaw(self.event)


def _candidate(warning, index):
    return {
        "id": "W%d" % index,
        "rule": warning.rule,
        "file": warning.file,
        "line": warning.line,
        "reason": (
            "未命中本次变更行或机器可识别的变更函数，"
            "需确认是否存在间接影响"
        ),
    }


def build_completed_scan(
        *, step, at, head, files, scoped,
        moonlight, fallback_log_path):
    """Build a scan record, conservatively including candidates at night."""
    warnings = list(scoped.warnings)
    reasons = [
        reason.as_record()
        for reason in scoped.reasons
    ]
    candidates = [
        _candidate(warning, index)
        for index, warning in enumerate(
            scoped.excluded, 1)
    ]
    raw_count = scoped.total + len(candidates)
    moonlight_included = 0
    if moonlight and candidates:
        moonlight_included = len(candidates)
        warnings.extend(scoped.excluded)
        reasons.extend({
            "rule": item["rule"],
            "file": item["file"],
            "line": item["line"],
            "reason": "月光模式无法人工裁决，保守纳入",
        } for item in candidates)
        candidates = []
    pairs = [
        warning.as_tuple()
        for warning in warnings
    ]
    count = (
        len(pairs)
        if scoped.classified else scoped.total
    )
    record = {
        "step": step,
        "at": at,
        "head": head,
        "count": count,
        "files": list(files),
        "pairs": pairs,
        "commands": list(scoped.commands),
        "scope_reasons": reasons,
        "log_path": (
            scoped.log_path or fallback_log_path),
        "raw_count": raw_count,
        "scope_candidates": candidates,
        "scope_pending": bool(candidates),
        "stock_excluded": (
            0 if scoped.classified else None),
    }
    event = {
        "head": head,
        "files": list(files),
        "raw_count": raw_count,
        "kept_count": count,
        "kept_pairs": pairs,
        "scope_reasons": reasons,
        "scope_candidates": candidates,
        "scope_pending": bool(candidates),
        "moonlight": moonlight,
    }
    return CompletedScan(
        record=record,
        event=event,
        moonlight_included=moonlight_included,
        classification_unknown=(
            not scoped.classified and bool(pairs)),
    )


def build_tool_error_scan(
        *, step, at, head, files, error, log_path):
    """Bind one real CodeCheck tool failure to the current source facts."""
    record = {
        "step": step,
        "at": at,
        "head": head,
        "count": None,
        "status": "TOOL_ERROR",
        "files": list(files),
        "pairs": [],
        "commands": [],
        "error": error,
        "log_path": log_path,
    }
    event = {
        "head": head,
        "files": list(files),
        "error": error,
    }
    return CompletedScan(
        record=record,
        event=event,
    )


def _scope_include(include_text):
    return {
        value.upper()
        for value in re.split(
            r"[\s,，、]+", include_text or "")
        if value.strip()
    }


def _scan_scope_error(
        scan, current_step, source_changed,
        source_error):
    if scan.get("step") != current_step:
        return "尚无本步骤的 codecheck-scan 结果；先执行首检。"
    candidates = scan.get("scope_candidates") or []
    if not candidates:
        return "本轮没有需要用户判断的疑似范围外告警，不需要 codecheck-scope。"
    if not scan.get("scope_pending"):
        return "本轮 CodeCheck 涉及范围已经确认；代码未变化时直接按 current 继续。"
    if source_error:
        return (
            "CodeCheck 首检基点失效:"
            + source_error
            + "；重新执行 codecheck-scan。"
        )
    if source_changed:
        return (
            "首检后源码发生变化: "
            + "、".join(source_changed[:5])
            + "。旧候选不再代表当前代码，重新执行 codecheck-scan。"
        )
    return ""


def _selection_error(candidates, include, none):
    if bool(include) == bool(none):
        return "codecheck-scope 必须二选一：--include W1,W3 或 --none。"
    valid = {
        str(item.get("id", "")).upper()
        for item in candidates
    }
    unknown = sorted(include - valid)
    if unknown:
        return (
            "未知候选编号: "
            + "、".join(unknown)
            + "；只能从本轮输出的 "
            + "、".join(sorted(valid))
            + " 中选择。"
        )
    return ""


def _ack_scope_error(
        include, ack, ack_verified, ack_error):
    if not ack:
        return "codecheck-scope 的消息 ID 没有解析出用户回答。"
    if not ack_verified:
        return "CodeCheck 涉及范围确认验真失败:" + ack_error
    ack_upper = str(ack).upper()
    missing = sorted(
        item for item in include
        if not re.search(
            r"(?<![A-Z0-9])"
            + re.escape(item)
            + r"(?![A-Z0-9])",
            ack_upper,
        )
    )
    if missing:
        return (
            "--include 中的 "
            + "、".join(missing)
            + " 没有出现在用户确认原话里。必须让用户看到编号并明确选择，"
            "不能由 Agent 根据自己的判断补选。"
        )
    if (
        not include
        and not re.search(
            r"(?:均|都|全部).{0,4}不涉及|"
            r"没有.{0,4}涉及|无.{0,4}涉及",
            ack,
        )
    ):
        return (
            "--none 必须对应用户明确表示“全部/均不涉及本次修改”的原话，"
            "普通的“确认/继续”不能替代范围裁决。"
        )
    return ""


def _scope_error(
        scan, current_step, include, none, ack,
        ack_verified, ack_error, source_changed,
        source_error):
    error = _scan_scope_error(
        scan, current_step, source_changed,
        source_error)
    if error:
        return error
    candidates = scan.get("scope_candidates") or []
    error = _selection_error(
        candidates, include, none)
    if error:
        return error
    return _ack_scope_error(
        include, ack, ack_verified, ack_error)


def decide_scope(
        *, scan, current_step, include_text, none,
        ack, ack_verified, source_changed,
        source_error, at, ack_error="", authorization=None):
    """Validate a user scope decision and return a detached scan record."""
    include = _scope_include(include_text)
    error = _scope_error(
        scan, current_step, include, none, ack,
        ack_verified, ack_error, source_changed,
        source_error,
    )
    if error:
        return ScopeDecision(error=error)
    updated = copy.deepcopy(scan)
    candidates = updated.get("scope_candidates") or []
    selected = [
        (
            item.get("rule", ""),
            item.get("file", ""),
            item.get("line"),
        )
        for item in candidates
        if str(item.get("id", "")).upper() in include
    ]
    updated["pairs"] = (
        list(updated.get("pairs") or []) + selected)
    updated["scope_reasons"] = (
        list(updated.get("scope_reasons") or [])
        + [{
            "rule": item.get("rule", ""),
            "file": item.get("file", ""),
            "line": item.get("line"),
            "reason": "用户确认涉及本次修改（%s）"
            % item.get("id", ""),
        } for item in candidates
            if str(item.get("id", "")).upper() in include]
    )
    updated["count"] = len(updated["pairs"])
    updated["stock_excluded"] = (
        len(candidates) - len(selected))
    updated["scope_pending"] = False
    updated["scope_review"] = {
        "head": updated.get("head", ""),
        "included": sorted(include),
        "authorization": copy.deepcopy(authorization or {}),
        "at": at,
    }
    excluded = [
        item.get("id")
        for item in candidates
        if str(item.get("id", "")).upper() not in include
    ]
    event = {
        "head": updated.get("head", ""),
        "candidates": candidates,
        "included": sorted(include),
        "excluded": excluded,
        "authorization": copy.deepcopy(authorization or {}),
        "final_count": updated["count"],
        "stock_excluded": updated["stock_excluded"],
    }
    return ScopeDecision(
        record=updated,
        event=event,
        included=tuple(sorted(include)),
        excluded=tuple(excluded),
    )


def decide_scope_with_ports(
        *, scan, current_step, include_text, none,
        ack, authorization, source_changed_since, verify_ack, now):
    """Collect freshness and acknowledgement facts only when required."""
    error = _scan_scope_error(
        scan, current_step, (), "")
    if error:
        return ScopeDecision(error=error)
    changed, source_error = source_changed_since(
        scan.get("head", ""))
    error = _scan_scope_error(
        scan, current_step, changed, source_error)
    if error:
        return ScopeDecision(error=error)
    include = _scope_include(include_text)
    error = _selection_error(
        scan.get("scope_candidates") or [],
        include,
        none,
    )
    if error:
        return ScopeDecision(error=error)
    if not ack:
        return ScopeDecision(
            error="codecheck-scope 的消息 ID 没有解析出用户回答。")
    ack_verified, ack_error = verify_ack(ack)
    return decide_scope(
        scan=scan,
        current_step=current_step,
        include_text=include_text,
        none=none,
        ack=ack,
        ack_verified=ack_verified,
        ack_error=ack_error,
        source_changed=changed,
        source_error=source_error,
        at=now(),
        authorization=authorization,
    )


def build_manual_records(
        *, step, head, files, count, diagnostic,
        diagnostic_sha256, reason, authorization, at, log_path):
    """Build matching manual and scan cache records."""
    manual = {
        "step": step,
        "head": head,
        "files": list(files),
        "count": count,
        "diagnostic": diagnostic,
        "diagnostic_sha256": diagnostic_sha256,
        "reason": reason,
        "authorization": copy.deepcopy(authorization or {}),
        "at": at,
    }
    scan = {
        "step": step,
        "head": head,
        "files": list(files),
        "pairs": [],
        "commands": [
            "人工核对诊断文件:" + diagnostic],
        "count": count,
        "at": at,
        "manual": True,
        "log_path": log_path,
    }
    event = {
        "head": head,
        "files": list(files),
        "count": count,
        "diagnostic": diagnostic,
        "diagnostic_sha256": diagnostic_sha256,
        "reason": reason,
        "authorization": copy.deepcopy(authorization or {}),
    }
    return ManualRecords(
        manual=manual,
        scan=scan,
        event=event,
    )

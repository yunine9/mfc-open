"""Pure creation and freshness checks for Hook quality receipts."""

from dataclasses import dataclass
import hashlib
import re
from typing import Mapping, Optional, Tuple


@dataclass(frozen=True)
class ReceiptContext:
    at: str
    head: str
    source_snapshot: Optional[Mapping] = None


def same_config(actual, expected):
    def normalized(value):
        return re.sub(r"\s+", "", str(value or "")).lower()

    got = normalized(actual)
    wanted = normalized(expected)
    return bool(got) and bool(wanted) and wanted in got


def askuser_receipt(tool_input):
    """Keep only the displayed question and option labels needed for choice proof."""
    questions = []
    for question in (tool_input or {}).get("questions") or []:
        if not isinstance(question, dict):
            continue
        labels = []
        for option in question.get("options") or []:
            label = (
                option.get("label", "")
                if isinstance(option, dict) else option)
            label = str(label or "").strip()
            if label:
                labels.append(label)
        if labels:
            questions.append({
                "question": str(
                    question.get("question", "") or "").strip(),
                "options": labels,
            })
    return {"questions": questions} if questions else {}


def _common(task, context):
    receipt = {
        "at": context.at,
        "step": task.get("step", ""),
        "task_sha256": task.get("sha256", ""),
        "head": context.head,
    }
    if task.get("standalone"):
        receipt["source_snapshot"] = dict(
            context.source_snapshot or {})
    return receipt


def plan_codecheck_build_receipt(task, context, build):
    return dict(_common(task, context), build=build)


def plan_codecheck_fullcheck_receipt(
        task, context, command_count, raw_counts, scan,
        expected_raw=None, result_hashes=()):
    count = int(command_count)
    counts = list(raw_counts)
    complete = (
        len(counts) == count
        and all(isinstance(value, int) and value >= 0 for value in counts)
    )
    return dict(
        _common(task, context),
        command_count=count,
        raw_counts=counts,
        raw_total=int(sum(counts)),
        machine_counts_complete=complete,
        expected_raw=(
            int(expected_raw) if expected_raw is not None else None),
        result_hashes=list(result_hashes or ()),
        scan_count=scan.get("count"),
        stock_excluded=scan.get("stock_excluded"),
    )


def plan_ut_generator_receipt(task, context, value):
    return dict(_common(task, context), value=value)


def plan_ut_run_receipt(
        task, context, value, reported_counts, result):
    digest = hashlib.sha256(
        str(result or "").encode(
            "utf-8", errors="replace")).hexdigest()
    return dict(
        _common(task, context),
        value=value,
        reported_counts=dict(reported_counts),
        result_sha256=digest,
    )


def plan_compile_run_receipt(
        task, context, build, status, result):
    """Bind an opaque compile run without persisting provider output."""
    digest = hashlib.sha256(
        str(result or "").encode(
            "utf-8", errors="replace")).hexdigest()
    receipt = dict(
        _common(task, context),
        task_issuance_id=task.get("issuance_id", ""),
        build=build,
        status=status,
        result_sha256=digest,
    )
    if context.source_snapshot is not None:
        receipt["source_snapshot"] = dict(context.source_snapshot)
    return receipt


def _same_task(receipt, task):
    """Whether a receipt belongs to this task card.

    Task cards carry no digest, so the receipt stores ``""``. Comparing a
    stored ``""`` against a missing key (``None``) made every freshly issued
    receipt look like it belonged to a different card, which silently killed
    all receipt reuse and forced a full recompile/recheck on every re-report.
    Freshness itself is enforced by ``_fresh`` from real source changes.
    """
    return bool(
        receipt
        and receipt.get("step") == task.get("step")
        and str(receipt.get("task_sha256") or "")
        == str(task.get("sha256") or "")
    )


def _fresh(
        receipt, task, standalone_snapshot, changed_paths, source_error):
    if task.get("standalone"):
        return receipt.get("source_snapshot") == (
            standalone_snapshot or {})
    return not source_error and not changed_paths


def reusable_ut_receipt(
        receipt, task, expected=None, standalone_snapshot=None,
        changed_paths: Tuple[str, ...] = (), source_error=""):
    if not _same_task(receipt, task):
        return None
    if (
            expected is not None
            and not same_config(receipt.get("value", ""), expected)):
        return None
    return (
        receipt
        if _fresh(
            receipt,
            task,
            standalone_snapshot,
            changed_paths,
            source_error,
        )
        else None
    )


def reusable_compile_run_receipt(
        receipt, task, expected_build, status, source_snapshot=None,
        changed_paths: Tuple[str, ...] = (), source_error=""):
    if not _same_task(receipt, task):
        return None
    if (
            receipt.get("task_issuance_id", "")
            != task.get("issuance_id", "")
            or not same_config(receipt.get("build", ""), expected_build)
            or receipt.get("status") != status):
        return None
    if task.get("standalone") or task.get("precommit_review"):
        if "source_snapshot" not in receipt:
            return None
        return (
            receipt
            if receipt.get("source_snapshot") == (source_snapshot or {})
            else None
        )
    return (
        receipt
        if _fresh(
            receipt,
            task,
            source_snapshot,
            changed_paths,
            source_error,
        )
        else None
    )


def reusable_codecheck_build_receipt(
        receipt, task, expected_build, standalone_snapshot=None,
        changed_paths: Tuple[str, ...] = (), source_error=""):
    if not _same_task(receipt, task):
        return None
    if not same_config(receipt.get("build", ""), expected_build):
        return None
    if not task.get("standalone") and not receipt.get("head"):
        return None
    return (
        receipt
        if _fresh(
            receipt,
            task,
            standalone_snapshot,
            changed_paths,
            source_error,
        )
        else None
    )


def _coherent_fullcheck(receipt, command_count):
    counts = receipt.get("raw_counts")
    if (
            not isinstance(counts, list)
            or not all(
                isinstance(value, int) and value >= 0 for value in counts)
            or sum(counts) != receipt.get("raw_total")):
        return False
    if receipt.get("machine_counts_complete"):
        return len(counts) == int(command_count)
    return not counts and bool(receipt.get("result_hashes"))


def reusable_codecheck_fullcheck_receipt(
        receipt, task, command_count, scan, standalone_snapshot=None,
        changed_paths: Tuple[str, ...] = (), source_error=""):
    if not _same_task(receipt, task):
        return None
    if (
            receipt.get("command_count") != int(command_count)
            or receipt.get("scan_count") != scan.get("count")
            or receipt.get("stock_excluded") != scan.get(
                "stock_excluded")
            or not _coherent_fullcheck(receipt, command_count)):
        return None
    return (
        receipt
        if _fresh(
            receipt,
            task,
            standalone_snapshot,
            changed_paths,
            source_error,
        )
        else None
    )

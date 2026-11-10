"""Observable UT-writing artifacts, separate from local UT execution.

The receipt proves which existing tests were inspected and which test files
changed. It intentionally does not claim that tests ran; local execution or a
SHA-bound pipeline remains the authority for that separate capability.
"""

import hashlib
import json
import os


SCHEMA = "mae-flow-ut-artifact/1"
RECEIPT_FIELDS = (
    "inspected_existing",
    "added_test_paths",
    "modified_test_paths",
    "test_digest",
    "coverage_targets",
)
_READ_TOOLS = frozenset(("read",))
_WRITE_TOOLS = frozenset(("write", "edit", "multiedit"))


def _relative_path(value, repository_root):
    if not isinstance(value, str) or not value:
        return ""
    root = os.path.realpath(os.path.abspath(repository_root))
    source = value.replace("\\", os.sep)
    target = os.path.realpath(os.path.abspath(
        source if os.path.isabs(source) else os.path.join(root, source)))
    try:
        if os.path.commonpath((root, target)) != root:
            return ""
    except (TypeError, ValueError):
        return ""
    relative = os.path.relpath(target, root).replace(os.sep, "/")
    return "" if relative in ("", ".") or relative.startswith("../") else relative


def successful_direct_paths(calls, repository_root):
    """Return successful direct file reads and writes from one transcript."""
    reads, writes = set(), set()
    for call in calls or ():
        name = str(getattr(call, "name", "") or "").lower()
        if name not in _READ_TOOLS | _WRITE_TOOLS:
            continue
        if (not getattr(call, "result_seen", False)
                or getattr(call, "is_error", False)
                or not isinstance(getattr(call, "input", None), dict)):
            continue
        path = _relative_path(
            call.input.get("path") or call.input.get("file_path"),
            repository_root)
        if path:
            (reads if name in _READ_TOOLS else writes).add(path)
    return tuple(sorted(reads)), tuple(sorted(writes))


def coverage_targets(targets, batches=()):
    """Freeze the active adaptive batch, or all hunk targets when unbatched."""
    active = tuple(
        str(item).strip()
        for batch in (batches or ()) for item in batch
        if str(item).strip())
    if active:
        return tuple(dict.fromkeys(active))
    flattened = []
    for path, rows in sorted((targets or {}).items()):
        if not rows:
            flattened.append(str(path) + " | 删除/迁移行为")
            continue
        for row in rows:
            flattened.append("%s:%s-%s | %s" % (
                path, row.get("start", "?"), row.get("end", "?"),
                row.get("context") or "按变更行定位函数"))
    return tuple(dict.fromkeys(flattened))


def task_contract(targets, batches=()):
    return {
        "schema": SCHEMA,
        "inspected_existing": [],
        "added_test_paths": [],
        "modified_test_paths": [],
        "test_digest": "",
        "coverage_targets": list(coverage_targets(targets, batches)),
    }


def _digest(fingerprints):
    if not fingerprints:
        return ""
    encoded = json.dumps(
        fingerprints, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _unique_paths(paths):
    return sorted(dict.fromkeys(
        str(path) for path in (paths or ()) if str(path)))


def _classify_changed(paths, existed_at_head):
    added, modified = [], []
    for path in _unique_paths(paths):
        (modified if existed_at_head(path) else added).append(path)
    return added, modified


def _inspected_paths(paths, modified, existed_at_head):
    existing = []
    for path in _unique_paths(paths):
        if existed_at_head(path):
            existing.append(path)
    return sorted(set(existing) | set(modified))


def _artifact_fingerprints(paths, fingerprint):
    values = {}
    for path in paths:
        value = fingerprint(path)
        if value:
            values[path] = value
    return values


def build_receipt(
        task, *, inspected_paths, changed_test_paths, existed_at_head,
        fingerprint, invocation_id, at):
    """Build one task-bound artifact receipt from repository/tool facts."""
    contract = (task or {}).get("ut_artifact_contract") or {}
    added, modified = _classify_changed(
        changed_test_paths, existed_at_head)
    # Editing a tracked test necessarily inspects its old content, even when
    # the host records Edit but no separate Read call.
    inspected = _inspected_paths(
        inspected_paths, modified, existed_at_head)
    artifact_paths = sorted(set(inspected) | set(added) | set(modified))
    fingerprints = _artifact_fingerprints(artifact_paths, fingerprint)
    return {
        "schema": SCHEMA,
        "step": str((task or {}).get("step", "") or ""),
        "task_head": str((task or {}).get("head", "") or ""),
        "task_path": str((task or {}).get("path", "") or ""),
        "invocation_id": str(invocation_id or ""),
        "at": str(at or ""),
        "inspected_existing": inspected,
        "added_test_paths": added,
        "modified_test_paths": modified,
        "test_digest": _digest(fingerprints),
        "coverage_targets": list(contract.get("coverage_targets") or ()),
    }


def receipt_has_artifact(receipt):
    if not isinstance(receipt, dict) or receipt.get("schema") != SCHEMA:
        return False
    paths = (
        list(receipt.get("inspected_existing") or ())
        + list(receipt.get("added_test_paths") or ())
        + list(receipt.get("modified_test_paths") or ()))
    return bool(paths and receipt.get("test_digest"))


def merge_receipts(receipts):
    """Aggregate adaptive batches without weakening each receipt's identity."""
    valid = [dict(item) for item in (receipts or ())
             if receipt_has_artifact(item)]
    merged = {
        "schema": SCHEMA,
        "inspected_existing": [],
        "added_test_paths": [],
        "modified_test_paths": [],
        "test_digest": "",
        "coverage_targets": [],
        "receipts": [item.get("invocation_id", "") for item in valid],
    }
    for field in (
            "inspected_existing", "added_test_paths",
            "modified_test_paths", "coverage_targets"):
        merged[field] = sorted(set(
            value for item in valid for value in (item.get(field) or ())
            if value))
    if valid:
        merged["test_digest"] = _digest({
            item.get("invocation_id", str(index)): item.get("test_digest", "")
            for index, item in enumerate(valid)
        })
    return merged

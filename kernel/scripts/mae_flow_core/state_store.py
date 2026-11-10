"""Versioned, cross-process-safe JSON persistence for Mae-Flow.

`os.replace` prevents torn JSON but does not prevent two Hook processes from
overwriting each other's read-modify-write updates.  This module adds one short
project-scoped lock plus a monotonically increasing revision.
"""

import copy
import hashlib
import json
import os
import tempfile
import time
from datetime import datetime


CURRENT_SCHEMA_VERSION = 2


class StateStoreError(RuntimeError):
    pass


class StateLockTimeout(StateStoreError):
    pass


class StateConflictError(StateStoreError):
    pass


def _lock_dir(project_root):
    root = os.path.normcase(os.path.abspath(project_root or os.getcwd()))
    key = hashlib.sha256(root.encode("utf-8", errors="replace")).hexdigest()[:24]
    return os.path.join(tempfile.gettempdir(), "mae-flow-state-locks", key + ".lock")


class ProjectStateLock:
    """Portable lock based on atomic directory creation.

    The lock lives in the OS temp directory, so pre-init operations do not add
    `.mae-flow-work/` to an otherwise untouched repository.
    """

    def __init__(self, project_root=None, timeout=2.0, stale_after=30.0):
        self.path = _lock_dir(project_root or os.getcwd())
        self.timeout = timeout
        self.stale_after = stale_after
        self.acquired = False

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                os.mkdir(self.path)
                self.acquired = True
                return self
            except FileExistsError:
                try:
                    age = time.time() - os.path.getmtime(self.path)
                    if age > self.stale_after:
                        os.rmdir(self.path)
                        continue
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise StateLockTimeout(
                        "等待 Mae-Flow 状态锁超时；另一 Hook/命令可能仍在写状态")
                time.sleep(0.01)
            except PermissionError:
                # Windows 删除语义(CI 实锤):并发释放锁的 rmdir 让目录进入
                # "删除挂起",此窗口内 mkdir 同名报 WinError 5 而非
                # FileExistsError——语义上就是"锁被占",按占用重试,
                # 绝不能让锁自身崩溃(多 hook 并发写状态的生产核心路径)。
                if time.monotonic() >= deadline:
                    raise StateLockTimeout(
                        "等待 Mae-Flow 状态锁超时；另一 Hook/命令可能仍在写状态")
                time.sleep(0.01)

    def __exit__(self, exc_type, exc, tb):
        if self.acquired:
            try:
                os.rmdir(self.path)
            except OSError:
                pass
        self.acquired = False


def read_json(path):
    # utf-8-sig:团队手写并提交的 JSON(如 .mae-flow-defaults.json)常被
    # Windows 编辑器存成带 BOM 的 UTF-8;对无 BOM 文件无害。
    with open(path, encoding="utf-8-sig") as stream:
        return json.load(stream)


def safe_read_json(path):
    if not os.path.isfile(path):
        return None, None
    try:
        return read_json(path), None
    except Exception as exc:
        return None, "%s: %s" % (type(exc).__name__, exc)


def _replace_with_retry(src, dst, attempts=6, base_delay=0.05):
    """Windows 杀软/索引器会短暂锁住目标文件,os.replace 抛 PermissionError。
    指数退避重试(总计 ~1.5s)后仍失败才向上抛;丢写比多等一秒昂贵得多。"""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(base_delay * (2 ** i))


def remove_with_retry(path, attempts=6, base_delay=0.05):
    """删除同样会撞杀软的短锁窗口;不存在视为已完成。"""
    for i in range(attempts):
        try:
            os.remove(path)
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(base_delay * (2 ** i))


def atomic_write_json(path, data):
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(path, text)


def atomic_write_text(path, text):
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    tmp = "%s.tmp.%s.%s" % (path, os.getpid(), time.time_ns())
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            try:
                os.fsync(stream.fileno())
            except OSError:
                pass
        _replace_with_retry(tmp, path)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


def normalize_document(data, kind):
    """Migrate an old document in memory without discarding unknown fields."""
    if not isinstance(data, dict):
        raise ValueError("%s 状态必须是 JSON object" % kind)
    out = copy.deepcopy(data)

    # Lean schema-v3 is an isolated recovery cursor.  It must not inherit the
    # schema-v2 defaults, revision metadata, or legacy `current` requirement.
    if kind == "flow" and out.get("engine") == "lean-v1":
        if (type(out.get("schema_version")) is not int
                or out.get("schema_version") != 3):
            raise ValueError("lean-v1 flow 状态版本必须是 3")
        return out

    version = int(out.get("schema_version", 0) or 0)
    if version > CURRENT_SCHEMA_VERSION:
        raise ValueError(
            "%s 状态版本 %s 高于当前支持版本 %s" %
            (kind, version, CURRENT_SCHEMA_VERSION))

    if kind == "flow":
        out.setdefault("config", {})
        out.setdefault("choices", {})
        out.setdefault("history", [])
        if not isinstance(out.get("current"), str) or not out.get("current"):
            raise ValueError("flow 状态缺少 current")
    elif kind == "action":
        out.setdefault("tokens", {})
        out.setdefault("rejections", {})
        out.setdefault("quality", {})
        if not isinstance(out.get("kind"), str) or not out.get("kind"):
            raise ValueError("action 状态缺少 kind")
    elif kind == "exit":
        out.setdefault("status", "exited")

    out["schema_version"] = CURRENT_SCHEMA_VERSION
    out["revision"] = int(out.get("revision", 0) or 0)
    return out


def _stamp_appended_history(document, previous):
    """Capture the writer's timezone for appended history without rewriting at.

    Legacy CLI consumers compare/parse at as local wall time. Keep it intact,
    and add an absolute instant for readers on other hosts. Never backfill old
    rows: the current process may not share their original writer's timezone.
    Only an unchanged prefix followed by new rows is a known append.
    """
    old = (previous or {}).get("history", [])
    rows = document.get("history", [])
    if not isinstance(old, list) or not isinstance(rows, list):
        return
    if rows[:len(old)] != old:
        return
    for row in rows[len(old):]:
        if not isinstance(row, dict) or row.get("at_iso"):
            continue
        try:
            stamp = datetime.fromisoformat(str(row.get("at", "")).replace("Z", "+00:00"))
            row["at_iso"] = stamp.astimezone().isoformat()
        except (ValueError, OverflowError, OSError):
            # Invalid optional display metadata must not break state writes.
            continue


def save_versioned_json(path, data, kind, project_root=None, expected_revision=None):
    """Save a complete versioned document with optional compare-and-swap."""
    if (kind == "flow" and isinstance(data, dict)
            and data.get("engine") == "lean-v1"):
        raise ValueError("lean-v1 test-only 状态不能使用 schema-v2 writer")
    root = project_root or os.getcwd()
    with ProjectStateLock(root):
        current, err = safe_read_json(path)
        if err:
            raise StateStoreError(
                "%s 当前状态不可读，拒绝覆盖坏现场（%s）" % (kind, err))
        if current is not None:
            current = normalize_document(current, kind)
            if kind == "flow" and current.get("engine") == "lean-v1":
                raise ValueError(
                    "lean-v1 test-only 状态不能使用 schema-v2 writer")
        current_revision = int((current or {}).get("revision", 0) or 0)
        wanted = expected_revision
        if wanted is None and isinstance(data, dict) and "revision" in data:
            wanted = int(data.get("revision", 0) or 0)
        if wanted is not None and current is not None and wanted != current_revision:
            raise StateConflictError(
                "%s revision 已从 %s 变为 %s，拒绝用旧快照覆盖新状态" %
                (kind, wanted, current_revision))
        saved = normalize_document(data, kind)
        if kind == "flow":
            _stamp_appended_history(saved, current)
        saved["revision"] = current_revision + 1
        saved["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        atomic_write_json(path, saved)
        if isinstance(data, dict):
            data.clear()
            data.update(copy.deepcopy(saved))
        return saved


def _quarantine_corrupt(path):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = "%s.corrupt.%s.%s" % (path, stamp, os.getpid())
    target, suffix = base, 2
    while os.path.exists(target):
        target, suffix = base + "." + str(suffix), suffix + 1
    _replace_with_retry(path, target)
    return target


def update_json(path, mutator, default=None, project_root=None,
                recover_corrupt=False):
    """Locked read-modify-write for sidecars that intentionally have no schema."""
    root = project_root or os.getcwd()
    with ProjectStateLock(root):
        current, err = safe_read_json(path)
        if err:
            if not recover_corrupt:
                raise ValueError("状态文件不可读 %s (%s)" % (path, err))
            _quarantine_corrupt(path)
            current = copy.deepcopy(default)
        if current is None:
            current = copy.deepcopy(default)
        result = mutator(current)
        if result is None:
            result = current
        atomic_write_json(path, result)
        return result


def update_versioned_json(path, kind, mutator, default=None, project_root=None):
    """Locked read-modify-write for flow/action/exit documents."""
    root = project_root or os.getcwd()
    with ProjectStateLock(root):
        current, err = safe_read_json(path)
        if err:
            raise ValueError("状态文件不可读 %s (%s)" % (path, err))
        if current is None:
            current = copy.deepcopy(default or {})
        if (kind == "flow" and isinstance(current, dict)
                and current.get("engine") == "lean-v1"):
            raise ValueError("lean-v1 test-only 状态不能使用 schema-v2 writer")
        current = normalize_document(current, kind)
        previous = copy.deepcopy(current) if kind == "flow" else None
        revision = int(current.get("revision", 0) or 0)
        result = mutator(current)
        if result is None:
            result = current
        if (kind == "flow" and isinstance(result, dict)
                and result.get("engine") == "lean-v1"):
            raise ValueError("lean-v1 test-only 状态不能使用 schema-v2 writer")
        result = normalize_document(result, kind)
        if kind == "flow":
            _stamp_appended_history(result, previous)
        result["revision"] = revision + 1
        result["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        atomic_write_json(path, result)
        return result

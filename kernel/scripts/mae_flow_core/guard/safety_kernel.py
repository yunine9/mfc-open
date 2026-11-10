"""Pure, fail-open safety policy for lean workflow tool calls."""

from collections.abc import Mapping
from dataclasses import dataclass, replace
import ntpath
import os
import posixpath

from ..foundation import git_intent
from ..foundation.commit_message import valid_business_commit_message
from ..foundation.source_paths import (
    normalize_path,
    repository_path_identity,
)
from ..orchestration import FlowState
from .command_policy import dangerous_bash_result, recursive_delete_facts
from .manifest import DeliveryManifest, authorize_delivery, compare_staged


_ADOPTED_DIRTY = "delivery.adopted_dirty"
@dataclass(frozen=True)
class SafetyDecision:
    allow: bool
    rule: str = ""
    message: str = ""


@dataclass(frozen=True)
class SafetyContext:
    state: FlowState
    repository_root: str
    staged_files: tuple = ()
    commit_files: tuple = ()
    initial_dirty: tuple = ()
    current_dirty_fingerprints: tuple = ()
    # safe_write_targets 随 source_edit 闸退役一并拆除:它只为"哪些
    # 路径豁免语义授权"服务,闸没了它就是没有读方的字段。
    task_owned_temp_dir: str = ""


def _allow(rule=""):
    return SafetyDecision(True, rule=rule)


def _block(rule, message):
    return SafetyDecision(False, rule=rule, message=message)


def _values(input_value, key):
    if not isinstance(input_value, Mapping):
        return ()
    value = input_value.get(key, ())
    if isinstance(value, str):
        return (value,)
    try:
        return tuple(value)
    except TypeError:
        return ()


def _command(tool_input):
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, Mapping):
        value = tool_input.get("command", "")
        return value if isinstance(value, str) else ""
    return ""


def _write_targets(tool, tool_input):
    targets = _values(tool_input, "targets")
    if targets:
        return targets
    if not isinstance(tool_input, Mapping):
        return ()
    if str(tool or "").lower() not in {
            "applypatch", "apply_patch", "edit", "multiedit", "write"}:
        return ()
    for key in ("file_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return (value,)
    return ()


def _uses_windows_paths(repository_root):
    normalized = normalize_path(repository_root).strip().strip("\"'")
    drive, _ = ntpath.splitdrive(normalized)
    return os.name == "nt" or bool(drive)


def _canonical_repository_root(repository_root):
    normalized = normalize_path(repository_root).strip().strip("\"'")
    if not normalized:
        raise ValueError("repository root is required")
    return posixpath.normpath(normalized)


def _relative_target(context, path):
    if not isinstance(path, str):
        return ""
    normalized = normalize_path(path).strip().strip("\"'")
    if not normalized:
        return ""
    root = _canonical_repository_root(context.repository_root)
    root_drive, _ = ntpath.splitdrive(root)
    target_drive, target_tail = ntpath.splitdrive(normalized)
    if target_drive and not target_tail.startswith("/"):
        raise ValueError("drive-relative write targets are ambiguous")
    if target_drive:
        canonical = posixpath.normpath(normalized)
    elif normalized.startswith("/"):
        if root_drive and not normalized.startswith("//"):
            canonical = posixpath.normpath(root_drive + normalized)
        else:
            canonical = posixpath.normpath(normalized)
    else:
        canonical = posixpath.normpath(posixpath.join(root, normalized))

    case_insensitive = _uses_windows_paths(context.repository_root)
    root_identity = repository_path_identity(
        root, case_insensitive=case_insensitive)
    canonical_identity = repository_path_identity(
        canonical, case_insensitive=case_insensitive)
    if canonical_identity == root_identity:
        return "."
    root_prefix = root_identity.rstrip("/") + "/"
    if canonical_identity.startswith(root_prefix):
        return canonical[len(root.rstrip("/")) + 1:]
    return canonical


def _write_identity(context, path):
    return repository_path_identity(
        path,
        case_insensitive=_uses_windows_paths(context.repository_root),
    )


def _is_protected_control(path):
    lowered = repository_path_identity(
        path, case_insensitive=True).casefold()
    first = lowered.split("/", 1)[0]
    if first == ".mae-flow-work":
        return lowered == ".mae-flow-work/moonlight-report.md"
    return (
        first == ".mae-flow"
        or first.startswith(".mae-flow.")
        or first.startswith(".mae-flow-")
    )


def _edit_decision(context, tool, tool_input):
    targets = []
    try:
        for path in _write_targets(tool, tool_input):
            relative = _relative_target(context, path)
            if relative:
                targets.append(relative)
    except ValueError:
        # 规则名随 source_edit 闸退役更正:这条拦的是"写目标无法安全
        # 解析",不是源码阶段授权。
        return _block(
            "write_target",
            "Write targets must be unambiguous repository paths.",
        )
    if any(_is_protected_control(path) for path in targets):
        return _block(
            "protected_control",
            "Mae-Flow control files cannot be edited by workflow tools.",
        )
    # 步骤级/阶段级"源码编辑需要语义授权"已随 2026-08-28 退役整体拆除:
    # 这里曾按 phase 拦源码编辑("Source edits require semantic
    # authorization"),而它要求的授权 key(focused.scope_approved /
    # quality.source_fix_approved)全仓从无签发方——"要求的出路实际
    # 不存在"的教科书案例;lean kernel 一旦接线就会原地复现"能提交
    # 不能编辑"事故。保留的只有绝对保护(控制文件)与路径可解析性检查。
    return None


def _unsafe_delete_targets(context, targets):
    if not context.task_owned_temp_dir:
        return tuple(targets)
    try:
        task_temp = _relative_target(context, context.task_owned_temp_dir)
        task_identity = _write_identity(context, task_temp).rstrip("/")
    except ValueError:
        return tuple(targets)
    unsafe = []
    for target in targets:
        try:
            relative = _relative_target(context, target)
            identity = _write_identity(context, relative).rstrip("/")
        except ValueError:
            unsafe.append(target)
            continue
        if identity != task_identity and not identity.startswith(
                task_identity + "/"):
            unsafe.append(target)
    return tuple(unsafe)


def _dangerous_bash_decision(context, command, tool_input):
    supplied = _values(tool_input, "recursive_delete_targets")
    delete_targets = supplied or recursive_delete_facts(command)
    rule, message = dangerous_bash_result(
        command, _unsafe_delete_targets(context, delete_targets))
    return _block(rule, message) if rule else None


def _adopted_paths(state):
    return tuple(
        value for key, value in state.decisions
        if key == _ADOPTED_DIRTY
    )


def _manifest(context):
    try:
        manifest = DeliveryManifest.from_paths(
            context.state.delivery_files,
            adopted_dirty=_adopted_paths(context.state),
            repository_root=context.repository_root,
        )
        validation_state = replace(
            context.state,
            initial_dirty=_initial_dirty_paths(context),
        )
        authorize_delivery(validation_state, manifest)
        return manifest
    except (TypeError, ValueError):
        return None


def _identities(paths):
    return {
        repository_path_identity(path, case_insensitive=True)
        for path in paths
        if isinstance(path, str)
    }


def _initial_dirty_paths(context):
    paths = []
    seen = set()

    def append(path):
        identity = repository_path_identity(path, case_insensitive=True)
        if identity not in seen:
            seen.add(identity)
            paths.append(path)

    for path in context.state.initial_dirty:
        if isinstance(path, str):
            append(path)
    for item in context.initial_dirty:
        if isinstance(item, str):
            append(item)
        elif (
                isinstance(item, (list, tuple))
                and len(item) == 2
                and isinstance(item[0], str)):
            append(item[0])
    return tuple(paths)


def _manifest_has_unadopted_dirty(context, manifest):
    initial = _identities(_initial_dirty_paths(context))
    adopted = _identities(manifest.adopted_dirty)
    delivery = _identities(manifest.files)
    return bool((initial & delivery) - adopted)


def _stage_decision(context, intent):
    """Staging is reversible local preparation, not publication permission."""
    return _allow("git_staging")


def _exact_manifest_decision(context, actual_files, rule):
    manifest = _manifest(context)
    if (
            manifest is None
            or not manifest.files
            or _manifest_has_unadopted_dirty(context, manifest)):
        return _block(
            rule,
            "Delivery requires an authorized manifest with explicit dirty adoption.",
        )
    try:
        comparison = compare_staged(manifest, actual_files)
    except (TypeError, ValueError):
        return _block(rule, "Delivery file facts are not exact repository files.")
    if not comparison.matches:
        return _block(
            rule,
            "Delivery files do not exactly match the authorized manifest.",
        )
    return _allow(rule)


def _commit_decision(context, intent):
    """A local commit needs no formatting, file-batch or task-card permit."""
    return _allow("git_commit")


def _commit_message(arguments):
    for index, token in enumerate(arguments):
        if token in ("-m", "--message"):
            return arguments[index + 1] if index + 1 < len(arguments) else ""
        if token.startswith("--message="):
            return token.split("=", 1)[1]
        if token.startswith("-m") and token != "-m":
            return token[2:]
    return None


def _push_decision(context, intent):
    if intent.opaque_pathspec:
        return _block(
            "git_publish",
            "Opaque wrapped Git publish cannot be authorized exactly.",
        )
    return _exact_manifest_decision(
        context, context.commit_files, "git_publish")


def decide_pretool(context, tool, tool_input):
    """Return the first narrow safety rule for one already-factored tool call."""
    if not isinstance(context, SafetyContext):
        raise TypeError("context must be a SafetyContext")
    if not isinstance(context.state, FlowState):
        raise TypeError("context.state must be a FlowState")

    command = _command(tool_input)
    if command:
        dangerous = _dangerous_bash_decision(context, command, tool_input)
        if dangerous is not None:
            return dangerous

    edit = _edit_decision(context, tool, tool_input)
    if edit is not None:
        return edit

    if command:
        for intent in git_intent.git_delivery_intents(command):
            if intent.operation == "add":
                decision = _stage_decision(context, intent)
            elif intent.operation == "commit":
                decision = _commit_decision(context, intent)
            else:
                decision = _push_decision(context, intent)
            if not decision.allow:
                return decision
    return _allow()


def decide_stateless_pretool(
        repository_root, tool, tool_input, task_owned_temp_dir=""):
    """Keep confirmed danger blocked when FlowState cannot be decoded."""
    if str(tool or "").casefold() != "bash":
        return _allow()
    context = SafetyContext(
        state=None,
        repository_root=repository_root,
        task_owned_temp_dir=task_owned_temp_dir,
    )
    command = _command(tool_input)
    if not command:
        return _allow()
    dangerous = _dangerous_bash_decision(context, command, tool_input)
    if dangerous is not None:
        return dangerous
    if any(
            intent.operation in ("commit", "push")
            for intent in git_intent.git_delivery_intents(command)):
        return _block(
            "git_delivery",
            "Delivery is blocked because the exact manifest state is unavailable.",
        )
    return _allow()

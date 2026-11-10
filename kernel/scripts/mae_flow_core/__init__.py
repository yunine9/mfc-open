"""Mae-Flow harness core.

Only infrastructure that must be shared by the CLI and Hook adapter belongs here.
Workflow semantics stay in flow/modes modules; host event details stay in dispatch.py.
"""

# 测试进程以及它派生的一切内核子进程,绝不弹真桌面通知。
# _popup 里的 unittest 探测只护得住本进程;测试常拉起真内核 CLI 当裁判,
# 子进程里没有 unittest,只能靠环境变量随继承传下去(2026-08-15 实锤:
# 跑内核全量,用户的 mac 被弹了一串"需要你确认")。setdefault 不覆盖用户
# 显式设置;生产 CLI 不导入 unittest/pytest,真用户路径恒为无操作。
import os as _os
import sys as _sys
if "unittest" in _sys.modules or "pytest" in _sys.modules:
    _os.environ.setdefault("MAE_FLOW_NO_NOTIFY", "1")

from .runtime import (
    ACTION_FILE,
    EXIT_FILE,
    FLOW_FILE,
    RuntimeMode,
    RuntimeSnapshot,
    find_project_root,
    resolve_runtime,
)
from .capabilities import (
    CAPABILITY_PACKS,
    CapabilityError,
    diagnostics as capability_diagnostics,
    ensure_codecheck,
    prepare_project,
    render_pack,
    run_comet,
    run_openspec,
)
from .state_store import (
    CURRENT_SCHEMA_VERSION,
    ProjectStateLock,
    StateConflictError,
    StateLockTimeout,
    StateStoreError,
    atomic_write_json,
    atomic_write_text,
    normalize_document,
    read_json,
    remove_with_retry,
    safe_read_json,
    save_versioned_json,
    update_json,
    update_versioned_json,
)
from .standalone import (
    action_path,
    action_work_dir,
    archive_action,
    archive_corrupt_action,
    load_action,
    save_action,
    update_action,
)
from .codecheck_log import (
    append_codecheck_event,
    codecheck_log_path,
    save_codecheck_artifact,
)
from .orchestration import (
    CapabilityAttempt,
    CommitPace,
    DeliveryPath,
    FlowState,
    Phase,
    decode_flow_state,
    encode_flow_state,
)

__all__ = [
    "ACTION_FILE",
    "EXIT_FILE",
    "FLOW_FILE",
    "CURRENT_SCHEMA_VERSION",
    "ProjectStateLock",
    "RuntimeMode",
    "RuntimeSnapshot",
    "CAPABILITY_PACKS",
    "CapabilityError",
    "capability_diagnostics",
    "ensure_codecheck",
    "prepare_project",
    "render_pack",
    "run_comet",
    "run_openspec",
    "StateConflictError",
    "StateLockTimeout",
    "StateStoreError",
    "atomic_write_json",
    "atomic_write_text",
    "find_project_root",
    "normalize_document",
    "read_json",
    "remove_with_retry",
    "resolve_runtime",
    "safe_read_json",
    "save_versioned_json",
    "update_json",
    "update_versioned_json",
    "action_path",
    "action_work_dir",
    "archive_action",
    "archive_corrupt_action",
    "load_action",
    "save_action",
    "update_action",
    "append_codecheck_event",
    "codecheck_log_path",
    "save_codecheck_artifact",
    "CapabilityAttempt",
    "CommitPace",
    "DeliveryPath",
    "FlowState",
    "Phase",
    "decode_flow_state",
    "encode_flow_state",
]

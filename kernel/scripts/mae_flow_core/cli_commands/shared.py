"""Imports and immutable values shared by CLI adapter modules."""

import glob as globmod, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile, time
from dataclasses import replace
from io import BytesIO

from comet_compat import BEGIN as COMET_COMPAT_BEGIN, comet_guard_paths, ensure_direct_mode_compat
from mae_flow_core import (
    CapabilityError,
    RuntimeMode,
    StateConflictError,
    StateStoreError,
    action_work_dir as core_action_work_dir,
    archive_action as core_archive_action,
    archive_corrupt_action as core_archive_corrupt_action,
    atomic_write_json,
    atomic_write_text,
    find_project_root as core_find_project_root,
    load_action as core_load_action,
    normalize_document,
    remove_with_retry,
    resolve_runtime,
    safe_read_json,
    save_action as core_save_action,
    save_versioned_json,
    update_json,
    append_codecheck_event,
    capability_diagnostics,
    codecheck_log_path,
    ensure_codecheck,
    prepare_project,
    render_pack,
    run_comet,
    run_openspec,
    save_codecheck_artifact,
)
from mae_flow_core.moonlight import (
    QUALITY_STEPS as MOONLIGHT_QUALITY_STEPS,
    REPAIR_ENTRY as MOONLIGHT_REPAIR_ENTRY,
    can_hard_block as moonlight_can_hard_block,
    data as moonlight_data,
    enabled as moonlight_enabled,
    resolve_kind as moonlight_resolve_kind,
    step_kind as moonlight_step_kind,
    unresolved as moonlight_unresolved,
)
from mae_flow_core.cli_parser import parse_args
from mae_flow_core import command_dispatch, specengine
from mae_flow_core.lightcheck import (
    analyze_changed_with_timeout,
    render_markdown,
)
from mae_flow_core.foundation.fingerprints import (
    path_fingerprint as _shared_path_fingerprint,
    review_path_fingerprint as _shared_review_path_fingerprint,
)
from mae_flow_core.foundation import source_paths
from mae_flow_core.foundation import git_intent
from mae_flow_core.file_io import load_json, read_bytes, read_lines, read_text, write_text
from mae_flow_core.application.delivery.standalone import (
    cancel_standalone,
    confirm_standalone_scope,
    finish_standalone,
    inspect_standalone,
    prepare_standalone_critic,
    start_standalone,
    validate_scope_confirmation,
    validate_standalone_start,
)
from mae_flow_core.application.delivery.moonlight import (
    activate_moonlight,
    disable_moonlight,
    finalize_moonlight,
    record_blocker,
    record_push_failure,
    repair_moonlight,
    validate_blocker,
    validate_finalize,
    validate_finalize_step,
    validate_push_failure,
)
from mae_flow_core.application.delivery.moonlight_branch import (
    MoonlightBranchFacts,
    resolve_moonlight_branch,
)
from mae_flow_core.application.delivery.moonlight_defer import (
    MoonlightDeferPorts,
    defer_moonlight_quality,
)
from mae_flow_core.application.quality.codecheck import (
    CodeCheckRunPorts,
    run_codecheck as execute_codecheck,
)
from mae_flow_core.application.quality import (
    task_cards as quality_task_card_use_cases,
)
from mae_flow_core.application.quality import (
    task_card_documents as quality_task_card_documents,
)
from mae_flow_core.application.quality import (
    codecheck_state as quality_codecheck_state,
)
from mae_flow_core.delivery.models import thaw as thaw_delivery_payload
from mae_flow_core.delivery.evidence import (
    DeliveryEvidencePorts,
    DeliveryEvidenceRules,
    review_has_confirmed_fix,
    review_status_count,
    review_statuses,
)
from mae_flow_core.delivery import moonlight as delivery_moonlight
from mae_flow_core.guard import intent as guard_intent
from mae_flow_core.guard.gate import (
    BashWriteContext,
    EditGateContext,
    decide_bash_write,
    decide_edit,
)
from mae_flow_core.guard.permits import (
    block_id as permit_block_id,
    check_permit,
    record_strike,
    strike_escalation,
)
from mae_flow_core.guard.ownership import (
    OwnershipFacts,
    decide_ownership,
)
from mae_flow_core.guard.bash import (
    BashGateContext,
    decide_commit_branch,
    decide_post_commit,
    decide_pre_commit,
)
from mae_flow_core.quality import task_cards as quality_task_cards
from mae_flow_core.foundation.models import EvidenceResult
from mae_flow_core.quality import codecheck as quality_codecheck
from mae_flow_core.quality.evidence import (
    QualityEvidencePorts,
    QualityEvidenceRules,
)
from mae_flow_core.workflow import advancement as workflow_advancement
from mae_flow_core.workflow.agent_evidence import (
    AgentEvidencePorts,
    AgentEvidenceRules,
)
from mae_flow_core.workflow import completion as workflow_completion
from mae_flow_core.workflow import definition as workflow_definition
from mae_flow_core.workflow.evidence_rules import (
    WorkflowEvidencePorts,
    WorkflowEvidenceRules,
    substitute as subst,
)
from mae_flow_core.workflow.evidence import build_evidence_registry
from mae_flow_core.workflow import transitions as workflow_transitions

# Read-only compatibility names for historical diagnostics.
_review_status_count = review_status_count
_review_statuses = review_statuses
_review_has_confirmed_fix = review_has_confirmed_fix

# 尊重宿主选择的控制台编码；只降级不可表示的 emoji/符号，避免整段中文乱码。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass



HERE = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".."))

FLOW_PATH = os.path.join(HERE, "..", "flow", "flow.json")

STEPS_DIR = os.path.join(HERE, "..", "flow", "steps")

STATE_PATH = ".mae-flow.json"

EXIT_PATH = ".mae-flow.json.exited"

AGENT_WRITES_PATH = STATE_PATH + ".agent-writes"

MOONLIGHT_INTENT_PATH = STATE_PATH + ".moonlight-intent"

EXIT_INTENT_PATH = STATE_PATH + ".exit-intent"

FAILURE_PATH = STATE_PATH + ".failures"

ACTION_PATH = os.path.join(".mae-flow-work", "standalone-action.json")

CONFIG_CONFIRM_ACK = "确认以上全部配置"

HISTORY_PATH = ".mae-flow-history.jsonl"

DEFAULTS_PATH = ".mae-flow-defaults.json"

# 下单事实(宿主契约,2026-08-19):云端下单表单收齐的配置事实——单号/
# 基线分支/工号/交付方式——由宿主写进工作区这个文件,内核直接消费:
# config-review 拿它们补缺省(--set 显式给的赢,打回改口不受影响),
# 配置确认卡不再问交付方式,workflow_select 无捕获答案时以它为准。
# 为什么是文件不是 prompt:prompt 靠模型转述,弱模型会漏、会再问一遍
# (车道实战);文件是机械读取,模型连转述的机会都没有。与仓库预设
# (.mae-flow-defaults.json,进仓的团队恒定项)不同,它是**每单**的、
# 宿主生成的、不进仓。
ORDER_PATH = ".mae-flow-order.json"


def load_order_facts():
    """读下单事实。缺席=非云端下单形态,一切照旧;解析失败可见不静默。"""
    if not os.path.exists(ORDER_PATH):
        return {}, ""
    try:
        with open(ORDER_PATH, encoding="utf-8-sig") as stream:
            data = json.load(stream)
        return (data if isinstance(data, dict) else {}), ""
    except Exception as e:
        return {}, f"⚠ {ORDER_PATH} 解析失败,已忽略(宿主生成的下单事实): {e}"


def resolve_order_workflow(step, facts):
    """下单事实的「交付方式」→ 内核 choice 代号;认代号或选项原文全等,
    不做子串搜索(与 ack 的对账纪律同款)。认不出返回 ""。"""
    value = str((facts or {}).get("交付方式", "") or "").strip()
    if not value:
        return ""
    answers = step.get("choice_answers") or {}
    for key in step.get("choices") or []:
        if value == key or value in (answers.get(key) or []):
            return key
    return ""

def workflow_chosen(st):
    """交付方式(choices.workflow)已选定=流程头部已走完。
    编辑/Bash 门禁用它封"配置确认前写源码"(2026-08-19 跨仓实锤)。"""
    return bool(((st or {}).get("choices") or {}).get("workflow"))


def source_unlocked_for(st, sid):
    """用户裁决的源码解锁是否对当前步生效(unlock source 的对账口)。"""
    unlock = (st or {}).get("unlock") or {}
    return unlock.get("scope") == "source" and unlock.get("step") == sid


def order_workflow_verdict(step, choice):
    """下单事实对 --choice 的裁决:(handled, accepted, why)。
    handled=False 表示下单事实没覆盖本步骤(文件缺席/交付方式认不出/
    步骤 choices 对不上),调用方走原有拒绝路径,一个字不变。"""
    order_wf = resolve_order_workflow(step, load_order_facts()[0])
    if not order_wf:
        return False, False, ""
    if order_wf == choice:
        return True, True, ""
    return True, False, (
        "用户下单时选定的交付方式是「%s」,但 Agent 准备提交 --choice %s。"
        "请按下单事实执行,禁止替用户改选;用户要换道须经确认卡打回改选。"
        % (order_wf, choice)
    )

FLOW = None

MOONLIGHT_REPORT_PATH = os.path.join(".mae-flow-work", "moonlight-report.md")

SOURCE_EXTS = source_paths.SOURCE_EXTENSIONS

SOURCE_FILENAMES = source_paths.SOURCE_FILENAMES

BUILD_DESCRIPTOR_EXTS = source_paths.BUILD_DESCRIPTOR_EXTENSIONS

BUILD_SCRIPT_EXTS = source_paths.BUILD_SCRIPT_EXTENSIONS

BUILD_ARTIFACT_STRONG_SUFFIXES = (
    ".o", ".obj", ".pyc", ".pyo", ".class", ".gcda", ".gcno",
    ".profraw", ".profdata", ".ilk", ".tlog", ".lastbuildstate",
    ".ninja_deps", ".ninja_log", ".log",
)

BUILD_ARTIFACT_STRONG_NAMES = {
    "cmakecache.txt", "cmake_install.cmake",
}

BUILD_ARTIFACT_STRONG_DIRS = {
    "cmakefiles", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".gradle", "node_modules", "coverage", "htmlcov",
}

BUILD_ARTIFACT_AMBIGUOUS_SUFFIXES = (
    ".a", ".lib", ".so", ".dll", ".dylib", ".exe", ".pdb",
    ".jar", ".war", ".ear",
)

BUILD_ARTIFACT_AMBIGUOUS_DIRS = {
    "build", "dist", "out", "target", "bin", "obj", "debug", "release",
    ".next", ".nuxt", ".svelte-kit", ".vite", ".turbo", ".parcel-cache",
}

_COMMIT_VALUE_OPTIONS = git_intent.COMMIT_VALUE_OPTIONS

_PathspecCollector = git_intent.PathspecCollector

REQ_SHA_MARKER = "MAE-FLOW-USERMSG-SHA256:"

_BINARY_PREFIXES = (b"%PDF-", b"PK\x03\x04", b"\x89PNG", b"\xff\xd8\xff", b"GIF8")

RISK_AGENT_LABELS = {
    "COMPILE": "没有可验证的编译成功证据，代码可能无法构建",
    "CODECHECK": "CodeCheck 修复 Agent 没有可验证的正常返回；本次将只保留首检结果，缺少专项修复结论",
    "CODECHECK_TOOL": "CodeCheck CLI 自动安装或执行失败，本次将缺少代码规范检查结果",
    "UT": "没有可验证的 UT 生成/运行通过证据，回归问题可能进入后续阶段",
    "STORY": "没有可验证的 Story Generator 正常返回记录",
    "REVIEWER": "没有可验证的 Reviewer 正常返回记录，设计或代码问题可能遗漏",
    "GRILL": "Grill Critic 没有正常返回，需求边界可能仍有遗漏",
    "GRILL_PREP": "Grill 备课 Critic 没有正常返回，初始问题树可能存在遗漏",
    "GRILL_FINAL": "Grill 收尾 Critic 没有正常返回，衍生问题可能存在遗漏",
    "ASKUSER": "宿主没有签发用户交互令牌；本次风险确认本身仍必须匹配用户真实原话",
    "UTRUN": "没有观测到 UT 命令真实调起",
    "TIER_SCOPE": "本单改动文件数超过所选交付档的升级阈值，继续按轻量档走会绕过设计与规格环节",
}

# 口径在 foundation/source_paths.CODE_EXTENSIONS,这里只做转发——
# 原来这份与 lightcheck_source.SUPPORTED_EXTENSIONS 是逐字节相同的两份副本。
CODE_EXTS = source_paths.CODE_EXTENSIONS

DEFAULT_TEST_PATS = [
    r"(^|/)(tests?|__tests__|spec|[^/]+[_-]tests?)/", r"(^|/)src/test/",
    r"(^|/)test_[^/]+\.py$",
    r"(_test|\.test|\.spec)\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|tpp|py|go|rs|js|jsx|cjs|mjs|ts|tsx|cts|mts)$",
    r"Tests?\.(c|cc|cpp|cxx|h|hh|hpp|hxx|java|kt|cs)$",
]

CODECHECK_LINE_SLACK = 3

LIGHTCHECK_REPORT_PATH = os.path.join(
    ".mae-flow-work", "lightcheck", "latest.md")

SPEC_REGISTER_FIELDS = ("design_doc", "plan", "verification_report")

SPEC_PHASES = ("open", "design", "build", "verify", "archive", "archived")

WORKFLOW_LABELS = {"full": "完整开发", "hotfix": "已定位问题修复",
                   "tweak": "局部修改", "review": "处理评审意见"}

GATE_STRIKES_PATH = STATE_PATH + ".gate-strikes"

GATE_PERMITS_PATH = STATE_PATH + ".gate-permits"

GATE_STRIKE_LIMIT = 3

WRITEISH_STRONG = (r"(sed\s+-i|perl\s+-i|git\s+apply|Set-Content|Out-File|Add-Content"
                   r"|\brm\s+|(?<![\w-])del\s+)")

WRITEISH_WEAK = (r"(\btee\s+|\bcp\s+|\bmv\s+|(?<![\w-])copy\s+|(?<![\w-])move\s+"
                 r"|(?<![\w-])patch\b)")

_COMMAND_UNHANDLED = object()

__all__ = [name for name in globals() if not name.startswith("__")]

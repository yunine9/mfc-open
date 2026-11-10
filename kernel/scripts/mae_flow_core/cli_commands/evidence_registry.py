"""Evidence registries wired to public CLI command ports."""

import re

from .shared import (
    AgentEvidencePorts, AgentEvidenceRules, DeliveryEvidencePorts,
    DeliveryEvidenceRules, QualityEvidencePorts, QualityEvidenceRules,
    RISK_AGENT_LABELS, WorkflowEvidencePorts, WorkflowEvidenceRules,
    append_codecheck_event, build_evidence_registry, globmod, os,
    read_bytes,
    read_text, STATE_PATH, specengine, sys, time,
)
from .wiring import api
from mae_flow_core.workflow.advisories import record_advisory
from mae_flow_core.workflow import agent_observations
from mae_flow_core import host_env
from mae_flow_core.workflow.agent_observations import (
    finished_observation,
    open_started_observations,
)
from mae_flow_core.workflow.quality_executions import (
    quality_input_snapshot, successful_quality_execution,
)
from mae_flow_core.orchestration.domain_archive import (
    candidate_from_dict,
    input_digest,
)
from mae_flow_core.orchestration.work_package import ensure_work_package
from .local_spec import local_spec_errors


def _domain_archive_fresh(state):
    record = (state or {}).get("domain_archive") or {}
    ticket = str(((state or {}).get("config") or {}).get("单号", "")).strip()
    if not ticket:
        return False, "领域归档缺少需求单号；执行 domain-archive status"
    try:
        root = os.getcwd()
        package = ensure_work_package(root, ticket)
        entries = tuple(
            candidate_from_dict(root, value)
            for value in record.get("domains", ()))
        git_facts = "%s\n%s" % (
            api.sh("git -c core.quotepath=false diff --no-ext-diff --binary HEAD -- ."),
            api.sh("git -c core.quotepath=false status --porcelain --untracked-files=all"),
        )
        actual = input_digest(
            root,
            (
                package.spec, package.grill, package.story,
                package.implementation, package.decisions,
            ),
            git_facts,
            entries,
        )
    except (OSError, TypeError, ValueError) as exc:
        return False, "领域归档新鲜度无法校验: %s；执行 domain-archive status" % exc
    if actual != record.get("input_sha256"):
        return False, (
            "领域归档输入已变化；只需重新执行 domain-archive prepare，"
            "不会回退编码、检视或质量阶段")
    return True, ""


def _local_spec_valid(state):
    ticket = str(((state or {}).get("config") or {}).get("单号", "")).strip()
    try:
        path = ensure_work_package(os.getcwd(), ticket).spec
        content = read_text(path, encoding="utf-8")
    except (OSError, TypeError, ValueError) as exc:
        return False, "本地 Spec 不可读: %s；执行 local-spec init" % exc
    errors = local_spec_errors(content)
    if errors:
        return False, (
            "本地 Spec 缺少有效内容: %s；补齐后执行 local-spec validate"
            % "、".join(errors))
    return True, ""


# 结论只认"独立成行、并且就落在行尾"的那一句。整篇搜 \bFAIL\b 会把正文里的
# `SendResult.fail(...)`、`test_..._fail` 当成结论——而"失败要重试"这类需求,
# 报告里必然到处是 fail,机器于是诬告一份老实报告说谎(实战撞过,当场卡死)。
# 前缀限长并排除表格行(|)与代码(`);FAIL 前一个字符不能是 . 或字母数字,
# 免得把 SendResult.fail 这种收尾的行也算上。机器只拦谎言,不拦用词。
_VERDICT_FAIL = re.compile(r"(?mi)^[^|`\n]{0,24}?(?<![.\w])FAIL\s*$")
_VERDICT_PASS = re.compile(r"(?mi)^\s*(?:总体|结论)?\s*[:：]?\s*PASS\b")


def _verification_passed(state):
    ticket = str(((state or {}).get("config") or {}).get("单号", "")).strip()
    try:
        package = ensure_work_package(os.getcwd(), ticket)
        path = os.path.join(package.root, "verification.md")
        content = read_text(path, encoding="utf-8")
    except (OSError, TypeError, ValueError) as exc:
        return False, "本地验证报告不可读: %s" % exc
    if _VERDICT_FAIL.search(content):
        return False, "本地验证报告结论为 FAIL；修复后重新完成质量链"
    if not _VERDICT_PASS.search(content):
        return False, (
            "本地验证报告缺少独立一行的 PASS 结论；"
            "在 .mae-flow-work/<单号>/verification.md 补充真实结论")
    # 机器只拦谎言,不拦格式——频繁打回毁体验,格式与充分性交给人工检视。
    # 「有结论为缺失的行却写 PASS」是自相矛盾的伪证,属于底线,拦;
    # 「矩阵没写/写成散文」是质量问题,只在 current 提示一次,放行。
    rows = [
        line for line in content.splitlines()
        if line.strip().startswith("|")
        and re.search(r"满足|部分|缺失", line)
        and "---" not in line
    ]
    filled = [row for row in rows if not re.search(r"满足\s*/\s*部分", row)]
    missing = [
        row for row in filled
        if re.search(r"\|\s*缺失\s*\|?\s*$", row)
    ]
    if missing:
        return False, (
            "验证报告存在结论为「缺失」的验收项,却写了 PASS——两者矛盾。"
            "缺失项要么补实现重走质量链,要么按用户裁决修订 Spec: "
            + missing[0].strip()[:120])
    if not filled:
        try:
            record_advisory(
                STATE_PATH, str((state or {}).get("current", "")),
                "verification-matrix",
                "verification.md 没有逐条对齐矩阵(验收项|实现位置|验证方式|结论),"
                "人工检视时请留意规格覆盖是否只是一句话带过",
                time.strftime("%Y-%m-%d %H:%M:%S"))
        except Exception:
            pass  # 建议层失败绝不反过来挡流程
    return True, ""


def _step_scoped_source_files(state):
    """本步进入后仍未提交的源码改动——与 agent-task 发卡侧同一套计算。"""
    try:
        step = str((state or {}).get("current", "") or "")
        head = str(((state or {}).get("step_heads", {}) or {}).get(step, "")
                   or "HEAD")
        snapshot = api._worktree_snapshot_since(head)
        return [
            path for path in snapshot
            if api._is_source_path(path, state, api.FLOW)
        ], ""
    except Exception as exc:              # noqa: BLE001
        return None, "无法计算本步源码改动: %s" % exc


def _finished_agent_observation(kind, step, since):
    observed = finished_observation(STATE_PATH, kind, step, since)
    if observed:
        return observed
    # Read-only compatibility for in-flight stable-v2 work.  Old Hook tokens
    # are treated only as historical "returned" lifecycle facts; status,
    # digest, task issuance, HEAD and source fingerprints are intentionally
    # ignored.  New completions never create these tokens.
    legacy = api._agent_token_data().get(kind, "")
    at = legacy.get("at", "") if isinstance(legacy, dict) else legacy
    legacy_step = legacy.get("step", "") if isinstance(legacy, dict) else ""
    if at and at >= since and legacy_step in ("", step):
        return {
            "kind": kind, "step": step, "lifecycle": "returned",
            "at": at, "legacy": True,
        }
    return None


def _open_agent_observation(kind, step, since):
    return next((
        item for item in open_started_observations(
            STATE_PATH, kind=kind, step=step)
        if str(item.get("at", "")) >= str(since or "")
    ), None)


_AGENT_EVIDENCE = AgentEvidenceRules(AgentEvidencePorts(
    moonlight=lambda state: api._moonlight(state),
    step_entered=lambda state: api._step_entered_at(state),
    risk_acceptance=lambda kind, state: api._risk_acceptance(kind, state),
    script_path=lambda: sys.argv[0],
    risk_labels=RISK_AGENT_LABELS,
    finished_observation=_finished_agent_observation,
    finished_observations=lambda kind, step, since: agent_observations
        .finished_observations(STATE_PATH, kind, step, since),
    open_observation=_open_agent_observation,
    quality_execution=lambda kind, step, state: successful_quality_execution(
        STATE_PATH, kind, step, quality_input_snapshot(state, kind, step)),
    askuser_tokens=lambda: api._agent_token_data(),
    changed_source_files=lambda state: api._changed_source_files(state),
    step_scoped_source_files=lambda state: _step_scoped_source_files(state),
    shell_output=lambda command: api.sh(command),
    argv_output=lambda arguments: api.argv_out(arguments),
    blocking_dirty_source_paths=lambda state: api._blocking_dirty_source_paths(
        state),
))

ev_agent_ran = _AGENT_EVIDENCE.agent_ran


_DELIVERY_EVIDENCE = DeliveryEvidenceRules(DeliveryEvidencePorts(
    moonlight=lambda state: api._moonlight(state),
    source_changed_since=lambda head, state: api._source_changed_since(
        head, state),
    archive_delivery_paths=lambda state: api._archive_delivery_paths(state),
    shell_output=lambda command: api.sh(command),
    argv_output=lambda arguments: api.argv_out(arguments),
    committed_initial_carryover=lambda state: api._committed_initial_carryover(
        state),
    committed_delivery_paths=lambda state: api._committed_delivery_paths(state),
    trusted_harness_commit_path=lambda path, state:
        api._trusted_harness_commit_path(
            path, state, include_user_authorized=True),
    dirty_paths=lambda: api._dirty_paths(),
    path_fingerprint=lambda path: api._path_fingerprint(path),
    repo_path_identity=lambda path: api._repo_path_identity(path),
    agent_written_paths=lambda: api._agent_written_paths(),
    read_text_replace=lambda path: read_text(path, errors="replace"),
    agent_ran=lambda spec, state: _AGENT_EVIDENCE.agent_ran(spec, state),
    push_runs_locally=lambda state: host_env.git_push_runs_locally(state),
    review_document=lambda state: os.path.join(
        ensure_work_package(
            os.getcwd(), (state.get("config") or {}).get("单号", "")).root,
        "review.md"),
))

ev_archive_paths_clean = _DELIVERY_EVIDENCE.archive_paths_clean
ev_pushed = _DELIVERY_EVIDENCE.pushed
ev_commit_tagged = _DELIVERY_EVIDENCE.commit_tagged
ev_commit_tagged_after_entry = _DELIVERY_EVIDENCE.commit_tagged_after_entry
ev_delivery_manifest_committed = _DELIVERY_EVIDENCE.delivery_manifest_committed


_QUALITY_EVIDENCE = QualityEvidenceRules(QualityEvidencePorts(
    business_changed_files=lambda state: api._biz_changed_files(state),
    risk_acceptance=lambda kind, state: api._risk_acceptance(kind, state),
    source_changed_since=lambda head, state: api._source_changed_since(
        head, state),
    agent_ran=lambda spec, state: _AGENT_EVIDENCE.agent_ran(spec, state),
    append_event=lambda state, event, payload: append_codecheck_event(
        os.getcwd(), state, event, payload),
    git_head=lambda: api.sh("git rev-parse --verify HEAD"),
    exists=os.path.exists,
    is_file=os.path.isfile,
    argv_output=lambda arguments: api.argv_out(arguments),
    run_codecheck=lambda files, state, source: api._run_codecheck(
        files, state, source),
    scope_filter=lambda result, state, files:
        api._filter_codecheck_with_repository_facts(
            result, state, files),
    read_bytes=lambda path: read_bytes(path),
    read_text_replace=lambda path: read_text(path, errors="replace"),
    now=lambda: time.strftime("%Y-%m-%d %H:%M:%S"),
    exemption_text_has_pair=lambda text, rule, path:
        api._exemption_text_has_pair(text, rule, path),
    approved_exemptions=lambda state: api._approved_exemptions(state),
    was_exempt_before_review=lambda state, exemption, rule, path:
        api._was_exempt_before_review(state, exemption, rule, path),
    approval_key=lambda rule, path: api._approval_key(rule, path),
    exemption_path=lambda state: os.path.join(
        ensure_work_package(
            os.getcwd(), (state.get("config") or {}).get("单号", "")).root,
        "codecheck-exemptions.md"),
))



_WORKFLOW_EVIDENCE = WorkflowEvidenceRules(WorkflowEvidencePorts(
    cwd=os.getcwd,
    glob_paths=globmod.glob,
    is_file=os.path.isfile,
    read_text=lambda path: read_text(path),
    read_text_replace=lambda path: read_text(path, errors="replace"),
    shell_output=lambda command: api.sh(command),
    argv_output=lambda arguments: api.argv_out(arguments),
    tasks_source=lambda root, change: specengine.tasks_source(root, change),
    spec_has_delta=lambda root, change: specengine.has_delta(root, change),
    spec_validate=lambda root, change: specengine.validate(root, change),
    spec_required_sections=lambda root, change, workflow:
        specengine.check_required_sections(root, change, workflow),
    spec_error=specengine.SpecEngineError,
    spec_data=lambda state: api._spec_data(state),
    risk_acceptance=lambda kind, state: api._risk_acceptance(kind, state),
    business_changed_files=lambda state: api._biz_changed_files(state),
    domain_archive_fresh=_domain_archive_fresh,
    local_spec_valid=_local_spec_valid,
    verification_passed=_verification_passed,
))

# Compatibility names used by in-flight command handlers and legacy tests.
ev_glob = _WORKFLOW_EVIDENCE.glob
ev_branch_ok = _WORKFLOW_EVIDENCE.branch_ok
ev_tasks_checked = _WORKFLOW_EVIDENCE.tasks_checked
ev_spec_field = _WORKFLOW_EVIDENCE.spec_field
ev_tier_scope = _WORKFLOW_EVIDENCE.tier_scope
ev_spec_validate = _WORKFLOW_EVIDENCE.spec_validate
ev_content_free = _WORKFLOW_EVIDENCE.content_free
ev_glob_absent = _WORKFLOW_EVIDENCE.glob_absent
ev_clean_paths = _WORKFLOW_EVIDENCE.clean_paths
ev_domain_archive_complete = _WORKFLOW_EVIDENCE.domain_archive_complete
ev_local_spec_valid = _WORKFLOW_EVIDENCE.local_spec_valid
ev_verification_passed = _WORKFLOW_EVIDENCE.verification_passed


_EVIDENCE_REGISTRY = build_evidence_registry(
    workflow=_WORKFLOW_EVIDENCE,
    agent=_AGENT_EVIDENCE,
    delivery=_DELIVERY_EVIDENCE,
    quality=_QUALITY_EVIDENCE,
)
# Read-only compatibility view for older diagnostics that enumerate names.
EVIDENCE = _EVIDENCE_REGISTRY

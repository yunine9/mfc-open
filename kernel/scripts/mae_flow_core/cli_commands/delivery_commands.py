"""Trusted Cloud host commands for the continuous delivery review loop."""
import hashlib
import json
import re
from .shared import os, time
from .wiring import api
from .delivery_support import (
    original_feedback_order,
    render_delivery_feedback,
    unpushed_commits as collect_unpushed_commits,
)
from .user_intervention import clear_stale_evidence
from mae_flow_core.quality.external_repair import (
    clear_feedback_authorization, issue_feedback_authorization)
from mae_flow_core.workflow.execution_contract import continuous_review_enabled
from .host_capability import (
    host_managed_continuous_review, verify_host_proof)
from .host_receipts import (
    attest_host_receipts, external_facts, verify_feedback_facts, has_receipt_for,
    save_with_host_proof, trusted_active_batch,
    trusted_pipeline_projection)
from .selection_reconcile import reconcile_selection
from .ticket_correction import correct_ticket
BATCH_SCHEMA = "mae-flow-feedback-batch/1"
RESULT_SCHEMA = "mae-flow-feedback-result/1"
STATE_SCHEMA = "mae-flow-delivery-loop/1"
_RESULTS = frozenset(("fixed", "explained", "needs_human", "not_applicable"))
# Cloud adds source, revision and observed SHA around a valid source_id.
# The composite identity must not inherit the shorter source_id limit.
_FEEDBACK_ID_LIMIT = 512
_WAITING = frozenset(("external_verify", "delivery_watch"))
_WRITER = frozenset(("feedback_triage", "build", "domain_archive",
                     "delivery_review", "push"))
def _die(message):
    api.die("delivery: " + message, 2)

def _verify_host_proof(state, args, action, payload):
    return verify_host_proof(state, args.host_proof, action, payload)

def _payload(path, schema):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
        if os.path.islink(absolute) or not os.path.isfile(absolute):
            raise ValueError("事实文件必须是普通文件")
        if info.st_size > 512 * 1024:
            raise ValueError("事实文件超过 512 KiB")
        with open(absolute, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _die("无法读取事实文件 %s: %s" % (absolute, exc))
    if not isinstance(value, dict) or value.get("schema") != schema:
        _die("事实文件 schema 必须是 %s" % schema)
    return value

def _text(value, name, limit=4000, required=True):
    result = str(value or "").strip()
    if required and not result:
        _die("%s 不能为空" % name)
    if len(result) > limit:
        _die("%s 超过 %s 字符" % (name, limit))
    return result

def _loop(state):
    # delivery_loop 可能是 None(老任务、首次推送前还没开过反馈批次)。
    # setdefault 只在 key 不存在时写默认值,key 存在但值是 None 时不覆盖——
    # 不处理 None 的话,后续 loop.get("schema") 直接 AttributeError,整条
    # delivery 链死。None 跟"不存在"语义一致,都表示还没初始化。
    loop = state.get("delivery_loop")
    if loop is None:
        loop = {
            "schema": STATE_SCHEMA,
            "delivery_round": 0,
            "active_batch_id": "",
            "batches": [],
            "close_events": [],
        }
        state["delivery_loop"] = loop
    elif not isinstance(loop, dict):
        _die("delivery_loop 状态损坏")
    if loop.get("schema") != STATE_SCHEMA:
        _die("delivery_loop 状态版本不受支持")
    loop.setdefault("delivery_round", 0)
    loop.setdefault("active_batch_id", "")
    loop.setdefault("batches", [])
    loop.setdefault("close_events", [])
    return loop

def _batch(loop, batch_id):
    return next((
        item for item in loop.get("batches", [])
        if isinstance(item, dict) and item.get("batch_id") == batch_id
    ), None)


def _capability(state):
    if not (host_managed_continuous_review()
            or continuous_review_enabled(state)):
        _die("当前任务没有启用 Cloud continuous_review 执行契约，拒绝静默降级")


def _head():
    value = api.sh("git rev-parse --verify HEAD")
    if not value:
        _die("无法读取当前 HEAD")
    return value


def _item(raw):
    if not isinstance(raw, dict):
        _die("items 每一项必须是 JSON object")
    item_id = _text(raw.get("id"), "items.id", _FEEDBACK_ID_LIMIT)
    source = _text(raw.get("source"), "items.source", 80)
    result = {
        "id": item_id,
        "source": source,
        "source_id": _text(raw.get("source_id"), "items.source_id", 200),
        "source_revision": int(raw.get("source_revision", raw.get("revision", 0)) or 0),
        "kind": _text(raw.get("kind"), "items.kind", 80, required=False),
        "summary": _text(raw.get("summary"), "items.summary", 4000),
        "material": _text(raw.get("material"), "items.material", 1000, required=False),
        "verification": _text(raw.get("verification"), "items.verification", 80),
    }
    if raw.get("file") is not None:
        result["file"] = _text(raw.get("file"), "items.file", 1000, required=False)
    if raw.get("line") is not None:
        try:
            result["line"] = int(raw.get("line"))
        except (TypeError, ValueError):
            _die("items.line 必须是整数")
    return result


def _history(state, step, result, note):
    state.setdefault("history", []).append({
        "step": step,
        "result": result,
        "note": note,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


def _adopt_watch(state, payload, proof_nonce):
    """One-way adoption for pre-contract Cloud tasks already awaiting merge."""
    migration_id = _text(payload.get("batch_id"), "batch_id", 200)
    contract = state.get("execution_contract") or {}
    if contract.get("host") != "cloud":
        _die("只有旧 Cloud 任务可以迁移到持续检视")
    loop = _loop(state)
    migrations = loop.setdefault("migrations", [])
    previous = next((
        item for item in migrations
        if isinstance(item, dict) and item.get("migration_id") == migration_id
    ), None)
    if previous is not None:
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": STATE_SCHEMA, "idempotent": True,
            "migration_id": migration_id, "current": state.get("current"),
        }, ensure_ascii=False))
        return
    if state.get("current") != "end":
        _die("adopt-watch 只接受旧终态 end，当前是 %s"
             % str(state.get("current") or "?"))
    head = _head()
    external = ((state.get("quality") or {}).get("external_verification") or {})
    if external.get("verdict") != "PASS" or external.get("sha") != head:
        _die("旧终态没有绑定当前 HEAD 的权威 PASS，不能安全迁移")
    contract["continuous_review"] = True
    state["execution_contract"] = contract
    state["current"] = "delivery_watch"
    state.setdefault("step_heads", {})["delivery_watch"] = head
    migrations.append({
        "migration_id": migration_id,
        "kind": "terminal-to-delivery-watch",
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "head": head,
    })
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": STATE_SCHEMA, "idempotent": False,
        "migration_id": migration_id, "current": "delivery_watch",
    }, ensure_ascii=False))


def _open(flow, state, args):
    del flow
    payload = _payload(args.file, BATCH_SCHEMA)
    proof_nonce = _verify_host_proof(state, args, "feedback-open", payload)
    if payload.get("mode") == "adopt-watch":
        return _adopt_watch(state, payload, proof_nonce)
    if payload.get("mode") == "control":
        from .feedback_control import control_feedback
        return control_feedback(state, payload, proof_nonce)
    if payload.get("mode") == "published":
        from .published_feedback import record_publication
        return record_publication(state, payload, proof_nonce)
    _capability(state)
    batch_id = _text(payload.get("batch_id"), "batch_id", 200)
    if host_managed_continuous_review():
        verify_feedback_facts(state)
    loop = _loop(state)
    previous = _batch(loop, batch_id)
    if previous is not None:
        incoming_digest = _result_digest({
            "task_id": payload.get("task_id"),
            "base_sha": payload.get("base_sha"),
            "items": original_feedback_order(payload.get("items"), previous.get("items")),
        })
        if previous.get("payload_digest") != incoming_digest:
            _die("批次 %s 的载荷与首次登记不一致，拒绝当作幂等重放" % batch_id)
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": STATE_SCHEMA,
            "idempotent": True,
            "batch_id": batch_id,
            "status": previous.get("status"),
            "current": state.get("current"),
        }, ensure_ascii=False))
        return
    if state.get("current") == "end":
        _die("任务已由 merged close 进入终态，不能再打开反馈")
    if state.get("current") in ("config_confirm", "workflow_select", "branch_create"):
        _die("任务尚未建立完整交付上下文，不能打开持续检视批次")
    base_sha = _text(payload.get("base_sha"), "base_sha", 80)
    head = _head()
    external = ((state.get("quality") or {}).get("external_verification") or {})
    allowed_bases = {head, str(external.get("sha") or "")}
    for existing in loop.get("batches", []):
        if isinstance(existing, dict):
            allowed_bases.add(str(existing.get("base_sha") or ""))
    if base_sha not in allowed_bases:
        _die("base_sha %s 与当前 HEAD/当前交付轮不一致（当前 HEAD %s）"
             % (base_sha[:12], head[:12]))
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        _die("items 必须是非空数组")
    items = [_item(value) for value in raw_items]
    ids = [value["id"] for value in items]
    if len(ids) != len(set(ids)):
        _die("同一批次 items.id 不得重复")
    loop["delivery_round"] = int(loop.get("delivery_round") or 0) + 1
    active_batch = _batch(loop, str(loop.get("active_batch_id") or ""))
    # A RED result for the code produced by the previous batch is itself new
    # feedback. The previous receipts stay immutable/auditable, but it no
    # longer owns the writer; otherwise the RED batch would queue behind a
    # PASS that can never happen and Cloud would livelock on external_verify.
    if active_batch and active_batch.get("status") == "awaiting_verification":
        active_batch["status"] = "addressed"
        active_batch["verification_failed_at"] = time.strftime(
            "%Y-%m-%d %H:%M:%S")
        loop["active_batch_id"] = ""
        clear_feedback_authorization(state)
        active_batch = None
    active = bool(active_batch)
    status = "queued" if active else "repairing"
    record = {
        "batch_id": batch_id,
        "task_id": _text(payload.get("task_id"), "task_id", 200),
        "round": loop["delivery_round"],
        "base_sha": base_sha,
        "opened_at": _text(payload.get("opened_at"), "opened_at", 80),
        "from_step": str(state.get("current") or ""),
        "status": status,
        "items": items,
        "payload_digest": _result_digest({
            "task_id": payload.get("task_id"),
            "base_sha": payload.get("base_sha"),
            "items": payload.get("items"),
        }),
    }
    loop["batches"].append(record)
    old = str(state.get("current") or "")
    if not active:
        loop["active_batch_id"] = batch_id
        issue_feedback_authorization(
            state, batch_id=batch_id, base_sha=base_sha,
            at=record["opened_at"], dirty_paths=api._dirty_paths(),
            allowed_paths=(item.get("file", "") for item in items))
        if old in _WAITING:
            state["current"] = "feedback_triage"
            state.setdefault("step_heads", {})["feedback_triage"] = head
    _history(state, old, "feedback-open:" + batch_id,
             "收到 %s 条反馈；%s" % (len(items), status))
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": STATE_SCHEMA,
        "idempotent": False,
        "batch_id": batch_id,
        "status": status,
        "current": state.get("current"),
        "round": record["round"],
    }, ensure_ascii=False))


def _result_digest(results):
    encoded = json.dumps(results, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _promote(state, loop):
    queued = next((
        item for item in loop.get("batches", [])
        if isinstance(item, dict) and item.get("status") == "queued"
    ), None)
    if queued is None:
        loop["active_batch_id"] = ""
        clear_feedback_authorization(state)
        return None
    queued["status"] = "repairing"
    loop["active_batch_id"] = queued["batch_id"]
    issue_feedback_authorization(
        state, batch_id=queued["batch_id"], base_sha=queued["base_sha"],
        at=queued.get("opened_at", ""), dirty_paths=api._dirty_paths(),
        allowed_paths=(item.get("file", "")
                       for item in queued.get("items", [])))
    return queued


def complete_verified_feedback(state, verified_sha):
    """Close an addressed code-changing batch after authoritative PASS."""
    loop = state.get("delivery_loop") or {}
    batch = _batch(loop, str(loop.get("active_batch_id") or ""))
    verified_sha = str(verified_sha or "")
    closed_at = time.strftime("%Y-%m-%d %H:%M:%S")
    closed_batch_id = ""
    if batch and batch.get("status") == "awaiting_verification":
        batch["status"] = "closed"
        batch["verified_sha"] = verified_sha
        batch["closed_at"] = closed_at
        closed_batch_id = str(batch.get("batch_id") or "")
    for previous in loop.get("batches", []):
        if isinstance(previous, dict) and previous.get("status") == "addressed":
            previous["status"] = "closed"
            previous["verified_sha"] = verified_sha
            previous["closed_at"] = closed_at
        # 发布新 SHA 时，旧流水线失败批次会先退出 writer 并标记为
        # superseded。后续新 SHA 的权威 PASS 正是它的来源方核验事件；
        # 若不在这里闭环，Cloud 投影会永久停在 awaiting_verification。
        # 只接受由该次 push 淘汰、且全部来自 pipeline 的机器反馈，绝不
        # 用流水线 PASS 代替工作台批注或 MR 检视人的人工确认。
        if (isinstance(previous, dict)
                and previous.get("status") == "superseded"
                and previous.get("superseded_by_push") == verified_sha):
            items = previous.get("items") or []
            pipeline_only = bool(items) and all(
                isinstance(item, dict)
                and item.get("source") == "pipeline"
                and item.get("verification") == "pipeline"
                for item in items)
            if pipeline_only:
                previous["status"] = "closed"
                previous["verified_sha"] = verified_sha
                previous["superseded_by_pipeline"] = verified_sha
                previous["closed_at"] = closed_at
                closed_batch_id = closed_batch_id or str(
                    previous.get("batch_id") or "")
    if closed_batch_id:
        _history(state, state.get("current", ""),
                 "feedback-verified:" + closed_batch_id,
                 "权威验证通过 %s" % verified_sha[:12])
    return bool(_promote(state, loop))


def complete_superseded_pipeline_feedback(state, verified_sha):
    """Retire only a trusted, pipeline-only batch superseded by a newer PASS.

    This is a host verification fact, not a fabricated Agent result. Human,
    mixed, unknown-version and current-version feedback keeps its writer.
    """
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", verified_sha):
        return None
    loop = state.get("delivery_loop") or {}
    batch = _batch(loop, str(loop.get("active_batch_id") or ""))
    items = (batch or {}).get("items") or []
    if not batch or not items or batch.get("status") not in ("repairing", "needs_human"):
        return None
    for item in items:
        source_sha = str(item.get("source_id") or "").split(":")[0]
        if (item.get("source") != "pipeline" or item.get("verification") != "pipeline"
                or not re.fullmatch(r"[0-9a-fA-F]{40,64}", source_sha)
                or source_sha == verified_sha):
            return None
    if not trusted_active_batch(state, ("feedback-open", "pipeline-record", "selection-reconcile")):
        return None
    batch["status"] = "closed"
    batch["verified_sha"] = verified_sha
    batch["superseded_by_pipeline"] = verified_sha
    batch["closed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _history(state, state.get("current", ""), "feedback-superseded:" + batch["batch_id"],
             "新提交权威流水线通过 %s；旧失败保留历史" % verified_sha[:12])
    return bool(_promote(state, loop))


def _handoff_host_feedback(state, batch):
    # Cloud 已提交逐条处理结果；后续推送和权威验证由宿主负责。
    # 不再要求 Agent 为推进步骤重走 build/归档/检视，不产生质量 PASS。
    if (host_managed_continuous_review()
            and batch.get("status") == "awaiting_verification"
            and batch.get("batch_id") == (state.get("delivery_loop") or {}).get("active_batch_id")
            and state.get("current") in _WRITER):
        state["current"] = "external_verify"
        state.setdefault("step_heads", {})["external_verify"] = _head()


def _result(flow, state, args):
    del flow
    payload = _payload(args.file, RESULT_SCHEMA)
    proof_nonce = _verify_host_proof(state, args, "feedback-result", payload)
    _capability(state)
    if host_managed_continuous_review():
        verify_feedback_facts(state)
    batch_id = _text(payload.get("batch_id"), "batch_id", 200)
    loop = _loop(state)
    batch = _batch(loop, batch_id)
    if batch is None:
        _die("找不到反馈批次 %s" % batch_id)
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        _die("results 必须是数组")
    results = []
    from .feedback_control import deferred_feedback
    deferred = deferred_feedback(state)
    # A host-recorded defer is a scheduling decision, not an Agent response.
    # Supply its explanation only for omitted entries; real replies stay intact.
    present = {item.get("id") for item in raw_results if isinstance(item, dict)}
    raw_results = list(raw_results) + [
        {"id": item["id"], "status": "explained",
         "summary": "责任人暂缓自动修复：" + deferred[item["id"]]["reason"]}
        for item in batch.get("items", [])
        if item.get("id") in deferred and item.get("id") not in present]
    for raw in raw_results:
        if not isinstance(raw, dict):
            _die("results 每一项必须是 JSON object")
        status = _text(raw.get("status"), "results.status", 40)
        if status not in _RESULTS:
            _die("results.status 只能是 " + "/".join(sorted(_RESULTS)))
        results.append({
            "id": _text(raw.get("id"), "results.id", _FEEDBACK_ID_LIMIT),
            "status": status,
            "summary": _text(raw.get("summary"), "results.summary", 4000),
            "evidence": _text(raw.get("evidence"), "results.evidence", 4000,
                              required=False),
        })
    from .published_feedback import historical_pipeline_item
    historical = {item["id"] for item in batch.get("items", []) if historical_pipeline_item(state, item)}
    results = [item for item in results if item["id"] not in historical]
    expected = {item["id"] for item in batch.get("items", [])} - historical
    actual = {item["id"] for item in results}
    if len(actual) != len(results) or actual != expected:
        _die("逐条回执必须精确覆盖本批反馈。缺少: %s；夹带: %s"
             % ("、".join(sorted(expected - actual)) or "无",
                "、".join(sorted(actual - expected)) or "无"))
    digest = _result_digest(results)
    if batch.get("result_digest"):
        if batch.get("result_digest") != _result_digest(original_feedback_order(results, batch.get("results"))):
            _die("批次 %s 已登记不同结果，拒绝覆盖" % batch_id)
        _handoff_host_feedback(state, batch)
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({
            "schema": STATE_SCHEMA, "idempotent": True,
            "batch_id": batch_id, "status": batch.get("status"),
            "current": state.get("current"),
        }, ensure_ascii=False))
        return
    if batch_id != str(loop.get("active_batch_id") or ""):
        _die("反馈批次 %s 尚未取得唯一 writer，不能提前登记处理结果"
             % batch_id)
    head = _head()
    declared_changed = bool(payload.get("changed"))
    changed = declared_changed or head != batch.get("base_sha")
    batch["results"] = results
    batch["result_digest"] = digest
    batch["result_head"] = head
    batch["result_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    if any(item["status"] == "needs_human" for item in results):
        batch["status"] = "needs_human"
    elif changed:
        clear_stale_evidence(state)
        batch["status"] = "awaiting_verification"
        if state.get("current") == "feedback_triage":
            state["current"] = "build"
            state.setdefault("step_heads", {})["build"] = head
    else:
        batch["status"] = "closed"
        batch["closed_at"] = batch["result_at"]
        promoted = _promote(state, loop)
        state["current"] = "feedback_triage" if promoted else "delivery_watch"
        state.setdefault("step_heads", {})[state["current"]] = head
    _handoff_host_feedback(state, batch)
    _history(state, str(batch.get("from_step") or ""),
             "feedback-result:" + batch_id,
             "%s；HEAD %s" % (batch["status"], head[:12]))
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({
        "schema": STATE_SCHEMA,
        "idempotent": False,
        "batch_id": batch_id,
        "status": batch["status"],
        "current": state.get("current"),
        "changed": changed,
    }, ensure_ascii=False))


def _close(flow, state, args):
    proof_payload = {
        "reason": args.reason,
        "sha": args.sha,
        "event_id": args.event_id,
    }
    proof_nonce = _verify_host_proof(state, args, "close", proof_payload)
    _capability(state)
    if args.reason != "merged":
        _die("close 当前只接受 --reason merged")
    event_id = _text(args.event_id, "event_id", 200)
    loop = _loop(state)
    previous = next((
        item for item in loop.get("close_events", [])
        if isinstance(item, dict) and item.get("event_id") == event_id
    ), None)
    if previous is not None:
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({**previous, "idempotent": True}, ensure_ascii=False))
        return
    # 平台合入是人的最终交付决定，由宿主签名证明来源。
    # 可以覆盖旧 SHA 的失败/缺失验证，但不能把那些结果改写成 PASS。
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", str(args.sha)):
        _die("合入源 SHA 格式不合法")
    verified = external_facts(state)
    if not flow.get("steps", {}).get("end", {}).get("terminal"):
        _die("内核流程缺少终态 end")
    dirty = list(api._dirty_paths())
    local_head = _head()
    unpushed_commits = collect_unpushed_commits(str(args.sha), local_head, _die)
    old = str(state.get("current") or "")
    event = {
        "schema": STATE_SCHEMA,
        "event_id": event_id,
        "reason": "merged",
        "sha": str(args.sha),
        "completion_basis": "platform_merge",
        "last_verification": {"sha": verified.get("sha"), "verdict": verified.get("verdict")},
        "local_head": local_head,
        "unpushed_local_commits": unpushed_commits,
        "closed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "unpushed_local_paths": dirty,
        "idempotent": False,
    }
    loop["close_events"].append(event)
    loop["active_batch_id"] = ""
    for batch in loop.get("batches", []):
        if isinstance(batch, dict) and batch.get("status") not in ("closed",):
            batch["status"] = "superseded_by_merge"
    clear_feedback_authorization(state)
    state.pop("external_repair_authorization", None)
    state["current"] = "end"
    _history(state, old, "delivery-close:merged", "MR 已合入 %s" % args.sha[:12])
    save_with_host_proof(state, proof_nonce)
    print(json.dumps(event, ensure_ascii=False))


def cmd_delivery(flow, state, args):
    if args.delivery_action == "feedback-open":
        return _open(flow, state, args)
    if args.delivery_action == "feedback-result":
        return _result(flow, state, args)
    if args.delivery_action == "selection-reconcile":
        return reconcile_selection(state, args, load_payload=_payload,
            verify_host_proof=_verify_host_proof, capability=_capability,
            head=_head, history=_history, state_schema=STATE_SCHEMA)
    if args.delivery_action == "ticket-correction":
        return correct_ticket(state, args, load_payload=_payload,
            verify_host_proof=_verify_host_proof, history=_history)
    if args.delivery_action == "close":
        return _close(flow, state, args)
    if args.delivery_action == "attest":
        return attest_host_receipts(state, args)
    _die("未知动作")

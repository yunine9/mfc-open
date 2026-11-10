"""Owner-directed scheduling of feedback, separate from quality results.

The host signs this through feedback-open. Keeping the decision inside the
existing delivery loop makes recovery and writer promotion use the same fact.
No feedback text, result, or pipeline verdict is rewritten by this operation.
"""

import datetime
import hashlib
import json


def deferred_feedback(state):
    return (state.get("delivery_loop") or {}).get("deferred_feedback") or {}


def scheduled_items(state, batch):
    from .published_feedback import historical_pipeline_item
    deferred = deferred_feedback(state)
    return [item for item in batch.get("items", [])
            if item.get("id") not in deferred and not historical_pipeline_item(state, item)]


def control_feedback(state, payload, proof_nonce):
    from .delivery_commands import (
        _capability, _die, _history, _loop, _promote, _text, _head,
        STATE_SCHEMA)
    from .host_receipts import (
        verify_feedback_facts, save_with_host_proof)
    from mae_flow_core.quality.external_repair import (
        clear_feedback_authorization, issue_feedback_authorization)

    _capability(state)
    verify_feedback_facts(state)
    if state.get("current") in ("config_confirm", "workflow_select",
                                "branch_create", "end"):
        _die("任务尚未建立执行现场或已经结束，不能调整修复目标")
    operation_id = _text(payload.get("operation_id"), "operation_id", 200)
    target = _text(payload.get("target"), "target", 4000)
    actor = _text(payload.get("actor"), "actor", 200)
    request_id = _text(payload.get("request_id"), "request_id", 200)
    reason = _text(payload.get("reason"), "reason", 4000)
    # One decision per call. The UI and natural-language tools share the same
    # per-item discipline; a missing ID never means "ignore everything".
    feedback_id = _text(payload.get("feedback_id"), "feedback_id", 512, False)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True,
                                      ensure_ascii=False).encode()).hexdigest()
    loop = _loop(state)
    controls = loop.setdefault("controls", [])
    previous = next((entry for entry in controls
                     if entry.get("operation_id") == operation_id), None)
    if previous:
        if previous.get("payload_digest") != digest:
            _die("同一目标调整操作不能改写其参数")
        save_with_host_proof(state, proof_nonce)
        print(json.dumps({"schema": STATE_SCHEMA, "idempotent": True,
                          "current": state.get("current"),
                          "status": "target-updated"}))
        return
    batch = next((entry for entry in loop.get("batches", [])
                  if any(item.get("id") == feedback_id
                         for item in entry.get("items", []))), None)
    if feedback_id and (not batch or batch.get("status") in ("closed", "addressed")):
        _die("指定反馈不存在或已处理，请读取当前反馈后再决定")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    record = {"operation_id": operation_id, "target": target,
              "actor": actor, "request_id": request_id, "reason": reason,
              "feedback_id": feedback_id, "at": now,
              "payload_digest": digest}
    if feedback_id:
        loop.setdefault("deferred_feedback", {})[feedback_id] = record
        if not scheduled_items(state, batch):
            batch["status"] = "deferred"
    controls.append(record)
    loop["target"] = record
    active_id = loop.get("active_batch_id")
    active = next((entry for entry in loop.get("batches", [])
                   if entry.get("batch_id") == active_id), None)
    old = str(state.get("current") or "")
    if active and active.get("status") == "deferred":
        loop["active_batch_id"] = ""
        clear_feedback_authorization(state)
        active = _promote(state, loop)
        # There is still an owner-requested target. Return to coding without
        # declaring PASS, delivery-ready, or the entire task complete.
        state["current"] = "feedback_triage" if active else "build"
        state.setdefault("step_heads", {})[state["current"]] = _head()
    elif active and feedback_id:
        previous_auth = state.get("delivery_repair_authorization") or {}
        clear_feedback_authorization(state)
        issue_feedback_authorization(
            state, batch_id=active_id, base_sha=active.get("base_sha", ""),
            at=now, dirty_paths=previous_auth.get("baseline_dirty", []),
            allowed_paths=(item.get("file", "")
                           for item in scheduled_items(state, active)))
    elif not active and old in ("external_verify", "delivery_watch"):
        state["current"] = "build"
        state.setdefault("step_heads", {})["build"] = _head()
    _history(state, old, "target-update:" + operation_id,
             "%s：%s；暂缓 %s" % (actor, target, feedback_id or "无"))
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({"schema": STATE_SCHEMA, "idempotent": False,
                      "current": state.get("current"),
                      "status": "target-updated"}, ensure_ascii=False))

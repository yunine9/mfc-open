"""Host push receipts retire obsolete CI scheduling, never manufacture PASS."""
import datetime
import json
import re


def historical_pipeline_item(state, item):
    published = ((state.get("delivery_loop") or {}).get("published") or {}).get("sha")
    source = str(item.get("observed_sha") or item.get("source_id") or "").split(":")[0]
    return (item.get("source") == "pipeline" and bool(published)
            and bool(re.fullmatch(r"[0-9a-fA-F]{40,64}", source))
            and source != published)


def record_publication(state, payload, proof_nonce):
    from .delivery_commands import _capability, _die, _history, _loop, _promote, _head, STATE_SCHEMA
    from .host_receipts import verify_feedback_facts, save_with_host_proof
    from .feedback_control import scheduled_items
    from mae_flow_core.quality.external_repair import clear_feedback_authorization

    _capability(state)
    receipt = payload.get("receipt") or {}
    sha = str(receipt.get("sha") or "")
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", sha) or not receipt.get("ref") or not receipt.get("remote"):
        _die("推送交接缺少真实 SHA、远端与引用收据")
    # 同 SHA 重放只读，不重新登记或覆盖最终 close 事实。
    if ((state.get("delivery_loop") or {}).get("published") or {}).get("sha") == sha:
        # 恢复会在读取 task.json 的 push 收据后幂等补登记。若内核已经
        # 用同一 SHA 完成 merged close，生命周期的最新可信事实是 close；
        # 不能先用旧 push 去要求一条“非终态反馈链”收据，更不能为了
        # 一次无状态变化的重放覆盖最终 close 投影。
        print(json.dumps({"schema": STATE_SCHEMA, "current": state.get("current"), "idempotent": True}))
        return
    verify_feedback_facts(state)
    loop = _loop(state)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    loop["published"] = {"sha": sha, "receipt": receipt, "at": now}
    active_id = loop.get("active_batch_id")
    retired_active = False
    for batch in loop.get("batches", []):
        if batch.get("status") not in ("repairing", "needs_human", "queued", "awaiting_verification"):
            continue
        items = batch.get("items") or []
        if items and any(historical_pipeline_item(state, item) for item in items) and not scheduled_items(state, batch):
            batch["status"] = "superseded"
            batch["superseded_by_push"] = sha
            batch["superseded_at"] = now
            retired_active = retired_active or batch.get("batch_id") == active_id
    old = str(state.get("current") or "")
    if retired_active:
        loop["active_batch_id"] = ""
        clear_feedback_authorization(state)
        promoted = _promote(state, loop)
        # 纯旧 CI 已完成发布，宿主接续验证。人工意见仍有自己的 writer。
        if old != "end":
            state["current"] = "feedback_triage" if promoted else "external_verify"
            state.setdefault("step_heads", {})[state["current"]] = _head()
    _history(state, old, "feedback-published:" + sha, "已推送新版本；旧流水线反馈只保留历史，不代表通过")
    save_with_host_proof(state, proof_nonce)
    print(json.dumps({"schema": STATE_SCHEMA, "current": state.get("current"), "idempotent": False}))

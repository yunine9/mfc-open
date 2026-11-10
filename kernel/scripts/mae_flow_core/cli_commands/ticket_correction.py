"""Host-only metadata correction; unchanged trees inherit existing decisions."""
import copy
import json
import re
from .wiring import api
from .host_receipts import save_with_host_proof, verify_feedback_facts


def correct_ticket(state, args, *, load_payload, verify_host_proof, history):
    payload = load_payload(args.file, "mae-flow-ticket-correction/1")
    proof = verify_host_proof(state, args, "ticket-correction", payload)
    config = state.setdefault("config", {})
    old, new = payload["old_ticket"], payload["ticket"]
    if config.get("单号") not in (None, "", old, new):
        api.die("纠正单号与当前任务不一致", 2)
    applied = state.setdefault("ticket_corrections", [])
    if any(item.get("id") == payload["id"] for item in applied):
        save_with_host_proof(state, proof)
        print(json.dumps({"schema": "mae-flow-delivery-loop/1", "status": "ticket-corrected"}))
        return
    verify_feedback_facts(state)
    mapping = payload.get("sha_map") or {}
    for previous, current in mapping.items():
        if not all(re.fullmatch(r"[0-9a-f]{40,64}", sha) for sha in (previous, current)):
            api.die("提交映射格式错误", 2)
        before = api.sh("git rev-parse %s^{tree}" % previous).strip()
        after = api.sh("git rev-parse %s^{tree}" % current).strip()
        if not before or before != after:
            api.die("单号纠正不能改变代码内容", 2)
    replacements = dict(mapping)
    for name in ("branch", "mr_url", "mr_id"):
        if payload.get("old_" + name) is not None and payload.get(name) is not None:
            replacements[str(payload["old_" + name])] = str(payload[name])

    if payload.get("old_branch") and payload.get("branch"):
        replacements["refs/heads/" + payload["old_branch"]] = "refs/heads/" + payload["branch"]

    def mapped(value):
        if isinstance(value, str):
            return replacements.get(value, value)
        if isinstance(value, list):
            return [mapped(item) for item in value]
        if isinstance(value, dict):
            return {replacements.get(key, key): mapped(item) for key, item in value.items()}
        return value

    original = {}
    # 不改历史日志、用户原话、责任人决定；只迁移活动状态中的版本引用。
    for key in ("quality", "host_actions", "step_heads", "delivery_loop",
                "delivery_selection", "delivery_repair_authorization",
                "external_repair_authorization", "delivery_manifest"):
        if key in state:
            original[key] = copy.deepcopy(state[key])
            state[key] = mapped(state[key])
    config["单号"] = new
    if payload.get("branch"):
        config["分支名"] = payload["branch"]
    manifest = state.get("delivery_manifest") or {}
    if manifest.get("commit_message"):
        manifest["commit_message"] = manifest["commit_message"].replace("[" + old + "]", "[" + new + "]", 1)
    applied.append({"id": payload["id"], "old_ticket": old, "ticket": new,
                    "sha_map": mapping, "original": original})
    history(state, str(state.get("current") or ""), "ticket-correction",
            "宿主纠正单号 %s → %s；代码未变，沿用已有验证与检视结论" % (old, new))
    save_with_host_proof(state, proof)
    print(json.dumps({"schema": "mae-flow-delivery-loop/1", "status": "ticket-corrected"}))

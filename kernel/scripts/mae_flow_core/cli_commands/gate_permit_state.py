"""Permit consumption and strike recording for gate decisions."""

from .shared import (
    GATE_PERMITS_PATH,
    GATE_STRIKES_PATH,
    GATE_STRIKE_LIMIT,
    check_permit,
    load_json,
    os,
    permit_block_id,
    record_strike,
    strike_escalation,
    sys,
    time,
    update_json,
)
from .wiring import api


def _gate_block_id(rule, subject):
    return permit_block_id(rule, subject)


def _hook_rule_message(rule, message):
    if os.environ.get("MAE_FLOW_HOOK_TRACE") == "1":
        return "[mae-flow-rule=%s]\n%s" % (rule, message)
    return message


def _gate_die(st, sid, rule, subject, msg):
    """Consume an exact permit or record a strike and show recovery guidance."""
    bid = _gate_block_id(rule, subject)
    try:
        permits = load_json(GATE_PERMITS_PATH)
    except FileNotFoundError:
        permits = {}
    except Exception:
        # A damaged permit store is quarantined so the same authorization can be
        # issued again without silently turning into an ordinary gate failure.
        permits = {}
        try:
            os.replace(
                GATE_PERMITS_PATH,
                GATE_PERMITS_PATH + ".corrupt." + time.strftime("%Y%m%d-%H%M%S"),
            )
            print(
                "[mae-flow] ⚠ 放行令存储损坏,已隔离;若刚签发过放行令,"
                "重新执行同一条 allow 命令即可重签。",
                file=sys.stderr,
            )
        except OSError:
            pass
    rec = permits.get(bid)
    if rec and not rec.get("used") and rec.get("step") == sid:
        head = api.sh("git rev-parse --verify HEAD")
        permit = check_permit(permits, bid, sid, head)
        if permit.kind == "stale":
            msg = (
                "已有放行令 %s 因代码版本变化作废(签发于 %s)。需重新征得"
                "用户同意后 allow 重签。"
                % (bid, rec.get("head", "")[:8])
            ) + msg
        if permit.kind == "valid":

            def consume(data):
                entry = (data or {}).get(bid) or {}
                entry["used"] = True
                entry["used_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                data[bid] = entry
                return data

            try:
                update_json(
                    GATE_PERMITS_PATH,
                    consume,
                    default={},
                    recover_corrupt=True,
                )
            except Exception:
                pass
            try:
                action = rec.get("git_action")
                if isinstance(action, dict) and api._authorization_is_exact(action):
                    receipt = dict(action)
                    receipt.update(
                        {
                            "id": bid,
                            "rule": rule,
                            "step": sid,
                            "head": head,
                            "pre_head": head,
                            "consumed": True,
                            "consumed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                            "finalized": False,
                        }
                    )
                    authorizations = st.setdefault("git_authorizations", [])
                    authorizations[:] = [
                        row
                        for row in authorizations
                        if isinstance(row, dict) and row.get("id") != bid
                    ]
                    authorizations.append(receipt)
                    del authorizations[:-50]
                st.setdefault("history", []).append(
                    {
                        "step": sid,
                        "result": "gate:allowed-by-user",
                        "note": rule + " " + bid,
                        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    }
                )
                api.save_state(st)
            except Exception:
                pass
            print(
                "[mae-flow] 用户放行令 %s 生效(一次性,已作废):规则 %s 放过此动作,"
                "其余规则继续检查。" % (bid, rule),
                file=sys.stderr,
            )
            return
    count = 1
    try:

        def bump(data):
            result, _count = record_strike(
                data,
                rule,
                sid,
                bid,
                subject,
                time.strftime("%Y-%m-%d %H:%M:%S"),
            )
            return result

        data = update_json(
            GATE_STRIKES_PATH,
            bump,
            default={},
            recover_corrupt=True,
        )
        count = int(
            ((data or {}).get("counts", {}).get(rule) or {}).get("count", 1) or 1
        )
    except Exception:
        count = 1
    msg += strike_escalation(
        count,
        GATE_STRIKE_LIMIT,
        api._moonlight(st or {}),
        bid,
        os.path.abspath(sys.argv[0]),
    )
    api.die(_hook_rule_message(rule, msg), 2)

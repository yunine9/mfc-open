"""Durable host receipts: what one Cloud host action sealed, and how it is
verified later.

分工:host_capability 回答"这条命令是不是宿主发的"(信任根、绑定、签名);
本模块回答"宿主上一次把这一单封成了什么样"(投影、落盘、回溯核对)。
两者拆开是因为它们的失败语义必须不同——鉴权 fail-closed,历史台账
体检 fail-soft(读不动的旧收据跳过接着找,不许升级成拒绝服务)。
"""

import hashlib
import hmac
import json
import stat
import sys

from .shared import STATE_PATH, os, time
from .wiring import api
from .host_capability import (
    PROOF_SCHEMA, _bound_task_id, _canonical, _capability_root, _die,
    _trusted_authority, _verify_rsa_sha256)

LIFECYCLE_SCHEMA = "mae-flow-host-lifecycle/2"
RECEIPT_SCHEMA = "mae-flow-host-receipt/1"
ATTEST_SCHEMA = "mae-flow-host-attest/1"
# 收据现在只封摘要,恒定几百字节;上限留给"写坏了/被人塞了别的东西"。
_RECEIPT_LIMIT = 32 * 1024


def _digest(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def external_facts(state):
    """The one normalization both writer and verifier must share."""
    return ((state.get("quality") or {}).get("external_verification")) or {}


def _active_batch(loop):
    if not isinstance(loop, dict):
        return None
    active_id = str(loop.get("active_batch_id") or "")
    if not active_id:
        return None
    return next((item for item in loop.get("batches", [])
                 if isinstance(item, dict)
                 and str(item.get("batch_id") or "") == active_id), None)


def _feedback_control_projection(state):
    """Owner decisions have their own stable digest across normal batch work.

    Omit the fields entirely for pre-feature tasks, so historical lifecycle
    receipts retain their original projection shape. Control operations append
    to controls; the count also prevents restoring an older signed decision.
    """
    loop = state.get("delivery_loop") or {}
    keys = ("controls", "target", "deferred_feedback")
    control = {key: loop[key] for key in keys if key in loop}
    if not control:
        return {}
    controls = control.get("controls")
    return {
        "feedback_control_digest": _digest(control),
        "feedback_control_count": len(controls) if isinstance(controls, list) else 0,
    }


def verify_feedback_control_predecessor(state):
    """Never re-sign Agent-written owner decisions during an unrelated action.

    This runs centrally when a host proof is admitted, before any command can
    mutate state. Checking only the active batch would miss target/deferred
    fields beside that batch and silently give those edits a fresh signature.
    """
    current = _feedback_control_projection(state)
    latest_count = 0
    latest_digests = set()
    for authority, record in _scan_receipts(state):
        stored = record.get("projection")
        if not isinstance(stored, dict):
            continue
        count = stored.get("feedback_control_count")
        digest = stored.get("feedback_control_digest")
        if not isinstance(count, int) or count < 1 or not isinstance(digest, str):
            continue
        action = str((record.get("proof") or {}).get("action") or "")
        if not _valid_stored_receipt(authority, record, action, stored):
            continue
        if count > latest_count:
            latest_count, latest_digests = count, {digest}
        elif count == latest_count:
            latest_digests.add(digest)
    if not current and latest_count == 0:
        return
    if (current.get("feedback_control_count") == latest_count
            and current.get("feedback_control_digest") in latest_digests):
        return
    _die("责任人目标或暂缓决定与最新宿主收据不一致，拒绝重新签署被改写的决定")


def host_projection(state, action, payload):
    """Seal the complete lifecycle produced by one host mutation.

    A receipt for only ``PASS`` or ``results`` can be spliced together with an
    Agent-written ``current``/``status``.  Every host action therefore seals the
    same indivisible lifecycle projection; later legitimate host actions simply
    emit a newer complete projection.

    2026-09-01 勘误:投影原来把**整份 delivery_loop 与逐条意见正文**封进
    收据。写盘不限体积、读回限 32 KiB,一轮 12 条 350 字的 MR 检视(内核
    自己允许单条 4000 字)就越线;之后 feedback-open / feedback-result /
    pipeline record 乃至 MR 合入后的 close 全部永久失败,而且**制造死锁
    的那条命令自己报成功**,没有任何命令能救回来(实测复现)。改封摘要:
    防篡改强度一个字节没松,体积从此恒定。
    """
    if action not in ("feedback-open", "feedback-result", "close",
                      "pipeline-record", "intervention-reconcile",
                      "selection-reconcile", "ticket-correction"):
        return None
    loop = state.get("delivery_loop")
    loop = loop if isinstance(loop, dict) else None
    return {
        "schema": LIFECYCLE_SCHEMA,
        "action": action,
        "current": state.get("current"),
        "active_batch_id": (loop or {}).get("active_batch_id") if loop else None,
        "delivery_loop_digest": _digest(loop),
        "active_batch_digest": _digest(_active_batch(loop)),
        "external_verification_digest": _digest(external_facts(state)),
        "user_intervention_digest": _digest(state.get("user_intervention")),
        **_feedback_control_projection(state),
    }


def _receipt_prefix(task_id):
    """Receipts belong to (task, workspace), not to a bare task id.

    信任根是按部署共享的目录:同一个任务号在另一份代码仓里(重建、
    夹具、诊断克隆)会读到不属于它的历史收据,于是"生命周期投影对不上"
    ——一单被另一单的陈账挡死。把工作区一起算进归属,串味从此不可能。
    """
    identity = "%s\0%s" % (task_id, os.path.realpath(os.getcwd()))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest() + ".receipt-"


def _receipt_path(root, task_id, nonce):
    if not all(char.isalnum() or char in "-_" for char in nonce):
        _die("宿主凭据 nonce 格式不合法")
    return os.path.join(root, "%s%s.json" % (_receipt_prefix(task_id), nonce))


def _sync_receipt_directory(path):
    descriptor = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _stage_receipt(context, projection):
    """Write ahead; a committed state can recover this receipt after a crash.

    Temporary receipts are never accepted merely because they exist. Recovery
    requires the persisted nonce and exact signed lifecycle to match.
    """
    proof = context["proof"]
    path = _receipt_path(context["root"], proof["task_id"], proof["nonce"])
    record = {
        "schema": RECEIPT_SCHEMA,
        "proof": proof,
        # 只留摘要。原来这里逐字存整份 payload——一批 12 条 350 字的
        # 检视意见就把收据顶到 16 KiB,和当初封整份 delivery_loop 是
        # 同一个体积漏口。摘要够用:proof 已被签名绑住 payload_digest,
        # 载荷原文本来就在任务状态与事实文件里。
        "payload_digest": _digest(context["payload"]),
        "projection": projection,
        "projection_digest": _digest(projection),
        "recorded_at": int(time.time()),
    }
    staged = path + ".staged"
    try:
        descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(_canonical(record) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        _sync_receipt_directory(staged)
    except OSError as exc:
        _die("无法落盘宿主权威收据: %s" % exc)
    return staged, path


def _readable_receipt(path):
    """Read one historical receipt, or ``None`` when it cannot be trusted.

    2026-09-01 勘误:这三个扫描函数原来对每一份历史收据都走严格
    _read_json_file,权限被动过、体积超限、写坏了任何一条都会 SystemExit
    掀掉整条宿主命令——反馈、流水线登记、连 MR 合入后的 close 一起永久
    失败,且无命令可救。鉴权仍旧 fail-closed(签名、载荷摘要、投影逐字
    比对一个都没松);松掉的只是"读不动的旧文件跳过去接着找"。
    """
    try:
        absolute = os.path.abspath(path)
        info = os.lstat(absolute)
        if (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)
                or os.path.realpath(absolute) != absolute
                or info.st_size > _RECEIPT_LIMIT
                or stat.S_IMODE(info.st_mode) != 0o600
                or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
            return None
        with open(absolute, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _scan_receipts(state):
    """Yield every readable receipt of the bound task, newest name first.

    The authority is resolved once: it is the same public key for every receipt
    of one task, and hoisting it keeps the per-record loop incapable of dying.
    """
    root = _capability_root()
    task_id = _bound_task_id(root)
    authority = _trusted_authority(state, {"task_id": task_id}, root)
    prefix = _receipt_prefix(task_id)
    try:
        names = sorted(os.listdir(root))
    except OSError as exc:
        _die("无法读取 Cloud 宿主信任根: %s" % exc)
    for name in reversed(names):
        if not name.startswith(prefix):
            continue
        path = os.path.join(root, name)
        if name.endswith(".json.staged"):
            _recover_staged_receipt(path, authority)
            path = path[:-7]
        elif not name.endswith(".json"):
            continue
        record = _readable_receipt(path)
        if record is not None:
            yield authority, record


def _valid_stored_receipt(authority, record, action, projection):
    if record.get("schema") != RECEIPT_SCHEMA:
        return False
    proof = record.get("proof")
    if not isinstance(proof, dict) or proof.get("action") != action:
        return False
    if str(proof.get("task_id") or "") != str(authority.get("task_id") or ""):
        return False
    unsigned = {key: proof.get(key) for key in (
        "schema", "task_id", "action", "payload_digest", "nonce", "issued_at")}
    signature = str(proof.get("signature") or "")
    if (unsigned.get("schema") != PROOF_SCHEMA
            or not _verify_rsa_sha256(
                authority, _canonical(unsigned).encode("utf-8"), signature)):
        return False
    # 载荷摘要以**被签名的那份**为准;收据里那份只是同一事实的副本,
    # 两者必须一致,谁也不能单独改。
    return (hmac.compare_digest(str(record.get("payload_digest") or ""),
                                str(unsigned.get("payload_digest") or ""))
            and hmac.compare_digest(str(record.get("projection_digest") or ""),
                                    _digest(projection))
            and hmac.compare_digest(
                _canonical(record.get("projection")).encode("utf-8"),
                _canonical(projection).encode("utf-8")))


def _recover_staged_receipt(path, authority):
    """Only the state actually saved on disk may finish a pending transaction."""
    record = _readable_receipt(path)
    if not record:
        return
    proof = record.get("proof")
    if not isinstance(proof, dict):
        return
    try:
        with open(STATE_PATH, encoding="utf-8") as stream:
            committed = json.load(stream)
    except (OSError, ValueError):
        return
    if not isinstance(committed, dict):
        return
    if proof.get("nonce") not in committed.get("host_capability_nonces", []):
        return
    action = proof.get("action")
    projection = host_projection(committed, action, {})
    if projection is None or not _valid_stored_receipt(authority, record, action, projection):
        return
    try:
        os.replace(path, path[:-7])
        _sync_receipt_directory(path)
    except FileNotFoundError:
        pass  # Another reader finished the same recovery.
    except OSError as exc:
        _die("宿主收据恢复暂时失败，请重试: %s" % exc)


def trusted_projection(state, action, projection):
    """Verify a state projection against a host-only durable receipt."""
    for authority, record in _scan_receipts(state):
        if _valid_stored_receipt(authority, record, action, projection):
            return True
    return False


def has_receipt_for(state, action):
    """Whether this task ever produced a valid receipt for one host action."""
    for authority, record in _scan_receipts(state):
        proof = record.get("proof")
        stored = record.get("projection")
        if (isinstance(proof, dict) and proof.get("action") == action
                and isinstance(stored, dict)
                and _valid_stored_receipt(authority, record, action, stored)):
            return True
    return False


def verify_feedback_facts(state):
    """Validate existing feedback facts, not whether some host once ran.

    Empty recovered tasks have no feedback facts to endorse. A historical close
    (or any other receipt) must not force them to recreate an obsolete chain.
    Nonempty loops still need authentic backing: otherwise publication could
    re-sign forged results or silently dropped human feedback. A close receipt
    seals those facts just as other host actions do; it is not a permanent lock.
    Owner target/defer rollback is checked separately by host_capability before
    this function, including when somebody clears the entire loop.
    """
    loop = state.get("delivery_loop")
    if loop is None:
        return
    if isinstance(loop, dict) and not any(
            value for key, value in loop.items()
            if key not in ("schema", "delivery_round")):
        return
    if not trusted_feedback_loop(state):
        _die("现有反馈事实与宿主收据不一致，拒绝重新签署被改写的反馈")


def trusted_current_lifecycle(state, actions):
    """Require an exact signed predecessor before another host transition."""
    # Metadata-only host correction re-signs the same decisions for equivalent
    # commit trees. It is an accepted successor, not a new pipeline execution.
    return any(trusted_projection(
        state, action, host_projection(state, action, {}))
        for action in (*actions, "ticket-correction"))


def trusted_pipeline_projection(state, projection):
    """Verify the exact pipeline fact inside an authentic pipeline receipt.

    Later feedback legitimately changes ``current`` and ``delivery_loop``. The
    original pipeline receipt remains authoritative for its immutable quality
    projection, while ready/terminal attestations still require a separate
    full-lifecycle receipt for their current state.
    """
    wanted = _digest(projection or {})
    for authority, record in _scan_receipts(state):
        stored = record.get("projection")
        if (isinstance(stored, dict)
                and hmac.compare_digest(
                    str(stored.get("external_verification_digest") or ""), wanted)
                and _valid_stored_receipt(
                    authority, record, str((record.get("proof") or {}).get("action")), stored)
                and (record.get("proof") or {}).get("action") in ("pipeline-record", "ticket-correction")):
            return True
    return False


def trusted_feedback_loop(state):
    """Feedback facts survive workflow movement and close; never endorse edits."""
    actions = ("feedback-open", "feedback-result", "pipeline-record", "close",
               "selection-reconcile", "intervention-reconcile", "ticket-correction")
    wanted = _digest(state.get("delivery_loop"))
    for authority, record in _scan_receipts(state):
        stored = record.get("projection")
        if not isinstance(stored, dict):
            continue
        action = str((record.get("proof") or {}).get("action") or "")
        if (action in actions
                and hmac.compare_digest(str(stored.get("delivery_loop_digest") or ""), wanted)
                and _valid_stored_receipt(authority, record, action, stored)):
            return True
    return False


def trusted_active_batch(state, actions):
    """Verify active_batch_id and the complete active batch against a receipt.

    Agent work may legitimately move ``current`` between host calls, but it may
    not rewrite which feedback owns the writer or any field of that batch.
    """
    loop = state.get("delivery_loop") or {}
    active_id = str(loop.get("active_batch_id") or "")
    active = _active_batch(loop)
    if not active_id or active is None:
        return False
    wanted = _digest(active)
    for authority, record in _scan_receipts(state):
        stored = record.get("projection")
        if not isinstance(stored, dict):
            continue
        proof = record.get("proof")
        action = str((proof or {}).get("action") or "") \
            if isinstance(proof, dict) else ""
        if (action in (*actions, "ticket-correction")
                and stored.get("active_batch_id") == active_id
                and hmac.compare_digest(
                    str(stored.get("active_batch_digest") or ""), wanted)
                and _valid_stored_receipt(authority, record, action, stored)):
            return True
    return False


def _snapshot_from_stdin():
    # Trusted local IPC: historical feedback may legitimately exceed 512 KiB.
    # Decode the stream once; do not turn task age into an authorization limit.
    try:
        value = json.load(sys.stdin)
    except ValueError as exc:
        _die("状态快照不是合法 JSON: %s" % exc)
    if not isinstance(value, dict):
        _die("状态快照必须是一个对象")
    return value


def _actions(raw):
    return [item.strip() for item in str(raw or "").split(",") if item.strip()]


def attest_host_receipts(state, args):
    """Verify receipt backing, finishing interrupted receipt publication if needed.

    Cloud 原来把这段核对(收据归属、签名、投影形状、活动批次摘要)抄了
    一份 TypeScript 镜像。2026-09-02 内核一改投影契约,镜像没跟上,Cloud
    三个 fail-closed 门当场恒假、整条持续检视链静默锁死——"同一契约两份
    实现"的实锤。现在裁决只在这里:Cloud 只问,不判。

    快照走 stdin:Cloud 核对的必须是**它自己刚读到的那份**状态,而不是
    内核此刻再读一次的现场。本命令不消费 nonce、不改业务状态；仅可补完
    已保存状态对应的收据改名。信任根在 Agent 够不着的地方,所以
    它不需要宿主凭据。
    """
    snapshot = _snapshot_from_stdin() if args.snapshot_stdin else state
    lifecycle = _actions(args.lifecycle)
    active = _actions(args.active_batch)
    record = {
        "schema": ATTEST_SCHEMA,
        "lifecycle": (trusted_current_lifecycle(snapshot, lifecycle)
                      if lifecycle else None),
        "active_batch": (trusted_active_batch(snapshot, active)
                         if active else None),
    }
    if getattr(args, "feedback_loop", False):
        record["feedback_loop"] = trusted_feedback_loop(snapshot)
    print(json.dumps(record, ensure_ascii=False))
    return record


def save_with_host_proof(state, context):
    nonce = context["proof"]["nonce"]
    consumed = state.setdefault("host_capability_nonces", [])
    consumed.append(nonce)
    # Proofs expire in two minutes. A bounded replay window is sufficient and
    # prevents the task state growing forever during a long-lived MR.
    if len(consumed) > 256:
        del consumed[:-256]
    projection = host_projection(
        state, context["proof"]["action"], context["payload"])
    if projection is None:
        _die("宿主命令没有形成可核对的权威投影")
    staged, path = _stage_receipt(context, projection)
    # A save can fail after its atomic replacement. Keep the journal;
    # recovery checks the persisted state, never this in-memory object.
    api.save_state(state)
    try:
        os.rename(staged, path)
        _sync_receipt_directory(path)
    except FileNotFoundError:
        # Concurrent attest may already have recovered this exact receipt.
        record = _readable_receipt(path)
        if not record or record.get("projection_digest") != _digest(projection):
            _die("宿主权威收据未落盘，请重试")
    except OSError as exc:
        _die("无法落盘宿主权威收据: %s" % exc)
    _refresh_pulse()


def _refresh_pulse():
    """宿主推进了阶段(登记 PASS → 持续检视、合入收口 → 已合入),看板脉冲
    要跟上——Agent 不在场,没有 Hook 事件替它写。Cloud 的进度条只读脉冲。
    纯旁路:失败静默,绝不影响已落盘的状态与收据。"""
    try:
        from mae_flow_core.panel import pulse
        pulse.write_pulse(STATE_PATH, root=os.getcwd(), force=True)
    except Exception:                      # noqa: BLE001 —— 旁路软失败
        pass

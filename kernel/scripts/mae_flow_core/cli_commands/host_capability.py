"""Cryptographic capability for Cloud-owned delivery commands.

The Agent can invoke the public Mae-Flow CLI, so command spelling is never an
authorization boundary.  Cloud keeps the RSA private key outside the mounted
task workspace and pins only the public key in the task state.  Every host
mutation therefore carries a short-lived, task/action/payload-bound proof.
"""

import base64
import hashlib
import hmac
import json
import stat

from .shared import os, time
from .wiring import api


PROOF_SCHEMA = "mae-flow-host-proof/1"
AUTHORITY_SCHEMA = "mae-flow-host-authority/1"
_RSA_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _die(message):
    api.die("delivery: " + message, 2)


def _text(value, name, limit):
    result = str(value or "").strip()
    if not result:
        _die("%s 不能为空" % name)
    if len(result) > limit:
        _die("%s 超过 %s 字符" % (name, limit))
    return result


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _secure_mode(info, expected, label):
    mode = stat.S_IMODE(info.st_mode)
    if mode != expected:
        _die("%s 权限必须是 %s，当前是 %s" % (
            label, oct(expected), oct(mode)))
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        _die("%s 不属于当前宿主进程" % label)


def _secure_directory(path, label):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
    except OSError as exc:
        _die("无法读取%s %s: %s" % (label, absolute, exc))
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        _die("%s必须是真实目录" % label)
    if os.path.realpath(absolute) != absolute:
        _die("%s不能经过符号链接" % label)
    _secure_mode(info, 0o700, label)
    return absolute


def _secure_file(path, label, limit=32 * 1024):
    absolute = os.path.abspath(path)
    try:
        info = os.lstat(absolute)
    except OSError as exc:
        _die("无法读取%s %s: %s" % (label, absolute, exc))
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        _die("%s必须是普通文件" % label)
    if os.path.realpath(absolute) != absolute:
        _die("%s不能经过符号链接" % label)
    if info.st_size > limit:
        _die("%s过大" % label)
    _secure_mode(info, 0o600, label)
    return absolute


def _capability_root():
    """Locate the host-only trust root without trusting task state or args.

    Production repositories live at ``<data>/<task>/<repo>`` and the Cloud
    trust root at ``<data>/.host-capabilities``.  The contract fixture runs a
    repository directly as its workspace, so it uses the one-level fallback.
    If the production root exists it always wins; an Agent-created inner
    directory can therefore only cause a visible refusal, never become trust.
    """
    project = os.path.realpath(os.getcwd())
    workspace = os.path.dirname(project)
    candidates = (
        os.path.join(os.path.dirname(workspace), ".host-capabilities"),
        os.path.join(workspace, ".host-capabilities"),
    )
    for candidate in candidates:
        if os.path.lexists(candidate):
            root = _secure_directory(candidate, "宿主信任根")
            try:
                if os.path.commonpath((project, root)) == project:
                    _die("宿主信任根不能位于 Agent 工作区")
            except ValueError:
                _die("宿主信任根与任务工作区不在同一文件系统")
            return root
    _die("当前任务找不到 Cloud 宿主信任根，拒绝宿主命令")


def _bound_task_id(root):
    """Read the task identity from the host-only cwd binding."""
    project = os.path.realpath(os.getcwd())
    name = "binding-%s.json" % hashlib.sha256(
        project.encode("utf-8")).hexdigest()
    binding = _read_json_file(os.path.join(root, name), "宿主任务绑定")
    if (not isinstance(binding, dict)
            or binding.get("schema") != "mae-flow-host-binding/1"
            or binding.get("continuous_review") is not True
            or os.path.realpath(str(binding.get("cwd") or "")) != project):
        _die("宿主任务绑定损坏或与当前工作区不匹配")
    task_id = str(binding.get("task_id") or "").strip()
    if not task_id:
        _die("宿主任务绑定缺少任务身份")
    return task_id


def host_managed_continuous_review():
    """Whether an external, Agent-inaccessible capability binds this task."""
    project = os.path.realpath(os.getcwd())
    workspace = os.path.dirname(project)
    candidates = (
        os.path.join(os.path.dirname(workspace), ".host-capabilities"),
        os.path.join(workspace, ".host-capabilities"),
    )
    for candidate in candidates:
        if not os.path.lexists(candidate):
            continue
        root = _secure_directory(candidate, "宿主信任根")
        binding_name = "binding-%s.json" % hashlib.sha256(
            project.encode("utf-8")).hexdigest()
        if not os.path.lexists(os.path.join(root, binding_name)):
            return False
        task_id = _bound_task_id(root)
        name = hashlib.sha256(task_id.encode("utf-8")).hexdigest() + ".json"
        path = os.path.join(root, name)
        if not os.path.lexists(path):
            return False
        stored = _read_json_file(path, "宿主能力")
        authority = stored.get("authority") if isinstance(stored, dict) else None
        if (stored.get("schema") != "mae-flow-host-capability/1"
                or not isinstance(authority, dict)
                or authority.get("task_id") != task_id):
            _die("当前任务的宿主能力绑定损坏")
        return True
    return False


def _read_json_file(path, label):
    absolute = _secure_file(path, label)
    try:
        with open(absolute, "r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _die("无法读取%s %s: %s" % (label, absolute, exc))


def _proof_payload(path):
    root = _capability_root()
    # 只把**所在目录**解引用,末段保持原样:_secure_file 还要靠它识别
    # "凭据本身是软链"。原来直接拿 abspath 和 realpath 化过的 root 比,
    # 只要 <data> 经过任何一层软链就永远不相等——macOS 的 /var 就是
    # (2026-09-01 实测:一条宿主命令都过不去,报"不在信任根内")。
    absolute = os.path.join(
        os.path.realpath(os.path.dirname(os.path.abspath(path))),
        os.path.basename(path))
    if os.path.dirname(absolute) != root:
        _die("宿主凭据不在 Cloud 宿主信任根内")
    value = _read_json_file(absolute, "宿主凭据")
    if not isinstance(value, dict) or value.get("schema") != PROOF_SCHEMA:
        _die("宿主凭据 schema 必须是 %s" % PROOF_SCHEMA)
    nonce = _text(value.get("nonce"), "proof.nonce", 200)
    if os.path.basename(absolute) != "proof-%s.json" % nonce:
        _die("宿主凭据文件名与 nonce 不匹配")
    return value, root


def _b64url(value):
    encoded = str(value or "").encode("ascii")
    return base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))


def _verify_rsa_sha256(authority, message, signature):
    try:
        modulus = int.from_bytes(_b64url(authority.get("n")), "big")
        exponent = int.from_bytes(_b64url(authority.get("e")), "big")
        signed = int.from_bytes(_b64url(signature), "big")
        if modulus <= 0 or exponent <= 0 or signed >= modulus:
            return False
        size = (modulus.bit_length() + 7) // 8
        encoded = pow(signed, exponent, modulus).to_bytes(size, "big")
    except (TypeError, ValueError, OverflowError):
        return False
    digest_info = _RSA_SHA256_PREFIX + hashlib.sha256(message).digest()
    if len(encoded) < len(digest_info) + 11 or not encoded.startswith(b"\x00\x01"):
        return False
    separator = encoded.find(b"\x00", 2)
    if separator < 10 or any(value != 0xff for value in encoded[2:separator]):
        return False
    return hmac.compare_digest(encoded[separator + 1:], digest_info)


def _trusted_authority(state, proof, root):
    task_id = _text(proof.get("task_id"), "proof.task_id", 200)
    if task_id != _bound_task_id(root):
        _die("宿主凭据与当前任务目录绑定不匹配")
    name = hashlib.sha256(task_id.encode("utf-8")).hexdigest() + ".json"
    stored = _read_json_file(os.path.join(root, name), "宿主能力")
    if not isinstance(stored, dict) or stored.get("schema") != \
            "mae-flow-host-capability/1":
        _die("宿主能力文件格式损坏")
    authority = stored.get("authority")
    if not isinstance(authority, dict) or authority.get("schema") != \
            AUTHORITY_SCHEMA or authority.get("alg") != "RS256":
        _die("宿主能力没有有效的 RS256 公钥")
    if str(authority.get("task_id") or "") != task_id:
        _die("宿主能力绑定的任务不匹配")
    try:
        modulus = int.from_bytes(_b64url(authority.get("n")), "big")
        exponent = int.from_bytes(_b64url(authority.get("e")), "big")
    except (TypeError, ValueError, UnicodeError):
        _die("宿主能力公钥编码无效")
    if modulus.bit_length() < 2048 or exponent != 65537:
        _die("宿主能力公钥必须是 2048 位以上 RSA 且 e=65537")
    expected_key_id = hashlib.sha256((
        "%s.%s" % (authority.get("n"), authority.get("e"))
    ).encode("utf-8")).hexdigest()[:24]
    if not hmac.compare_digest(str(authority.get("key_id") or ""),
                               expected_key_id):
        _die("宿主能力 key_id 与公钥不匹配")
    # Agent 可写状态中的 host_authority 只是诊断镜像，不是信任根。真正的
    # 任务身份、公钥和强制模式全部来自工作区外的 capability 文件。
    return authority


def verify_host_proof(state, proof_path, action, payload):
    proof, root = _proof_payload(proof_path)
    authority = _trusted_authority(state, proof, root)
    unsigned = {
        "schema": PROOF_SCHEMA,
        "task_id": _text(proof.get("task_id"), "proof.task_id", 200),
        "action": _text(proof.get("action"), "proof.action", 40),
        "payload_digest": _text(
            proof.get("payload_digest"), "proof.payload_digest", 128),
        "nonce": _text(proof.get("nonce"), "proof.nonce", 200),
        "issued_at": int(proof.get("issued_at") or 0),
    }
    if unsigned["task_id"] != str(authority.get("task_id") or ""):
        _die("宿主凭据绑定的任务不匹配")
    if unsigned["action"] != action:
        _die("宿主凭据绑定的动作不匹配")
    expected = hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()
    if not hmac.compare_digest(unsigned["payload_digest"], expected):
        _die("宿主凭据绑定的载荷摘要不匹配")
    now = int(time.time())
    if unsigned["issued_at"] < now - 120 or unsigned["issued_at"] > now + 30:
        _die("宿主凭据已过期或时间异常")
    if unsigned["nonce"] in state.setdefault("host_capability_nonces", []):
        _die("宿主凭据已经消费，拒绝重放")
    signature = _text(proof.get("signature"), "proof.signature", 8192)
    if authority.get("alg") != "RS256" or not _verify_rsa_sha256(
            authority, _canonical(unsigned).encode("utf-8"), signature):
        _die("宿主凭据签名无效")
    # Every host mutation shares this admission point. Owner scheduling cannot
    # be changed by editing task JSON and waiting for the next unrelated host
    # event to re-sign it. Import lazily: receipt verification uses this module.
    from .host_receipts import verify_feedback_control_predecessor
    verify_feedback_control_predecessor(state)
    return {
        "root": root,
        "proof": {**unsigned, "signature": signature},
        "payload": payload,
    }

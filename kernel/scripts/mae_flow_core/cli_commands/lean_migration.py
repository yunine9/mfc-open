"""Non-destructive recovery of an in-flight Lean v3 state into stable v2."""

import hashlib
import json
import os
import re
import subprocess
import sys
import time

from mae_flow_core.orchestration.stable_recovery import recover_lean_flow
from mae_flow_core.state_store import atomic_write_json
from mae_flow_core.workflow.command_catalog import render_display

from .shared import STATE_PATH


_BACKUP_DIRECTORY = os.path.join(".mae-flow-work", "state-backups")
_PROPOSAL_PATH = os.path.join(_BACKUP_DIRECTORY, "lean-v3-recovery.json")

# One-time retirement bridge.  These names are intentionally isolated here;
# no active command, transition, hook or evidence rule understands the old
# batch-development protocol.
_RETIRED_BATCH_TARGETS = {
    "test_blueprint": "story",
    "build_plan": "build",
    "build_pace": "build",
    "tw_pace": "build",
    "rf_pace": "build",
    "tw_change": "build",
    "tw_compile": "build",
    "tw_review": "build",
    "rf_fix": "build",
    "rf_compile": "build",
    "rf_review": "build",
}


def _read_bytes(path):
    with open(path, "rb") as stream:
        return stream.read()


def _parse_json(raw):
    return json.loads(raw.decode("utf-8-sig", errors="strict"))


def _lean_document(path=STATE_PATH):
    raw = _read_bytes(path)
    document = _parse_json(raw)
    return raw, document


def _is_lean(document):
    return isinstance(document, dict) and document.get("engine") == "lean-v1"


def _proposal_for(raw, recovery):
    digest = hashlib.sha256(raw).hexdigest()
    if os.path.isfile(_PROPOSAL_PATH):
        try:
            with open(_PROPOSAL_PATH, encoding="utf-8") as stream:
                existing = json.load(stream)
            backup = existing.get("backup_path", "")
            if existing.get("source_sha256") == digest and os.path.isfile(backup):
                return existing
        except (OSError, ValueError, TypeError):
            pass
    os.makedirs(_BACKUP_DIRECTORY, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(
        _BACKUP_DIRECTORY, "%s-%s-lean-v3.json" % (stamp, digest[:10]))
    suffix = 2
    base = backup
    while os.path.exists(backup):
        backup = base[:-5] + "-%d.json" % suffix
        suffix += 1
    with open(backup, "xb") as stream:
        stream.write(raw)
        stream.flush()
        try:
            os.fsync(stream.fileno())
        except OSError:
            pass
    proposal = {
        "source_sha256": digest,
        "backup_path": backup.replace("\\", "/"),
        "safe_boundary": recovery.safe_boundary,
        "terminal": recovery.terminal,
        "confirmed": False,
    }
    atomic_write_json(_PROPOSAL_PATH, proposal)
    return proposal


def prepare_stable_recovery(path=STATE_PATH):
    raw, document = _lean_document(path)
    if not _is_lean(document):
        raise ValueError("当前状态不是 Lean v3，无需恢复")
    recovery = recover_lean_flow(document)
    if recovery.warning:
        raise ValueError(recovery.warning)
    return recovery, _proposal_for(raw, recovery), raw


def _confirmation_text(message_id):
    wanted = str(message_id or "").strip()
    if not wanted:
        raise ValueError("缺少 --message-id；先执行 messages 获取真实用户消息 ID")
    path = STATE_PATH + ".usermsg"
    try:
        with open(path, encoding="utf-8") as stream:
            rows = json.load(stream)
    except (OSError, ValueError) as exc:
        raise ValueError("无法读取用户消息: %s" % exc)
    matches = [row for row in rows if isinstance(row, dict)
               and str(row.get("id", "")) == wanted]
    if not matches:
        raise ValueError("不存在用户消息 ID %s" % wanted)
    return str(matches[-1].get("text", "") or "")


def _assert_natural_confirmation(text):
    compact = re.sub(r"\s+", "", text)
    if any(word in compact for word in ("不确认", "不同意", "不要恢复", "取消")):
        raise ValueError("用户消息没有授权恢复")
    if not any(word in compact for word in ("确认", "同意", "批准", "恢复", "迁移")):
        raise ValueError("用户消息没有明确确认恢复")


def confirm_stable_recovery(path, message_id):
    recovery, proposal, raw = prepare_stable_recovery(path)
    _assert_natural_confirmation(_confirmation_text(message_id))
    if _read_bytes(path) != raw:
        raise ValueError("Lean 状态在确认期间发生变化，请重新查看恢复卡")
    if recovery.terminal:
        terminal = proposal["backup_path"][:-5] + "-terminal.json"
        if not os.path.exists(terminal):
            os.replace(path, terminal)
        proposal["terminal_archive"] = terminal.replace("\\", "/")
    else:
        stable = dict(recovery.state)
        stable["started"] = time.strftime("%Y-%m-%d %H:%M:%S")
        stable["initial_dirty_fingerprints"] = {}
        atomic_write_json(path, stable)
    proposal["confirmed"] = True
    atomic_write_json(_PROPOSAL_PATH, proposal)
    return recovery, proposal


def _print_card(recovery, proposal):
    print("[mae-flow] 检测到 Lean v3 在途状态；已创建逐字节恢复备份。")
    print("备份: " + proposal["backup_path"])
    if recovery.terminal:
        print("状态: 已完成/已退出；确认后仅归档，不启动稳定流程。")
    else:
        print("建议恢复到稳定流程步骤: " + recovery.safe_boundary)
        print("仅迁移单号、用户配置、分支、启动时修改和已确认产物路径；"
              "不会迁移令牌、哈希、指纹、检视摘要或交付收据。")
    print("请用户明确确认后先执行 %s，再运行: %s" % (
        render_display("messages"),
        render_display("migrate_confirm", {"message_id": "<消息ID>"}),
    ))


def _terminal_lean_gate_bypasses():
    if not os.path.isfile(STATE_PATH):
        return False


def retire_legacy_batch_state(path=STATE_PATH):
    """Strip the retired batch protocol and resume at whole-change build."""
    if not os.path.isfile(path):
        return False
    try:
        raw = _read_bytes(path)
        document = _parse_json(raw)
    except Exception:
        return False
    if not isinstance(document, dict) or _is_lean(document):
        return False
    has_legacy = (
        document.get("current") in _RETIRED_BATCH_TARGETS
        or "development_review" in document
        or "development_pace" in (document.get("choices") or {})
        or "development_checkpoints" in (document.get("protocols") or {})
        or "CP_IMPLEMENT" in (document.get("agent_tasks") or {})
        or any(role in (document.get("role_tasks") or {}) for role in (
            "cp-implement", "task-analysis", "craft-plan", "craft-code"))
    )
    if not has_legacy:
        return False
    document.pop("development_review", None)
    choices = document.get("choices") or {}
    choices.pop("development_pace", None)
    protocols = document.get("protocols") or {}
    protocols.pop("development_checkpoints", None)
    tasks = document.get("agent_tasks") or {}
    tasks.pop("CP_IMPLEMENT", None)
    roles = document.get("role_tasks") or {}
    for role in ("cp-implement", "task-analysis", "craft-plan", "craft-code"):
        roles.pop(role, None)
    if document.get("current") in _RETIRED_BATCH_TARGETS:
        document["current"] = _RETIRED_BATCH_TARGETS[document["current"]]
    if not document.get("implementation_base_head"):
        try:
            document["implementation_base_head"] = subprocess.check_output(
                ["git", "rev-parse", "--verify", "HEAD"],
                text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            document["implementation_base_head"] = ""
    document.setdefault("migrations", []).append({
        "type": "retire-batch-development",
        "target": "build",
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    if _read_bytes(path) != raw:
        return False
    atomic_write_json(path, document)
    return True
    try:
        _raw, document = _lean_document(STATE_PATH)
        recovery = recover_lean_flow(document)
        return recovery.terminal
    except Exception:
        return False


def handle_early_state_command(args):
    """Intercept Lean state before the stable loader sees it."""
    if args.cmd == "gate" and _terminal_lean_gate_bypasses():
        return True
    if args.cmd not in {"current", "migrate-flow"}:
        return False
    if not os.path.isfile(STATE_PATH):
        if args.cmd == "current":
            return False
        print("[mae-flow] 没有可恢复的 .mae-flow.json。", file=sys.stderr)
        raise SystemExit(2)
    try:
        _raw, document = _lean_document(STATE_PATH)
    except Exception as exc:
        print("[mae-flow] 状态读取失败: %s" % exc, file=sys.stderr)
        raise SystemExit(2)
    if not _is_lean(document):
        if args.cmd == "current":
            return False
        if not (isinstance(document, dict)
                and document.get("schema_version") == 2
                and isinstance(document.get("current"), str)
                and document.get("current")):
            print("[mae-flow] 恢复失败: 不支持的状态格式；原文件保持不变。",
                  file=sys.stderr)
            raise SystemExit(2)
        print("[mae-flow] 当前已经是稳定流程状态，无需迁移。")
        return True
    try:
        if args.cmd == "migrate-flow" and args.confirm:
            if not args.message_id:
                raise ValueError("--confirm 必须同时提供 --message-id")
            recovery, proposal = confirm_stable_recovery(
                STATE_PATH, args.message_id)
            if recovery.terminal:
                print("[mae-flow] Lean 终态已安全归档，当前没有活动流程。")
            else:
                print("[mae-flow] 已恢复到稳定流程步骤: "
                      + recovery.safe_boundary)
            print("原始备份: " + proposal["backup_path"])
            return True
        if args.cmd == "migrate-flow" and args.message_id:
            raise ValueError("--message-id 只能与 --confirm 一起使用")
        recovery, proposal, _raw = prepare_stable_recovery(STATE_PATH)
    except Exception as exc:
        print("[mae-flow] 恢复失败: %s" % exc, file=sys.stderr)
        raise SystemExit(2)
    _print_card(recovery, proposal)
    return True


def migrate_legacy_spec_workspace(root="."):
    """openspec/ → .mae-flow-work/spec 一次性搬迁。返回 (moved, note)。

    这是目录归一,不是行为变更:规格引擎自 v4 起就是内置纯 Python,
    openspec/ 只是它沿用的退役外部引擎的目录名。搬迁规则:

    - 旧目录被 git 跟踪(老仓的 openspec/specs 历史领域真相、已提交的在途单)
      → 原地保留,引擎继续用旧根——搬走会在用户的 git status 里制造成片删除;
    - 不在 git 仓、git 查询失败、目标已存在、搬迁抛错 → 跳过并沿用旧根,
      **绝不阻塞**:引擎的双根解析保证两种布局都能继续工作;
    - 只有"旧目录存在 + 完全未跟踪 + 新目录不存在"才搬,搬完旧路径消失,
      引擎自动切到新根。
    """
    base = os.path.abspath(root)
    legacy = os.path.join(base, "openspec")
    target = os.path.join(base, ".mae-flow-work", "spec")
    if not os.path.isdir(legacy) or os.path.exists(target):
        return False, ""
    try:
        probe = subprocess.run(
            ["git", "-C", base, "ls-files", "--", "openspec"],
            shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=15)
    except Exception:
        return False, ""
    if probe.returncode != 0:
        return False, ""  # 不是 git 仓/查询失败:无法证明未跟踪,不动
    if probe.stdout.strip():
        return False, ""  # 被跟踪:历史真相原地保留
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        import shutil
        shutil.move(legacy, target)
    except OSError:
        return False, ""  # 半途失败也不阻塞;引擎双根解析兜底
    return True, ("[mae-flow] 规格工作区已从 openspec/ 归一到 "
                  ".mae-flow-work/spec/(本地过程区,不进提交)。")

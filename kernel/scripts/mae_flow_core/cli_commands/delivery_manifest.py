"""Human-readable, exact delivery manifest commands for the stable flow."""

import copy
import shlex

from mae_flow_core.delivery.archive_commit import committed_archive_receipt

from mae_flow_core.guard.manifest import (
    DeliveryManifest,
    validate_delivery_document_boundary,
)
from mae_flow_core.workflow.command_catalog import render_display

from .shared import os, re, subprocess
from .wiring import api


def _archive_delivery_paths(st):
    """Return only paths produced by this delivery's archive operation."""
    data = (st or {}).get("spec", {}) or {}
    paths = [
        re.sub(r"^(?:\./)+", "", api.norm(path))
        for path in data.get("archive_paths", []) or []
        if isinstance(path, str) and path.strip()
    ]
    if paths:
        return list(dict.fromkeys(paths))

    # One-way compatibility for archive state written before exact archive
    # paths were persisted.  Derive only current outputs, never old dirt.
    archive_name = str(data.get("archived_to", "") or "")
    if archive_name:
        paths.append("openspec/changes/archive/" + archive_name)
    paths.extend(
        path for path in api._dirty_paths()
        if path.startswith("openspec/specs/")
        and not api._unchanged_initial_dirty(path, st or {})
    )
    return list(dict.fromkeys(paths))


def _committed_delivery_paths(st):
    """List paths committed inside the current delivery's quality scope."""
    scope, err = api._scope_diff(st)
    if err:
        return [], err
    try:
        result = subprocess.run(
            ["git", "-c", "core.quotepath=false", "diff", "--name-only",
             "--no-renames", "--diff-filter=ACMRTUXB", scope, "--"],
            shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
    except Exception as exc:
        return [], str(exc)
    if result.returncode != 0:
        return [], (result.stderr or result.stdout or "git diff 失败").strip()
    changed = {
        re.sub(r"^(?:\./)+", "", api.norm(path))
        for path in result.stdout.splitlines() if path.strip()
    }
    return sorted(changed), ""


def _committed_initial_carryover(st):
    """Find unchanged pre-flow dirt accidentally committed in this delivery."""
    if not st or not st.get("initial_dirty"):
        return [], ""
    changed, err = _committed_delivery_paths(st)
    if err:
        return [], err
    changed = set(changed)
    written = api._agent_written_paths()
    carried = [
        path for path in (st.get("initial_dirty", []) or [])
        if path in changed
        and api._unchanged_initial_dirty(path, st)
        and api._repo_path_identity(path) not in written
        and not api._authorized_delivery_path(path, st)
    ]
    return carried, ""


def _identity(path):
    return str(path).replace("\\", "/").casefold()


def select_unchanged_build_residue(
        current_dirty, agent_written, compile_side_effects,
        artifact_confidence, is_source, fingerprint):
    """Return fingerprinted local build residue safe to exclude from delivery.

    The decision is provenance-first, not directory-name-first. A direct Agent
    edit is always a delivery candidate. A strong compiler artefact may be
    recognised by shape; every other path needs both a COMPILE side-effect
    receipt and a non-source classification. Ambiguous ``test/``/``imap/``
    directories therefore cannot be hidden merely because an Agent called them
    generated output.
    """
    written = {_identity(path) for path in agent_written or ()}
    compiled = {_identity(path) for path in compile_side_effects or ()}
    residue = {}
    for path in current_dirty or ():
        identity = _identity(path)
        if identity in written:
            continue
        confidence = artifact_confidence(path)
        if (
            confidence == "strong"
            or (identity in compiled and not is_source(path))
        ):
            residue[path] = fingerprint(path)
    return residue


def _unchanged_build_residue(state, current_dirty):
    """Bind proven build residue to its current bytes for an unchanged manifest."""
    return select_unchanged_build_residue(
        current_dirty,
        api._agent_written_paths(),
        api._compile_side_effect_paths(),
        api._build_artifact_confidence,
        lambda path: api._is_source_path(path, state or {}, api.FLOW or {}),
        api._path_fingerprint,
    )


def _adoption_decisions(values, repository_root):
    decisions = {}
    for value in values or ():
        if "=" not in value:
            raise ValueError(
                "--adopt-dirty 必须使用 精确路径=用户自然语言决定")
        path, decision = value.split("=", 1)
        normalized = DeliveryManifest.from_paths(
            [path], repository_root=repository_root).files[0]
        decision = decision.strip()
        if len(decision) < 2:
            raise ValueError("启动时已有修改必须附带明确的用户自然语言决定")
        decisions[normalized] = decision
    return decisions


def build_delivery_manifest(
        state, files, message, target, adoption_values=(),
        candidate_paths=(), repository_root=None):
    """Build a stable manifest while preserving an unchanged confirmation."""
    root = os.path.abspath(repository_root or os.getcwd())
    exact = DeliveryManifest.from_paths(files, repository_root=root)
    if not exact.files:
        raise ValueError("交付清单至少需要一个精确文件")
    message = str(message or "").strip()
    target = str(target or "").strip()
    if not message:
        raise ValueError("交付清单缺少提交说明")
    if not target:
        raise ValueError("交付清单缺少目标分支")
    archive = (state or {}).get("domain_archive") or {}
    archive_paths = (
        archive.get("applied_paths") or ()
        if archive.get("status") == "applied" else ())
    advisories = list(validate_delivery_document_boundary(exact.files, archive_paths))

    candidates = {_identity(path) for path in candidate_paths}
    outside = [path for path in exact.files if _identity(path) not in candidates]
    if outside:
        advisories.append("选定文件未出现在候选增量中，请检视: " + "、".join(outside))

    adopted = _adoption_decisions(adoption_values, root)
    initial = {
        _identity(path): str(path).replace("\\", "/")
        for path in (state or {}).get("initial_dirty", ())
    }
    selected = {_identity(path): path for path in exact.files}
    adopted_ids = {_identity(path) for path in adopted}
    missing_adoption = [
        selected[identity] for identity in selected
        if identity in initial and identity not in adopted_ids
    ]
    if missing_adoption:
        advisories.append("选定文件含启动前改动，请一并检视: " + "、".join(missing_adoption))
    outside_adoption = [
        path for path in adopted if _identity(path) not in selected
    ]
    if outside_adoption:
        raise ValueError("采用决定不属于交付文件: " + "、".join(outside_adoption))

    candidate = {
        "files": sorted(exact.files, key=str.casefold),
        "commit_message": message,
        "target_branch": target,
        "adopted_dirty": {
            path: adopted[path] for path in sorted(adopted, key=str.casefold)
        },
        "confirmed": False,
        "advisories": advisories,
    }
    previous = (state or {}).get("delivery_manifest") or {}
    comparable = dict(candidate)
    comparable.pop("confirmed")
    comparable.pop("advisories", None)
    comparable.pop("commit_message", None)
    old_comparable = dict(previous)
    old_confirmed = bool(old_comparable.pop("confirmed", False))
    old_comparable.pop("confirmation", None)
    old_comparable.pop("advisories", None)
    old_comparable.pop("commit_message", None)
    if comparable == old_comparable and old_confirmed:
        candidate["confirmed"] = True
    return candidate


def build_unchanged_delivery_manifest(
        state, target, current_dirty=(), preserved_initial_dirty=(),
        build_residue_fingerprints=None, repository_root=None):
    """Build a confirmed no-op manifest after an unchanged domain archive."""
    archive = (state or {}).get("domain_archive") or {}
    advisories = []
    try:
        archive_receipt = committed_archive_receipt(archive, repository_root)
    except ValueError as exc:
        archive_receipt = {}
        advisories.append(str(exc))
    target = str(target or "").strip()
    if not target:
        raise ValueError("交付清单缺少目标分支")

    root = os.path.abspath(repository_root or os.getcwd())
    dirty = DeliveryManifest.from_paths(
        current_dirty or (), repository_root=root).files
    preserved = DeliveryManifest.from_paths(
        preserved_initial_dirty or (), repository_root=root).files
    preserved_ids = {_identity(path) for path in preserved}
    residue_input = (
        build_residue_fingerprints
        if isinstance(build_residue_fingerprints, dict) else {})
    residue_input_by_identity = {
        _identity(path): value for path, value in residue_input.items()
    }
    residue_paths = DeliveryManifest.from_paths(
        residue_input.keys(), repository_root=root).files
    residue_by_identity = {
        _identity(path): residue_input_by_identity[_identity(path)]
        for path in residue_paths
    }
    dirty_ids = {_identity(path) for path in dirty}
    stale_residue = [
        path for path in residue_paths
        if _identity(path) not in dirty_ids
    ]
    if stale_residue:
        raise ValueError(
            "构建现场不属于当前未提交文件: " + "、".join(stale_residue))
    unexpected = [
        path for path in dirty
        if (
            _identity(path) not in preserved_ids
            and _identity(path) not in residue_by_identity
        )
    ]
    if unexpected:
        listed = "、".join(unexpected[:20])
        suffix = " 等 %d 个" % len(unexpected) if len(unexpected) > 20 else ""
        raise ValueError("仍有新增未提交文件: " + listed + suffix
                         + "。--unchanged 不是已推送声明；请复用现有清单，或用"
                         " manifest set --file 列出本次交付文件（可含已提交文件），"
                         "其余残留保留，无需删除缓存或回退代码。")

    return {
        "files": [],
        "commit_message": "",
        "target_branch": target,
        "adopted_dirty": {},
        "confirmed": True,
        "no_changes": True,
        "advisories": advisories,
        "committed_archive_receipt": archive_receipt,
        "unchanged_initial_dirty": sorted(preserved, key=str.casefold),
        # 路径+指纹一起落盘：只豁免 manifest 当下那份编译现场。之后同路径
        # 被改成源码或资源时指纹会失配，done 仍会明确拦住。
        "unchanged_build_residue": {
            path: residue_by_identity[_identity(path)]
            for path in sorted(residue_paths, key=str.casefold)
        },
        "confirmation": {"mode": "unchanged"},
    }


def confirm_delivery_manifest(
        state, message_id, command_api=api, moonlight_auto=False):
    manifest = (state or {}).get("delivery_manifest") or {}
    if not manifest.get("files"):
        raise ValueError("尚未生成交付清单，请先执行 manifest set")
    if manifest.get("confirmed") is True:
        return state
    if moonlight_auto:
        from mae_flow_core import host_env
        if not host_env.unattended_confirm_allowed(state):
            raise ValueError("--auto 只允许在月光宝盒或云端宿主运行中使用")
        confirmation = {"mode": "moonlight-auto"}
    else:
        ok, answer, receipt, error = command_api._authorization_message(
            state, message_id)
        if not ok:
            raise ValueError(error)
        if not str(answer or "").strip():
            raise ValueError("用户确认内容为空")
        from mae_flow_core.workflow.consent import is_refusal
        if is_refusal(answer):
            raise ValueError(
                "用户回答没有明确批准当前交付清单；"
                "清单保持待确认，请按用户意见修改后重新展示")
        confirmation = {"mode": "user", "receipt": receipt}
    updated = copy.deepcopy(state)
    updated["delivery_manifest"]["confirmed"] = True
    updated["delivery_manifest"]["confirmation"] = confirmation
    return updated


def _current_candidates(files):
    command = "git add -- " + " ".join(shlex.quote(path) for path in files)
    return tuple(api._pending_commit_candidates(command).get("paths", ()))


def _print_manifest(manifest):
    print("[mae-flow] 精确交付清单")
    print("目标分支: " + str(manifest.get("target_branch", "")))
    print("提交说明: " + str(manifest.get("commit_message", "")))
    print("用户确认: " + ("已确认" if manifest.get("confirmed") else "待确认"))
    print("文件:")
    files = manifest.get("files", ())
    if files:
        for path in files:
            print("- " + path)
    else:
        print("- 无新增待提交文件（已有提交仍须继续交付）")
    for advisory in manifest.get("advisories") or ():
        print("提示（不阻断）: " + advisory)
    adopted = manifest.get("adopted_dirty") or {}
    if adopted:
        print("启动时已有修改的采用决定:")
        for path, decision in adopted.items():
            print("- %s: %s" % (path, decision))
    residue = manifest.get("unchanged_build_residue") or {}
    if residue:
        print("本地构建现场（不交付、不要求清理）:")
        for path in list(residue)[:20]:
            print("- " + path)
        if len(residue) > 20:
            print("- …其余 %d 个" % (len(residue) - 20))


def cmd_delivery_manifest(state, args):
    if state is None:
        api.die("流程未初始化，不能生成交付清单。", 2)
    if args.manifest_action == "show":
        manifest = state.get("delivery_manifest") or {}
        if not manifest:
            api.die("尚未生成交付清单。", 2)
        _print_manifest(manifest)
        return manifest
    if args.manifest_action == "set":
        try:
            if args.unchanged:
                dirty = tuple(api._dirty_paths())
                preserved = tuple(
                    path for path in dirty
                    if api._unchanged_initial_dirty(path, state)
                )
                manifest = build_unchanged_delivery_manifest(
                    state, args.target, current_dirty=dirty,
                    preserved_initial_dirty=preserved,
                    build_residue_fingerprints=(
                        _unchanged_build_residue(state, dirty)))
            else:
                manifest = build_delivery_manifest(
                    state, args.file or (), args.message, args.target,
                    args.adopt_dirty, _current_candidates(args.file or ()))
        except ValueError as exc:
            api.die(str(exc), 2)
        updated = copy.deepcopy(state)
        updated["delivery_manifest"] = manifest
        api.save_state(updated)
        _print_manifest(manifest)
        if manifest.get("no_changes"):
            print("下一步: 无需创建新提交；执行 done，已有提交继续进入交付流程。")
        elif not manifest["confirmed"]:
            print("下一步: 请向用户展示以上清单；收到回答后执行 "
                  + render_display("messages") + "，再执行 "
                  + render_display(
                      "manifest_confirm", {"message_id": "<消息ID>"}) + "。")
        return manifest
    try:
        updated = confirm_delivery_manifest(
            state, args.message_id or "", moonlight_auto=args.moonlight_auto)
    except ValueError as exc:
        api.die(str(exc), 2)
    if updated is not state:
        api.save_state(updated)
    label = "无人值守自动确认" if args.moonlight_auto else "用户确认"
    print("[mae-flow] 交付清单已由%s；只允许暂存并提交上述精确文件。" % label)
    return updated.get("delivery_manifest")

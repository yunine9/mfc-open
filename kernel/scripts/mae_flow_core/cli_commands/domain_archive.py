"""Local candidate and confirmed domain archive commands."""

import copy
import difflib
import json
import shutil
import sys

from .shared import os
from .wiring import api
from .domain_archive_recovery import (
    changed_domain_paths, prepare_existing)
from mae_flow_core.orchestration.domain_archive import (
    apply_candidates,
    candidate_from_dict,
    initialize_candidate,
    input_digest,
    prepare_candidate,
)
from mae_flow_core.orchestration.work_package import ensure_work_package


def _ticket(state):
    value = str(((state or {}).get("config") or {}).get("单号", "")).strip()
    if not value:
        raise ValueError("领域归档缺少需求单号")
    return value


def _package_inputs(package):
    return (
        package.spec, package.grill, package.story,
        package.implementation, package.decisions,
    )


def _git_facts():
    return "%s\n%s" % (
        api.sh("git -c core.quotepath=false diff --no-ext-diff --binary HEAD -- ."),
        api.sh("git -c core.quotepath=false status --porcelain --untracked-files=all"),
    )


def _localize_legacy_process_files(root, state, package):
    ticket = _ticket(state)
    change = str(((state or {}).get("config") or {}).get("CHANGE_NAME", "")).strip()
    mappings = [
        (os.path.join(root, "docs", "clarifications-%s.md" % ticket), package.decisions),
        (os.path.join(root, "docs", "review", "REVIEW-%s.md" % ticket),
         os.path.join(package.root, "review.md")),
        (os.path.join(root, "docs", "codecheck-exempt-%s.md" % ticket),
         os.path.join(package.root, "codecheck-exemptions.md")),
        (os.path.join(root, "docs", "story", "STORY-%s.md" % ticket), package.story),
        (os.path.join(root, "docs", "delivery-notes.md"),
         os.path.join(package.root, "legacy", "delivery-notes.md")),
    ]
    if change:
        mappings.append((
            os.path.join(root, "openspec", "changes", change),
            os.path.join(package.root, "legacy", "openspec-change-%s" % change),
        ))
        mappings.append((
            os.path.join(root, ".mae-flow-work", "spec", "changes", change),
            os.path.join(package.root, "legacy", "spec-change-%s" % change),
        ))
    moved = []
    for source, preferred in mappings:
        if not os.path.exists(source):
            continue
        relative = os.path.relpath(source, root).replace("\\", "/")
        tracked = api.argv_out([
            "git", "ls-files", "--", relative]).strip()
        if tracked:
            continue
        target = preferred
        if os.path.exists(target):
            target = os.path.join(
                package.root, "legacy", relative.replace("/", "__"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(source, target)
        moved.append((relative, os.path.relpath(target, root).replace("\\", "/")))
    return tuple(moved)


def _entries(root, record):
    return tuple(candidate_from_dict(root, value) for value in record.get("domains", ()))


def _fresh_digest(root, package, entries):
    return input_digest(root, _package_inputs(package), _git_facts(), entries)


def _show(record, root):
    print("[mae-flow] 领域归档状态: " + str(record.get("status", "未准备")))
    domains = record.get("domains") or ()
    print("- 归档结果: " + str(record.get("result", "未判定")))
    if "changed_paths" in record:
        print("- 本次实际内容变化: " + ("、".join(record["changed_paths"]) or "无"))
    if record.get("applied_paths"):
        print("- 已认领归档文件（不代表仍需新提交）: " + "、".join(record["applied_paths"]))
    if record.get("reapply_paths") and record.get("status") != "applied":
        print("- 本次将由 apply 重新写入并接纳已有领域文档与索引；候选已冻结，请核对正文。")
    if not domains:
        if record.get("result") == "unchanged":
            print("- 结论: unchanged（无需更新领域文档）")
        else:
            print("- 尚未生成领域归档候选")
        return
    for value in domains:
        entry = candidate_from_dict(root, value)
        print("- %s: 候选内容 %s（相对当前文档） -> %s" % (entry.domain, entry.action, entry.target_path))
        target = os.path.join(root, *entry.target_path.split("/"))
        try:
            with open(target, encoding="utf-8") as stream:
                before = stream.read().splitlines(True)
        except OSError:
            before = []
        try:
            with open(entry.candidate_path, encoding="utf-8") as stream:
                after = stream.read().splitlines(True)
        except OSError:
            print("  提示: 候选文件不可读，现有正式文档保持不变；可补充候选或直接 done。")
            continue
        for line in difflib.unified_diff(
                before, after, fromfile=entry.target_path,
                tofile=value["candidate_path"]):
            print(line.rstrip("\n"))


def _command_text(arguments):
    executable = json.dumps(os.path.abspath(sys.argv[0]), ensure_ascii=False)
    rendered = []
    for index, value in enumerate(arguments):
        text = str(value)
        rendered.append(
            text if index < 2 or text.startswith("--") or text == "done"
            else json.dumps(text, ensure_ascii=False))
    return "python %s %s" % (executable, " ".join(rendered))


def _status_recovery(record):
    status = str((record or {}).get("status", "") or "")
    domains = list((record or {}).get("domains") or ())
    if status == "draft" and domains:
        value = domains[-1]
        arguments = [
            "domain-archive", "prepare", "--domain", value.get("domain", "")]
        for keyword in value.get("keywords") or ():
            arguments.extend(("--keyword", keyword))
        return _command_text(arguments)
    if status == "prepared":
        return _command_text(("domain-archive", "show"))
    if status == "applied":
        return _command_text(("done",))
    return _command_text((
        "domain-archive", "prepare", "--domain", "<领域>",
        "--keyword", "<关键词>"))


def _prepare(state, args, root, package):
    if getattr(args, "adopt_existing", False):
        record = prepare_existing(state, args, root, package, _fresh_digest)
        _show(record, root)
        return record
    updated = copy.deepcopy(state)
    previous = copy.deepcopy(updated.get("domain_archive") or {})
    if previous.get("status") == "applied" and not args.unchanged:
        previous_entries = _entries(root, previous)
        current_digest = _fresh_digest(root, package, previous_entries)
        requested_keywords = tuple(dict.fromkeys(
            str(word).strip() for word in args.keyword if str(word).strip()))
        same_request = any(
            entry.domain == args.domain and entry.keywords == requested_keywords
            for entry in previous_entries)
        if same_request and previous.get("input_sha256") == current_digest:
            _show(previous, root)
            print("提示: 已应用且内容未变化，可直接 done。")
            return previous
        # 后续轮次准备一个领域时保留同需求其他已核对候选；否则它们
        # 仍在交付增量中，却会随 applied_paths 清空而失去归档归属。
        previous = {} if args.unchanged else {
            "domains": previous.get("domains") or [],
            "reapply_paths": previous.get("reapply_paths") or [],
        }
    if args.unchanged:
        # Explicitly choosing no further archive edits does not erase documents
        # or old provenance, and is independent of code already committed.
        if previous.get("domains"):
            print("提示: 本轮不再应用候选；已有文档和归档凭证保留。")
        record = {
            "status": "prepared", "result": "unchanged", "domains": [],
            "input_sha256": _fresh_digest(root, package, ()),
            "applied_paths": list(previous.get("applied_paths") or ()),
            "changed_paths": [],
        }
        updated["domain_archive"] = record
        api.save_state(updated)
        _show(record, root)
        return record
    archive_root = os.path.join(package.root, "domain-archive")
    template = os.path.join(
        root, ".mae-flow-work", "plugin-resources", "assets",
        "DOMAIN-SPEC-TEMPLATE.md")
    try:
        with open(template, encoding="utf-8") as stream:
            template_content = stream.read()
    except OSError:
        template_content = "# <领域名称>\n"
        print("提示（不阻断）: 领域模板不可读，使用基础标题创建候选。")
    initialized = initialize_candidate(
        root, archive_root, args.domain, template_content)
    values = list(previous.get("domains") or ())
    if initialized.initialized:
        values = [value for value in values if value.get("domain") != args.domain]
        draft = initialized.to_dict(root)
        draft["keywords"] = list(dict.fromkeys(
            str(keyword).strip() for keyword in args.keyword
            if str(keyword).strip()))
        values.append(draft)
        record = {
            "status": "draft", "result": "pending", "domains": values,
            "reapply_paths": list(previous.get("reapply_paths") or ()),
            "input_sha256": "", "applied_paths": [],
        }
        updated["domain_archive"] = record
        api.save_state(updated)
        print("[mae-flow] 已初始化领域候选: "
              + os.path.relpath(initialized.candidate_path, root).replace("\\", "/"))
        print("填写长期领域事实后，原样重跑本次 prepare 命令。")
        return record
    prepared = prepare_candidate(
        root, initialized.candidate_path, args.domain, args.keyword)
    values = [value for value in values if value.get("domain") != args.domain]
    values.append(prepared.to_dict(root))
    entries = tuple(candidate_from_dict(root, value) for value in values)
    reapply_paths = _reapply_delivery_paths(state, entries, previous)
    record = {
        "status": "prepared",
        "result": (
            "unchanged"
            if not reapply_paths and entries
            and all(entry.action == "unchanged" for entry in entries)
            else "changes"),
        "reapply_paths": reapply_paths,
        "domains": values,
        "input_sha256": _fresh_digest(root, package, entries),
        "applied_paths": [],
    }
    updated["domain_archive"] = record
    api.save_state(updated)
    _show(record, root)
    return record


def _reapply_delivery_paths(state, entries, record):
    paths = set(record.get("reapply_paths") or ())
    if entries:
        try:
            changed = set(changed_domain_paths(state))
        except ValueError as exc:
            print("提示（不阻断）: 无法计算历史归档归属: " + str(exc))
            changed = set()
        for entry in entries:
            if entry.target_path in changed or "docs/specs/index.md" in changed:
                paths.add(entry.target_path)
    return sorted(paths)


def _document_bytes(root, path):
    try:
        with open(os.path.join(root, path), "rb") as stream:
            return stream.read()
    except FileNotFoundError:
        return None


def _apply(state, args, root, package):
    record = copy.deepcopy(state.get("domain_archive") or {})
    already_applied = record.get("status") == "applied"
    if record.get("status") not in ("prepared", "applied"):
        raise ValueError("领域归档尚未准备完成；执行 domain-archive status 查看恢复动作")
    entries = _entries(root, record)
    digest = _fresh_digest(root, package, entries)
    reapply = _reapply_delivery_paths(state, entries, record)
    # Applying local documents is ordinary workspace editing, not publication.
    # A supplied human answer must still be genuine and must not be a refusal.
    receipt = {"mode": "moonlight-auto" if getattr(args, "moonlight_auto", False) else "local-edit"}
    if getattr(args, "message_id", None):
        ok, answer, receipt, error = api._authorization_message(
            state, args.message_id)
        if not ok:
            raise ValueError(error)
        if not str(answer or "").strip():
            raise ValueError("用户确认内容为空")
        from mae_flow_core.workflow.consent import is_refusal
        if is_refusal(answer):
            raise ValueError(
                "用户回答没有明确批准本次领域归档；候选已保留，"
                "按用户意见修改后重新 prepare/show")
    if (already_applied and "changed_paths" in record
            and record.get("input_sha256") == digest
            and set(reapply).issubset(set(record.get("applied_paths") or ()))):
        _show(record, root)
        return record
    if record.get("input_sha256") != digest:
        print("提示: 候选或目标内容已变化，按当前内容重新计算本次归档。")
    # Preserve provenance separately from bytes changed by this application.
    record["reapply_paths"] = reapply
    entries = tuple(prepare_candidate(root, e.candidate_path, e.domain, e.keywords) for e in entries)
    observed = {e.target_path for e in entries} | {"docs/specs/index.md"}
    before = {path: _document_bytes(root, path) for path in observed}
    paths = apply_candidates(root, entries, reapply_paths=record["reapply_paths"])
    changed = sorted(path for path in observed if before[path] != _document_bytes(root, path))
    record.update({
        "status": "applied",
        "result": "changes" if changed else "unchanged",
        "changed_paths": changed,
        "domains": [e.to_dict(root) for e in entries],
        "applied_paths": sorted(set(paths) | set(record.get("applied_paths") or ())),
        "authorization": receipt,
    })
    record["input_sha256"] = _fresh_digest(root, package, entries)
    updated = copy.deepcopy(state)
    updated["domain_archive"] = record
    api.save_state(updated)
    print("[mae-flow] 领域归档已应用。")
    for path in paths:
        print("- " + path)
    if not changed:
        print("- 无领域文档内容变化；已认领路径仅作为归档凭证")
    return record


def cmd_domain_archive(state, args):
    if state is None:
        api.die("流程未初始化，不能执行领域归档。", 2)
    root = os.getcwd()
    try:
        package = ensure_work_package(root, _ticket(state))
        if args.domain_archive_action == "prepare":
            return _prepare(state, args, root, package)
        record = state.get("domain_archive") or {}
        if args.domain_archive_action in {"show", "status"}:
            _show(record, root)
            if args.domain_archive_action == "status":
                print("下一步: " + _status_recovery(record))
            return record
        return _apply(state, args, root, package)
    except (OSError, TypeError, ValueError) as exc:
        api.die("领域归档失败: %s" % exc, 2)

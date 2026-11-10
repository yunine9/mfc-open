"""Explicit recovery for formal domain files written before archive apply."""
import copy
import json
import os

from .wiring import api
from mae_flow_core.orchestration.domain_archive import (
    initialize_candidate, prepare_candidate, candidate_from_dict)
from mae_flow_core.orchestration.behavior_baseline import plan_domain_reconciliation


def changed_domain_paths(state):
    scope, error = api._scope_diff(state)
    if error:
        raise ValueError("无法核对领域文档变化: " + error)
    committed = api.argv_out([
        "git", "diff", "--name-only", scope, "--", "docs/specs/"])
    paths = set(committed.splitlines()) | set(api._dirty_paths())
    return sorted(path for path in paths if path.startswith("docs/specs/"))


def recovery_hint(paths):
    domains = [path[len("docs/specs/"):-3] for path in paths
               if path.startswith("docs/specs/") and path.endswith(".md")
               and path != "docs/specs/index.md"]
    commands = ["domain-archive prepare --domain %s --adopt-existing --keyword <领域关键词>"
                % json.dumps(domain, ensure_ascii=False) for domain in domains]
    return ("领域归档记录与实际文档不一致: " + "、".join(paths)
            + "。保留现有文件，逐领域执行 " + "；".join(commands or [
                "domain-archive prepare --domain <关联领域> --adopt-existing --keyword <领域关键词>"])
            + "，再 show 核对、apply 归档；不要手改 applied_paths。")


def prepare_existing(state, args, root, package, fresh_digest):
    if args.unchanged or not args.domain:
        raise ValueError("--adopt-existing 必须与 --domain 一起使用，不能声明 --unchanged")
    target = plan_domain_reconciliation(root, args.domain, "placeholder")
    if not os.path.isfile(target.absolute_path) or os.path.islink(target.absolute_path):
        raise ValueError("接纳的正式领域文档不存在或是符号链接: " + target.path)
    initialized = initialize_candidate(
        root, os.path.join(package.root, "domain-archive"), args.domain, "", adopt_existing=True)
    prepared = prepare_candidate(root, initialized.candidate_path, args.domain, args.keyword)
    previous = state.get("domain_archive") or {}
    domains = [item for item in previous.get("domains", []) if item.get("domain") != args.domain]
    domains.append(prepared.to_dict(root))
    entries = tuple(candidate_from_dict(root, item) for item in domains)
    paths = sorted(set(previous.get("reapply_paths") or ()) | {prepared.target_path})
    record = {"status": "prepared", "result": "changes", "domains": domains,
              "reapply_paths": paths, "applied_paths": [],
              "input_sha256": fresh_digest(root, package, entries)}
    updated = copy.deepcopy(state)
    updated["domain_archive"] = record
    api.save_state(updated)
    return record

"""Generate compact, whole-change role task cards."""

import hashlib
import os
import time

from mae_flow_core.foundation import source_paths
from mae_flow_core.application.quality.role_task_documents import (
    RoleTaskContext,
    build_role_task_document,
)
from mae_flow_core.application.quality.task_cards import (
    TaskCardStorePorts,
    store_task_card,
)
from mae_flow_core.orchestration.behavior_baseline import (
    load_relevant_domain_context,
)
from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.quality.role_tasks import role_allowed

from .shared import read_text, write_text
from .wiring import api


def _existing(paths):
    result = []
    for path in paths:
        value = str(path or "")
        if value and os.path.isfile(value):
            absolute = os.path.abspath(value)
            if absolute not in result:
                result.append(absolute)
    return tuple(result)


def _story_context(state, role, document="", axis=""):
    config = state.get("config") or {}
    ticket = str(config.get("单号", "") or "")
    package = ensure_work_package(os.getcwd(), ticket)
    survey = os.path.join(package.root, "survey.md")
    terms = []
    for path in (config.get("需求文档", ""), package.spec, package.grill):
        if path and os.path.isfile(path):
            terms.append(read_text(path, encoding="utf-8", errors="replace"))
    try:
        domain = load_relevant_domain_context(os.getcwd(), terms)
    except ValueError as exc:
        api.die("领域索引无效: %s。请先执行 domain-docs validate。" % exc, 2)
    domain_paths = [
        os.path.join(os.getcwd(), *item.path.split("/"))
        for item in domain.documents
    ]
    paths = [
        os.path.join(os.getcwd(), ".mae-flow-work", "owner-inputs.json"),
        config.get("需求文档", ""), package.decisions, package.spec, package.grill,
        survey, os.path.join("docs", "specs", "index.md"),
        *domain_paths,
    ]
    if role == "story-generate":
        paths.extend((
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "STORY-TEMPLATE.md"),
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "IMPLEMENTATION-TEMPLATE.md"),
        ))
    elif role == "story-review":
        # 生成给了模板、检视不给,等于让它判"合不合规"却不告诉它规矩是什么。
        paths.extend((
            package.story, package.implementation,
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "STORY-TEMPLATE.md"),
            os.path.join(".mae-flow-work", "plugin-resources", "assets",
                         "IMPLEMENTATION-TEMPLATE.md"),
        ))
    if document:
        paths.append(document)
    return package, _existing(paths)


def cmd_role_task(_flow, state, args):
    role = str(args.role or "")
    step = str(state.get("current", "") or "")
    if not role_allowed(role, step):
        api.die("当前步骤 %s 不允许生成 %s 角色任务卡。" % (step or "(空)", role), 2)
    stage = str(getattr(args, "stage", "") or "")
    document_path = str(getattr(args, "document", "") or "")
    if role == "grill-critic" and (not stage or not document_path):
        api.die("grill-critic 必须同时指定 --stage prep|final 和 --document。", 2)

    ticket = str((state.get("config") or {}).get("单号", "") or "")
    package, context_paths = _story_context(state, role, document_path)
    card = build_role_task_document(
        role=role,
        project_root=os.path.abspath(os.getcwd()),
        ticket=ticket,
        stage=stage,
        context=RoleTaskContext(
            context_paths=context_paths,
            diff="",
            write_output=package.story if role == "story-generate" else "",
            companion_output=(
                package.implementation if role == "story-generate" else ""),
            feedback=str(getattr(args, "feedback", "") or ""),
        ),
    )
    artifact = store_task_card(
        card,
        os.path.join(".mae-flow-work", "role-tasks"),
        "%s-%s%s.md" % (step, role, ("-" + stage) if stage else ""),
        TaskCardStorePorts(
            absolute=os.path.abspath,
            make_directory=lambda path: os.makedirs(path, exist_ok=True),
            write_text=lambda path, body: write_text(path, body, encoding="utf-8"),
        ),
    )
    record = {
        "step": step,
        "path": artifact.path,
        "sha256": artifact.digest,
        "stage": stage,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    state.setdefault("role_tasks", {})[role] = record
    kind = {
        "story-generate": "STORY",
        "story-review": "REVIEWER",
        "grill-critic": "GRILL_" + stage.upper(),
    }[role]
    head = api.sh("git rev-parse --verify HEAD")
    state.setdefault("agent_tasks", {})[kind] = {
        **record,
        "head": head,
        "precommit_review": False,
        "source_snapshot": {},
    }
    api.save_state(state)
    agent = {
        "story-generate": "story-generator-agent",
        "story-review": "craft-reviewer-agent",
        "grill-critic": "grill-critic-agent",
    }[role]
    print("[mae-flow] %s 角色任务卡已生成: %s" % (role, artifact.path))
    print('启动 %s 时只传：读取并严格执行任务卡 "%s"；返回可使用自然语言。'
          % (agent, artifact.path))

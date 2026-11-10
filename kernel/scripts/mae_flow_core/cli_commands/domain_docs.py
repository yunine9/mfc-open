"""Relevant domain context and durable reconciliation commands."""

from .shared import os
from .wiring import api
from mae_flow_core.orchestration.behavior_baseline import load_relevant_domain_context


def cmd_domain_docs(state, args):
    del state
    root = os.getcwd()
    try:
        if args.domain_docs_action == "context":
            context = load_relevant_domain_context(root, args.term)
            print("[mae-flow] 相关领域文档: %d" % len(context.documents))
            for document in context.documents:
                print("- " + document.path)
            return context
        if args.domain_docs_action in {"show", "validate"}:
            context = load_relevant_domain_context(root, ("",))
            if args.domain_docs_action == "validate":
                print("[mae-flow] 领域文档索引校验通过: " + context.index_path)
                return context
            print("[mae-flow] 领域文档索引: " + context.index_path)
            return context
        api.die(
            "domain-docs reconcile 已停用，防止绕过用户确认直接改写真相源；"
            "请在领域归档阶段使用 domain-archive prepare。",
            2,
        )
    except (OSError, TypeError, ValueError) as exc:
        api.die("领域文档协调失败: %s" % exc, 2)

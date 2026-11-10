"""Kernel authority: coordinate work, report quality, preserve human control."""

# Document shape belongs to step guidance and human review, not automatic
# evaluation. Keep legacy flow declarations readable and explicit diagnostics usable.
PROMPT_ONLY_EVIDENCE = frozenset({
    "glob", "content_free", "tasks_checked", "spec_field", "yaml_field",
    "spec_validate", "local_spec_valid",
})

# These checks describe quality/convention, not permission or external facts.
# Evaluators still return their real result; only their veto is retired.
ADVISORY_EVIDENCE = frozenset({
    "glob", "glob_absent", "tasks_checked", "commit_tagged",
    "commit_tagged_after_entry", "delivery_manifest_committed", "spec_field",
    "yaml_field", "spec_validate", "tier_scope", "agent_ran", "content_free",
    "clean_paths", "archive_paths_clean", "domain_archive_complete",
    "local_spec_valid", "verification_passed",
})

ADVISORY_TOOL_RULES = frozenset({
    "bash-internal-state-read",
    "bash-wide-add", "bash-wide-openspec-add", "bash-commit-format",
    "bash-core-dump-delete", "bash-vendored-runtime", "bash-global-openspec",
    "bash-retired-force-phase",
})


def advisory_message(message):
    # Preserve the original diagnostic but explicitly revoke its old imperative.
    return "建议核对（不阻断，不要求重新授权；以下是诊断原文）：" + str(message)

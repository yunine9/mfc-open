from .git_candidate_diagnostics import pending_commit_files
"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    AGENT_WRITES_PATH, BUILD_ARTIFACT_AMBIGUOUS_DIRS,
    BUILD_ARTIFACT_AMBIGUOUS_SUFFIXES, BUILD_ARTIFACT_STRONG_DIRS,
    BUILD_ARTIFACT_STRONG_NAMES, BUILD_ARTIFACT_STRONG_SUFFIXES, EXIT_PATH, git_intent,
    os, re, safe_read_json, source_paths, subprocess, time,
)
from .wiring import api

def norm(p):
    """路径/命令归一化:Windows 反斜杠 → 正斜杠,供正则匹配。"""
    return source_paths.normalize_path(p)

def _repo_path_identity(path, case_insensitive=None):
    """Normalize a repository path for identity comparisons.

    Git normally reports the index spelling while file tools may preserve the
    caller's spelling. On Windows those names address the same file, so exact
    string comparison would lose Agent-write provenance.
    """
    if case_insensitive is None:
        case_insensitive = os.name == "nt"
    return source_paths.repository_path_identity(
        path,
        case_insensitive=case_insensitive,
    )

def _clear_broken_exit_marker():
    """写退出标记前收殓坏旧标记(实测死角:坏标记的 CAS 校验曾让三条退出
    路径全部 crash——退出标记的唯一写方就是"正在退出",旧标记本该被覆盖,
    坏了更该被收殓而不是挡路)。"""
    from mae_flow_core.state_store import safe_read_json as _srj
    if not os.path.exists(EXIT_PATH):
        return
    _raw, err = _srj(EXIT_PATH)
    if not err:
        return
    try:
        os.replace(EXIT_PATH,
                   EXIT_PATH + ".corrupt." + time.strftime("%Y%m%d-%H%M%S"))
    except OSError:
        try:
            os.remove(EXIT_PATH)
        except OSError:
            pass

def _build_artifact_confidence(path):
    """Return strong/ambiguous/empty for a repository-relative path.

    This deliberately classifies paths, not build commands. Only newly staged
    files are checked by the caller, so already tracked generated assets keep
    following the repository's existing contract.
    """
    p = re.sub(r"^(?:\./)+", "", norm(path).strip().strip("\"'"))
    if not p:
        return ""
    low = p.lower()
    parts = [item for item in low.split("/") if item]
    base = parts[-1] if parts else low
    if (base in BUILD_ARTIFACT_STRONG_NAMES
            or low.endswith(BUILD_ARTIFACT_STRONG_SUFFIXES)
            or any(item in BUILD_ARTIFACT_STRONG_DIRS for item in parts)
            or any(item.startswith("cmake-build-") for item in parts)
            or any(item.endswith(".dsym") for item in parts)):
        return "strong"
    if (low.endswith(BUILD_ARTIFACT_AMBIGUOUS_SUFFIXES)
            or any(item in BUILD_ARTIFACT_AMBIGUOUS_DIRS for item in parts)):
        return "ambiguous"
    return ""

def _git_status_paths(pathspecs, include_ignored=False):
    """List changed/untracked paths under explicit git-add pathspecs."""
    if not pathspecs:
        return []
    args = [
        "git", "-c", "core.quotepath=false", "status", "--porcelain",
        "--untracked-files=all",
    ]
    if include_ignored:
        args.append("--ignored=matching")
    out = _git_candidate_output([*args, "--", *pathspecs])
    paths = []
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        status, path = parts
        if status == "!!" and not include_ignored:
            continue
        paths.append(norm(path.split(" -> ")[-1].strip().strip('"')))
    return list(dict.fromkeys(paths))

def _git_ignored_paths(pathspecs):
    if not pathspecs:
        return []
    out = api.argv_out([
        "git", "-c", "core.quotepath=false", "status", "--porcelain",
        "--untracked-files=all", "--ignored=matching", "--", *pathspecs,
    ])
    return list(dict.fromkeys(
        norm(line.split(None, 1)[1].strip().strip('"'))
        for line in out.splitlines()
        if line.startswith("!! ") and len(line.split(None, 1)) == 2
    ))

def _git_add_pathspecs(command):
    """Extract explicit pathspecs from git-add segments in a compound command."""
    paths, force = [], False
    for intent in _git_add_intents(command):
        paths.extend(intent["pathspecs"])
        force = force or intent["force"]
    return list(dict.fromkeys(paths)), force

def _git_subcommand_tokens(command, subcommand):
    return git_intent.git_subcommand_tokens(command, subcommand)

def _option_consumes_following(token, value_options):
    return git_intent.option_consumes_following(token, value_options)

def _command_pathspecs(tokens, value_options=None):
    return git_intent.command_pathspecs(tokens, value_options)

def _git_add_intent(tokens):
    return git_intent.git_add_intent(tokens)

def _git_add_intents(command):
    return git_intent.git_add_intents(command)

def _short_option_flags(tokens):
    return git_intent.short_option_flags(tokens)

def _git_commit_intent(command):
    return git_intent.git_commit_intent(command)

def _agent_written_paths():
    """Return paths successfully changed through Agent file-writing tools.

    This is deliberately a candidate set, not a commit allowlist: a file being
    touched by the Agent does not mean it belongs in the commit.
    """
    raw, err = safe_read_json(AGENT_WRITES_PATH)
    if err or not isinstance(raw, dict):
        return set()
    entries = raw.get("paths", raw)
    if not isinstance(entries, dict):
        return set()
    return {
        _repo_path_identity(path) for path in entries
        if isinstance(path, str) and _repo_path_identity(path)
    }


def _agent_written_receipts():
    raw, err = safe_read_json(AGENT_WRITES_PATH)
    if err or not isinstance(raw, dict):
        return {}
    entries = raw.get("paths", raw)
    if not isinstance(entries, dict):
        return {}
    return {
        _repo_path_identity(path): dict(receipt or {})
        for path, receipt in entries.items()
        if isinstance(path, str) and _repo_path_identity(path)
        and isinstance(receipt, dict)
    }

def _compile_side_effect_paths():
    """Return normalized COMPILE side-effect ledger keys, if available."""
    raw, err = safe_read_json(AGENT_WRITES_PATH)
    if err or not isinstance(raw, dict):
        return set()
    entries = raw.get("compile_side_effects")
    if not isinstance(entries, dict):
        return set()
    return {
        _repo_path_identity(path) for path in entries
        if isinstance(path, str) and _repo_path_identity(path)
    }

def _is_story_document(path):
    """Recognize STORY content even when an agent writes it to the wrong tree."""
    p = re.sub(r"^(?:\./)+", "", norm(path))
    if not p.lower().endswith(".md"):
        return False
    if "story" in os.path.basename(p).lower():
        return True
    try:
        with open(p, encoding="utf-8", errors="replace") as stream:
            sample = stream.read(65536)
    except OSError:
        # A staged file may have been moved/deleted from the worktree while its
        # old blob is still queued for commit. Inspect the index too, otherwise
        # `notes.md` containing a STORY could evade the content check.
        sample = api.argv_out(["git", "show", ":" + p])[:65536]
        if not sample:
            return False
    return bool(re.search(r"(?mi)^#\s*STORY[-：:]|Story转测自检表", sample))

def _domain_archived_paths(st):
    record = ((st or {}).get("domain_archive") or {})
    return {re.sub(r"^(?:\./)+", "", norm(str(path)))
            for path in (record.get("applied_paths") or ())}


def _trusted_harness_commit_path(
        path, st=None, include_user_authorized=False):
    """Paths the current delivery may create without an Edit/Write event.

    OpenSpec is deliberately scoped to the active change/archive. Treating the
    whole tree as trusted lets an old untracked file ride a later
    ``git add openspec/`` without even a provenance warning.
    """
    p = re.sub(r"^(?:\./)+", "", norm(path))
    if (
            include_user_authorized
            and api._authorized_delivery_path(p, st)):
        return True
    if p in {".gitignore", ".gitattributes"}:
        return True
    # 领域知识归档是 harness 自己写的文件,不经 Write/Edit,于是每一单都要
    # 报一次"来路不明"——狼来了喊多了就没人听了。认账依据不是给
    # docs/specs/ 开白名单,而是这一单归档时实际落盘的那份清单。
    if p in _domain_archived_paths(st):
        return True
    if p.startswith("docs/req/"):
        return True
    if not p.startswith("openspec/") or _is_story_document(p):
        return False
    if p in {"openspec/config.yaml", "openspec/config.yml"}:
        return True
    state = st or {}
    config = state.get("config", {}) or {}
    change_name = str(config.get("CHANGE_NAME", "") or "")
    active = "openspec/changes/" + change_name if change_name else ""
    if active and (p == active or p.startswith(active + "/")):
        return True
    spec_data = state.get("spec", {}) or {}
    archive_name = str(spec_data.get("archived_to", "") or "")
    archived = ("openspec/changes/archive/" + archive_name
                if archive_name else "")
    if archived and (p == archived or p.startswith(archived + "/")):
        return True
    archive_paths = {
        re.sub(r"^(?:\./)+", "", norm(item))
        for item in spec_data.get("archive_paths", []) or []
    }
    if any(p == item or p.startswith(item.rstrip("/") + "/")
           for item in archive_paths if item):
        return True
    # Old in-flight states predate archive_paths. During their archive/push
    # handoff, specs are legitimate harness output; unchanged initial dirt is
    # still rejected independently by the carry-over check below.
    if (p.startswith("openspec/specs/")
            and (state.get("current") == "archive"
                 or (spec_data.get("phase") == "archived"
                     and state.get("current") == "push"))):
        return True
    return False

def _git_candidate_output(args):
    """A failed index/worktree read is not evidence of an empty candidate set."""
    try:
        result = subprocess.run(
            list(args), shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        api.die("Git 提交候选读取失败（%s，cwd=%s）；未判定文件缺少，"
                "请检查仓库和 Git index 可访问性后重试。"
                % (type(exc).__name__, os.getcwd()), 75)
    if result.returncode:
        api.die("Git 提交候选读取失败（exit=%s，cwd=%s）：%s。"
                "未判定文件缺少；请修复 Git 读取错误后重试，"
                "无需反复 git add。"
                % (result.returncode, os.getcwd(), result.stderr.strip()[:800]), 75)
    return result.stdout.strip()


def _staged_commit_candidates():
    staged_all = _git_candidate_output([
        "git", "-c", "core.quotepath=false", "diff", "--cached",
        "--name-only", "--no-renames", "--",
    ]).splitlines()
    staged_new = _git_candidate_output([
        "git", "-c", "core.quotepath=false", "diff", "--cached",
        "--name-only", "--diff-filter=A", "--no-renames", "--",
    ]).splitlines()
    staged_deleted = _git_candidate_output([
        "git", "-c", "core.quotepath=false", "diff", "--cached",
        "--name-only", "--diff-filter=D", "--no-renames", "--",
    ]).splitlines()
    return (
        [norm(path) for path in staged_all if path],
        [norm(path) for path in staged_new if path],
        [norm(path) for path in staged_deleted if path],
    )

def _git_diff_name_args(diff, pathspecs, cached, diff_filter=""):
    args = [
        "git", "-c", "core.quotepath=false", "diff",
        "--name-only", "--no-renames",
    ]
    if diff_filter:
        args.append("--diff-filter=" + diff_filter)
    if cached:
        args.append("--cached")
    if diff:
        args.append(diff)
    args += ["--", *(pathspecs or [])]
    return args

def _git_diff_names(
        diff="HEAD", pathspecs=None, cached=False, diff_filter=""):
    args = _git_diff_name_args(
        diff, pathspecs, cached, diff_filter)
    return [
        norm(path) for path in _git_candidate_output(args).splitlines()
        if path
    ]

def _intent_candidate_paths(intent):
    pathspecs = intent["pathspecs"]
    if not pathspecs:
        return []
    if intent["tracked_only"]:
        return _git_diff_names("HEAD", pathspecs)
    return _git_status_paths(
        pathspecs, include_ignored=intent["force"])

def _untracked_candidate_paths(paths):
    return [
        path for path in paths
        if not api.argv_out([
            "git", "ls-files", "--error-unmatch", "--", path])
    ]

def _head_tracked_paths(paths):
    if not paths:
        return set()
    out = api.argv_out([
        "git", "-c", "core.quotepath=false",
        "ls-tree", "-r", "--name-only", "HEAD", "--", *paths,
    ])
    return {
        _repo_path_identity(path)
        for path in out.splitlines() if path
    }

def _compound_add_candidates(command):
    pending, new_candidates, deleted, forced, present = (
        [], [], [], [], [])
    for operation, arguments in git_intent.git_invocations(command):
        if operation == "commit":
            break
        if operation != "add":
            continue
        intent = _git_add_intent(list(arguments))
        current = _intent_candidate_paths(intent)
        pending.extend(current)
        current_present = [
            path for path in current
            if os.path.lexists(path)
        ]
        present_identities = {
            _repo_path_identity(path) for path in current_present
        }
        current_deleted = [
            path for path in current
            if _repo_path_identity(path) not in present_identities
        ]
        deleted.extend(current_deleted)
        present.extend(current_present)
        tracked_at_head = _head_tracked_paths(current_present)
        new_candidates.extend(
            path for path in current_present
            if _repo_path_identity(path) not in tracked_at_head
        )
        if intent["force"]:
            forced.extend(_git_ignored_paths(intent["pathspecs"]))
    return (
        list(dict.fromkeys(pending)),
        list(dict.fromkeys(new_candidates)),
        list(dict.fromkeys(deleted)),
        list(dict.fromkeys(forced)),
        list(dict.fromkeys(present)),
    )

def _commit_worktree_candidates(command):
    intent = _git_commit_intent(command)
    pathspecs = intent["pathspecs"]
    if intent["all"]:
        return (
            _git_diff_names("HEAD"),
            False,
            _git_diff_names("HEAD", diff_filter="D"),
        )
    if pathspecs:
        # Explicit commit paths (-i/--only) take contents from the worktree.
        # After rm --cached, Git diff still reports D because the local file
        # is untracked; that is not a deletion if this command includes it.
        deleted = [path for path in _git_diff_names(
            "HEAD", pathspecs, diff_filter="D") if not os.path.lexists(path)]
        return (
            _git_diff_names("HEAD", pathspecs),
            not intent["include"],
            deleted,
        )
    return [], False, []

def _pending_commit_candidates(command=""):
    """Return exact staged/compound-add candidates before a commit runs."""
    staged_paths, new_candidates, staged_deleted = (
        _staged_commit_candidates())
    candidates = list(staged_paths)
    pending, pending_new, pending_deleted, forced, pending_present = (
        _compound_add_candidates(command))
    commit_working, commit_only, commit_deleted = (
        _commit_worktree_candidates(command))
    if commit_only:
        candidates = list(commit_working)
        new_candidates = [
            path for path in new_candidates if path in candidates
        ]
        deleted = list(commit_deleted)
        forced = [path for path in forced if path in candidates]
    else:
        candidates.extend(pending)
        candidates.extend(commit_working)
        new_candidates.extend(pending_new)
        deleted = (
            list(staged_deleted)
            + list(pending_deleted)
            + list(commit_deleted)
        )
        present_overrides = {
            _repo_path_identity(path)
            for path in (
                list(pending_present)
                + [
                    path for path in commit_working
                    if _repo_path_identity(path) not in {
                        _repo_path_identity(item)
                        for item in commit_deleted
                    }
                ]
            )
        }
        deleted = [
            path for path in deleted
            if _repo_path_identity(path) not in present_overrides
        ]
    candidates = list(dict.fromkeys(candidates))
    deleted_identities = {
        _repo_path_identity(path) for path in deleted
    }
    return {
        "paths": candidates,
        "present_paths": [
            path for path in candidates
            if _repo_path_identity(path) not in deleted_identities
        ],
        "deleted_paths": set(deleted),
        "new_paths": set(new_candidates),
        "staged_paths": set(staged_paths),
        "working_paths": set(pending) | set(commit_working),
        "forced_paths": set(forced),
    }

def _pending_commit_files(command="", st=None, candidate_snapshot=None):
    return pending_commit_files(command, st, candidate_snapshot)

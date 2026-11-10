"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    MoonlightBranchFacts, STATE_PATH, hashlib, json, os, read_bytes, re,
    resolve_moonlight_branch, safe_read_json, source_paths, subprocess, time,
)
from .wiring import api


def _risk_acceptance(kind, st):
    record = (st.get("risk_acceptances", {}) or {}).get(kind, {})
    if not record:
        return False, ""
    if record.get("step") != st.get("current"):
        return False, "旧风险确认属于步骤 %s" % record.get("step", "?")
    if record.get("at", "") < api._step_entered_at(st):
        return False, "旧风险确认早于当前步骤"
    task = (st.get("agent_tasks", {}) or {}).get(kind, {})
    if (record.get("task_sha256")
            and record.get("task_sha256") != task.get("sha256", "")):
        return False, "风险确认绑定的任务卡已经变化"
    if (record.get("task_issuance_id")
            and record.get("task_issuance_id") != task.get("issuance_id", "")):
        return False, "风险确认绑定的任务卡签发批次已经变化"
    snapshot = record.get("source_snapshot")
    if isinstance(snapshot, dict):
        head = task.get("head", "")
        if not head:
            return False, "风险确认缺少任务卡源码基线"
        if api._source_snapshot_since(head, st) != snapshot:
            return False, "风险确认后未提交代码快照发生变化"
        return True, ""
    head = record.get("head", "")
    changed, error = api._source_changed_since(head, st) if head else ([], "风险确认缺少 HEAD")
    if error:
        return False, "风险确认新鲜度无法核实:" + error
    if changed:
        return False, "风险确认后代码发生变化:" + "、".join(changed[:5])
    return True, ""

def _branch_adoption_requested(text):
    """Whether the user explicitly chose to keep working on the current branch."""
    value = re.sub(r"[（(]推荐[）)]", "", str(text or "")).strip()
    value = re.sub(r"[“”「」『』`\"']", "", value)
    if re.search(
            r"(不要|不在|不想|拒绝|取消|改用其他|另开|新建|切到|切换到|"
            r"是否|能否|可以吗|怎么|如何|为什么|[?？])",
            value, re.I):
        return False
    branch = r"(?:当前|现有|现在|这个)分支"
    keep = r"(?:继续|沿用|保留|使用|开发|往下做)"
    action = (
        r"(?:" + keep + r"(?:在)?" + branch
        + r"|(?:在)?" + branch + r"(?:上)?" + keep + r")"
    )
    suffix = (
        r"(?:完成)?(?:本次|后续|剩余|这个|该)?"
        r"(?:开发|实现|修复|处理|交付|工作|任务|需求)?"
    )
    lead = r"(?:我)?(?:请|选择|决定|要求|希望|同意)?(?:直接|就|仍然)?"
    allowed = (
        re.compile(r"^" + lead + action + suffix + r"$", re.I),
        re.compile(
            r"^(?:需求文档|需求)(?:已)?(?:确认|核对|检查)"
            r"(?:无误|完成|通过)?后(?:请|直接)?" + action
            + suffix + r"$",
            re.I,
        ),
        re.compile(
            r"^(?:开启|启动)?月光宝盒(?:后)?(?:请|直接)?"
            + action + suffix + r"$",
            re.I,
        ),
    )
    clauses = [
        clause.strip()
        for clause in re.split(r"[，。！？,;；\n]+", value)
        if clause.strip()
    ]
    return any(pattern.fullmatch(clause)
               for clause in clauses for pattern in allowed)

def _adopt_current_branch(st, ack):
    """Bind the explicitly chosen existing branch to this delivery round."""
    current = api.sh("git branch --show-current")
    head = api.argv_out(["git", "rev-parse", "--verify", "HEAD"])
    base = str((st.get("config", {}) or {}).get("基线分支", "") or "")
    base_head = api.argv_out(["git", "rev-parse", "--verify", base + "^{commit}"]) if base else ""
    if not current or not head:
        return False, "当前处于 detached HEAD 或 Git 状态不可读，不能登记为本单工作分支。"
    if not base or not base_head:
        return False, "配置中的基线分支不可解析，不能判断现有分支是否来自正确基线。"
    if current == base:
        return False, (
            "当前仍是基线分支 %s，不能把主干直接登记成本单工作分支。"
            "请创建约定分支，或先让用户选择一个非基线的现有工作分支。" % base
        )
    if api.argv_out(["git", "merge-base", base_head, head]) != base_head:
        return False, (
            "现有分支 %s 不包含基线 %s 的当前 HEAD，直接沿用会把无关历史带入本单。"
            "请先迁移/同步分支后重新让用户裁决。" % (current, base)
        )
    previous = str((st.get("config", {}) or {}).get("分支名", "") or "")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    st.setdefault("config", {})["分支名"] = current
    st["branch_resolution"] = {
        "mode": "adopt-current",
        "branch": current,
        "head": head,
        "base": base,
        "base_head": base_head,
        "previous_branch": previous,
        "ack_sha256": hashlib.sha256(
            str(ack or "").encode("utf-8")).hexdigest(),
        "at": now,
    }
    return True, (
        "用户明确选择沿用现有分支；本单分支由 %s 调整为 %s，"
        "裁决时 HEAD=%s" % (previous or "(未配置)", current, head[:10])
    )


def _recorded_delivery_head(state):
    if not isinstance(state, dict):
        return ""
    moonlight = state.get("moonlight")
    moonlight = moonlight if isinstance(moonlight, dict) else {}
    step_heads = state.get("step_heads")
    step_heads = step_heads if isinstance(step_heads, dict) else {}
    current = str(state.get("current", ""))
    step_head = step_heads.get(current, "")
    return str(step_head or moonlight.get("pushed_head", ""))


def _archived_delivery_facts(state):
    if not isinstance(state, dict):
        return "", "", ""
    config = state.get("config")
    config = config if isinstance(config, dict) else {}
    return (
        str(config.get("单号", "") or ""),
        str(config.get("分支名", "") or ""),
        _recorded_delivery_head(state),
    )


def _last_delivery_snapshot():
    path = STATE_PATH + ".last"
    raw, error = safe_read_json(path)
    if error or not isinstance(raw, dict):
        return {}, ""
    try:
        digest = hashlib.sha256(read_bytes(path)).hexdigest()
    except OSError:
        return {}, ""
    return raw, digest


def _is_ancestor(ancestor, descendant):
    if not ancestor or not descendant:
        return False
    return api.argv_out(
        ["git", "merge-base", ancestor, descendant]) == ancestor


def _resolve_moonlight_branch(flow, st):
    """Resolve existing work before branch_create evidence in Moonlight only."""
    if not api._moonlight(st) or st.get("current") != "branch_create":
        return False
    config = st.get("config") or {}
    current = api.sh("git branch --show-current")
    head = api.argv_out(["git", "rev-parse", "--verify", "HEAD"])
    base = str(config.get("基线分支", "") or "")
    base_head = (
        api.argv_out(["git", "rev-parse", "--verify", base + "^{commit}"])
        if base else ""
    )
    previous, previous_sha = _last_delivery_snapshot()
    previous_ticket, previous_branch, previous_head = (
        _archived_delivery_facts(previous))
    request = str((st.get("moonlight") or {}).get("request", "") or "")
    facts = MoonlightBranchFacts(
        current_branch=current,
        head=head,
        base_branch=base,
        base_head=base_head,
        base_is_ancestor=_is_ancestor(base_head, head),
        explicit_continue=_branch_adoption_requested(request),
        request_sha256=hashlib.sha256(
            request.encode("utf-8")).hexdigest(),
        last_state_sha256=previous_sha,
        previous_ticket=previous_ticket,
        previous_branch=previous_branch,
        previous_head=previous_head,
        previous_head_is_ancestor=_is_ancestor(previous_head, head),
        dirty_paths=tuple(api._dirty_paths()[:100]),
    )
    result = resolve_moonlight_branch(
        st, facts, time.strftime("%Y-%m-%d %H:%M:%S"))
    if not result.effects:
        return False
    api._apply_moonlight_result(flow, st, result)
    hard_blocked = (st.get("moonlight") or {}).get("hard_blocked") or {}
    return (
        hard_blocked.get("step") == "branch_create"
        and not st.get("branch_resolution")
    )


def _unchanged_initial_dirty(path, st):
    """流程启动前已脏且指纹未变的文件不是本单变化，仍保留在状态中可审计。"""
    rel = api.norm(path).strip().strip('"')
    initial = set((st or {}).get("initial_dirty", []) or [])
    fingerprints = (st or {}).get("initial_dirty_fingerprints", {}) or {}
    return bool(rel in initial and fingerprints.get(rel) == api._path_fingerprint(rel))

def _blocking_dirty_source_paths(st, flow=None):
    return [p for p in api._dirty_paths()
            if api._is_source_path(p, st, flow or api.FLOW)
            and not _unchanged_initial_dirty(p, st)]

def _unchanged_initial_dirty_source_paths(st, flow=None):
    return [p for p in api._dirty_paths()
            if api._is_source_path(p, st, flow or api.FLOW)
            and _unchanged_initial_dirty(p, st)]

def _source_changed_since(head, st=None):
    """令牌签发时 HEAD 之后,源码是否变化:已提交 diff + 工作区未提交改动。
    返回 (变更清单, 错误);基点不可解析(amend/rebase/GC)属错误,由调用方判拒——重签令牌即可恢复。"""
    if not re.fullmatch(r"[0-9a-f]{7,64}", head):
        return None, "令牌基点格式异常"
    cur = api.sh("git rev-parse --verify HEAD")
    if not cur:
        return None, "无法读取当前 HEAD（仓库可能已切走、损坏或不再是 Git 工作区）"
    changed = []
    if cur and cur != head:
        # cat-file 探基点存在性(不用 rev-parse ^{commit}:^ 在 Windows cmd 是转义符)
        if api.argv_out(["git", "cat-file", "-t", head]) != "commit":
            return None, "令牌基点 commit 不可解析(经历过 amend/rebase?)"
        # core.quotepath=false:否则非 ASCII 文件名被引号+八进制转义,pattern 匹配不到 = 漏检
        out = api.argv_out([
            "git", "-c", "core.quotepath=false",
            "diff", "--name-only", head, cur,
        ])
        changed += [f for f in out.splitlines() if f and api._is_source_path(f, st)]
    # 校准实锤:令牌签发前就存在、内容此后未变的存量脏文件曾被算作"签发后
    # 变化",连锁封死任务卡/accept-risk/令牌复用(连裁决出口一起封)。init 已
    # 记 initial_dirty + 指纹,据此豁免:仅当该文件本单真动过(指纹变了)才算变化。
    for line in api.sh("git -c core.quotepath=false status --porcelain --untracked-files=all").splitlines():
        # 按空白切"状态 路径",不用列偏移:sh() 会 strip 首行前导空格(' M' → 'M'),偏移取路径会错位
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        f = parts[1].split(" -> ")[-1].strip().strip('"')
        if not f or not api._is_source_path(f, st):
            continue
        if _unchanged_initial_dirty(f, st):
            continue  # 存量脏文件,本单未动,不算签发后变化
        changed.append(f + "(未提交)")
    return changed, ""

def _changed_paths_since_head(head):
    paths = []
    if head and api.argv_out(["git", "cat-file", "-t", head]) == "commit":
        paths.extend(api.argv_out([
            "git", "-c", "core.quotepath=false", "diff",
            "--name-only", "--no-renames", head, "HEAD",
        ]).splitlines())
    paths.extend(api.argv_out([
        "git", "-c", "core.quotepath=false", "diff",
        "--name-only", "--no-renames", "HEAD",
    ]).splitlines())
    paths.extend(api._dirty_paths())
    return list(dict.fromkeys(api.norm(path) for path in paths if path))

def _source_fingerprints(paths, st=None, flow=None):
    result = {}
    for path in paths:
        if api._is_source_path(path, st, flow or api.FLOW):
            result[path] = api._review_path_fingerprint(path)
    return result

def _source_snapshot_since(head, st=None, flow=None):
    """Fingerprint committed, staged, unstaged and untracked source changes."""
    return _source_fingerprints(
        _changed_paths_since_head(head), st, flow)


def _worktree_snapshot_since(head):
    """Fingerprint every Git-visible change for a COMPILE provenance baseline."""
    return {
        path: api._review_path_fingerprint(path)
        for path in _provenance_changed_paths_since_head(head)
        if (
            os.path.lexists(path)
            and not source_paths.is_flow_control_path(path)
        )
    }


def _provenance_git_output(arguments):
    """Run one required provenance Git read and surface every failure."""
    try:
        result = subprocess.run(
            list(arguments),
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
    except Exception as exc:
        raise RuntimeError(
            "COMPILE provenance Git command failed: %s" % exc
        ) from exc
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        raise RuntimeError(
            "COMPILE provenance Git command exited %s%s"
            % (
                result.returncode,
                (": " + detail) if detail else "",
            )
        )
    return result.stdout or ""


def _provenance_status_paths(output):
    paths = []
    for line in output.splitlines():
        fields = line.split(None, 1)
        if len(fields) == 2:
            paths.append(
                fields[1].split(" -> ")[-1].strip().strip('"'))
    return paths


def _provenance_changed_paths_since_head(head):
    """Collect committed and working paths without trustworthy-empty fallbacks."""
    if not head:
        raise RuntimeError("COMPILE provenance baseline HEAD is missing")
    if _provenance_git_output(
            ["git", "cat-file", "-t", head]).strip() != "commit":
        raise RuntimeError(
            "COMPILE provenance baseline HEAD is not a commit")
    paths = _provenance_git_output([
        "git", "-c", "core.quotepath=false", "diff",
        "--name-only", "--no-renames", head, "HEAD",
    ]).splitlines()
    paths.extend(_provenance_git_output([
        "git", "-c", "core.quotepath=false", "diff",
        "--name-only", "--no-renames", "HEAD",
    ]).splitlines())
    paths.extend(_provenance_status_paths(_provenance_git_output([
        "git", "-c", "core.quotepath=false", "status",
        "--porcelain", "--untracked-files=all",
    ])))
    return list(dict.fromkeys(
        api.norm(path) for path in paths if path))


def _source_files_for_diff(diff, st, include_tests=True):
    """Return changed source/build paths for one Git diff range."""
    out = api.argv_out([
        "git", "-c", "core.quotepath=false", "diff", "--name-only", diff])
    files = [path for path in out.splitlines()
             if path and api._is_source_path(path, st)]
    if not include_tests:
        files = [path for path in files if not api._is_test_file(path, st)]
    return files, ""


def _changed_source_files(st, include_tests=True):
    diff, error = api._scope_diff(st)
    if error:
        return None, error
    return _source_files_for_diff(diff, st, include_tests)

def _numstat_line_net(line, st=None, flow=None):
    fields = line.split("\t")
    if len(fields) != 3:
        return 0
    if not api._is_source_path(fields[2], st, flow or api.FLOW):
        return 0
    try:
        added, deleted = int(fields[0]), int(fields[1])
    except ValueError:
        return 0
    return added - deleted

def _numstat_source_net(output, st=None, flow=None):
    return sum(
        _numstat_line_net(line, st, flow)
        for line in output.splitlines())

def _file_line_count(path):
    try:
        with open(path, "rb") as stream:
            return sum(1 for _line in stream)
    except OSError:
        return 0

def _untracked_source_net(st=None, flow=None):
    tracked = set(api.argv_out([
        "git", "ls-files", "--others", "--exclude-standard",
    ]).splitlines())
    return sum(
        _file_line_count(path) for path in tracked
        if api._is_source_path(path, st, flow or api.FLOW))

def _working_source_net(head, st=None, flow=None):
    committed = api.argv_out([
        "git", "-c", "core.quotepath=false", "diff",
        "--numstat", head, "HEAD",
    ])
    working = api.argv_out([
        "git", "-c", "core.quotepath=false", "diff",
        "--numstat", "HEAD",
    ])
    return (
        _numstat_source_net(committed, st, flow)
        + _numstat_source_net(working, st, flow)
        + _untracked_source_net(st, flow))

def _snapshot_sha256(snapshot):
    body = json.dumps(
        snapshot or {}, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()

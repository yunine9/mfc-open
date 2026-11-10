"""Deterministic host transcript path resolution for Agent completions."""

import json
import os


def explicit_agent_transcript_path(payload, invocation_id=""):
    """Resolve only a transcript explicitly bound to this host invocation.

    Claude Code and compatible CodeAgent hosts may either provide the
    subagent transcript directly or provide the main transcript plus an agent
    id. Picking the newest sibling is unsafe when agents overlap, so an
    unbound payload deliberately yields no path.
    """
    for key, value in payload.items():
        if (isinstance(value, str) and "transcript" in key.lower()
                and "agent" in key.lower()):
            return value
    main = payload.get("transcript_path", "")
    if not isinstance(main, str) or not main:
        return ""
    identifiers = {
        str(value or "").strip()
        for value in (
            invocation_id,
            payload.get("invocation_id"),
            payload.get("agent_id"),
            payload.get("agentId"),
            payload.get("tool_use_id"),
            payload.get("task_id"),
        )
        if str(value or "").strip()
    }
    expected = set()
    for identifier in identifiers:
        safe = os.path.basename(identifier)
        if safe != identifier:
            continue
        expected.add(safe + ".jsonl")
        expected.add("agent-" + safe + ".jsonl")
    directory = os.path.join(os.path.splitext(main)[0], "subagents")
    matches = [
        os.path.join(directory, name)
        for name in sorted(expected)
        if os.path.isfile(os.path.join(directory, name))
    ]
    return matches[0] if len(matches) == 1 else ""


def _meta_bound_transcript(directory, invocation_id):
    """在 subagents 目录里按 meta.json 的 toolUseId 精确绑定 transcript。

    实战事故:宿主 SubagentStop payload 给的 agent transcript 路径指向
    永不存在的文件(payload 里的 agent id 与真实落盘的不一致),编译真实
    执行了却被 fail-closed 判为无证据,模型被误导去追固定字段的假线索。
    meta.json 的 toolUseId 与观察台账的 invocation_id 精确对应——
    这是确定性绑定,不是"挑最新文件"那种危险猜测;匹配不到照旧返回空,
    fail-closed 语义不变。
    """
    wanted = str(invocation_id or "").strip()
    if not wanted or not os.path.isdir(directory):
        return ""
    hits = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".meta.json"):
            continue
        try:
            with open(os.path.join(directory, name),
                      encoding="utf-8") as stream:
                meta = json.load(stream)
        except (OSError, ValueError):
            continue
        if str(meta.get("toolUseId", "") or "").strip() == wanted:
            hits.append(name[:-len(".meta.json")] + ".jsonl")
    if len(hits) != 1:
        return ""
    candidate = os.path.join(directory, hits[0])
    return candidate if os.path.isfile(candidate) else ""


def _project_subagent_dirs(projects_base="", project_root=""):
    """从当前项目根反推宿主的 transcript 目录。

    实测(fieldtest 第三次编译):后台代理的 SubagentStop 是贫载荷——
    既无 agent transcript 键也无 transcript_path,解析器连该扫哪个目录
    都不知道,meta 绑定没机会跑,而文件明明在重试窗口内就已落盘。
    宿主的落盘规则是确定的: ~/.claude/projects/<cwd 以 - 转义>/<会话>/subagents;
    hook 的 cwd 就是项目根,可零猜测地反推。toolUseId 全局唯一,
    跨会话扫 meta 仍是精确绑定。
    """
    base = projects_base or os.path.expanduser(
        os.path.join("~", ".claude", "projects"))
    # 用调用方给的项目根,不靠 cwd:hook 进程的 cwd 未必是项目根
    # (实战第四次:反推目录数=0,取证在正确目录下明明一次命中)。
    munged = (project_root or os.getcwd()).replace(
        os.sep, "-").replace("/", "-")
    root = os.path.join(base, munged)
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        directory = os.path.join(root, name, "subagents")
        if os.path.isdir(directory):
            out.append(directory)
    return out


def resolve_agent_transcript(payload, invocation_id="", projects_base="",
                             project_root=""):
    """显式路径优先;缺失或错位时按 meta 绑定;贫载荷时从项目根反推目录。"""
    explicit = explicit_agent_transcript_path(payload, invocation_id)
    if explicit and os.path.isfile(explicit):
        return explicit
    directories = []
    if explicit:
        directories.append(os.path.dirname(explicit))
    main = payload.get("transcript_path", "")
    if isinstance(main, str) and main:
        directories.append(
            os.path.join(os.path.splitext(main)[0], "subagents"))
    directories.extend(
        _project_subagent_dirs(projects_base, project_root))
    for directory in dict.fromkeys(directories):
        bound = _meta_bound_transcript(directory, invocation_id)
        if bound:
            return bound
    return explicit


def transcript_quality_call(payload, invocation_id, load_calls, pick_call,
                            attempts=10, delay=0.6, sleep=None,
                            log=lambda message: None, project_root=""):
    """有界重试取证:宿主在 SubagentStop 事件之后才把子会话账本刷盘。

    实测误差表(fieldtest 2026-08-09):meta.json 启动即落盘,transcript
    却晚于事件 0~8 秒——当场读取天然竞态,fail-closed 会把真实执行过的
    编译判成无证据。重试直到取到含最终 tool_result 的匹配调用;
    半行 JSON(还在刷盘)同样重试;等不到按原 fail-closed 语义交还调用方。
    """
    import time as _time
    sleep = sleep or _time.sleep
    for attempt in range(attempts):
        if attempt:
            sleep(delay)
        path = resolve_agent_transcript(
            payload, invocation_id, project_root=project_root)
        if not path or not os.path.isfile(path):
            continue
        try:
            calls = load_calls(path)
        except Exception as exc:           # noqa: BLE001 —— 半个 JSON 行
            log("quality transcript retry#%d: %s" % (attempt, exc))
            continue
        call = pick_call(calls)
        if call is not None and getattr(call, "result_seen", False):
            return call
    return None

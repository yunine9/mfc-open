"""交付现场只读快照:面板与任何外部展示层的唯一结构化出口。

契约(改字段前先读):

- **只读**:本模块不写任何状态,调用前后 .mae-flow.json 的 revision 与 mtime 不变;
- **软失败**:取不到的东西写进 warnings,其余字段照给,永不抛栈、永不非零退出;
- **不内联文件内容**:只给绝对路径与统计,消费方在本地自己读——载荷恒小,
  也避免出口变成源码外泄通道(内网仓库必须守);
- **不知道就写 null**:进度百分比在有分支和回退的图上必然是编的,宁可空着。

加字段不算破坏;改语义或删字段要升 schema 版本号。
"""

import json
import os
import subprocess
import time

from mae_flow_core.foundation import source_paths
from mae_flow_core import host_env
from mae_flow_core.panel.external_quality import snapshot_external
from mae_flow_core.workflow.execution_contract import (
    effective_config_keys,
    uses_pipeline,
    validation_environment,
)

SCHEMA = "mae-flow-status/1"
WORK_DIR = ".mae-flow-work"
DOC_KINDS = (
    ("survey", "调研"), ("grill-prep", "拷问准备"), ("grill", "需求澄清"),
    ("decisions", "决策记录"), ("spec", "规格条目"), ("story", "Story"),
    ("implementation", "实现记录"),
    # 返工与局部修改这两条路子的产物。原来不在册,面板对它们全瞎——
    # 而它们恰恰就是那两条路上要人检视的东西。
    ("review", "检视报告"), ("verification", "验收对齐"),
)
COMMIT_CAP = 50
HISTORY_CAP = 50


def _git(root, *args):
    try:
        done = subprocess.run(
            ["git", "-C", root] + list(args), shell=False,
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=30)
    except Exception:                      # noqa: BLE001 —— 看现场不能变卡点
        return ""
    return done.stdout if done.returncode == 0 else ""


def _abs(root, *parts):
    return os.path.abspath(os.path.join(root, *parts))


def _config(state):
    return (state or {}).get("config", {}) or {}


def _ticket(state):
    return str(_config(state).get("单号", "") or "")


def _repo(root, state, warnings):
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").strip()
    if not branch:
        warnings.append("git 不可用或此处不是仓库,分支与提交信息缺失")
    dirty = [line for line in
             _git(root, "status", "--porcelain").splitlines() if line.strip()]
    return {
        "root": os.path.abspath(root),
        "branch": branch,
        "baseline": _config(state).get("基线分支", ""),
        "head": _git(root, "rev-parse", "--short", "HEAD").strip(),
        "dirty_files": len(dirty),
    }


def _delivery(state):
    config = _config(state)
    return {
        "ticket": config.get("单号", ""),
        "ticket_type": config.get("单号类型", ""),
        "workflow": ((state or {}).get("choices", {}) or {}).get("workflow", ""),
        "requirement_doc": config.get("需求文档", ""),
        "owner": config.get("工号", ""),
        "started_at": (state or {}).get("started", ""),
        "moonlight": bool((state or {}).get("moonlight", {})),
    }


def _documents(root, state):
    ticket = _ticket(state)
    if not ticket:
        return []
    folder = os.path.join(root, WORK_DIR, ticket)
    out = []
    for stem, label in DOC_KINDS:
        path = os.path.join(folder, stem + ".md")
        if not os.path.isfile(path):
            continue
        try:
            info = os.stat(path)
        except OSError:
            continue
        out.append({
            "kind": stem, "label": label, "path": os.path.abspath(path),
            "relative": "%s/%s/%s.md" % (WORK_DIR, ticket, stem),
            "bytes": info.st_size,
            "updated_at": time.strftime("%Y-%m-%d %H:%M",
                                        time.localtime(info.st_mtime)),
        })
    return out


def _spec(root, state):
    legacy = os.path.join(root, "openspec")
    workspace = legacy if os.path.isdir(legacy) else os.path.join(
        root, WORK_DIR, "spec")
    data = (state or {}).get("spec", {}) or {}
    return {
        "workspace": os.path.abspath(workspace)
        if os.path.isdir(workspace) else "",
        "engine": data.get("engine", "builtin"),
        "phase": data.get("phase") or None,
        "change_dir": data.get("change_dir", ""),
    }


def _commits(root, base):
    if not base:
        return []
    span = "%s..HEAD" % base
    raw = _git(root, "log", "--no-merges", "--date=format:%Y-%m-%d %H:%M",
               "--pretty=%h\t%ad\t%s", span)
    out = []
    for body in raw.splitlines()[:COMMIT_CAP]:
        parts = body.split("\t", 2)
        if len(parts) == 3:
            out.append({"sha": parts[0], "at": parts[1], "subject": parts[2]})
    return out


_UNTRACKED_EMBED_CAP = 512 * 1024


_UNTRACKED_FILE_CAP = 60


def _dependency_path(path):
    """依赖目录与构建产物目录——口径来自 foundation/source_paths,共用一份。

    只按目录排,不按扩展名排。面板回答的是"这次要检视什么",不是"这是不是源码":
    本单新加的 logo.bin 不是源码,却实实在在是待检视增量(列出来、不出 diff)。
    按扩展名排会把它一起吞掉——那正是面板最不能犯的错:显示与现场不符。
    """
    return (source_paths.is_tool_managed_path(path)
            or source_paths.is_derived_path(path))


def _untracked_entries(root):
    """未跟踪文件也是待检视增量——人工检视发生在提交之前,本单新建的
    文件恰好全是 untracked,git diff 看不见它们(实战反馈:检视时没有
    diff,提交后才冒出来——缺的正是最重要的新文件)。"""
    # 依赖目录与构建产物不是待检视增量。--exclude-standard 只认 .gitignore,
    # 仓里没忽略 node_modules 很常见——那会把几千个文件渲染成"新增",
    # 面板当场没法看(与任务卡那处同一个洞的第二个出口)。
    raw = _git(root, "ls-files", "--others", "--exclude-standard")
    entries = []
    candidates = [line.strip() for line in raw.splitlines() if line.strip()]
    candidates = [path for path in candidates if not _dependency_path(path)]
    if len(candidates) > _UNTRACKED_FILE_CAP:
        # 截断要说出来:面板看起来完整、实则少了一半,比明说更难查。
        entries.append({
            "path": "（另有 %d 个未跟踪文件未展示,超过 %d 个上限;"
                    "属于本次交付就先 git add,不属于就加进 .gitignore）"
                    % (len(candidates) - _UNTRACKED_FILE_CAP,
                       _UNTRACKED_FILE_CAP),
            "added": 0, "removed": 0, "patch": ""})
        candidates = candidates[:_UNTRACKED_FILE_CAP]
    for path in sorted(candidates):
        full = os.path.join(root, path)
        try:
            if os.path.getsize(full) > _UNTRACKED_EMBED_CAP:
                entries.append({"path": path, "added": 0, "removed": 0,
                                "patch": ""})
                continue
            with open(full, "rb") as stream:
                blob = stream.read()
            if b"\0" in blob[:8192]:      # 二进制:列出但不出 diff
                entries.append({"path": path, "added": 0, "removed": 0,
                                "patch": ""})
                continue
            lines = blob.decode("utf-8", "replace").split("\n")
            if lines and lines[-1] == "":
                lines.pop()
            patch = "@@ -0,0 +1,%d @@\n%s" % (
                len(lines), "\n".join("+" + line for line in lines))
            entries.append({"path": path, "added": len(lines),
                            "removed": 0, "patch": patch})
        except OSError:
            continue
    return entries


def changes(root, base):
    """两组变更:本单已提交范围、当前未提交(含未跟踪新文件)。"""
    from . import diffview
    groups = []
    # -U999999:整个文件都进 patch,页面把未改动长段折叠成"展开"——
    # file:// 页面没有运行时读文件的能力,全文必须生成时就埋进去。
    plans = [("未提交", "工作区待检视增量",
              ["diff", "--numstat"], ["diff", "-U999999"])]
    if base:
        span = "%s..HEAD" % base
        plans.insert(0, ("已提交", "本单范围 %s..HEAD" % base,
                         ["diff", "--numstat", span],
                         ["diff", "-U999999", span]))
    for title, note, stat_args, patch_args in plans:
        stats = diffview.numstat(_git(root, *stat_args))
        patches = diffview.split_patch(_git(root, *patch_args))
        files = [{"path": path, "added": stats[path][0],
                  "removed": stats[path][1], "patch": patches.get(path, "")}
                 for path in sorted(stats)]
        if title == "未提交":
            files = sorted(files + _untracked_entries(root),
                           key=lambda item: item["path"])
        if files:
            groups.append({"title": title, "note": note, "files": files})
    return groups


def _agent_evidence(state, name, label):
    task = ((state or {}).get("agent_tasks", {}) or {}).get(name)
    if not isinstance(task, dict):
        return None
    return {"name": label, "at": task.get("at", ""),
            "head": (task.get("head") or "")[:7],
            "step": task.get("step", ""),
            "files": len(task.get("task_files") or []),
            "task_card": task.get("path", "")}


def _codecheck(state):
    scan = ((state or {}).get("quality", {}) or {}).get("codecheck_scan")
    if not isinstance(scan, dict):
        return None
    status = str(scan.get("status", "") or "")
    return {
        "name": "CodeCheck", "at": scan.get("at", ""), "status": status,
        "count": scan.get("count"),
        "degraded": status in ("TOOL_ERROR", "UNAVAILABLE"),
        "files": len(scan.get("files") or []),
        "reason": (scan.get("error") or "").strip()[:300],
    }


def _reviews(state):
    out = []
    for name, task in sorted(((state or {}).get("role_tasks", {}) or {}).items()):
        if isinstance(task, dict):
            out.append({"role": name, "at": task.get("at", ""),
                        "path": task.get("path", "")})
    return out


def _evidence(state):
    attempts = (state or {}).get("quality_attempts", {}) or {}
    ut_session = (state or {}).get("ut_session", {}) or {}
    out = {
        "compile": _agent_evidence(state, "COMPILE", "编译"),
        "reviewer": _agent_evidence(state, "REVIEWER", "Agent 预检"),
        "codecheck": _codecheck(state),
        "reviews": _reviews(state),
    }
    external = snapshot_external(state)
    if external:
        out["external"] = external
    if ut_session:
        batches = ut_session.get("batches") or []
        out["ut"] = {
            "name": "UT 编写", "at": ut_session.get("at", ""),
            "phase": ut_session.get("phase", ""),
            "complete": bool(ut_session.get("complete")),
            "batches": len(batches),
            "completed_batches": len(ut_session.get("completed_batches") or []),
        }
    return out


def _advisories(root, state):
    path = os.path.join(root, ".mae-flow.json.advisories")
    if not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as stream:
            data = json.load(stream)
    except Exception:                      # noqa: BLE001
        return []
    current = (state or {}).get("current", "")
    notices = data.get("advisories", []) if isinstance(data, dict) else []
    return [item for item in notices
            if isinstance(item, dict) and item.get("step") == current]


# 确认步骤 → 要检视的文档种类。卡片说"确认 Story",内容就必须真是 Story——
# 把整张项目配置倒进去,是视觉在提醒、信息在撒谎。
ACK_REVIEW_DOCS = {
    "open": ("spec",), "hf_open": ("spec",), "tw_open": ("spec",),
    "story": ("story", "implementation"),
    "archive_confirm": ("spec",),
}


ACTION_KINDS = {"ut": "单元测试", "codecheck": "规范检查", "grill": "需求拷问"}


def _standalone(root):
    """独立任务(ut/codecheck/grill)也是"正在发生的事"。

    面板只读交付状态时,独立任务期间会显示「无在途单 · 不需要你处理」——
    正有任务在跑却说没事,是显示与现场不符的另一种形态(用户红线)。
    """
    path = os.path.join(root, WORK_DIR, "standalone-action.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as stream:
            action = json.load(stream)
    except Exception:                      # noqa: BLE001
        return None
    if not isinstance(action, dict) or not action.get("id"):
        return None
    kind = str(action.get("kind", "") or "")
    work_dir = str(action.get("work_dir", "") or "")
    return {
        "id": action.get("id", ""),
        "kind": kind,
        "label": ACTION_KINDS.get(kind, kind or "独立任务"),
        "created_at": action.get("created_at", ""),
        "files": list(action.get("files", []) or [])[:50],
        "scope_confirmed": not bool(action.get("inferred_scope")),
        "work_dir": work_dir if os.path.isdir(work_dir) else "",
    }


def _pending(state, flow, documents):
    """待你裁决:只列真正需要人拍板的事,且卡片内容必须与步骤对得上。"""
    current = (state or {}).get("current", "")
    step = ((flow or {}).get("steps", {}) or {}).get(current)
    if not isinstance(step, dict):
        return []
    config = _config(state)
    if step.get("choice_key"):
        answers = step.get("choice_answers", {}) or {}
        return [{
            "kind": "choice", "step": current, "title": step.get("title", ""),
            "needs": "choice",
            "items": [{"label": key, "value": "/".join(value)}
                      for key, value in sorted(answers.items())],
            "paths": [],
        }]
    if not step.get("user_ack"):
        return []
    config_keys = effective_config_keys(
        step, state, host_env.host_kind())
    if config_keys:        # 配置确认:确认的就是当前宿主真正使用的配置
        reviewed = ((state or {}).get("config_review", {}) or {}).get(
            "config", {}) or config
        items = [{
            "label": "UT 编写方式" if key == "UT生成方式" else key,
            "value": str(reviewed.get(key, "")),
        } for key in config_keys]
        if uses_pipeline(state, host_env.host_kind()):
            items.append({
                "label": "验证环境",
                "value": validation_environment(
                    state, host_env.host_kind()) + "（只读）",
            })
        return [{
            "kind": "config_review", "step": current,
            "title": step.get("title", ""), "needs": "user_ack",
            "items": items,
            "paths": [],
        }]
    kinds = ACK_REVIEW_DOCS.get(current, ())
    paths = [doc["path"] for doc in documents if doc["kind"] in kinds]
    return [{
        "kind": "doc_review" if paths else "ack", "step": current,
        "title": step.get("title", ""), "needs": "user_ack",
        "items": [],                    # 不倒配置:与本步无关的信息就是噪声
        "paths": paths,
        # 文档还没落盘时说清"等的是什么"——空卡片只会让人困惑;
        # 落盘瞬间 hook 会重生成面板,这些名字自动变成可点开的门。
        "expected": ["%s.md" % kind for kind in kinds
                     if not any(path.endswith("/%s.md" % kind)
                                or path.endswith("\\%s.md" % kind)
                                for path in paths)],
    }]


def _remaining(flow, current):
    """沿 flow 图数还剩几步;分支未定时给可达上界。"""
    steps = (flow or {}).get("steps", {}) or {}
    if current not in steps:
        return None
    seen, frontier, depth = {current}, [current], 0
    while frontier:
        following = []
        for name in frontier:
            nxt = (steps.get(name) or {}).get("next")
            options = list(nxt.values()) if isinstance(nxt, dict) else [nxt]
            for option in options:
                if option and option in steps and option not in seen:
                    seen.add(option)
                    following.append(option)
        if following:
            depth += 1
        frontier = following
    return depth


def _progress(state, flow):
    current = (state or {}).get("current", "")
    steps = ((flow or {}).get("steps", {}) or {})
    history, timeline = [], []
    for item in (state or {}).get("history", []):
        if not isinstance(item, dict):
            continue
        name = item.get("step")
        if not name:
            continue
        history.append(name)
        timeline.append({
            "step": str(name),
            "title": str((steps.get(name) or {}).get("title", "") or ""),
            "result": str(item.get("result", "") or ""),
            "at": str(item.get("at", "") or ""),
        })
    done = list(dict.fromkeys(history))
    remaining = _remaining(flow, current)
    step = steps.get(current) or {}
    gotos = sum(1 for item in (state or {}).get("history", [])
                if isinstance(item, dict) and "goto" in str(item.get("result")))
    return {
        "step": current,
        "step_title": step.get("title", ""),
        "steps_done": done,
        "steps_total_estimate": (len(done) + remaining + 1)
        if remaining is not None else None,
        "percent": None,        # 有分支与回退,算出来必然是编的
        "started_at": (state or {}).get("started", ""),
        "revisits": {"goto": gotos},
        "history": timeline[-HISTORY_CAP:],
    }


def build(root=".", state=None, flow=None):
    """组装快照。任何一段取不到都只记 warning,不影响其余字段。"""
    warnings = []
    if state is None:
        warnings.append("没有 .mae-flow.json:本仓当前没有在途交付,仅给出仓库信息")
    base = (state or {}).get("implementation_base_head", "")
    documents = _documents(root, state)
    return {
        "schema": SCHEMA,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "state_revision": (state or {}).get("revision"),
        "repo": _repo(root, state, warnings),
        "delivery": _delivery(state),
        "standalone": _standalone(root),
        "pending": _pending(state, flow, documents),
        "artifacts": {
            "documents": documents,
            "spec": _spec(root, state),
            "commits": _commits(root, base),
            "logs": {
                key: _abs(root, WORK_DIR, sub)
                for key, sub in (("lightcheck", "lightcheck/latest.md"),
                                 ("codecheck", "codecheck-logs"),
                                 ("agent_tasks", "agent-tasks"),
                                 ("role_tasks", "role-tasks"),
                                 # 月光报告:无人值守一整夜,它是用户唯一的现场
                                 ("moonlight_report", "moonlight-report.md"))
                if os.path.exists(_abs(root, WORK_DIR, sub))
            },
        },
        "evidence": _evidence(state),
        "advisories": _advisories(root, state),
        "progress": _progress(state, flow),
        "warnings": warnings,
    }

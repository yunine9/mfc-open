"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    DEFAULTS_PATH, FLOW_PATH, REQ_SHA_MARKER, STATE_PATH, StateConflictError,
    StateStoreError,
    _BINARY_PREFIXES, _shared_path_fingerprint, _shared_review_path_fingerprint,
    core_find_project_root, hashlib, load_json, moonlight_can_hard_block,
    moonlight_data, moonlight_enabled, moonlight_resolve_kind, moonlight_step_kind,
    moonlight_unresolved, normalize_document, os, re, read_bytes, safe_read_json,
    save_versioned_json, source_paths, subprocess, sys, time, update_json,
    workflow_definition,
)
from .wiring import api
from mae_flow_core import host_env
from mae_flow_core.orchestration.work_package import ensure_work_package
from mae_flow_core.workflow.execution_contract import effective_config_keys

# 2026-08-25 编排瘦身的一次性退役桥(参照 lean-v3 退役先例):除本表外,
# 没有任何活的命令、迁移、hook 或证据规则还认识这些旧步骤名。
_RETIRED_CHOREOGRAPHY = {
    "code_reviewer_ask": "branch_create",
    "build_agent_review": "build", "build_rework": "build",
    "build_review": "build", "build_commit": "build",
    "quality_recompile": "build", "quality_review": "build",
    "quality_rework": "build", "quality_commit": "build",
    "verify_ponytail": "build", "verify_post_ponytail_compile": "build",
    "verify_recompile": "build", "verify_codecheck": "build",
    "verify_codecheck_compile": "build", "verify_ut": "build",
    "verify_spec": "build", "verify_comet": "build",
    "tw_codecheck": "build", "tw_ut": "build", "tw_verify": "build",
    "rf_codecheck": "build", "rf_ut": "build", "rf_verify": "build",
}

def find_project_root(start=None):
    """从 start(默认 cwd)向上定位项目根,消除"模型 cd 进子目录后调用"的错位:
    每层先找已有 .mae-flow.json 或退出标记，再判断 .git / .mae-flow-work / openspec 项目边界；
    不越过最近仓库去捡父目录的陈旧状态。都没有就留在原地。
    返回 (root, 是否已有状态文件)。"""
    root = core_find_project_root(start)
    return root, os.path.exists(os.path.join(root, STATE_PATH))

def load_flow():
    return workflow_definition.load_definition(FLOW_PATH)

def load_state():
    if not os.path.exists(STATE_PATH):
        return None
    raw, err = safe_read_json(STATE_PATH)
    if err:
        raise ValueError(err)
    st = normalize_document(raw, "flow")
    # Older releases could stop in the project setup phase. Setup is no longer
    # part of the workflow; migrate in place so an upgrade resumes normally.
    if st.get("current") == "env_setup":
        st["current"] = "config_confirm"
        st.setdefault("migrations", []).append({
            "type": "remove-project-setup", "from": "env_setup",
            "to": "config_confirm", "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        save_state(st)
    # 2026-08-25 编排瘦身:编码段的编排步骤(检视/精确提交/质量小循环/四步
    # 验证)整体退役,出口验收改由 prepush+权威流水线+MR 检视承担。停在这些
    # 步骤上的在途状态落回宽 build 步继续干;code_reviewer_ask 落回分支创建。
    retired = _RETIRED_CHOREOGRAPHY.get(st.get("current", ""))
    if retired:
        st.setdefault("migrations", []).append({
            "type": "retire-build-choreography", "from": st["current"],
            "to": retired, "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        st["current"] = retired
        save_state(st)
    return st

def save_state(st):
    # 共享 StateStore 同时提供原子写、revision/CAS 和跨 Hook 进程锁。
    try:
        save_versioned_json(STATE_PATH, st, "flow")
    except StateConflictError as exc:
        # Stable machine-readable line for a trusted host. Human diagnostics
        # remain separate so callers never infer retryability from prose.
        print('[mae-flow:error] {"code":"FLOW_REVISION_CONFLICT",'
              '"schema":"mae-flow-error/1"}', file=sys.stderr)
        die("流程状态存在并发更新，已拒绝覆盖：" + str(exc)
            + "。重新执行 current 获取最新状态；若仍失败可直接 `/mae-flow:mae-flow exit` 保存现场并退出。", 2)
    except StateStoreError as exc:
        die("流程状态存在并发更新或不可读，已拒绝覆盖：" + str(exc)
            + "。重新执行 current 获取最新状态；若仍失败可直接 `/mae-flow:mae-flow exit` 保存现场并退出。", 2)

def _drop_agent_token(kind, strict=False):
    """清理单个令牌时保留其他并发 Hook 刚签发的事实。"""
    path = STATE_PATH + ".tokens"

    def remove_one(tokens):
        if not isinstance(tokens, dict):
            tokens = {}
        tokens.pop(kind, None)
        return tokens

    try:
        update_json(path, remove_one, default={}, recover_corrupt=True)
        return True
    except Exception as exc:
        if strict:
            die(
                "新任务签发前无法废弃旧 %s 令牌，已拒绝生成任务卡: %s。"
                "修复令牌 sidecar 后重试；禁止让旧收据复用到新任务。"
                % (kind, exc),
                2,
            )
        # token 清理是防旧证据复用；文件损坏时删除当前内存任务卡仍会让 done
        # 拒绝推进，不能反过来让恢复命令因附属文件故障卡死。
        return False

def _moonlight(st):
    return moonlight_enabled(st)

def _moonlight_data(st):
    return moonlight_data(st)

def _moonlight_unresolved(st):
    return moonlight_unresolved(st)

def _moonlight_resolve_kind(st, kind):
    """某一质量关真实通过后，关闭之前同类遗留；新一轮 defer 会另建记录。"""
    moonlight_resolve_kind(st, kind, sh("git rev-parse --verify HEAD"))

def _moonlight_step_kind(sid):
    return moonlight_step_kind(sid)

def _moonlight_can_block(sid):
    """硬阻塞出口用于非质量工作；质量关有 defer，push 有 push-failed。build 例外：
    它既是实现步骤，也可能遇到需求/依赖阻塞。"""
    return moonlight_can_hard_block(sid)

def _moonlight_issue_context(st):
    issues = _moonlight_unresolved(st)
    if not issues:
        return "当前无已记录遗留。"
    return "\n".join(
        f"- {x.get('id', '?')} [{x.get('kind', '?')}] {x.get('reason', '')}"
        for x in issues[-8:])

def die(msg, code=1):
    print("[mae-flow] " + msg, file=sys.stderr)
    sys.exit(code)

def sh(cmd):
    # encoding 必须显式 utf-8:中文 Windows 下 text=True 默认 GBK,
    # 读 UTF-8 的 git 输出(中文 commit message)会解码失败或乱码
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=15).stdout.strip()
    except Exception:
        return ""

def argv_out(args, timeout=15):
    """无需 shell 的命令输出；文件名、ref 等外部值只能走参数数组，跨平台防注入。"""
    try:
        return subprocess.run(
            list(args), shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        ).stdout.strip()
    except Exception:
        return ""

def _dirty_paths():
    """返回当前工作区脏路径。状态文件与过程目录由流程自己维护，不算交付改动。"""
    from mae_flow_core.guard.manifest import is_runtime_path
    out = []
    for line in sh("git -c core.quotepath=false status --porcelain --untracked-files=all").splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        p = api.norm(parts[1].split(" -> ")[-1].strip().strip('"'))
        if not p or is_runtime_path(p):
            continue
        out.append(p)
    return list(dict.fromkeys(out))

def _path_fingerprint(path):
    """记录初始化时脏文件的内容，防止同一路径后来被本单继续修改却仍冒充“原有脏文件”。"""
    return _shared_path_fingerprint(path)

def _review_path_fingerprint(path):
    """Hash the Git-relevant worktree state without changing legacy dirt IDs."""
    return _shared_review_path_fingerprint(path)

def _step_entered_at(st):
    """当前步骤的进入时间；旧状态没有精确记录时沿用 started。

    除正常推进(next 解析)与 goto 外,回流转移(source-recheck:)与恢复转移
    (resumed:)同样是"进入本步"——漏认会取到过早时间,令旧轮令牌复活。"""
    sid = st.get("current", "")
    for h in reversed(st.get("history", [])):
        result = str(h.get("result", ""))
        if (api._resolved_next(api.FLOW or {}, st, h.get("step", "")) == sid
                or result == "goto:" + sid
                or result == "source-recheck:" + sid
                or result == "resumed:" + sid):
            return h.get("at", st.get("started", ""))
    return st.get("started", "")

def _allowed_set_keys(step, st=None):
    """配置只允许在声明它的步骤写入，防止后续把基线改成 HEAD 等方式洗空检查范围。"""
    keys = set(effective_config_keys(step, st, host_env.host_kind()))
    if "基线分支" in keys:
        keys.add("分支名")
    return keys

def _validate_config_value(key, value):
    if not value:
        return "配置值不能为空"
    if "\x00" in value or "\ufffd" in value:
        return "包含 NUL/Unicode 替换字符，疑似发生编码损坏"
    if key == "单号" and not re.fullmatch(r"(?:REQ|DTS)\w+", value):
        return "单号必须以 REQ 或 DTS 开头"
    if key in ("工号", "基线分支", "分支名") and re.search(r"[\\\s~^:?*\[\];&|`$<>()\"']", value):
        return "包含 git/shell 不安全字符"
    if key in ("基线分支", "分支名"):
        try:
            checked = subprocess.run(
                ["git", "check-ref-format", "--branch", value],
                shell=False, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=10,
            )
        except Exception as exc:
            return "无法调用 git check-ref-format 校验分支名: " + str(exc)
        if checked.returncode != 0 or checked.stdout.strip() != value:
            return "不是合法且无隐式展开的 Git 分支名"
    if key == "CHANGE_NAME" and not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return "change 名只允许字母、数字、下划线和短横线"
    return ""

def _text_corruption_reason(text):
    """只拦高置信度损坏，不把普通中文内容误判成乱码。"""
    if "\x00" in text:
        return "包含 NUL 字符，疑似二进制或错误的 UTF-16 解码"
    if "\ufffd" in text:
        return "包含 Unicode 替换字符 �"
    controls = sum(1 for ch in text if ord(ch) < 32 and ch not in "\r\n\t")
    if controls:
        return "包含不可见控制字符"
    # UTF-8 被 GBK/Latin-1 错解后最常见的高信号组合；至少命中三次才拒绝，避免误伤正常用词。
    mojibake = re.findall(r"(?:锟斤拷|ï¿½|Ã.|Â.|(?:銆|锛|鈥|涔|鐨|鏃|鎴|璇|鍙|缂))", text)
    if len(mojibake) >= 3:
        return "命中多处常见乱码片段(" + "、".join(mojibake[:5]) + ")"
    return ""

def _read_text_source(path, normalize=False):
    """严格读取需求文本；normalize=True 时兼容常见 Windows 文本编码并返回编码名。"""
    try:
        raw = read_bytes(path)
    except OSError as exc:
        return "", "", "无法读取: %s" % exc
    if not raw:
        return "", "", "文件为空"
    if raw.startswith(_BINARY_PREFIXES):
        return "", "", "检测到 PDF/Office/图片等二进制格式，必须先提供文本版或粘贴关键内容"
    candidates = [("utf-8-sig", "utf-8-sig")]
    if normalize:
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            candidates.append(("utf-16", "utf-16"))
        candidates.append(("gb18030", "gb18030"))
    errors = []
    for label, enc in candidates:
        try:
            text = raw.decode(enc, errors="strict")
        except (UnicodeDecodeError, LookupError) as exc:
            errors.append("%s:%s" % (label, exc))
            continue
        bad = _text_corruption_reason(text)
        if bad:
            return "", label, bad
        if not text.strip():
            return "", label, "文件没有有效文本"
        return text, label, ""
    return "", "", ("不是可严格解码的 UTF-8 文本"
                    + ("；可用 requirement-record --source 规范化 GBK/UTF-16 文本" if not normalize else "")
                    + "（%s）" % " | ".join(errors[-2:]))

def _validate_requirement_document(path):
    """配置确认的需求入口必须是可复读的 UTF-8 文本；禁止 errors=replace 掩盖乱码。"""
    text, enc, err = _read_text_source(path, normalize=False)
    if err:
        return False, err
    marker = re.search(r"<!--\s*" + re.escape(REQ_SHA_MARKER) + r"\s*([0-9a-f]{64})\s*-->", text)
    if marker:
        body = text[marker.end():]
        # 记录器固定在 marker 后写一个正文换行；校验只去掉这一层封装，不改用户原文内部空白。
        body = body[1:] if body.startswith("\n") else body
        if body.endswith("\n"):
            body = body[:-1]
        actual = hashlib.sha256(body.encode("utf-8")).hexdigest()
        if actual != marker.group(1):
            return False, "需求原文指纹不一致，文件写入后被改动或截断"
    return True, enc

def _configured_source_patterns(st):
    """仓库私有源码布局；config 字符串优先，defaults 支持字符串或正则数组。"""
    raw = ((st or {}).get("config", {}) or {}).get("源码路径", "")
    if raw:
        return ([x.strip() for x in raw.split(",") if x.strip()]
                if isinstance(raw, str) else list(raw) if isinstance(raw, list) else [])
    try:
        # utf-8-sig:团队手写 defaults 常带 BOM;解析失败必须可见——
        # 「源码路径」静默失效等于门禁口径悄悄变宽。
        v = load_json(DEFAULTS_PATH, encoding="utf-8-sig").get("源码路径", [])
        if isinstance(v, str):
            return [x.strip() for x in v.split(",") if x.strip()]
        return v if isinstance(v, list) else []
    except FileNotFoundError:
        return []
    except Exception as e:
        print("⚠ %s 的「源码路径」解析失败,已忽略(请修复该 JSON): %s" % (DEFAULTS_PATH, e),
              file=sys.stderr)
        return []

def _matches_pattern(path, pattern):
    return source_paths.matches_pattern(path, pattern)

def _repo_rel_for_match(path):
    """目录类正则只能喂「项目根相对 + 正斜杠」路径。

    Edit gate 收到的是宿主给的绝对路径:直接拿去匹配 `(^|/)src/`,仓库祖先目录
    恰好叫 src/app/lib 时全仓所有文件都会被误判成源码(禁改步骤整体卡死且无出口);
    defaults 里 `^ut/` 这类锚定私有正则则反向永不命中。相对路径原样返回(去掉 ./ 前缀);
    项目根之外的绝对路径返回 None——目录模式对根外路径无意义(插件目录另有专门拦截)。
    不用 os.path.relpath:跨盘符抛 ValueError(Windows 军规3)。"""
    return source_paths.repo_relative_for_match(path, os.getcwd())

def _is_build_path(path):
    """识别会改变构建/依赖结果的入口；供源码范围和任务卡分类共用。"""
    return source_paths.is_build_path(path)

def _is_source_path(path, st=None, flow=None):
    """跨仓统一源码判定：扩展名/构建文件 + 通用目录 + 仓库私有路径，任一命中即算。

    Edit gate、Bash gate、令牌新鲜度和 UT 源码回流必须共用它，避免四套口径漂移。
    """
    normalized = api.norm(path).strip().strip('"\'')
    membership = os.path.isabs(normalized)
    known = source_paths.known_source_classification(
        normalized,
        project_root=os.getcwd(),
        require_membership=membership,
    )
    if known is not None:
        return known
    rules = list(
        (flow or api.FLOW or {}).get("source_patterns", []))
    rules.extend(_configured_source_patterns(st))
    return source_paths.is_source_path(
        normalized,
        rules,
        project_root=os.getcwd(),
        require_membership=membership,
    )

def _is_review(st):
    return (st.get("choices", {}) or {}).get("workflow") == "review"

def _ensure_review_base(st):
    """记录评审返工开始前的原 MR HEAD。

    新流程在 branch_create 离开前直接取 HEAD；旧版在途状态优先按进入 rf_triage 的
    history 时间反推，保证升级后不会把整个原需求 diff 当成本轮增量。
    """
    if not _is_review(st):
        return "", "当前不是评审意见处理流程"
    old = st.get("review_base_head", "")
    if old and argv_out(["git", "cat-file", "-t", old]) == "commit":
        return old, ""
    at = ""
    for h in st.get("history", []):
        if h.get("step") == "branch_create":
            at = h.get("at", "")
            break
    base = argv_out(["git", "rev-list", "-1", "--before=" + at, "HEAD"]) if at else ""
    if not base:
        review_doc = os.path.join(ensure_work_package(
            os.getcwd(), st.get("config", {}).get("单号", "")).root,
            "review.md")
        added = argv_out([
            "git", "log", "--diff-filter=A", "-1", "--format=%H", "--", review_doc])
        if added:
            # --verify 必带(军规5):root commit 的 {added}^ 不存在时,裸 rev-parse 会把
            # 参数字面串回显到 stdout,伪 rev 一路传染成空 diff → 质量链静默全过。
            base = argv_out(["git", "rev-parse", "--verify", "--quiet", added + "^"])
    if not base:
        return "", ("无法自动恢复返工基点。不要用当前 HEAD 代替，否则增量范围会变成空；"
                     "请把日志与原 MR 返工前 commit 交维护人处理")
    st["review_base_head"] = base
    save_state(st)
    return base, ""

def _scope_base(st):
    """本轮质量检查的代码基点：review 只看返工增量，其余流程看需求基线。"""
    if _is_review(st):
        return _ensure_review_base(st)
    base = st.get("config", {}).get("基线分支", "")
    if not base:
        return "", "缺基线分支配置"
    if not argv_out(["git", "rev-parse", "--verify", base]):
        return "", f"基线分支「{base}」无法解析(不存在/拼写错),diff 无从算起——先修配置"
    return base, ""

def _scope_diff(st):
    base, err = _scope_base(st)
    if err:
        return "", err
    return (f"{base}..HEAD" if _is_review(st) else f"{base}...HEAD"), ""

_path_fingerprint.__wrapped__ = _shared_path_fingerprint
_review_path_fingerprint.__wrapped__ = _shared_review_path_fingerprint

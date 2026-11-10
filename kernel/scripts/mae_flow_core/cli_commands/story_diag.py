"""CLI responsibilities extracted from the historical entrypoint."""

import tempfile

from mae_flow_core import host_env
from mae_flow_core.adapters.hook_diagnostics import recent_hook_anomalies
from mae_flow_core.workflow.execution_contract import (
    effective_config_keys,
    uses_pipeline,
    validation_environment,
)

from .shared import (
    COMET_COMPAT_BEGIN, FAILURE_PATH, GATE_STRIKES_PATH, GATE_STRIKE_LIMIT, STATE_PATH,
    capability_diagnostics, comet_guard_paths, globmod, json, load_json, os, read_text,
    resolve_runtime, subprocess, sys, time,
)
from .wiring import api

def _story_source_candidates(ticket):
    """Find dirty STORY output for this ticket, including a wrong directory."""
    canonical = "docs/story/STORY-" + ticket + ".md"
    if os.path.isfile(canonical):
        return [canonical]
    candidates = []
    for path in api._dirty_paths():
        if not os.path.isfile(path) or not api._is_story_document(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as stream:
                sample = stream.read(65536)
        except OSError:
            sample = ""
        if ticket.casefold() in (path + "\n" + sample).casefold():
            candidates.append(path)
    return list(dict.fromkeys(candidates))

def _unstage_uncommitted_story(path):
    """Remove a newly added STORY from the index without deleting its content."""
    staged = api.argv_out(
        ["git", "diff", "--cached", "--name-only", "--", path])
    if not staged:
        return
    restored = subprocess.run(
        ["git", "restore", "--staged", "--", path],
        shell=False, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=30,
    )
    if restored.returncode != 0:
        api.die(
            f"{path} 已暂存但无法安全移出暂存区:"
            + (restored.stderr or restored.stdout).strip()
            + "。先执行 git restore --staged -- " + path + " 后重试。", 2)

def _canonicalize_story_output(ticket, st=None):
    """Move one wrong-path STORY to the canonical location before validation."""
    canonical = "docs/story/STORY-" + ticket + ".md"
    if os.path.isfile(canonical):
        return canonical
    candidates = _story_source_candidates(ticket)
    if st is not None:
        written = api._agent_written_paths()
        candidates = [
            path for path in candidates
            if (not api._unchanged_initial_dirty(path, st)
                or api._repo_path_identity(path) in written)
        ]
    if len(candidates) > 1:
        api.die(
            "发现多个本单 STORY 输出且都不在标准路径: "
            + "、".join(candidates)
            + "。拒绝猜测，请先合并为 " + canonical + "。", 2)
    if not candidates:
        return ""
    src = candidates[0]
    tracked_in_head = api.argv_out(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", "--", src])
    if tracked_in_head:
        api.die(
            f"STORY 被写到错误路径且已经提交: {src}。"
            "请用普通后续提交把它迁移到 " + canonical
            + "，不能靠工作区移动掩盖已提交事实。", 2)
    _unstage_uncommitted_story(src)
    os.makedirs(os.path.dirname(canonical), exist_ok=True)
    os.replace(src, canonical)
    print(f"[mae-flow] ⚠ STORY 输出路径已自动纠正: {src} → {canonical}")
    return canonical

def _localize_story(ticket):
    """Move a not-for-commit STORY out of the delivery tree deterministically."""
    reason = api._validate_config_value("单号", ticket)
    if reason:
        api.die("STORY 本地化失败:" + reason, 2)
    candidates = _story_source_candidates(ticket)
    canonical = "docs/story/STORY-" + ticket + ".md"
    if not candidates:
        print("[mae-flow] 用户选择 STORY 不入库；未发现本次生成的 STORY 文件，"
              "无需清理。")
        return ""
    if len(candidates) > 1:
        api.die(
            "发现多个与本单匹配的 STORY，无法安全猜测该保留哪一份: "
            + "、".join(candidates)
            + "。先合并为 " + canonical + " 后重跑 story-localize。", 2)
    src = candidates[0]
    tracked_in_head = api.argv_out(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", "--", src])
    if tracked_in_head:
        api.die(
            f"用户选择 STORY 不入库，但 {src} 已存在于 HEAD。"
            "不能仅移动本地文件掩盖已提交事实；请用普通后续提交精确删除它，"
            "再重跑本命令。", 2)
    _unstage_uncommitted_story(src)
    api._git_local_runtime_ignore()
    dst_dir = os.path.join(".mae-flow-work", "story")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, os.path.basename(canonical))
    if os.path.exists(dst):
        stem, ext = os.path.splitext(os.path.basename(canonical))
        number = 2
        while os.path.exists(os.path.join(dst_dir, f"{stem}-{number}{ext}")):
            number += 1
        dst = os.path.join(dst_dir, f"{stem}-{number}{ext}")
    os.replace(src, dst)
    if src != canonical:
        print(f"[mae-flow] ⚠ STORY 曾被写到错误目录 {src}，已一并纠正。")
    print(f"[mae-flow] STORY 不入库，已移入 Git 本地排除的过程区: {api.norm(dst)}")
    return api.norm(dst)

def cmd_story_localize(args):
    """Cleanup command for standalone `/mae-flow:mae-flow story`."""
    return _localize_story((args.ticket or "").strip())

def cmd_envcheck(flow, args):
    checks = capability_diagnostics(os.getcwd(), include_codecheck=True)
    for item in checks:
        print(("✅ " if item["ok"] else "❌ ") + item["name"] + ": " + item["detail"])
    # CodeCheck is optional and is installed only when first used; its absence
    # does not make the plugin itself unusable.
    required_failed = [x for x in checks if not x["ok"] and x["name"] != "CodeCheck"]
    if required_failed:
        sys.exit(2)

def cmd_doctor(flow, st, args):
    sid = st["current"]
    step = flow["steps"][sid]
    print(f"项目根(状态文件所在): {os.getcwd()}")
    runtime = resolve_runtime(os.getcwd())
    print("✅ 运行模式: " + runtime.mode)
    if runtime.conflicts:
        print("⚠ 状态冲突: " + "、".join(runtime.conflicts)
              + "（完整流程具有唯一控制权，陈旧标记不会绕过当前门禁）")
        if "flow_and_action" in runtime.conflicts:
            print("   清理方式: 确认独立任务不再需要后执行 action cancel")
        if "flow_and_exit" in runtime.conflicts:
            print("   清理方式: 当前完整流程可正常继续；下次正常 exit/init 会重建退出标记")
    for error in runtime.errors:
        print("⚠ 非主控状态不可读: " + error)
    print(f"当前步骤: {sid} — {step['title']}")
    try:
        hook_log = os.path.join(tempfile.gettempdir(), "mae-flow-hook.log")
        anomalies = recent_hook_anomalies(
            read_text(hook_log, errors="replace").splitlines(),
            since=str(st.get("started", "") or ""),
        ) if os.path.isfile(hook_log) else []
        if anomalies:
            print("❌ 本单 Hook 内部异常（最近 %d 条）:" % len(anomalies))
            for anomaly in anomalies:
                print("   - " + anomaly)
        else:
            print("✅ 本单 Hook 内部异常: 未发现")
    except Exception as exc:
        print("⚠ Hook 异常日志不可读: " + str(exc)[:160])
    cur = api.sh("git branch --show-current")
    want = st["config"].get("分支名", "(未设置)")
    print(("✅" if cur == want else "❌") + f" 分支: 当前 {cur or '未知'} / 约定 {want}")
    cn = st["config"].get("CHANGE_NAME", "")
    # v3 后阶段真相源在 .mae-flow.json 的 spec 段;产物按布局探测
    # (v5=change.md,legacy=.openspec.yaml/四件套)。审计实锤:旧实现查
    # .comet.yaml,对 v3 之后的每张健康单都误报 ❌。
    if cn:
        from mae_flow_core import specengine
        workspace = os.path.relpath(
            specengine._openspec_dir(os.getcwd())).replace("\\", "/")
        cdir = f"{workspace}/changes/{cn}"
        ph = str(api._spec_data(st).get("phase", "") or "?")
        if os.path.isfile(cdir + "/change.md"):
            print(f"✅ change: {cn}(v5 四合一),phase={ph}")
        elif os.path.isdir(cdir):
            print(f"✅ change: {cn}(旧布局在途),phase={ph}")
        elif ph == "archived" or globmod.glob(
                f"{workspace}/changes/archive/*{cn}*"):
            print(f"✅ change: {cn} 已归档,phase={ph}")
        else:
            print(f"❌ change: {cn} 目录不存在且未见归档(phase={ph})")
    else:
        print("⚠ change: CHANGE_NAME 未设置(open 之前属正常)")
    nac = api._active_change_count()
    print(("✅" if nac <= 1 else "❌") + f" 活跃 change 数: {nac}" + ("(僵尸在场!comet 会抽错人,清理见下)" if nac > 1 else ""))
    guards = [p for p in comet_guard_paths(os.getcwd()) if os.path.isfile(p)]
    try:
        compat = bool(guards) and all(
            COMET_COMPAT_BEGIN in read_text(p, errors="strict")
            for p in guards)
    except Exception:
        compat = False
    print(("✅" if compat else "⚠") + " 直接开发逃生兼容: "
          + ("Comet Hook 已识别退出标记" if compat else
             "未确认（不阻止当前流程；exit 会再次尽力修复，且永不因此拒绝退出）"))
    for _w in api._sentinel_lines(sid, st):
        print("   " + _w)
    for kind, rec in sorted((st.get("risk_acceptances", {}) or {}).items()):
        if rec.get("step") != sid:
            continue
        valid, why = api._risk_acceptance(kind, st)
        if valid:
            print(f"⚠ 用户风险放行: {kind}（当前步骤/任务卡/HEAD 有效；其他证据不受影响）")
        else:
            print(f"❌ 用户风险放行已失效: {kind}（{why}）")
    fails = api.check_evidence(step, st)
    if fails:
        print("❌ 当前步证据未满足:")
        for x in fails:
            print("   - " + x)
    else:
        print("✅ 当前步证据已满足(或本步无证据要求)")
    ef = api.run_env_checks()
    print(("✅ 插件运行时: 完整" if not ef else
           "❌ 插件运行时不完整: " + "、".join(ef)))
    config_step = (flow.get("steps", {}) or {}).get("config_confirm", {})
    declared = config_step.get("require_sets")
    visible_keys = set(effective_config_keys(
        config_step, st, host_env.host_kind())) if declared else {
            "单号", "编译方式", "UT生成方式"
        }
    for key in ("单号", "编译方式", "UT生成方式"):
        if key not in visible_keys:
            continue
        label = "UT 编写方式" if key == "UT生成方式" else key
        value = st["config"].get(key)
        print(("✅" if value else "❌")
              + f" 配置 {label}: {value or '缺失'}")
    if uses_pipeline(st, host_env.host_kind()):
        print("✅ 验证环境: %s（只读，由部署执行契约决定）" %
              validation_environment(st, host_env.host_kind()))
    sp = api._configured_source_patterns(st)
    print(("✅" if sp else "ℹ") + " 私有源码路径: "
          + (" | ".join(sp) if sp else "未配置（使用跨仓扩展名、构建文件和通用目录规则）"))
    # 观测项(公司机金丝雀关注):ack 验真存储 与 UTRUN 令牌——两者依赖 harness payload 字段
    try:
        captured = json.loads(read_text(STATE_PATH + ".usermsg") or "[]")
        n = len(captured)
        print(f"✅ ack 验真存储: {n} 条用户输入" if n else
              "❌ ack 验真存储: 空(确认步骤会拒绝推进；请让用户发送一条普通消息后重试)")
        if captured:
            last = captured[-1]
            health = api._text_corruption_reason(last.get("text", ""))
            print(("❌" if health else "✅") + " 最近用户输入: id=%s step=%s encoding=%s sha256=%s%s" % (
                last.get("id", "旧记录无ID"), last.get("step", "?"),
                last.get("input_encoding", "旧记录未知"),
                (last.get("sha256", "") or "?")[:12],
                (" 疑似乱码=" + health) if health else ""))
    except Exception:
        print("❌ ack 验真存储: 不存在(确认步骤会拒绝推进；检查 UserPromptSubmit hook，"
              "临时恢复方式是让用户发送普通确认消息后重试)")
    try:
        failures = load_json(FAILURE_PATH) if os.path.exists(FAILURE_PATH) else {}
        rec = failures.get("ack:" + sid, {})
        if rec:
            print(("❌" if int(rec.get("count", 0)) >= 2 else "⚠")
                  + " 当前确认自动校验失败: %s 次（%s）。流程未锁死；正确的新回复仍可恢复" % (
                      rec.get("count", 0), rec.get("reason", "")[:160]))
    except Exception:
        pass
    try:
        tok = json.loads(read_text(STATE_PATH + ".tokens")).get("UTRUN", "")
        uts = tok.get("at") if isinstance(tok, dict) else tok
        print(("✅" if uts else "⚠") + f" UTRUN 令牌(UT 命令真实调起): {uts or '未记录(尚未跑 UT,或 PostToolUse-Bash 未触发)'}")
    except Exception:
        print("⚠ UTRUN 令牌: 无令牌文件")
    try:
        strikes = load_json(GATE_STRIKES_PATH) if os.path.exists(GATE_STRIKES_PATH) else {}
        hot = [(r, e) for r, e in (strikes.get("counts", {}) or {}).items()
               if int(e.get("count", 0) or 0) >= GATE_STRIKE_LIMIT]
        for rule, entry in hot:
            print("⚠ 疑似误拦: 规则 %s 在步骤 %s 连拦 %s 次(最近 %s)。"
                  "确属正当动作可用报错中的 allow 放行令;反复出现请把本行报给维护者修规则。"
                  % (rule, entry.get("step", "?"), entry.get("count"), entry.get("last_at", "?")))
    except Exception:
        pass

def cmd_report(flow, st, args):
    """按 history 时间戳输出各步骤耗时,供交付复盘/团队度量。"""
    def ts(s):
        return time.mktime(time.strptime(s, "%Y-%m-%d %H:%M:%S"))

    def fmt(sec):
        sec = int(sec)
        return f"{sec // 3600}h{sec % 3600 // 60:02d}m" if sec >= 3600 else f"{sec // 60}m{sec % 60:02d}s"

    cfg = st.get("config", {})
    print(f"单号: {cfg.get('单号', '?')}  分支: {cfg.get('分支名', '?')}  开始: {st['started']}")
    prev, total = ts(st["started"]), 0
    for h in st["history"]:
        cur = ts(h["at"])
        dur = max(0, cur - prev)
        prev, total = cur, total + dur
        note = ("  # " + h["note"][:40]) if h.get("note") else ""
        print(f"  {h['step']:<18} {h['result']:<10} {fmt(dur):>8}{note}")
    print(f"合计: {fmt(total)}  当前步骤: {st['current']}")
    # 摩擦统计:量化本单的 harness 干预(验收线指标:gate 误拦/单 应为个位数)
    fr = api._friction_from_log(st)
    goto_n = sum(1 for h in st["history"] if str(h.get("result", "")).startswith("goto:"))
    risk_n = sum(1 for h in st["history"] if str(h.get("result", "")).startswith("accept-risk:"))
    if fr:
        print(f"摩擦统计: gate 拦截 {fr['gate拦截']} 次 · 子agent契约打回 {fr['契约打回']} 次"
              f" · hook 异常 {fr['hook异常']} 次 · goto 人工跳转 {goto_n} 次 · 风险放行 {risk_n} 次")
    else:
        print(f"摩擦统计: hook 日志不可读 · goto 人工跳转 {goto_n} 次 · 风险放行 {risk_n} 次")

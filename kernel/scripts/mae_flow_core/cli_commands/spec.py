"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    DEFAULTS_PATH, GATE_PERMITS_PATH, GATE_STRIKES_PATH,
    SPEC_PHASES, SPEC_REGISTER_FIELDS, json, load_json, os, re, specengine, sys,
    time, update_json,
)
from .wiring import api
from mae_flow_core.quality.implementation_tasks import (
    implementation_task_progress,
)

_USER_GIT_AUTHORIZATION_RULES = {
    "bash-cross-delivery-carryover",
    "bash-foreign-openspec",
    "bash-specs",
    "bash-source",
    "bash-wipe-worktree",
    "bash-git-revert-user-authorization",
}

def _test_patterns(st):
    """仓库测试路径配置：config「测试路径」逗号分隔正则优先，否则读 defaults 数组。
    未配置返回 []，调用方使用 DEFAULT_TEST_PATS 保守兜底，不再 fail-open。"""
    raw = ((st or {}).get("config", {}) or {}).get("测试路径", "")
    if raw:
        values = ([x.strip() for x in raw.split(",") if x.strip()]
                  if isinstance(raw, str) else list(raw) if isinstance(raw, list) else [])
    else:
        try:
            raw = load_json(DEFAULTS_PATH, encoding="utf-8-sig").get("测试路径", [])
            values = ([x.strip() for x in raw.split(",") if x.strip()]
                      if isinstance(raw, str) else list(raw) if isinstance(raw, list) else [])
        except Exception:
            values = []
    valid = []
    for value in values:
        pattern = str(value).strip()
        if not pattern:
            continue
        try:
            re.compile(pattern)
        except re.error as exc:
            print("⚠ 测试路径正则「%s」无效，已按 fail-closed 忽略并保留内置测试边界: %s"
                  % (pattern, exc), file=sys.stderr)
            continue
        valid.append(pattern)
    return valid

def _business_source_changed_since_step(st, sid):
    """找出某步骤入口后发生的非测试源码变化(提交和工作区都算;月光 defer 用)。"""
    head = (st.get("step_heads", {}) or {}).get(sid, "")
    if not head:
        return None, (f"缺少步骤 {sid} 的入口 HEAD（可能是旧版在途状态）"
                      "，不能把当前 HEAD 当入口，否则会漏检")
    changed, err = api._source_changed_since(head, st)
    if err:
        return None, err
    out = []
    for raw in changed or []:
        path = raw[:-len("(未提交)")] if raw.endswith("(未提交)") else raw
        if not api._is_test_file(path, st) and not api._is_build_path(path):
            out.append(raw)
    return list(dict.fromkeys(out)), ""

def cmd_spec(flow, st, args):
    """交付登记与阶段推进(v3 取代 comet-state)。

    设计要点(比被取代者更硬):
    - 指针字段登记时**现场校验文件真实存在**,写不进不存在的路径;
    - `verify_result` 不可直写——它只能由 verify-pass 转换产生,而转换要求验证报告
      已登记且真实存在。这封掉了 comet 时代 `set verify_result pass` 的伪造通道;
    - 阶段推进只接受合法序,乱跳报错;所有动作写 history 留痕。"""
    if st is None:
        api.die("流程未初始化;先执行 init。", 2)
    action = args.spec_action
    data = api._spec_data(st)
    cn = (st.get("config", {}) or {}).get("CHANGE_NAME", "")
    now = time.strftime("%Y-%m-%d %H:%M:%S")

    from mae_flow_core import specengine

    if action == "show":
        out = {"change": cn, **data}
        # 已归档单的 change 目录已移走,查产物必然报"不存在"——成功之后
        # 看到报错违背流畅原则,改报归档去向。
        if cn and str(data.get("phase", "")) == "archived":
            workspace = api.norm(os.path.relpath(
                specengine._openspec_dir(os.getcwd()), os.getcwd()))
            out["note"] = "已归档: " + workspace + "/changes/archive/%s" % (
                data.get("archived_to", "?"))
        elif cn:
            try:
                out["artifacts"] = specengine.status(os.getcwd(), cn)
            except Exception as exc:
                out["artifacts_error"] = str(exc)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return
    # v5:新单一律四合一 change.md,档位跟随交付方式(review 不建单,缺省按 full)。
    workflow = (st.get("choices", {}) or {}).get("workflow", "")
    tier = workflow if workflow in ("full", "hotfix", "tweak") else "full"
    if action == "new":
        name = (args.value or cn or "").strip()
        if not name:
            api.die("需要变更目录名:spec new <英文短名>。", 2)
        try:
            specengine.ensure_config(os.getcwd())
            info = specengine.new_change(os.getcwd(), name, tier=tier)
        except specengine.SpecEngineError as exc:
            api.die("创建变更目录失败: " + str(exc), 2)
        # dogfood 实测:spec init 要求 CHANGE_NAME 已记录,而记录动作(done --set)
        # 排在 init 之后,真实链路要撞两次墙才绕通。new 是真实动作、目录名就是
        # 事实,创建成功即顺手登记(为空才写;done --set 同值幂等,权威不变)。
        # 注意:登记+吞并 init 的全部内存变更做完后【单次】save_state——
        # save_versioned_json 保存后会 clear+deepcopy 重建 st,先前取出的
        # data 引用即成孤儿,连续两次 save 的第二次会静默写空(实测踩雷)。
        registered = not cn
        if registered:
            st["config"]["CHANGE_NAME"] = name
            st.setdefault("history", []).append(
                {"step": st["current"], "result": "spec:new", "note": name,
                 "at": now})
        elif cn != name:
            print("[mae-flow] ⚠ 已登记 CHANGE_NAME=%s 与新目录 %s 不一致;"
                  "一仓一单,请确认没有开重复单。" % (cn, name), file=sys.stderr)
        # new 吞并 init(优化实测:init 只剩可推导字段,独立存在只制造
        # "init 先于登记"类顺序撞墙)。幂等守卫:已初始化过则不重置 phase。
        inited = (not data.get("initialized_at")) and (not cn or cn == name)
        if inited:
            data.update({"change": name, "phase": "open",
                         "workflow": workflow, "initialized_at": now})
            st.setdefault("history", []).append(
                {"step": st["current"], "result": "spec:init", "note": name,
                 "at": now})
        if registered or inited:
            api.save_state(st)
        # stdout 是 spec new 的 JSON 契约面,提示一律走 stderr
        if registered:
            print("[mae-flow] CHANGE_NAME=%s 已随创建自动登记(done 无需重复 --set)。"
                  % name, file=sys.stderr)
        if inited:
            print("[mae-flow] 交付登记已随创建初始化:change=%s phase=open"
                  % name, file=sys.stderr)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return
    if action == "instructions":
        artifact = args.value or ""
        if not cn:
            api.die("先记录 CHANGE_NAME(done --set CHANGE_NAME=<英文短名>)。", 2)
        try:
            print(specengine.instructions(os.getcwd(), artifact, cn, tier=tier),
                  end="")
        except specengine.SpecEngineError as exc:
            api.die("获取产物格式指令失败: " + str(exc), 2)
        return
    if action == "validate":
        if not cn:
            api.die("先记录变更目录名:spec new <英文短名>", 2)
        try:
            ok, messages = specengine.validate(os.getcwd(), cn)
        except specengine.SpecEngineError as exc:
            api.die("规格校验无法执行: " + str(exc), 2)
        for line in messages:
            print(line)
        if not ok:
            api.die("规格结构校验未通过:按上面的错误逐条修正后重跑(当步修比定稿时爆便宜得多)。", 2)
        print("[mae-flow] 规格结构校验通过。")
        return
    if action == "archive":
        if not cn:
            api.die("先记录变更目录名:spec new <英文短名>", 2)
        if api._spec_phase(st) != "archive":
            api.die("规格定稿只能在定稿阶段执行(当前阶段 %s):先完成验证并通过 spec verify-pass。"
                % (api._spec_phase(st) or "未初始化"), 2)
        try:
            info = specengine.archive(os.getcwd(), cn)
        except specengine.SpecEngineError as exc:
            api.die("规格定稿失败(现场保持原样,可修正后直接重跑): " + str(exc), 2)
        data["phase"] = "archived"
        data["archived_to"] = info.get("archive_name", "")
        archived_path = api.norm(os.path.relpath(
            info.get("archived_to", ""), os.getcwd()))
        workspace = api.norm(os.path.relpath(
            specengine._openspec_dir(os.getcwd()), os.getcwd()))
        data["archive_paths"] = list(dict.fromkeys(
            [workspace + "/changes/" + cn, archived_path] + [
                re.sub(r"^(?:\./)+", "", api.norm(path))
                for path in info.get("merged", []) or []
            ]))
        data["archived_at"] = now
        st.setdefault("history", []).append(
            {"step": st["current"], "result": "spec:archived",
             "note": info.get("archive_name", ""), "at": now})
        api.save_state(st)
        for warn in info.get("warnings", []) or []:
            print("⚠ " + str(warn), file=sys.stderr)
        print("[mae-flow] 规格已定稿:合并进真相源 %s;变更目录已移动到 %s。"
              % ("、".join(info.get("merged", [])) or "(无规格变更)",
                 info.get("archive_name", "")))
        print("[mae-flow] 本次只需精确提交: "
              + "、".join(data["archive_paths"]))
        print("禁止 git add %s/；该宽路径可能卷入其他单遗留文件。" % workspace)
        print("统计: " + json.dumps(info.get("totals", {}), ensure_ascii=False))
        return
    if action == "init":
        if not cn:
            api.die("先用 done --set CHANGE_NAME=<英文短名> 记录变更目录名。", 2)
        # spec new 已自动初始化,本命令保留为在途兼容的幂等别名——重复 init
        # 不得把已推进的 phase 重置回 open(旧实现的隐性坑,顺手关闭)。
        if data.get("initialized_at"):
            print("[mae-flow] 交付登记已存在:change=%s phase=%s(幂等,未改动)"
                  % (data.get("change", cn), data.get("phase", "?")))
            return
        data.update({"change": cn, "phase": "open", "workflow":
                     (st.get("choices", {}) or {}).get("workflow", ""),
                     "initialized_at": now})
        st.setdefault("history", []).append(
            {"step": st["current"], "result": "spec:init", "note": cn, "at": now})
        api.save_state(st)
        print("[mae-flow] 交付登记已初始化:change=%s phase=open" % cn)
        return
    if action == "set":
        field, value = args.field, (args.value or "").strip()
        if field not in SPEC_REGISTER_FIELDS:
            api.die("只能登记这些产物指针: %s。阶段与验证结论由 phase/verify-pass 转换产生,"
                "不接受直写(直写等于伪造机器结论)。" % "、".join(SPEC_REGISTER_FIELDS), 2)
        if not value:
            api.die("登记值不能为空。", 2)
        if not os.path.isfile(value):
            api.die("登记失败:%s 不存在。先真实产出该文件再登记(登记不是承诺,是事实)。" % value, 2)
        data[field] = api.norm(value)
        st.setdefault("history", []).append(
            {"step": st["current"], "result": "spec:set:" + field, "note": value, "at": now})
        api.save_state(st)
        print("[mae-flow] 已登记 %s = %s" % (field, api.norm(value)))
        return
    if action == "phase":
        target = args.value or ""
        if target not in SPEC_PHASES:
            api.die("阶段只能是: %s" % "、".join(SPEC_PHASES), 2)
        cur = api._spec_phase(st) or "open"
        order = list(SPEC_PHASES)
        # 轻量单快进:hotfix/tweak 不经 design/build 步骤,phase 停在 open,而
        # 防跳跃墙的报错本来就教模型机械连打三条——仪式改由机器代劳。
        # 逐格推进逐格留痕,审计轨迹与手动三连逐字等价;full 单不放行
        # (它的 design/build 推进各自绑在对应步骤的 done 证据里)。
        wf = (st.get("choices", {}) or {}).get("workflow", "")
        if target == "verify" and cur == "open" and wf in ("hotfix", "tweak"):
            for p in ("design", "build", "verify"):
                data["phase"] = p
                st.setdefault("history", []).append(
                    {"step": st["current"], "result": "spec:phase:" + p,
                     "at": now})
            api.save_state(st)
            print("[mae-flow] 交付阶段(轻量单快进):open → design → build → verify")
            return
        if order.index(target) < order.index(cur):
            api.die("阶段不能回退(%s → %s)。需要回流请让用户裁决，"
                "再用 messages + goto --force --message-id <ID>。"
                % (cur, target), 2)
        if order.index(target) - order.index(cur) > 1:
            # dogfood 实测:hotfix/tweak 单不经 design/build 步骤,阶段停在 open,
            # verify 步一条 phase verify 会撞这堵墙——报错必须给出路(核心原则)。
            # 审计实锤两修:①链止步 verify(archive/archived 由 verify-pass/
            # spec archive 产生,列进链会引导绕过三重校验并推进死胡同);
            # ②命令用本脚本真实路径(字面量 mae-flow.py 相对路径照抄必失败)。
            script = api.norm(os.path.abspath(sys.argv[0]))
            stop = min(order.index(target), order.index("verify"))
            chain = " && ".join(
                'python3 "%s" spec phase %s' % (script, p)
                for p in order[order.index(cur) + 1:stop + 1])
            tail = ("(verify 之后由 spec verify-pass 与 spec archive 推进,"
                    "不可用 phase 直达)" if order.index(target) > order.index("verify")
                    else "")
            api.die("阶段不能跳跃(%s → %s):中间阶段的产物与证据会被绕过。"
                "轻量单(hotfix/tweak)不经 design/build 步骤但阶段仍需逐级推进,"
                "依序执行:%s%s" % (cur, target, chain, tail), 2)
        if target == "archive":
            api.die("archive 阶段由 spec verify-pass 在三重校验(阶段在 verify+报告"
                "存在+清单全勾)通过后写入,不接受直接推进(直推会绕过验证)。", 2)
        if target == "archived":
            api.die("archived 由 spec archive 动作在真实完成定稿后写入,不接受直接推进。", 2)
        data["phase"] = target
        st.setdefault("history", []).append(
            {"step": st["current"], "result": "spec:phase:" + target, "at": now})
        api.save_state(st)
        print("[mae-flow] 交付阶段:%s → %s" % (cur, target))
        return
    if action == "verify-pass":
        # --report 合并"登记+判定"两连(优化实测:set verification_report 全仓
        # 只在 verify-pass 前一行出现,拆开只制造"忘登记"撞墙)。校验与 history
        # 与逐条执行完全一致;verify_result 不可直写的封印不动。
        report_arg = (getattr(args, "report", "") or "").strip()
        if report_arg:
            if not os.path.isfile(report_arg):
                api.die("登记失败:%s 不存在。先真实产出验证报告再登记。" % report_arg, 2)
            data["verification_report"] = api.norm(report_arg)
            st.setdefault("history", []).append(
                {"step": st["current"], "result": "spec:set:verification_report",
                 "note": report_arg, "at": now})
        cur = api._spec_phase(st)
        if cur != "verify":
            api.die("verify-pass 只能在验证阶段执行(当前阶段 %s):没进入验证就宣布验证通过"
                "等于跳过实现与检查。先按步骤指引把阶段推进到 verify。" % (cur or "未初始化"), 2)
        report = str(data.get("verification_report", "") or "")
        if not report or not os.path.isfile(report):
            script = api.norm(os.path.abspath(sys.argv[0]))
            api.die("verify-pass 要求先登记真实存在的验证报告:"
                "python3 \"%s\" spec set verification_report \"<路径>\"。"
                "验证结论不能凭口头产生。" % script, 2)
        # 校准实锤:0 字节报告与零任务清单曾可满足"三重硬校验"——空产物
        # 不能证明任何事。
        try:
            if os.path.getsize(report) == 0:
                api.die("验证报告 %s 是空文件——空报告不能证明验证发生过;"
                    "写入真实验证结论后重试。" % report, 2)
        except OSError:
            pass
        try:
            _label, tasks_txt = specengine.tasks_source(os.getcwd(), cn)
        except specengine.SpecEngineError as exc:
            api.die("实现清单无法读取:" + str(exc), 2)
        progress = implementation_task_progress(tasks_txt)
        if not progress["total"]:
            api.die(
                "实现清单没有任何生产代码任务条目"
                "(空清单或只有 verify 阶段 UT 任务不能证明实现完成)："
                "至少列出本单真实完成的生产代码任务并勾选后重试。",
                2,
            )
        ok, why = api.ev_tasks_checked({}, st)
        if not ok:
            api.die("verify-pass 前实现清单仍有未完成项:" + why, 2)
        data["verify_result"] = "pass"
        data["branch_status"] = "handled"
        data["verified_at"] = now
        data["phase"] = "archive"
        st.setdefault("history", []).append(
            {"step": st["current"], "result": "spec:verify-pass", "note": report, "at": now})
        api.save_state(st)
        print("[mae-flow] 规格符合性已通过:verify_result=pass,阶段 verify → archive。")
        return
    api.die("未知的 spec 动作: " + str(action), 2)

def cmd_allow(flow, st, args):
    """break-glass:为一次被误拦的动作签发单次放行令(用户裁决,强验真)。"""
    if st is None:
        api.die("流程未启用,gate 本来就不拦,无需放行令。", 2)
    bid = (args.block_id or "").strip()
    try:
        recent = (load_json(GATE_STRIKES_PATH) or {}).get("recent", {})
    except Exception:
        recent = {}
    rec = recent.get(bid)
    if not rec:
        listing = "\n".join(
            "  %s  %s  %s" % (k, v.get("rule", "?"), (v.get("sample", "") or "")[:60])
            for k, v in sorted(recent.items(), key=lambda kv: kv[1].get("at", ""),
                               reverse=True)[:5])
        api.die("未找到拦截编号 %s 的记录。最近的拦截:\n%s\n请使用报错里给出的编号,不要自行构造。"
            % (bid or "(空)", listing or "  (无)"), 2)
    if rec.get("step") != st.get("current"):
        api.die("拦截编号 %s 属于步骤 %s,当前步骤是 %s;放行令只能在拦截发生的步骤签发。"
            % (bid, rec.get("step", "?"), st.get("current", "?")), 2)
    ok, authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("放行令签发验真失败:" + why
            + "。必须先把动作原文和拦截原因展示给用户,取得用户明确同意的原话。", 2)
    head = api.sh("git rev-parse --verify HEAD")
    # 只查两条:这话是对这次动作说的(收据里有本次拦截编号)、且不是拒绝。
    # 原来还要在用户回答里逐字找齐动作涉及的每个路径——而回答是个短选项,
    # 装不下十几个路径,于是用户点了"允许"照样被判"扩大授权"。
    from mae_flow_core.workflow.consent import verdict
    passed, why = verdict(
        (authorization_receipt or {}).get("shown", ""), authorization, bid)
    if not passed:
        api.die(why, 2)
    action = {}
    if rec.get("rule") in _USER_GIT_AUTHORIZATION_RULES:
        modeled_action = api._git_authorization_action(
            rec.get("sample", ""), st, rec.get("rule", ""))
        if modeled_action is not None:
            action = api._git_authorization_record(modeled_action)

    def issue(data):
        data = data or {}
        data[bid] = {"rule": rec.get("rule", ""), "step": st.get("current", ""),
                     "head": head, "sample": rec.get("sample", ""),
                     "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                     "authorization": authorization_receipt,
                     "used": False}
        if action:
            data[bid]["git_action"] = action
        return data
    update_json(GATE_PERMITS_PATH, issue, default={}, recover_corrupt=True)
    st.setdefault("history", []).append({
        "step": st.get("current", ""), "result": "gate:allow-issued",
        "note": rec.get("rule", "") + " " + bid,
        "at": time.strftime("%Y-%m-%d %H:%M:%S")})
    api.save_state(st)
    print("[mae-flow] 已签发一次性放行令 %s(规则 %s):仅对该动作生效一次,"
          "绑定当前代码版本与步骤,用后即废、代码变化即废。请原样重试刚才被拦的那个动作。"
          % (bid, rec.get("rule", "")))

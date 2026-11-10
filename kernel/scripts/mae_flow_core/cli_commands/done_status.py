"""CLI responsibilities extracted from the historical entrypoint."""

from .shared import (
    STATE_PATH, WORKFLOW_LABELS, json, os, sys, time, workflow_completion,
    workflow_transitions,
)
from .wiring import api
from mae_flow_core.workflow.authority import (
    ADVISORY_EVIDENCE, PROMPT_ONLY_EVIDENCE, advisory_message,
)
from mae_flow_core.workflow.advisories import record_advisory


def _done_save_die(st, message):
    api.save_state(st)
    api.die(message, 2)

def _done_pending_config(step, st, args, sid):
    review = st.get("config_review") if sid == "config_confirm" else None
    if sid != "config_confirm" or api._moonlight(st):
        return api._validated_pending_config(step, st, args.set or [])
    if not isinstance(review, dict) or not isinstance(review.get("config"), dict):
        api.die(
            "尚未生成完整配置确认单。先按 current 输出执行 config-review --set ...；"
            "脚本会校验并展示全部配置，再让用户只做一次最终确认。"
            "不要直接拿基线分支、单号等局部回答调用 done。", 2)
    if args.set:
        pending_config = api._validated_pending_config(step, st, args.set)
    else:
        review_state = dict(st)
        review_state["config"] = dict(review.get("config") or {})
        pending_config = api._validated_pending_config(step, review_state, [])
    ok, why = api._config_ack_verified(
        st, args.ack or "")
    if not ok:
        api.die(why, 2)
    return pending_config


def _done_validate_choice_and_ack(step, st, args, sid):
    # 内容变化由 Agent 说明并遵循用户授权，不用文件指纹作废真实回答。
    error = workflow_completion.choice_error(step, args.choice)
    if error:
        api.die(error, 2)
    if (sid == "config_confirm" or api._moonlight(st)
            or not (step.get("user_ack") or step.get("confirmation_answers"))):
        return
    if (sid == "delivery_review"
            and (st.get("delivery_manifest") or {}).get("confirmed") is True):
        return  # Reuse the actual file-selection approval, not another question.
    if step.get("choice_key"):
        ok, why = api._choice_verified(step, st, args.choice)
    elif step.get("confirmation_answers"):
        ok, why = api._implicit_ack_verified(step, st)
    elif args.ack:
        ok, why = api._ack_verified(st, args.ack)
    else:
        ok, why = api._implicit_ack_verified(step, st)
    if not ok:
        api.die(why, 2)

def _done_commit_inputs(step, st, args, sid, pending_config):
    for key, value in workflow_completion.choice_config(step, args.choice).items():
        bad = api._validate_config_value(key, value)
        if bad:
            api.die(f"流程定义为选择 {args.choice} 配置的 {key}「{value}」不合法:{bad}。"
                "请维护人修正 flow.json，拒绝写入半套状态。", 2)
        pending_config[key] = value
    st["config"] = pending_config
    if sid == "config_confirm":
        st.pop("config_review", None)
        st.pop("branch_resolution", None)
    if step.get("choice_key"):
        st["choices"][step["choice_key"]] = args.choice

def _done_guard_branch(st, sid):
    if sid == "story":
        api._canonicalize_story_output(
            st.get("config", {}).get("单号", ""), st)
    want = st.get("config", {}).get("分支名", "")
    if sid not in (
            "config_confirm", "workflow_select", "branch_create") and want:
        cur = api.sh("git branch --show-current")
        if cur != want:
            _done_save_die(
                st, f"当前分支 {cur or '未知'} != 本单约定分支 {want}。先切回正确分支，禁止在别的分支推进。")

def _done_require_evidence(step, st, args, sid):
    required = dict(step)
    required["evidence"] = [spec for spec in step.get("evidence", ())
                            if spec.get("type") not in ADVISORY_EVIDENCE]
    for spec in step.get("evidence", ()):
        if (spec.get("type") not in ADVISORY_EVIDENCE
                or spec.get("type") in PROMPT_ONLY_EVIDENCE):
            continue
        try:
            findings = api.check_evidence({"evidence": [spec]}, st)
        except Exception as exc:
            findings = ["检查未完成: " + str(exc)]
        for finding in findings:
            text = advisory_message(finding)
            try:
                record_advisory(STATE_PATH, sid, "quality:" + spec["type"], text,
                                time.strftime("%Y-%m-%d %H:%M:%S"))
            except Exception as exc:
                print("提示记录未落盘（不影响推进）: " + str(exc))
            print(text)
    fails = api.check_evidence(required, st)
    if not fails:
        api._evidence_failure_count(sid, success=True)
        return
    api.save_state(st)
    count = api._evidence_failure_count(sid)
    target = (api._next_from_step(step, st, args.choice or "")
              if count >= 2 and not api._moonlight(st) else "")
    api.die(workflow_completion.evidence_error(
        fails, count, api._moonlight(st), target,
        os.path.abspath(sys.argv[0])), 2)


def _done_resolve_moonlight_branch(flow, st, sid):
    if sid == "branch_create" and api._resolve_moonlight_branch(flow, st):
        # A recorded hard blocker is a successful safe stop, not failed
        # evidence and not a workflow advance.
        raise SystemExit(0)


def _done_finalize(flow, st, args, sid, step):
    st.pop("approval_request", None)
    for event in workflow_completion.completion_events(
            sid, step, st, args.choice, args.ack or ""):
        if event.kind == "resolve_moonlight":
            api._moonlight_resolve_kind(st, event.value)
        elif event.kind == "localize_story":
            api._localize_story(event.value)
        elif event.kind == "advance":
            api.advance(flow, st, sid, step, "done", event.note)

def cmd_done(flow, st, args):
    sid = st["current"]
    step = flow["steps"][sid]
    if step.get("terminal"):
        api.die("流程已在终态。")
    if sid == "moonlight_review":
        api.die("月光宝盒已推送并等待早晨处理。请执行 moonlight report、moonlight repair 或 moonlight finalize，"
            "不能用 done 跳过报告闭环。", 2)
    args.choice = workflow_completion.resolve_choice(step, st, args.choice)
    pending_config = _done_pending_config(step, st, args, sid)
    _done_validate_choice_and_ack(step, st, args, sid)
    _done_commit_inputs(step, st, args, sid, pending_config)
    _done_guard_branch(st, sid)
    _done_resolve_moonlight_branch(flow, st, sid)
    api._done_prepare_external_verification(step, st, sid)
    _done_require_evidence(step, st, args, sid)
    _done_finalize(flow, st, args, sid, step)

def cmd_skip(flow, st, args):
    sid = st["current"]
    step = flow["steps"][sid]
    if not step.get("skippable"):
        api.die(f"步骤 {sid} 不可跳过。", 2)
    if not args.reason:
        api.die("skip 必须 --reason 说明理由(留痕)。", 2)
    if step.get("skip_requires_ack"):
        api.die("本步不能由 Agent 自行 skip；请走当前步骤的用户确认分支。", 2)
    kinds = sorted(_step_agent_kinds(step))
    if kinds:
        # 整步跳过会把本步**全部**检查一起扔掉;而 accept-risk 只放行拿不到的
        # 那一份证据,其余照查。实战撞过:UT 证据取不到,连试 6 次后用户被引到
        # 整步跳过——该步其他机器检查也一起没了,代价大得多。
        api.die(
            "别整步跳过:本步有更精确的出口。拿不到的只是 %s 的执行证据时,"
            "把实际跑过的结果摆给用户,取得同意后逐个执行 "
            "accept-risk %s --reason ... --message-id <ID>"
            "——它只放行这一份证据,本步其余检查照查。"
            "整步 skip 会把它们一起扔掉,只在确实整步都不适用时才用,"
            "且需要用户明确要求。" % ("、".join(kinds), kinds[0].lower()), 2)
    api.advance(flow, st, sid, step, "skipped", args.reason)

def _step_agent_kinds(step):
    kinds = set()
    for spec in step.get("evidence", []):
        if spec.get("type") == "agent_ran" and spec.get("agent"):
            kinds.add(str(spec["agent"]).upper())
    return kinds

def cmd_accept_risk(flow, st, args):
    """用户有意识地只放行当前步骤某个 Agent 令牌；不跳过同一步的其他机器证据。"""
    sid = st["current"]
    step = flow["steps"][sid]
    kind = args.agent.upper()
    required = _step_agent_kinds(step)
    # TIER_SCOPE 不是 Agent 令牌:它放行的是本步的档位范围硬校验(升级阈值),
    # 仅在挂了 tier_scope 证据的步骤可用。
    if kind == "TIER_SCOPE":
        if not any(e.get("type") == "tier_scope"
                   for e in step.get("evidence", [])):
            api.die(f"当前步骤 {sid} 没有档位范围校验,不需要 tier_scope 放行。", 2)
    elif kind not in required:
        api.die(f"当前步骤 {sid} 不需要 {kind} 令牌，不能预先或跨步骤放行。"
            + ("本步可放行: " + "、".join(sorted(required)) if required else "本步没有可风险放行的 Agent 令牌。"), 2)
    if not args.reason:
        api.die("accept-risk 必须 --reason 写清具体风险，不能只写『继续』。", 2)
    ok, _authorization, authorization_receipt, why = (
        api._authorization_message(st, args.message_id))
    if not ok:
        api.die("accept-risk 授权验真失败:" + why, 2)
    task = (st.get("agent_tasks", {}) or {}).get(kind, {})
    dirty = api._blocking_dirty_source_paths(st, flow)
    if dirty:
        api.die("风险确认必须绑定稳定代码版本，但仍有未提交源码/测试/构建文件: " + "、".join(dirty[:8])
            + "。先按本单规范提交，再向用户展示风险并重新确认。", 2)
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    inherited_dirty = api._unchanged_initial_dirty_source_paths(st, flow)
    rec = {"step": sid, "head": api.sh("git rev-parse --verify HEAD"), "at": now,
           "task_sha256": task.get("sha256", ""), "reason": args.reason,
           "authorization": authorization_receipt,
           "unchanged_initial_dirty": inherited_dirty}
    st.setdefault("risk_acceptances", {})[kind] = rec
    st.setdefault("history", []).append(
        {"step": sid, "result": "accept-risk:" + kind, "note": args.reason, "at": now})
    api.save_state(st)
    print(f"[mae-flow] 用户已确认承担 {kind} 令牌缺失风险；仅放行当前步骤 {sid}、当前代码版本。")
    print("风险: " + args.reason)
    if inherited_dirty:
        print("审计:以下流程启动前已脏文件指纹未变，不算本单变化: "
              + "、".join(inherited_dirty[:8]))
    print("其他机器证据不会跳过；源码/测试变化、任务卡变化或进入下一步后，"
          "本次放行自动失效。现在重新执行 done。")

def _workflow_chain(flow, wf):
    """按交付方式线性展开步骤链(可选询问步取"做"分支展示完整形态)。"""
    return workflow_transitions.workflow_chain(flow, wf)

def _steps_catalog(flow, st):
    """给宿主的机读目录:交付方式代号 + 选项原文 + 步骤链。

    存在的理由(2026-08-18 云端实战):宿主的下单表单要让人先选交付方式,
    它原来**自造了一套"快速/慢速车道"**——内核只认 完整开发/已定位问题
    修复/局部修改/处理评审意见,于是下单选过的答案在 workflow_select 那张
    卡上永远对不上,用户被重复问一遍。宿主随后改成直接读 flow/flow.json,
    对了,但那是在扒内核的内脏:文件布局一改宿主就哑。

    所以把它变成明面上的契约:分类归内核,宿主问一句就能拿到,拿到的
    `answer` 就是它该回传的选项原文。别处不要再有第二份交付方式清单。"""
    select = flow.get("steps", {}).get("workflow_select", {})
    # 新单可选集:review 仅限已交付单(步骤文档的禁令,这里机器可读)。
    # 字段缺席=全部可选,旧 flow 不炸。
    new_order = select.get("new_order_choices")
    return {
        "workflows": [
            {
                "key": wf,
                "label": WORKFLOW_LABELS[wf],
                "for_new_orders": (wf in new_order) if new_order else True,
                # 只说“什么情况选它”，不把步骤数、门禁数之类
                # 内部编排语言倒给下单的人。
                "description": str(
                    (select.get("choice_descriptions", {}) or {}).get(wf, "")
                ).strip(),
                # 选项原文:卡上就该出现它,done --choice 也按它对账
                "answers": list(
                    (flow.get("steps", {}).get("workflow_select", {})
                     .get("choice_answers", {}) or {}).get(wf, [])
                    or [WORKFLOW_LABELS[wf]]),
                "steps": [
                    {
                        "id": sid,
                        "title": flow["steps"][sid].get("title", ""),
                        "user_ack": bool(flow["steps"][sid].get("user_ack")),
                    }
                    for sid in _workflow_chain(flow, wf)
                ],
            }
            for wf in ("full", "hotfix", "tweak", "review")
        ],
        "active": (st.get("choices", {}) or {}).get("workflow") if st else None,
        "current": st.get("current") if st else None,
    }

def cmd_steps(flow, st, args):
    """工作流全景:每条交付方式背后的完整步骤链、每步卡什么、哪些环节可裁。

    透明化诉求:用户选档/裁剪前先看得见全貌;质量门禁步骤不在可裁白名单。
    --json 是给宿主(云端下单表单)的机读形态,见 _steps_catalog。"""
    if getattr(args, "json", False):
        print(json.dumps(_steps_catalog(flow, st), ensure_ascii=False))
        return
    current = st.get("current") if st else None
    active_wf = (st.get("choices", {}) or {}).get("workflow") if st else None
    ask_labels = {
        "grill_ask": "需求质询", "grill": "需求质询",
        "story_ask": "STORY", "story": "STORY",
    }
    for wf in ("full", "hotfix", "tweak", "review"):
        marker = "(本单)" if wf == active_wf else ""
        print("\n═══ %s(%s)%s ═══" % (WORKFLOW_LABELS[wf], wf, marker))
        for sid in _workflow_chain(flow, wf):
            step = flow["steps"][sid]
            tags = []
            if sid in ("grill_ask", "story_ask"):
                tags.append("可选环节:%s(流程内询问决定)" % ask_labels[sid])
            elif sid in ("grill", "story"):
                tags.append("随「%s」询问可选" % ask_labels[sid])
            if step.get("user_ack"):
                tags.append("用户确认")
            evidence = sorted({e.get("type", "?")
                               for e in step.get("evidence", [])})
            here = "▶" if (wf == active_wf and sid == current) else " "
            print(" %s %-28s %s%s" % (
                here, sid + " " + step.get("title", ""),
                ("[" + "、".join(tags) + "] ") if tags else "",
                ("证据:" + ",".join(evidence)) if evidence else "(无硬证据)"))
    print("\n可选环节(独立 CODE Reviewer/需求质询/STORY)由流程内询问逐单决定;其余步骤为流程完整性"
          "的一部分,不提供配置级裁剪。")

def cmd_status(flow, st, args):
    sid = st["current"]
    step = flow["steps"][sid]
    if args.inject:
        cfg = st.get("config", {})
        parts = []
        if cfg.get("单号"):
            parts.append(f"单号 {cfg['单号']},commit 格式 [{cfg['单号']}][{cfg.get('单号类型', 'feat|fix')}]描述")
        if cfg.get("分支名"):
            parts.append("分支 " + cfg["分支名"])
        if cfg.get("CHANGE_NAME"):
            parts.append("change " + cfg["CHANGE_NAME"])
        if api._moonlight(st):
            parts.append("月光宝盒=无人值守;禁止向用户提问;质量失败尽力修复后用 moonlight defer 留痕继续")
        ctx = (";" + ";".join(parts)) if parts else ""
        me = os.path.abspath(sys.argv[0])
        print(f"[mae-flow 状态] 当前步骤: {sid}({step['title']}){ctx};{api.perms_line(step)}。"
              f"执行 python3 \"{me}\" current 获取指令(勿搜索脚本位置,以此路径为准),"
              f"禁止做当前步骤之外的流程动作。"
              f"(用户与流程无关的问答/阅读/分析不受此限,照常回应;但无关的源码改动应引导用户开 worktree,勿混入交付分支)")
        return
    print(json.dumps(st, ensure_ascii=False, indent=2))

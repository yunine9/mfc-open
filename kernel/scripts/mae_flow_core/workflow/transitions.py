"""Pure transition policy for Mae-Flow workflow definitions."""


def _state_value(state, dotted_path):
    value = state
    for part in str(dotted_path or "").split("."):
        if not part or not isinstance(value, dict):
            return None
        value = value.get(part)
    return value if isinstance(value, str) and value else None


def transition_targets(step):
    targets = []

    def append(target, declared=False):
        if (declared or target is not None) and target not in targets:
            targets.append(target)

    nxt = step.get("next")
    if isinstance(nxt, dict):
        for target in nxt.values():
            append(target, declared=True)
    elif nxt:
        append(nxt)
    dynamic = step.get("dynamic_next")
    if isinstance(dynamic, (list, tuple)):
        for target in dynamic:
            append(target, declared=True)
    elif "dynamic_next" in step:
        append(dynamic, declared=True)
    return tuple(targets)


def next_step(step, state, choice_override=""):
    if step.get("next_from_state"):
        return _state_value(state, step["next_from_state"])
    nxt = step.get("next")
    try:
        if step.get("next_by"):
            # 选择项缺失时走明写的默认分支。没有兜底的话,这一步就"缺少可解析
            # 的下一步"——done 拒绝推进,current 又不给恢复办法,流程当场活锁
            # (实测:月光宝盒跑到 build,code_reviewer 从未被写进配置,卡死 38 轮)。
            picked = state.get("choices", {}).get(step["next_by"])
            if picked is None and step.get("next_default"):
                picked = step["next_default"]
            return nxt[picked]
        if isinstance(nxt, dict):
            choice = (
                choice_override
                or state.get("choices", {}).get(step.get("choice_key"))
            )
            return nxt[choice]
    except Exception:
        return None
    return nxt


def resolved_next(flow, state, step_id):
    step = flow.get("steps", {}).get(step_id, {})
    return next_step(step, state)


def workflow_chain(flow, workflow):
    """某条交付方式的完整步骤链(展示用:可选环节一律取"做"的那支)。

    非 workflow 的分叉(如历史上的 code_reviewer)按 next_default 取,
    与"取完整形态"一致;2026-08-25 编排瘦身后主链已无此类分叉,守则保留。
    """
    chain = []
    step_id = flow["start"]
    seen = set()
    while step_id and step_id not in seen:
        seen.add(step_id)
        chain.append(step_id)
        step = flow["steps"][step_id]
        nxt = step.get("next")
        if isinstance(nxt, dict):
            key = step.get("next_by")
            if key == "workflow":
                nxt = nxt.get(workflow)
            elif key:
                nxt = nxt.get(step.get("next_default"))
            else:
                nxt = nxt.get("yes") or next(iter(nxt.values()))
        step_id = nxt
    return chain


def workflow_cost(flow, workflow):
    """选交付方式时该看见的代价:多少步、要用户拍板几次、哪些环节与别条路不同。

    数字一律从 flow 现算,不许在任何地方手写一份——流程一改,手写的说明
    就开始骗人,而这段话恰恰是用户据以选档的唯一依据。

    `unique` 报的是"不是四条路都有的环节",不是"比 full 少了什么":后者
    会把 tweak 的 `小改—规范检查/单元测试/对照需求检查` 算成"省掉了验证
    1/4~4/4",等于告诉用户选轻的就免检——四条道的验证一步都不能免,轻的
    只是换成了更小的形态。这个误导比不显示还糟。
    """
    chains = {wf: workflow_chain(flow, wf)
              for wf in ("full", "hotfix", "tweak", "review")}
    chain = chains.get(workflow) or workflow_chain(flow, workflow)
    common = set(chains["full"])
    for other in chains.values():
        common &= set(other)
    steps = flow["steps"]
    acks = [sid for sid in chain if steps[sid].get("user_ack")]
    unique = [steps[sid].get("title", sid)
              for sid in chain if sid not in common]
    return {"steps": len(chain), "acks": len(acks), "unique": unique}

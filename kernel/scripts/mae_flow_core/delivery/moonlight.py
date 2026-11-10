"""Pure policy helpers for Moonlight delivery closure."""


def issue_id(existing_count):
    return "ML-%03d" % (existing_count + 1)


def finalize_target(state):
    del state
    return "domain_archive"


def repeat_count(issues, step, reason):
    """这一步、这个原因,连同本次一共登记过几回。

    实测:月光在 branch_create 上一字不差地登记了 7 次。每次都把上一条标成
    superseded,记录上看不出在重复;模型收不到"别再试了"的信号,就一直重试。
    """
    said = str(reason or "").strip()
    return 1 + sum(
        1 for old in (issues or ())
        if old.get("step") == step and str(old.get("reason", "")).strip() == said
    )


def step_block_count(issues, step):
    """这一步一共登记过几条阻塞——不看原因怎么写。

    实测:模型在 quality_commit 上连登 5 条,每条措辞都不同,按原文比对
    识别不出重复。而事实是它每次提交完又改了源码,"文件未提交"每次都
    属实;它却反过来断定系统清单坏了。同一步反复登记,先怀疑自己的现场。
    """
    return 1 + sum(1 for old in (issues or ()) if old.get("step") == step)


BLOCK_SAVED = ("[mae-flow] 月光宝盒已记录无法自动解决的硬阻塞并保存现场。"
               "本轮允许正常停止；早晨执行 moonlight report 查看，"
               "条件补齐后执行 moonlight repair 继续当前步骤。")


def block_notice(repeats, at_step=1):
    if repeats < 2 and at_step >= 3:
        return BLOCK_SAVED + (
            "\n[mae-flow] ⚠ 本步已登记 %d 条阻塞,每条原因还不一样——多半是你"
            "自己在改动之后又改动。先跑 status 看清现场再判断,别把自己的改动"
            "当成系统故障。" % at_step)
    if repeats < 2:
        return BLOCK_SAVED
    return BLOCK_SAVED + (
        "\n[mae-flow] ⚠ 本步同一原因已登记 %d 次——换个说法再试也不会有不同"
        "结果。停止重试本步,直接结束回复等人工处理;重复登记只会把晨间报告"
        "刷满。" % repeats)


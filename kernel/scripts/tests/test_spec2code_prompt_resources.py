#!/usr/bin/env python3
"""Story-centered prompts and retained coding roles."""

import io
import os
import re
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as stream:
        return stream.read()


def _read_reserved_packs():
    """runtime/guidance/capability-preservation.json 里显式登记的保留待用包。"""
    import json
    path = os.path.join(
        ROOT, "runtime", "guidance", "capability-preservation.json")
    with open(path, encoding="utf-8") as stream:
        data = json.load(stream)
    # 如实登记:这些包的来源子系统已退役,或其实质已手工融入其他载体。
    # 每个都必须写明理由——空理由等于没交代。
    dormant = data.get("dormant_capability_packs") or {}
    assert all(str(reason).strip() for reason in dormant.values()), dormant
    return set(dormant)


class Spec2CodePromptResourceTests(unittest.TestCase):
    def test_checkpoint_runtime_and_cp_agent_are_removed(self):
        removed = (
            "flow/steps/build_pace.md",
            "flow/steps/tw_pace.md",
            "flow/steps/rf_pace.md",
            "agents/cp-implementer-agent.md",
            "scripts/mae_flow_core/cli_commands/checkpoint_commands.py",
            "scripts/mae_flow_core/cli_commands/checkpoint_facts.py",
            "scripts/mae_flow_core/cli_commands/checkpoint_plan.py",
            "scripts/mae_flow_core/delivery/checkpoints.py",
            "scripts/mae_flow_core/application/delivery/checkpoints.py",
            "scripts/mae_flow_core/application/delivery/checkpoint_status.py",
            "scripts/mae_flow_core/application/delivery/checkpoint_recovery.py",
            "scripts/mae_flow_core/application/delivery/checkpoint_quality.py",
            "scripts/mae_flow_core/application/delivery/checkpoint_decisions.py",
            "scripts/mae_flow_core/application/delivery/checkpoint_ready_recovery.py",
            "scripts/mae_flow_core/application/delivery/checkpoint_final.py",
        )
        self.assertEqual([], [
            path for path in removed
            if os.path.exists(os.path.join(ROOT, path))
        ])

    def test_code_taste_baseline_exists_and_has_consumers(self):
        """标准文件必须有生产消费者——comment-standard 曾无人引用地躺了一个月。"""
        taste = read("runtime/standards/code-taste-v1.md")
        for marker in ("顺应优先于自包含", "按概念拆", "投机的灵活性",
                       "目标状态", "不是门禁", "改动收口", "最小改动面",
                       "每条离开路径", "依赖方向", "编译通过 ≠ 适配完整",
                       "复用靠调用，不靠粘贴", "副作用会随复制翻倍",
                       "散弹式修改", "不顺手重构"):
            self.assertIn(marker, taste)
        # 完整性收口必须三处闭环:写码纪律、基准、reviewer 独立核对
        self.assertIn("改动收口", read("flow/steps/build.md"))
        self.assertIn(
            "独立 grep", read("agents/craft-reviewer-agent.md"))
        self.assertIn(
            "非编译文件", read("agents/craft-reviewer-agent.md"))
        self.assertIn(
            "副作用随复制翻倍", read("agents/craft-reviewer-agent.md"))
        build = read("flow/steps/build.md")
        self.assertIn("standards/code-taste-v1.md", build)
        self.assertIn("comment-standard-v1.md", build)
        self.assertIn("四项自查", build)
        reviewer = read("agents/craft-reviewer-agent.md")
        self.assertIn("code-taste-v1.md", reviewer)
        self.assertIn("品味问题与正确性问题同级", reviewer)
        # 报告纪律:工具能管的不占名额;硬违规按事实陈述,判断题接受仓内既有做法反驳
        self.assertIn("工具已经在管的不写进来", reviewer)
        self.assertIn("区分硬违规与判断题", reviewer)
        self.assertIn("仓内既有形态胜过基准", reviewer)
        construction = read("runtime/guidance/construction.md")
        self.assertIn("code-taste-v1.md", construction)
        # 物化清单里必须有,否则项目本地路径是死链接
        runtime_source = read("scripts/mae_flow_core/cli_runtime.py")
        self.assertIn("standards/code-taste-v1.md", runtime_source)
        self.assertIn("standards/comment-standard-v1.md", runtime_source)

    def test_build_chunk_discipline_is_in_context_only(self):
        """分块是同一上下文内的纪律,不得回退成流程批次(那是 CP 被退掉的原因)。"""
        build = read("flow/steps/build.md")
        self.assertIn("分块纪律", build)
        self.assertIn("implementation.md", build)
        self.assertIn("不 done、不询问用户", build)
        self.assertIn("跨块漂移", build)
        # 反回退:仍然是一步、无批次文档
        self.assertIn("一次完成需求涉及的全部生产代码", build)
        self.assertIn("不要拆开发批次", build)
        # 子 Agent 边界(主会话模式):设计不外包;只读侦察与机械扇出是仅有的
        # 两类合法用法,且扇出产出不免检。
        # 2026-08-09 语义修订:L3 插槽启用后,"写码由子 Agent 做"不再等于
        # "实现整体外包"——外包的是打字,拆分决策、接口定稿、逐份验收、
        # 编译与人工检视全部留在主 Agent。真正的红线重定义为:
        # **连拆单与验收也丢掉**才是整体外包,那永远禁止。
        self.assertIn("设计承载的代码不外包", build)
        self.assertIn("只读侦察", build)
        self.assertIn("机械扇出", build)
        self.assertIn("不免检", build)
        self.assertIn("已亲写第一个完整样例", build)
        # 工单携带上下文而不是指向上下文——子 Agent 重建上下文正是 CP 被退掉的主因
        self.assertIn("自包含", build)
        self.assertIn("不要读 spec/story/领域文档", build)

    def test_superpowers_plan_substance_lives_in_implementation_appendix(self):
        """writing-plans 的真东西进实施附录:文件结构、任务边界、接口契约、定稿自查。

        整段注入 pack 会把 CP 时代的 TDD 微步与逐任务提交一起带回来——那正是被退掉的。
        """
        template = read("skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md")
        for marker in ("文件结构与任务边界", "独立否决其中一个任务而批准它的邻居",
                       "接口契约两栏", "消费", "产出",
                       "定稿自查", "占位符扫描", "类型与命名一致",
                       # codebase-design:深模块三判据落在设计时,而非写码时
                       "删除测试", "一个实现是假接缝，两个实现才是真接缝",
                       "接口就是测试面"):
            self.assertIn(marker, template)

    def test_build_anchors_attention_to_confirmed_documents(self):
        """L1 注意力锚定(业界 recitation 同族):长会话尾部写码,记忆里混着
        被否掉的方案——编码依据只认用户确认过的文档,不认会话记忆。
        纯内部指令,用户无感;/compact 类有感提示经业界调研后永久不做。"""
        build = read("flow/steps/build.md")
        self.assertIn("注意力锚定", build)
        self.assertIn("不天然比更新的原话更权威", build)
        self.assertIn("decisions.md", build)
        self.assertIn("owner-inputs.json", build)
        self.assertIn("不新增语义硬门禁", build)
        self.assertNotIn("/compact", build)

    def test_fresh_context_mode_is_dispatched_by_current(self):
        """插槽必须真接线:预设开启后 current 打印的 build 指令首段就要改口径,
        埋在文末等于没说(弱模型读长文档首段权重最高)。默认零变化。"""
        import os as _os, tempfile, shutil, sys as _sys
        _sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import mae_flow_core.cli_runtime  # noqa: F401  装配 api
        from mae_flow_core.cli_commands import current as current_cmd
        room = tempfile.mkdtemp(prefix="l3-slot-")
        self.addCleanup(shutil.rmtree, room, True)
        before = _os.getcwd()
        _os.chdir(room)
        try:
            plain = current_cmd._apply_build_execution_mode("build", "原文")
            self.assertEqual("原文", plain)          # 无预设:零变化
            with open(".mae-flow-defaults.json", "w", encoding="utf-8") as fh:
                fh.write('{"编码执行方式": "新上下文"}')
            switched = current_cmd._apply_build_execution_mode("build", "原文")
            self.assertTrue(switched.startswith("【本仓预设"))
            self.assertIn("不写生产代码", switched)
            self.assertIn("build-fresh-context.md", switched)
            self.assertIn("门禁与证据一个都不变", switched)
            self.assertIn("工单喂到嘴边,不给路径", switched)
            self.assertIn("不通读代码库", switched)
            self.assertTrue(switched.endswith("原文"))
            # 只改 build 步,别的步骤一个字不动
            self.assertEqual("原文", current_cmd._apply_build_execution_mode(
                "verify_ut", "原文"))
        finally:
            _os.chdir(before)

    def test_fresh_context_build_is_a_config_slot_with_unchanged_gates(self):
        """L3:编码挪进新鲜上下文——唯一真正减 token 的杠杆(主会话大头是
        Write 整文件内容,插件剪不动)。插槽纪律:默认主会话零行为变化;
        开启也不动任何门禁与证据;工单必须自包含,产出不免检。"""
        build = read("flow/steps/build.md")
        self.assertIn("编码执行方式", build)
        self.assertIn("build-fresh-context.md", build)
        self.assertIn("门禁与证据完全相同", build)
        guidance = read("runtime/guidance/build-fresh-context.md")
        self.assertIn("不回放聊天记录", guidance)
        # 新鲜上下文是本模式唯一的资产:让子 Agent 自己读文档=当场挥霍掉
        # (用户实战担忧,与派发三原则第一条"喂到嘴边"同源)
        self.assertIn("喂到嘴边,不给路径", guidance)
        self.assertIn("携带原文摘录", guidance)
        self.assertIn("禁止", guidance)
        self.assertIn("通读代码库", guidance)
        self.assertIn("唯一允许打开的代码", guidance)
        self.assertIn("NEEDS_INPUT", guidance)
        self.assertIn("产出不免检", guidance)
        self.assertIn("工单写不成自包含", guidance)
        self.assertIn("门禁与证据一个都不变", guidance)

    def test_build_stops_instead_of_guessing_when_blocked(self):
        build = read("flow/steps/build.md")
        self.assertIn("卡住就停，不要猜", build)
        self.assertIn("不做试探性修改", build)

    def test_review_reception_discipline_survives_in_guidance(self):
        """检视接收纪律不随 rework 步骤退役:guidance/review.md 保留完整口径,
        build.md 指向它(2026-08-25 编排瘦身)。"""
        guidance = read("runtime/guidance/review.md")
        self.assertIn("reject an unsupported finding with technical evidence",
                      guidance)
        self.assertIn("root cause", guidance)
        build = read("flow/steps/build.md")
        self.assertIn("guidance/review.md", build)

    def test_every_capability_pack_is_injected_by_some_step(self):
        """有资产无人读:pack 定义完整、vendor 完整,但没有步骤 {{...}} 它。

        comment-standard 与 8 个 pack 都栽在这上面。定义即须消费，或显式登记待用。
        """
        import re
        import sys as _sys
        scripts = os.path.join(ROOT, "scripts")
        if scripts not in _sys.path:
            _sys.path.insert(0, scripts)
        from mae_flow_core.capability_shared import CAPABILITY_PACKS

        steps_dir = os.path.join(ROOT, "flow", "steps")
        injected = set()
        for name in os.listdir(steps_dir):
            if not name.endswith(".md"):
                continue
            with open(os.path.join(steps_dir, name), encoding="utf-8") as fh:
                injected.update(
                    re.findall(r"CAPABILITY_PACK:([a-z0-9-]+)", fh.read()))
        reserved = _read_reserved_packs()
        orphans = sorted(set(CAPABILITY_PACKS) - injected - reserved)
        self.assertEqual(
            [], orphans,
            "这些能力包没有任何步骤注入,也没在 capability-preservation.json 的 "
            "dormant_capability_packs 里登记理由——等于白带 vendor")
        self.assertEqual(
            [], sorted(injected - set(CAPABILITY_PACKS)),
            "步骤注入了不存在的能力包")

    def test_every_guidance_file_is_pointed_at_by_some_step(self):
        """有资产无人读第四例:五份 guidance 全物化到项目里,却没有任何步骤指向它们。

        capability pack 栽过同一个坑。渐进披露只在指针存在时才成立——没有指针的
        参考文件既不省上下文也不被读到,纯粹白带。
        """
        import re

        guidance_dir = os.path.join(ROOT, "runtime", "guidance")
        have = {
            name[: -len(".md")]
            for name in os.listdir(guidance_dir) if name.endswith(".md")
        }
        steps_dir = os.path.join(ROOT, "flow", "steps")
        pointed = set()
        for name in os.listdir(steps_dir):
            if not name.endswith(".md"):
                continue
            with open(os.path.join(steps_dir, name), encoding="utf-8") as fh:
                pointed.update(
                    re.findall(r"guidance/([a-z-]+)\.md", fh.read()))
        self.assertEqual(
            set(), have - pointed,
            "这些 guidance 没有任何步骤指向,渐进披露不成立")
        self.assertEqual(
            set(), pointed - have, "步骤指向了不存在的 guidance")

    def test_comment_standard_is_single_versioned_source(self):
        text = read("runtime/standards/comment-standard-v1.md")
        self.assertIn("新增业务注释统一使用简体中文", text)
        self.assertIn("TODO(<问题单>)", text)
        self.assertIn("单行不超过 120 列", text)
        self.assertIn("逐行翻译代码", text)

    def test_story_and_implementation_companion_replace_heavy_plans(self):
        text = read("agents/story-generator-agent.md")
        self.assertIn("测试设计", text)
        self.assertIn("implementation.md", text)
        self.assertIn("不生成额外的编码前计划过程件", text)
        self.assertFalse(os.path.exists(os.path.join(
            ROOT, "agents", "test-design-agent.md")))
        self.assertFalse(os.path.exists(os.path.join(
            ROOT, "agents", "cp-task-analyst-agent.md")))

    def test_craft_reviewer_is_read_only_and_bounded(self):
        text = read("agents/craft-reviewer-agent.md")
        self.assertIn("每轮最多五条", text)
        self.assertIn("禁止修改源码", text)
        for field in ("位置", "依据", "证据", "实际影响", "最小改法"):
            self.assertIn(field, text)
        self.assertNotIn("TASK_CARD_SHA256", text)

    def test_main_agent_implements_without_implementation_subagent(self):
        self.assertFalse(os.path.exists(os.path.join(
            ROOT, "agents", "implementer-agent.md")))
        build = read("flow/steps/build.md")
        self.assertIn("主 Agent", build)
        self.assertIn("设计承载的代码不外包", build)

    def test_ut_generator_retains_behavior_driven_execution(self):
        text = read("agents/ut-generator-agent.md")
        self.assertIn("禁止重新发明测试场景", text)

    def test_build_prompt_is_one_whole_change(self):
        build = read("flow/steps/build.md")
        self.assertIn("spec.md", build)
        self.assertIn("story.md", build)
        self.assertNotIn("CP", build)
        # 编排退役后不得再指向已删除的任务卡命令
        self.assertNotIn("agent-task", build)

    def test_compile_risk_recovery_has_no_retired_cp_or_commit_first_hint(self):
        text = read("scripts/mae_flow_core/cli_commands/done_status.py")
        self.assertNotIn("分段编译风险确认", text)
        self.assertNotIn("精确提交当前修复，再执行 done", text)
        self.assertNotIn("agent-task compile", text)

    def test_live_operator_docs_have_no_checkpoint_or_story_commit_protocol(self):
        operator_docs = "\n".join(read(path) for path in (
            "README.md", "MAINTAINERS.md", "FIELD-TEST.md",
            "commands/mae-flow.md", "skills/mae-flow/SKILL.md",
        ))
        for retired in (
                "Staged", "Continuous", "development_review",
                "development_checkpoints", "CP 编号", "每个 CP",
                "CP1", "CP2", "STORY入库",
                "tasks 全部完成", "实现 tasks"):
            with self.subTest(retired=retired):
                self.assertNotIn(retired, operator_docs)

        command = read("commands/mae-flow.md")
        # 第一动作必须是启动流程:只说"不要自由发挥"留下了开局空档,
        # 实战里模型据此自行派只读侦察、先出方案,与流程意图完全相反。
        self.assertIn("第一个动作固定是启动流程本身", command)
        self.assertIn("禁止先做架构调研", command)
        self.assertIn("只读/计划模式", command)
        self.assertNotIn("docs/story/STORY-", command)
        self.assertNotIn("用户选择入库", command)
        self.assertNotIn("由你决定是否入库", read("README.md"))
        self.assertNotIn("只给 ASKUSER 令牌", read("MAINTAINERS.md"))


if __name__ == "__main__":
    unittest.main()


class CodeReviewTwoAxisTests(unittest.TestCase):
    """CODE 预检拆成两个互不参考的视角,三处必须同时说得住。

    一个 Agent 同时拿着 Spec、Story 和代码规范时,注意力会全部流向业务正确性,
    命名、重复实现、资源收口这类工程问题就漏了;反过来只盯规范的也发现不了需求做错。
    卡模板、步骤提示、Agent 定义三处必须一致,否则又变成"卡里拆了、提示没拆"。
    """


    def test_reviewer_agent_executes_exactly_one_axis(self):
        reviewer = read("agents/craft-reviewer-agent.md")
        self.assertIn("你只执行自己卡上写明的那一个", reviewer)
        self.assertIn("故意不给", reviewer)
        self.assertIn("两个视角互不参考", reviewer)

    def test_card_template_refuses_a_default_axis(self):
        template = read(
            "scripts/mae_flow_core/application/quality/role_task_documents.py")
        self.assertIn("必须指定视角", template)
        self.assertIn('CODE_REVIEW_AXES = ("standards", "spec")', template)


class AssumptionAndDeadCodeBoundaryTests(unittest.TestCase):
    """两条 Karpathy 原则落地后,四处口径必须一致,否则互相打脸。

    「路过的旧死代码不要动」如果只写进 build 而不改 reviewer,reviewer 会照着
    「失效旧代码是否删净」去报 builder 被要求不许动的东西——提示词自己打自己。
    """

    def test_small_ambiguity_is_surfaced_not_silently_resolved(self):
        build = read("flow/steps/build.md")
        self.assertIn("小歧义:选一个,把假设写出来", build)
        self.assertIn("默默挑一个", build)
        # 与"卡住就停"并列存在:根本缺口停下,小歧义带假设继续
        self.assertIn("卡住就停，不要猜", build)

    def test_pre_existing_dead_code_is_reported_not_deleted(self):
        build = read("flow/steps/build.md")
        taste = read("runtime/standards/code-taste-v1.md")
        reviewer = read("agents/craft-reviewer-agent.md")
        standards_brief = read(
            "scripts/mae_flow_core/application/quality/role_task_documents.py")
        self.assertIn("不是本次弄死的旧死代码点个位置", build)
        self.assertIn("只删自己弄死的", taste)
        # reviewer 两处口径都要跟上,否则它会去报 builder 被禁止动的东西
        self.assertIn("不是本次弄死的**旧死代码不算问题", reviewer)
        self.assertIn("本次改动弄死的旧代码是否删净", reviewer)
        self.assertIn("本次改动弄死的旧代码是否删净", standards_brief)
        self.assertIn("不是本次弄死的旧死代码不算问题", standards_brief)


class RiskTriggeredDimensionCheckTests(unittest.TestCase):
    """量纲检查是风险触发型,不是固定阶段。

    Hz/kHz/MHz、RB、时隙、逻辑与物理索引在代码里几乎全是整型,类型系统看不见单位,
    编译器也就看不见错——是"能编译、逻辑错"的主要产地。但绝大多数交付不碰这些,
    所以只在改动行命中时才往卡里追加检查段:不命中一个字都不加。
    """

    def card(self, diff, axis="standards"):
        from mae_flow_core.application.quality.role_task_documents import (
            RoleTaskContext, build_role_task_document)
        return "\n".join(build_role_task_document(
            role="code-review", project_root="/r", ticket="REQ-1",
            stage=axis, context=RoleTaskContext(diff=diff)))

    def test_section_only_appears_when_changed_lines_hit(self):
        plain = self.card("+    userName = request.getName();\n")
        unitful = self.card("+    freqKhz = narfcn * 5;\n")
        self.assertNotIn("量纲检查", plain)
        self.assertIn("量纲检查", unitful)
        self.assertIn("逻辑索引 vs 物理索引", unitful)
        # 只有 standards 轴带这一段;spec 轴不掺工程细节
        self.assertNotIn(
            "量纲检查", self.card("+ freqKhz = narfcn * 5;\n", axis="spec"))

    def test_trigger_reads_changed_lines_only(self):
        from mae_flow_core.application.quality.role_task_documents import (
            dimension_check_applies)
        self.assertFalse(dimension_check_applies(" int freq = 100;\n"))
        self.assertFalse(
            dimension_check_applies("+++ b/freq.c\n--- a/freq.c\n"))
        self.assertTrue(dimension_check_applies("+  slotIndex = 1;\n"))
        self.assertTrue(dimension_check_applies("-  subFrameNo = 0;\n"))


class ReviewDispositionLabelTests(unittest.TestCase):
    """检视目标是降低风险,不是追求完美——只有 BLOCKER 挡住推进。"""

    def test_three_labels_are_defined_and_only_blocker_gates(self):
        reviewer = read("agents/craft-reviewer-agent.md")
        card = read(
            "scripts/mae_flow_core/application/quality/role_task_documents.py")
        for text in (reviewer, card):
            self.assertIn("BLOCKER", text)
            self.assertIn("WARNING", text)
            self.assertIn("NOTE", text)
        self.assertIn("只有这一级需要在人工检视前修掉", reviewer)
        self.assertIn("拿不准就往低一级标", reviewer)


class ContextAndUncertaintyOrderTests(unittest.TestCase):
    def test_survey_carries_the_four_facts_build_keeps_needing(self):
        grill = read("flow/steps/grill.md")
        for marker in ("仓内同类实现的位置", "本模块的错误处理惯例",
                       "必须保持不变的存量行为", "已知历史坑"):
            self.assertIn(marker, grill)

    def test_riskiest_chunk_goes_first(self):
        self.assertIn(
            "最不确定、风险最高的块提前", read("flow/steps/build.md"))

    def test_incidental_old_code_cleanup_stays_outside_requested_change(self):
        build = read("flow/steps/build.md")
        self.assertIn("不是本次弄死的旧死代码", build)
        self.assertIn("diff 里不出现", build)

    def test_spec_alignment_is_a_per_item_matrix(self):
        verify = read("flow/steps/build.md")
        self.assertIn("逐条验收项", verify)
        self.assertIn("验收项", verify)
        self.assertIn("实现位置", verify)
        # demand:指不到实现的只能记缺失,不许用"整体看起来实现了"糊过去
        self.assertIn('只能算"缺失"', verify)

    def test_confused_caller_lens_is_in_the_interface_contract(self):
        template = read("skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md")
        self.assertIn("困惑的调用方", template)
        self.assertIn("参数调换了会不会照样编译通过", template)


class UserVisibilityDisciplineTests(unittest.TestCase):
    """实战发现:工具 stdout 在宿主界面里折叠,模型以为"已展示"而用户全程没看见。

    两个症状同根:确认卡不带配置内容、检视文档只给摘要不给路径。
    修法 = 转述义务写进权威处(config-review 输出)+ 通用纪律进 SKILL。
    """

    def test_moonlight_report_demands_restating_leftovers(self):
        """无人值守是转述断链的最坏场景:用户一整夜不在场,报告是唯一现场。
        只报"夜间已完成"不列遗留,等于替用户签收风险(横向排查补钉)。"""
        source = read("scripts/mae_flow_core/cli_commands/moonlight_commands.py")
        self.assertIn("逐条复制进你的回复正文", source)
        self.assertIn("等于替用户签收了风险", source)

    def test_config_review_output_demands_restating_in_reply(self):
        source = read("scripts/mae_flow_core/cli_commands/advancement.py")
        self.assertIn("逐项复制进你的回复正文", source)
        self.assertIn("用户看不见工具输出", source)
        self.assertIn("逐项复制进你的回复正文",
                      read("flow/steps/config_confirm.md"))

    def test_skill_carries_the_general_relay_rule(self):
        skill = read("skills/mae-flow/SKILL.md")
        self.assertIn("文件完整路径", skill)
        self.assertIn("工具输出用户看不见", skill)


class ReviewCarriesTheRulesTests(unittest.TestCase):
    """让人判"合不合规",就得把规矩一起给它。"""

    def test_story_review_card_carries_both_templates(self):
        import io as _io
        with _io.open(os.path.join(ROOT, "scripts", "mae_flow_core",
                                   "cli_commands", "role_task.py"),
                      encoding="utf-8") as stream:
            source = stream.read()
        block = source.split('elif role == "story-review":')[1][:600]
        self.assertIn("STORY-TEMPLATE.md", block)
        self.assertIn("IMPLEMENTATION-TEMPLATE.md", block)

    def test_appendix_rules_live_in_one_place_only(self):
        """同一件事在两处规定,迟早互相打架:步骤文档说"不得出现代码块",
        模板说"只写签名"——签名算不算代码块,模型只能自己猜。"""
        story = read("flow/steps/story.md")
        self.assertNotIn("不得出现代码块", story)
        self.assertIn("IMPLEMENTATION-TEMPLATE.md", story)
        template = read("skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md")
        self.assertIn("只写签名不写实现", template)

    def test_waiting_on_a_background_agent_is_not_a_user_decision(self):
        """实战:子 Agent 在后台跑,模型不敢空手结束回复,于是发了个
        "占位问题（请忽略此问）"——白打扰用户一次。规则读到了,
        但规则没覆盖这个处境。"""
        grill = read("flow/steps/grill.md")
        self.assertIn("直接结束回复等它", grill)
        self.assertIn("不要用占位问题", grill)
        skill = read("skills/mae-flow/SKILL.md")
        self.assertIn("等待不是决策", skill)
        self.assertIn("占位问题", skill)


class NoSideQuestsInVerifyTests(unittest.TestCase):
    """实战:模型在 CodeCheck 步顺手删了个没用的参数,首检随即失效,
    门禁反复拦 done,来回几轮后它自己回退了 5 个文件才脱身。

    两个毛病各修各的:步骤文档里那句"重构在此定稿"像是在邀请顺手改;
    门禁只说"不许"不说出路,模型只能试错。"""


    def test_block_message_offers_a_way_out(self):
        import io as _io
        with _io.open(os.path.join(ROOT, "scripts", "mae_flow_core",
                                   "quality", "evidence.py"),
                      encoding="utf-8") as stream:
            source = stream.read()
        self.assertIn("要么回退这些改动", source)
        self.assertIn("不在本步做", source)


class SourceLockedStepsDeclareTheirEdgeTests(unittest.TestCase):
    """会因源码变化而作废证据的步骤,必须自己说清"本步能不能改码"。

    实战:verify_codecheck 一边写着"重构在此定稿",一边靠"源码一变首检
    失效"卡住 done。模型照前半句派了 agent 去精简,然后在门禁前空转几轮。
    两句话分别都对,合起来是个陷阱。

    相似度比对抓不到这种——两句话措辞毫不相干,冲突在语义里。能机械
    守住的是这条:**凡是锁源码的步骤,都得把边界正面写出来**。
    """

    def test_every_source_locked_step_states_whether_you_may_edit(self):
        base = os.path.join(ROOT, "flow", "steps")
        locked = re.compile(r"首检失效|源码变化会让|源码又发生变化|源码变化后")
        edge = re.compile(r"本步不做|不在本步|不得在本步|只.{0,6}因.{0,10}告警")
        silent = []
        for name in sorted(os.listdir(base)):
            if not name.endswith(".md"):
                continue
            with io.open(os.path.join(base, name),
                         encoding="utf-8") as stream:
                text = stream.read()
            if locked.search(text) and not edge.search(text):
                silent.append(name)
        self.assertEqual(
            [], silent,
            "这些步骤会因源码变化作废证据,却没说清本步能不能改码: %s"
            % silent)


class PacingTests(unittest.TestCase):
    """两处最贵的循环:澄清逐题问、质量反复回环。

    实测:一轮交付里 grill 用掉 23 轮(全程约三分之一),质量回环每转一圈
    都要重编译加复验。两处都不该靠"多转几轮"解决。
    """

    def test_independent_questions_may_be_asked_together(self):
        grill = read("flow/steps/grill.md")
        self.assertIn("彼此独立的题一次问 3～4 个", grill)
        # 合并有边界:依赖前一题的、以及高影响裁决,必须单独问
        self.assertIn("必须单独问的两类，不许合并", grill)
        self.assertIn("高影响裁决", grill)
        self.assertIn("拿不准是否相关就分开问", grill)
        # 衍生检查跟着一组答案跑,不能因为合并就漏掉
        self.assertIn("每拿到**一组**答案", grill)

#!/usr/bin/env python3
"""The explainability contract must cover the flow without becoming a gate."""

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
MAE = os.path.join(SCRIPTS, "mae-flow.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from mae_flow_core.workflow.execution_plan import (  # noqa: E402
    SCHEMA,
    WORKFLOW_PROFILE_SCHEMA,
    build_execution_plan,
    catalog_errors,
    load_workflow_profile,
    render_agent_execution_plan,
    render_workflow_supplements,
    workflow_profile_errors,
)
from mae_flow_core.workflow.workflow_profile import (  # noqa: E402
    _workflow_profile_revision,
)


def read_json(relative):
    with open(os.path.join(ROOT, *relative.split("/")), encoding="utf-8") as stream:
        return json.load(stream)


def supplement_profile(instructions="先核对旧数据兼容性"):
    """supplement-only 的 v2 profile:v1 execution-profile 的直系替代。
    没有 final_snapshot——任务按平台默认方案执行,只叠文字建议。"""
    result = {
        "schema": WORKFLOW_PROFILE_SCHEMA,
        "source": {"kind": "platform", "id": "mae-flow.standard"},
        "supplements": [{
            "scope": "task", "source_id": "task-8", "title": "本任务补充",
            "instructions": instructions,
        }],
    }
    result["revision"] = _workflow_profile_revision(result)
    return result


def structural_profile(items=None):
    base_items = [
        {"id": "pipeline-floor", "kind": "tool", "title": "权威流水线",
         "locked": True, "editable": False, "source": "platform",
         "use": {"mode": "on_stage_enter"}},
        {"id": "implementation", "kind": "activity", "title": "完成实现",
         "description": "按规格完成真实代码改动", "locked": False,
         "editable": True, "source": "platform"},
        {"id": "generic-test", "kind": "activity", "title": "通用测试",
         "locked": False, "editable": True, "source": "platform"},
    ]
    stage = {"id": "platform.construction", "title": "完整实现与自查",
             "phase": "写代码", "steps": ["build"], "slots": [],
             "items": copy.deepcopy(base_items)}
    final_stage = copy.deepcopy(stage)
    final_stage["items"] = copy.deepcopy(items if items is not None else [
        base_items[0], base_items[1],
        {"id": "notify-test", "kind": "skill", "title": "通知模块测试",
         "description": "读取任务固定的 Skill 索引后按需执行",
         "instructions": "先覆盖失败与重试路径", "locked": False,
         "editable": True, "source": "workflow",
         "asset_ref": {"registry": "team_skill", "id": "notify-test",
                       "version": "pkg-v2", "digest": "sha256:" + "b" * 64},
         "use": {"mode": "before_item", "anchor": "implementation"}},
    ])
    snapshot = {"standard_id": "mae-flow.standard",
                "standard_version": "2.0.0",
                "catalog_digest": "sha256:" + "a" * 64,
                "stages": [stage]}
    result = {
        "schema": WORKFLOW_PROFILE_SCHEMA,
        "source": {"kind": "workflow", "id": "notify-flow", "version": "v2"},
        "base_snapshot": snapshot,
        "edits": [],
        "final_snapshot": {**snapshot, "stages": [final_stage]},
        "asset_manifest": [{
            "registry": "team_skill", "id": "notify-test",
            "version": "pkg-v2", "digest": "sha256:" + "b" * 64,
            "state": "available",
        }],
        "diagnostics": [],
    }
    source = json.dumps(
        {key: value for key, value in result.items() if key != "schema"},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    result["revision"] = "sha256:" + hashlib.sha256(
        source.encode("utf-8")).hexdigest()
    return result


class ExecutionPlanContractTests(unittest.TestCase):
    def setUp(self):
        self.flow = read_json("flow/flow.json")
        self.catalog = read_json("flow/playbooks.json")

    def test_every_step_has_exactly_one_versioned_default(self):
        self.assertEqual([], catalog_errors(self.flow, self.catalog))
        plans = [
            build_execution_plan(
                self.flow,
                {"current": step, "revision": 7,
                 "choices": {"workflow": "full"}},
                self.catalog,
            )
            for step in self.flow["steps"]
        ]
        self.assertEqual(len(self.flow["steps"]), len(plans))
        self.assertTrue(all(plan["schema"] == SCHEMA for plan in plans))
        self.assertTrue(all("@" in plan["plan_id"] for plan in plans))
        self.assertTrue(all(len(plan["plan_revision"]) == 16 for plan in plans))

    def test_projection_is_read_only_and_does_not_expose_raw_prompt(self):
        flow_before = copy.deepcopy(self.flow)
        catalog_before = copy.deepcopy(self.catalog)
        state = {"current": "build", "revision": 9,
                 "choices": {"workflow": "full"}}
        state_before = copy.deepcopy(state)
        plan = build_execution_plan(self.flow, state, self.catalog)
        self.assertEqual(flow_before, self.flow)
        self.assertEqual(catalog_before, self.catalog)
        self.assertEqual(state_before, state)
        encoded = json.dumps(plan, ensure_ascii=False).lower()
        self.assertNotIn("system_prompt", encoded)
        self.assertNotIn("compiled_prompt", encoded)
        self.assertEqual("indexed_on_demand", plan["knowledge"]["loading"])
        self.assertEqual("platform_default", plan["strategy"]["source"])
        guidance = render_agent_execution_plan(plan)
        self.assertIn("平台默认执行方案", guidance)
        self.assertIn("完整实现与自查", guidance)
        self.assertIn("不等于", guidance)
        self.assertIn("平台兜底", guidance)

    def test_contract_keeps_customization_below_the_safety_floor(self):
        plan = build_execution_plan(
            self.flow,
            {"current": "story", "choices": {"workflow": "full"}},
            self.catalog,
        )
        self.assertTrue(plan["contract"]["human_decision"])
        self.assertIn("Story", plan["contract"]["outputs"])
        self.assertIn("task_instructions",
                      plan["customization"]["customizable"])
        locked = " ".join(plan["customization"]["locked"])
        self.assertIn("真实执行证据", locked)
        self.assertIn("Git", locked)

    def test_every_referenced_guidance_or_standard_is_a_real_runtime_asset(self):
        for playbook in self.catalog["playbooks"]:
            for resource in playbook.get("resources", []):
                reference = resource.get("ref")
                if not reference:
                    continue
                path = os.path.join(ROOT, "runtime", *reference.split("/"))
                self.assertTrue(os.path.isfile(path), reference)

    def test_pinned_task_supplement_changes_plan_and_is_visible(self):
        """v1 层叠建议已并入 v2 supplements:同一体验,单一通道。"""
        default = build_execution_plan(
            self.flow, {"current": "build"}, self.catalog)
        customized = build_execution_plan(
            self.flow, {"current": "build"}, self.catalog,
            supplement_profile())
        self.assertNotEqual(default["plan_revision"],
                            customized["plan_revision"])
        self.assertEqual("platform_default+overrides",
                         customized["customization"]["effective_source"])
        # supplement-only 不许冒充定格:模式/来源必须如实说平台默认。
        self.assertEqual("bounded", customized["customization"]["mode"])
        self.assertEqual("platform_default", customized["strategy"]["source"])
        self.assertEqual("先核对旧数据兼容性",
                         customized["customization"]["layers"][0]["instructions"])
        rendered = render_workflow_supplements(supplement_profile())
        self.assertIn("先核对旧数据兼容性", rendered)
        self.assertIn("冲突部分无效", rendered)
        plan_text = render_agent_execution_plan(customized)
        self.assertIn("已叠加的执行补充", plan_text)

    def test_platform_default_plan_lists_only_required_activities(self):
        """v1 的"勾选可选动作/偏好资源"通道已退役:平台默认方案只列
        必做动作,想改结构走 v2 结构化定制(structural_profile)。"""
        plan = build_execution_plan(
            self.flow,
            {"current": "build", "choices": {"workflow": "full"}},
            self.catalog,
        )
        activities = {item["id"]: item for item in plan["activities"]}
        self.assertIn("risk-first-implementation", activities,
                      "平台必做动作必须保留")
        self.assertTrue(all(item["source"] == "platform_default"
                            for item in activities.values()))
        self.assertNotIn("environment-warmup", activities,
                         "可选动作没有勾选通道,不能冒充已启用")
        self.assertNotIn("stage_layers", plan["customization"],
                         "v1 阶段定制字段应随退役消失,不留空壳")

    def test_supplement_profile_with_bad_revision_falls_back_visibly(self):
        broken = supplement_profile()
        broken["supplements"][0]["instructions"] = "被篡改的内容"
        self.assertTrue(workflow_profile_errors(broken))
        with tempfile.TemporaryDirectory() as root:
            directory = os.path.join(root, ".mae-flow-work")
            os.makedirs(directory)
            with open(os.path.join(directory, "workflow-profile.json"), "w",
                      encoding="utf-8") as stream:
                json.dump(broken, stream, ensure_ascii=False)
            loaded, warning = load_workflow_profile(root)
        self.assertIsNone(loaded)
        self.assertIn("采用既有 Mae-Flow 方案", warning)

    def test_structural_profile_is_the_only_final_stage_plan(self):
        # 归一后建议层与结构化定格同住一档:supplements 字段随档展示,
        # 不再有第二个文件。
        workflow = structural_profile()
        workflow["supplements"] = [{
            "scope": "task", "source_id": "task-8", "title": "本任务补充",
            "instructions": "旧建议层仍可展示",
        }]
        workflow["revision"] = _workflow_profile_revision(workflow)
        self.assertEqual([], workflow_profile_errors(workflow))
        plan = build_execution_plan(
            self.flow, {"current": "build", "revision": 4}, self.catalog,
            workflow_profile=workflow)
        self.assertEqual("structural", plan["customization"]["mode"])
        self.assertEqual("旧建议层仍可展示",
                         plan["customization"]["layers"][0]["instructions"])
        self.assertEqual("compiled_final_plan",
                         plan["customization"]["effective_source"])
        self.assertEqual("workflow", plan["strategy"]["source"])
        self.assertEqual(
            ["pipeline-floor", "implementation", "notify-test"],
            [item["id"] for item in plan["workflow_items"]])
        self.assertNotIn("generic-test",
                         [item["id"] for item in plan["workflow_items"]])
        guidance = render_agent_execution_plan(plan)
        self.assertIn("已固定的最终执行方案", guidance)
        self.assertIn("工作流定制", guidance)
        self.assertIn("先覆盖失败与重试路径", guidance)
        self.assertIn("固定 Skill：notify-test@pkg-v2", guidance)
        self.assertNotIn("通用测试", guidance)

    def test_workflow_asset_snapshot_path_is_safe_and_visible_not_inlined(self):
        workflow = structural_profile()
        ref = {"registry": "business_knowledge", "id": "diagnosis",
               "business_module_id": "notify", "version": "3",
               "digest": "sha256:" + "c" * 64}
        item = {"id": "notify-diagnosis", "kind": "knowledge",
                "title": "通知问题定位", "locked": False,
                "editable": True, "source": "workflow",
                "asset_ref": ref, "use": {"mode": "when_needed"}}
        workflow["final_snapshot"]["stages"][0]["items"].append(item)
        workflow["asset_manifest"].append({
            **ref, "state": "available",
            "snapshot_path": ".mae-flow-work/business-modules/notify/diagnosis.md",
        })
        source = json.dumps(
            {key: value for key, value in workflow.items()
             if key not in ("schema", "revision")},
            ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        workflow["revision"] = "sha256:" + hashlib.sha256(
            source.encode("utf-8")).hexdigest()
        self.assertEqual([], workflow_profile_errors(workflow))
        plan = build_execution_plan(
            self.flow, {"current": "build"}, self.catalog,
            workflow_profile=workflow)
        guidance = render_agent_execution_plan(plan)
        self.assertIn("正文按需读取：.mae-flow-work/business-modules/notify/diagnosis.md",
                      guidance)
        self.assertNotIn("问题定位正文", guidance)

        workflow["asset_manifest"][-1]["snapshot_path"] = "../../secret"
        self.assertTrue(any("unsafe snapshot path" in error
                            for error in workflow_profile_errors(workflow)))

    def test_structural_profile_cannot_tamper_with_locked_floor(self):
        workflow = structural_profile()
        workflow["final_snapshot"]["stages"][0]["items"] = [
            item for item in workflow["final_snapshot"]["stages"][0]["items"]
            if item["id"] != "pipeline-floor"]
        source = json.dumps(
            {key: value for key, value in workflow.items()
             if key not in ("schema", "revision")},
            ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        workflow["revision"] = "sha256:" + hashlib.sha256(
            source.encode("utf-8")).hexdigest()
        self.assertTrue(any("locked item" in error
                            for error in workflow_profile_errors(workflow)))
        with tempfile.TemporaryDirectory() as root:
            directory = os.path.join(root, ".mae-flow-work")
            os.makedirs(directory)
            with open(os.path.join(directory, "workflow-profile.json"), "w",
                      encoding="utf-8") as stream:
                json.dump(workflow, stream, ensure_ascii=False)
            loaded, warning = load_workflow_profile(root)
        self.assertIsNone(loaded)
        self.assertIn("采用既有 Mae-Flow 方案", warning)

    def test_real_current_delivers_pinned_supplement_to_agent(self):
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(["git", "init", "-q", "-b", "master", project],
                           check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", project, "commit", "-q", "--allow-empty",
                 "-m", "init"], check=True, capture_output=True,
                env={**os.environ, "GIT_AUTHOR_NAME": "t",
                     "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                     "GIT_COMMITTER_EMAIL": "t@t"})
            directory = os.path.join(project, ".mae-flow-work")
            os.makedirs(directory)
            with open(os.path.join(directory, "workflow-profile.json"), "w",
                      encoding="utf-8") as stream:
                json.dump(supplement_profile("先检查灰度兼容，再动接口"),
                          stream, ensure_ascii=False)
            env = {**os.environ, "MAE_FLOW_NO_NOTIFY": "1"}
            initialized = subprocess.run(
                [sys.executable, MAE, "init"], cwd=project, env=env,
                text=True, capture_output=True, timeout=30)
            self.assertEqual(0, initialized.returncode,
                             initialized.stdout + initialized.stderr)
            current = subprocess.run(
                [sys.executable, MAE, "current"], cwd=project, env=env,
                text=True, capture_output=True, timeout=30)
            self.assertEqual(0, current.returncode,
                             current.stdout + current.stderr)
            self.assertIn("已固定的执行补充", current.stdout)
            self.assertIn("平台默认执行方案", current.stdout)
            self.assertIn("可靠开工", current.stdout)
            self.assertIn("先检查灰度兼容，再动接口", current.stdout)
            self.assertIn("冲突部分无效", current.stdout)


    def test_stage_id_mismatch_degrades_visibly_not_silently(self):
        """定格方案缺当前阶段 → 退平台默认 + 留 diagnostics(审计 P1-7)。

        stage.id 由 cloud 编译器写、内核消费,跨仓硬耦合;失配曾直接
        raise 把整条 CLI 打崩。降级后 mode/strategy.source 必须如实说
        "平台默认",不许一边跑默认一边展示定制皮。"""
        from mae_flow_core.workflow.workflow_profile import (
            _workflow_profile_revision)
        workflow = structural_profile()
        for key in ("base_snapshot", "final_snapshot"):
            for stage in workflow[key]["stages"]:
                stage["id"] = "cloud.renamed-elsewhere"
        workflow["revision"] = _workflow_profile_revision(workflow)
        self.assertEqual([], workflow_profile_errors(workflow))
        plan = build_execution_plan(
            self.flow, {"current": "build", "choices": {"workflow": "full"}},
            self.catalog, workflow_profile=workflow)
        self.assertEqual("bounded", plan["customization"]["mode"])
        self.assertEqual("platform_default", plan["strategy"]["source"])
        self.assertEqual("platform_default",
                         plan["customization"]["effective_source"])
        degrades = [item for item in plan["customization"]["diagnostics"]
                    if item.get("code") == "profile_invalid"]
        self.assertEqual(1, len(degrades))
        self.assertEqual("warning", degrades[0]["severity"])
        self.assertIn("退回平台默认", degrades[0]["message"])
        self.assertEqual("platform.construction", degrades[0]["stage_id"])

    def test_playbook_phase_vocabulary_matches_panel_phases(self):
        """playbook.phase 与 panel PHASES 必须同一词表(审计 P0-3 实锤:
        archive 两步一边归"定规格"一边归"交付",进度条点错阶段才弹层)。"""
        from mae_flow_core.panel.notify import phase_of
        for playbook in self.catalog["playbooks"]:
            for step in playbook.get("steps") or ():
                self.assertEqual(
                    playbook.get("phase"), phase_of(step),
                    "步骤 %s 的阶段词表分裂: playbook %s 说「%s」,"
                    "panel 说「%s」" % (step, playbook.get("id"),
                                       playbook.get("phase"), phase_of(step)))

    def test_cli_survives_poisoned_customization_with_degraded_json(self):
        """定制病到组装不出方案时 CLI 不许崩(审计 P1-6):退平台默认、
        留 profile_invalid 诊断、stderr 说人话——宿主靠这个上浮告警。"""
        import contextlib
        import io
        from unittest import mock
        from mae_flow_core.cli_commands import execution_plan as cli
        poisoned = structural_profile()
        poisoned["revision"] = "sha256:" + "f" * 64
        self.assertTrue(workflow_profile_errors(poisoned))
        args = type("Args", (), {"json": True})()
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(cli, "load_workflow_profile",
                               return_value=(poisoned, "")), \
                contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            cli.cmd_execution_plan(
                self.flow,
                {"current": "build", "choices": {"workflow": "full"}}, args)
        plan = json.loads(out.getvalue())
        self.assertEqual("platform_default", plan["strategy"]["source"])
        self.assertTrue(any(
            item.get("code") == "profile_invalid"
            for item in plan["customization"]["diagnostics"]))
        self.assertIn("已退回平台默认", err.getvalue())


if __name__ == "__main__":
    unittest.main()

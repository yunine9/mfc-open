#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""执行契约是一张任务级事实表，不应由每个门禁各猜一次宿主形态。"""

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

from mae_flow_core.workflow.execution_contract import (  # noqa: E402
    SCHEMA,
    contract_for_state,
    effective_config_keys,
    resolve_execution_contract,
    validation_environment,
)
from mae_flow_core import host_env  # noqa: E402
from mae_flow_core.cli_commands.current import _step_md_text  # noqa: E402


CONFIG_STEP = {
    "require_sets": [
        "工号", "编译方式", "UT生成方式", "UT运行命令",
    ],
}


def explicit_cloud_contract():
    return {
        "schema": SCHEMA,
        "host": "cloud",
        "compile": "pipeline",
        "ut_write": "agent",
        "ut_run": "pipeline",
        "codecheck": "pipeline",
        "git_push": "host",
        "continuous_review": True,
    }


class ExecutionContractResolutionTests(unittest.TestCase):
    def test_explicit_order_contract_has_priority_over_host_fallback(self):
        contract = resolve_execution_contract(
            {"execution_contract": explicit_cloud_contract()}, "local")
        self.assertEqual("order", contract["source"])
        self.assertEqual("cloud", contract["host"])
        self.assertEqual("pipeline", contract["compile"])
        self.assertTrue(contract["continuous_review"])

    def test_legacy_cloud_fallback_delegates_machine_validation(self):
        contract = resolve_execution_contract({}, "cloud")
        self.assertEqual("legacy-cloud", contract["source"])
        self.assertEqual("pipeline", contract["compile"])
        self.assertEqual("agent", contract["ut_write"])
        self.assertEqual("pipeline", contract["ut_run"])
        self.assertEqual("pipeline", contract["codecheck"])
        self.assertEqual("host", contract["git_push"])
        self.assertFalse(contract["continuous_review"])

    def test_local_default_preserves_all_local_execution(self):
        contract = resolve_execution_contract({}, "")
        self.assertEqual("local-default", contract["source"])
        self.assertEqual("local", contract["compile"])
        self.assertEqual("agent", contract["ut_write"])
        self.assertEqual("local", contract["ut_run"])
        self.assertEqual("local", contract["codecheck"])
        self.assertEqual("local", contract["git_push"])
        self.assertFalse(contract["continuous_review"])

    def test_persisted_contract_is_stable_when_process_host_changes(self):
        state = {"execution_contract": {
            **explicit_cloud_contract(), "source": "order",
        }}
        contract = contract_for_state(state, "local")
        self.assertEqual("cloud", contract["host"])
        self.assertEqual("pipeline", contract["compile"])
        self.assertEqual("order", contract["source"])

    def test_host_facade_exposes_the_same_persisted_contract(self):
        state = {"execution_contract": {
            **explicit_cloud_contract(), "source": "order",
        }}
        self.assertEqual(
            contract_for_state(state, "local"),
            host_env.execution_contract(state),
        )

    def test_invalid_order_contract_fails_closed(self):
        invalid = explicit_cloud_contract()
        invalid["ut_write"] = "pipeline"
        with self.assertRaisesRegex(ValueError, "ut_write"):
            resolve_execution_contract({"execution_contract": invalid}, "cloud")
        invalid = explicit_cloud_contract()
        invalid["schema"] = "future/9"
        with self.assertRaisesRegex(ValueError, "schema"):
            resolve_execution_contract({"execution_contract": invalid}, "cloud")
        invalid = explicit_cloud_contract()
        invalid["host"] = "local"
        with self.assertRaisesRegex(ValueError, "只能由 Cloud"):
            resolve_execution_contract({"execution_contract": invalid}, "local")


class EffectiveConfigTests(unittest.TestCase):
    def test_cloud_only_asks_for_human_and_agent_inputs(self):
        state = {"execution_contract": {
            **explicit_cloud_contract(), "source": "order",
        }}
        self.assertEqual(
            ("工号", "UT生成方式"),
            effective_config_keys(CONFIG_STEP, state, "local"),
        )
        self.assertEqual(
            "权威流水线（编译、UT 执行、CodeCheck）",
            validation_environment(state, "local"),
        )

    def test_local_keeps_compile_ut_write_and_ut_run_configuration(self):
        state = {"execution_contract": resolve_execution_contract({}, "local")}
        self.assertEqual(
            tuple(CONFIG_STEP["require_sets"]),
            effective_config_keys(CONFIG_STEP, state, "cloud"),
        )


class CurrentRenderingTests(unittest.TestCase):
    def test_cloud_hides_local_compile_and_ut_run_instructions(self):
        state = {"execution_contract": {
            **explicit_cloud_contract(), "source": "order",
        }}
        self.assertNotIn("agent-task", _step_md_text("build", state))
        self.assertNotIn(
            "UT运行命令", _step_md_text("config_confirm", state))

    def test_local_retains_ut_run_instructions(self):
        state = {
            "execution_contract": resolve_execution_contract({}, "local")}
        self.assertIn(
            "UT运行命令", _step_md_text("config_confirm", state))


class InitPersistenceTests(unittest.TestCase):
    def test_local_init_persists_default_and_keeps_original_review_fields(self):
        with tempfile.TemporaryDirectory() as project:
            subprocess.run(
                ["git", "init", "-q", "-b", "master", project],
                check=True, capture_output=True,
            )
            subprocess.run(
                ["git", "-C", project, "commit", "-q", "--allow-empty",
                 "-m", "init"],
                check=True, capture_output=True,
                env={
                    **os.environ,
                    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                    "GIT_COMMITTER_NAME": "t",
                    "GIT_COMMITTER_EMAIL": "t@t",
                },
            )
            env = {**os.environ, "MAE_FLOW_NO_NOTIFY": "1"}
            env.pop("MAE_FLOW_HOST", None)
            initialized = subprocess.run(
                [sys.executable, MAE, "init"], cwd=project, env=env,
                text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(
                0, initialized.returncode,
                initialized.stdout + initialized.stderr,
            )
            with open(os.path.join(project, ".mae-flow.json"),
                      encoding="utf-8") as stream:
                state = json.load(stream)
            self.assertEqual("local-default",
                             state["execution_contract"]["source"])
            self.assertEqual("local", state["execution_contract"]["compile"])
            current = subprocess.run(
                [sys.executable, MAE, "current"], cwd=project, env=env,
                text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(0, current.returncode,
                             current.stdout + current.stderr)
            self.assertIn("编译方式=<值>", current.stdout)
            self.assertIn("UT生成方式=<值>", current.stdout)
            self.assertIn("UT运行命令=<值>", current.stdout)
            self.assertNotIn("部署执行契约", current.stdout)



if __name__ == "__main__":
    unittest.main()

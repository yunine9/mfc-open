import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAE = os.path.join(ROOT, "scripts", "mae-flow.py")
DISPATCH = os.path.join(ROOT, "hooks", "dispatch.py")
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from mae_flow_core import cli_runtime as mf
from mae_flow_core.cli_commands import git_ownership
from mae_flow_core.guard.ownership import OwnershipFacts, decide_ownership
with open(
        os.path.join(ROOT, "flow", "flow.json"),
        encoding="utf-8") as flow_stream:
    mf.FLOW = json.load(flow_stream)


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, text=True,
        capture_output=True).stdout.strip()


def write(root, relative, text):
    path = os.path.join(root, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
    return path


class CommitOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mae-flow-ownership-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "ownership@test.invalid")
        git(self.repo, "config", "user.name", "Ownership Test")
        write(self.repo, "README.md", "base\n")
        git(self.repo, "add", "README.md")
        git(self.repo, "commit", "-qm", "base")
        git(self.repo, "branch", "-M", "main")
        git(self.repo, "checkout", "-qb", "feature")
        self.old_cwd = os.getcwd()
        os.chdir(self.repo)

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def state(self, current="build"):
        return {
            "current": current,
            "config": {
                "单号": "REQ123", "单号类型": "fix",
                "CHANGE_NAME": "current-change",
                "基线分支": "main", "分支名": "feature",
            },
            "choices": {"workflow": "full"},
            "history": [], "started": "2026-07-28 10:00:00",
            "initial_dirty": [], "initial_dirty_fingerprints": {},
        }

    def red_repair_state(self, baseline_dirty=()):
        state = self.state(current="external_verify")
        head = git(self.repo, "rev-parse", "HEAD")
        state["quality"] = {"external_verification": {
            "verdict": "RED", "sha": head,
        }}
        state["external_repair_authorization"] = {
            "schema": "mae-flow-external-repair/1",
            "status": "ready",
            "failed_sha": head,
            "issued_at": "2026-08-20 12:00:00",
            "baseline_dirty": list(baseline_dirty),
        }
        # Deliberately stale human manifest: the RED repair may need a new test
        # file, but must not manufacture another human Diff review round.
        state["delivery_manifest"] = {
            "files": ["README.md"],
            "commit_message": "[REQ123][fix]original delivery",
            "target_branch": "main",
            "adopted_dirty": {},
            "confirmed": True,
        }
        return state


    def cleanup_state(self, paths):
        state = self.state(current="build")
        state["delivery_loop"] = {"active_batch_id": "cleanup", "batches": [
            {"batch_id": "cleanup", "status": "repairing"}]}
        state["delivery_repair_authorization"] = {
            "schema": "mae-flow-feedback-repair/1", "status": "ready",
            "batch_id": "cleanup", "base_sha": git(self.repo, "rev-parse", "HEAD"),
            "allowed_paths": paths, "baseline_dirty": paths,
        }
        state["delivery_manifest"] = {"files": paths, "confirmed": True}
        return state


    def mark_initial(self, state, path):
        state["initial_dirty"].append(path)
        state["initial_dirty_fingerprints"][path] = mf._path_fingerprint(path)

    def write_sidecar(self, compile_side_effects=None, paths=None):
        sidecar = {"paths": paths or {}}
        if compile_side_effects is not None:
            sidecar["compile_side_effects"] = compile_side_effects
        write(self.repo, ".mae-flow.json.agent-writes", json.dumps(sidecar))

    def gate_bash(self, command):
        return subprocess.run(
            [sys.executable, MAE, "gate", "bash", command],
            cwd=self.repo,
            text=True,
            capture_output=True,
            timeout=120,
        )

    def posttool_bash(self, command):
        payload = json.dumps({
            "cwd": self.repo,
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": {"exit_code": 0, "stdout": ""},
        }, ensure_ascii=False) + "\n"
        result = subprocess.run(
            [sys.executable, DISPATCH, "posttooluse"],
            cwd=self.repo,
            input=payload,
            text=True,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return result

    def save_pending_compile(self, state=None):
        state = state or self.state()
        state["agent_tasks"] = {"COMPILE": {
            "step": state["current"],
            "head": git(self.repo, "rev-parse", "HEAD"),
            "sha256": "current-compile-task",
        }}
        mf.save_state(state)
        return state

    def push_to_new_remote(self):
        remote = os.path.join(self.tmp, "remote.git")
        git(self.tmp, "init", "--bare", "-q", remote)
        git(self.repo, "remote", "add", "origin", remote)
        git(self.repo, "push", "-qu", "origin", "HEAD")

    def capture_user_message(self, state, text):
        write(self.repo, ".mae-flow.json.usermsg", json.dumps([{
            "id": "user-git-authorization",
            "step": state["current"],
            "at": "9999-12-31 23:59:59",
            "text": text,
        }], ensure_ascii=False))

    def authorize_blocked_command(self, command, rule, ack):
        blocked = self.gate_bash(command)
        output = blocked.stdout + blocked.stderr
        self.assertNotEqual(0, blocked.returncode, output)
        permit_id = mf._gate_block_id(rule, command)
        state = mf.load_state()
        # 按新契约:问用户的那句话里必须带上本次放行编号。编号是流程在拦截那一刻
        # 生成的,Agent 只能从拦截消息里抄——抄了就意味着它真把这次动作摆给用户
        # 看过,别处的同意也就挪不过来。
        self.capture_user_message(state, "%s（放行编号 %s）" % (ack, permit_id))
        with contextlib.redirect_stdout(io.StringIO()):
            mf.cmd_allow(
                mf.FLOW,
                state,
                types.SimpleNamespace(
                    block_id=permit_id,
                    message_id="user-git-authorization",
                ),
            )
        return output, permit_id

    def mark_compile_completed(self, state, invocation="toolu-compile"):
        """按生产形态坐实"编译已完成":真实返回 + 当前输入上的真实成功执行。

        这里刻意不再手写 `.mae-flow.json.tokens`——COMPILE Hook 令牌早已没有
        写入方，用它坐实完成度会让测试通过在生产上永不成立的路径。
        """
        from mae_flow_core.workflow.agent_observations import (
            record_agent_finished, record_agent_started,
        )
        from mae_flow_core.workflow.quality_executions import (
            quality_input_snapshot, record_quality_execution,
        )
        state_path = os.path.join(self.repo, ".mae-flow.json")
        step = state.get("current", "")
        at = "2026-07-28 11:00:00"
        record_agent_started(state_path, "COMPILE", step, invocation, at)
        record_agent_finished(state_path, invocation, "returned", at)
        record_quality_execution(
            state_path, "COMPILE", step, invocation,
            state.get("config", {}).get("编译方式", "") or "make all",
            True, quality_input_snapshot(state, "COMPILE", step), at)

    def assert_compile_commit_lifecycle(self, path, tracked):
        if tracked:
            write(self.repo, path, "compiled=false\n")
            git(self.repo, "add", path)
            git(self.repo, "commit", "-qm", "track configuration")
        task_head = git(self.repo, "rev-parse", "HEAD")
        write(self.repo, path, "compiled=true\n")
        state = self.state()
        state["agent_tasks"] = {"COMPILE": {
            "step": "build",
            "head": task_head,
            "sha256": "current-compile-task",
        }}
        mf.save_state(state)
        command = (
            'git add -- "%s" && git commit -m "[REQ123][fix]compile"'
            % path
        )
        original_head = git(self.repo, "rev-parse", "HEAD")

        pending = self.gate_bash(command)

        pending_output = pending.stdout + pending.stderr
        self.assertNotEqual(0, pending.returncode, pending_output)
        self.assertIn("先完成当前 COMPILE 任务", pending_output)
        self.assertEqual(original_head, git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only"))
        self.assertFalse(os.path.exists(
            os.path.join(self.repo, ".mae-flow.json.gate-strikes")))
        self.assertFalse(os.path.exists(
            os.path.join(self.repo, ".mae-flow.json.gate-permits")))

        self.mark_compile_completed(state)
        self.write_sidecar({
            path: {"task_sha256": "current-compile-task"},
        })

        attributed = self.gate_bash(command)

        attributed_output = attributed.stdout + attributed.stderr
        self.assertNotEqual(0, attributed.returncode, attributed_output)
        self.assertNotIn("先完成当前 COMPILE 任务", attributed_output)
        self.assertIn("由 COMPILE 命令产生或改写", attributed_output)
        self.assertEqual(original_head, git(self.repo, "rev-parse", "HEAD"))

        self.write_sidecar(paths={
            path: {"tool": "file-write"},
        })
        completed = self.gate_bash(command)
        self.assertEqual(
            0,
            completed.returncode,
            completed.stdout + completed.stderr,
        )
        git(self.repo, "add", "--", path)
        git(self.repo, "commit", "-qm", "[REQ123][fix]compile")
        self.assertNotEqual(original_head, git(self.repo, "rev-parse", "HEAD"))

    def decide_pending_files(self, state):
        (inherited, foreign_openspec, compile_side_effects,
         strong_artifacts, unproven_paths, artifact_hints) = (
             mf._pending_commit_files("", state))
        decision = decide_ownership(OwnershipFacts(
            candidate_paths=tuple(mf._pending_commit_candidates()["paths"]),
            inherited=tuple(inherited),
            foreign_openspec=tuple(foreign_openspec),
            compile_side_effects=tuple(compile_side_effects),
            staged_compile_side_effects=tuple(compile_side_effects),
            command_compile_side_effects=(),
            strong_artifacts=tuple(strong_artifacts),
            unproven_paths=tuple(unproven_paths),
            artifact_hints=tuple(artifact_hints),
        ))
        return compile_side_effects, decision

    def test_unchanged_previous_story_is_blocked_before_commit(self):
        old_story = "openspec/changes/old/STORY-REQ122.md"
        write(self.repo, old_story, "# STORY-REQ122\n\n上一单。\n")
        state = self.state()
        self.mark_initial(state, old_story)
        git(self.repo, "add", old_story)

        inherited, foreign, compile_side_effects, strong, unproven, hints = (
            mf._pending_commit_files("", state))

        self.assertEqual([old_story], inherited)
        self.assertEqual([old_story], foreign)
        self.assertFalse(compile_side_effects)
        self.assertFalse(strong)
        self.assertIn(old_story, unproven)
        self.assertFalse(hints)

    def test_recorded_compile_side_effect_blocks_new_configuration_file(self):
        generated = "config/generated.properties"
        write(self.repo, generated, "compiled=true\n")
        self.write_sidecar({"./" + generated: {"task_sha256": "compile"}})
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([generated], compile_side_effects)
        self.assertEqual("bash-compile-side-effects", decision.block.rule)

    def test_recorded_compile_side_effect_blocks_tracked_configuration_file(self):
        generated = "config/runtime.properties"
        write(self.repo, generated, "compiled=false\n")
        git(self.repo, "add", generated)
        git(self.repo, "commit", "-qm", "track runtime config")
        write(self.repo, generated, "compiled=true\n")
        self.write_sidecar({generated: {"task_sha256": "compile"}})
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([generated], compile_side_effects)
        self.assertEqual("bash-compile-side-effects", decision.block.rule)


    def test_case_insensitive_identity_matches_compile_ledger_spelling(self):
        generated = "config/runtime.properties"
        write(self.repo, generated, "compiled=false\n")
        git(self.repo, "add", generated)
        git(self.repo, "commit", "-qm", "track runtime config")
        write(self.repo, generated, "compiled=true\n")
        self.write_sidecar({
            "CONFIG\\RUNTIME.PROPERTIES": {"task_sha256": "compile"},
        })
        git(self.repo, "add", generated)
        windows_os = mock.Mock(wraps=os)
        windows_os.name = "nt"

        with mock.patch.object(git_ownership, "os", windows_os):
            compile_side_effects, decision = self.decide_pending_files(
                self.state())

        self.assertEqual([generated], compile_side_effects)
        self.assertEqual("bash-compile-side-effects", decision.block.rule)

    def test_old_sidecar_without_compile_effects_stays_compatible(self):
        generated = "config/generated.properties"
        write(self.repo, generated, "legacy=true\n")
        self.write_sidecar(paths={generated: {"tool": "file-write"}})
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_malformed_legacy_sidecar_fails_open(self):
        generated = "config/generated.properties"
        write(self.repo, generated, "legacy=true\n")
        write(self.repo, ".mae-flow.json.agent-writes", "{not json\n")
        git(self.repo, "add", generated)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_snapshot_separates_staged_and_compound_add_candidates(self):
        staged = "config/staged.properties"
        command_only = "internal/generated/build.properties"
        write(self.repo, staged, "staged=true\n")
        write(self.repo, command_only, "compiled=true\n")
        self.write_sidecar({
            staged: {"task_sha256": "compile"},
            command_only: {"task_sha256": "compile"},
        })
        git(self.repo, "add", staged)
        command = "git add %s && git commit -m '[REQ123][fix]compile'" % command_only
        snapshot = mf._pending_commit_candidates(command)
        (inherited, foreign_openspec, compile_side_effects,
         strong_artifacts, unproven_paths, artifact_hints) = (
             mf._pending_commit_files(command, self.state(), snapshot))

        self.assertFalse(inherited)
        self.assertFalse(foreign_openspec)
        self.assertEqual([staged, command_only], compile_side_effects)
        self.assertEqual({staged}, snapshot["staged_paths"])
        self.assertEqual({command_only}, snapshot["working_paths"])
        self.assertFalse(strong_artifacts)
        self.assertIn(staged, unproven_paths)
        self.assertIn(command_only, unproven_paths)
        self.assertFalse(artifact_hints)

    def test_unwritten_output_artifact_is_blocked_with_a_permit_route(self):
        """别的编译任务的台账不该给它归属，但它仍是 Agent 没写过的产物。"""
        artifact = "dist/app.js"
        write(self.repo, artifact, "console.log('release');\n")
        self.write_sidecar({"internal/generated/build.properties": {
            "task_sha256": "different-compile",
        }})
        git(self.repo, "add", artifact)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual(
            [], compile_side_effects, "不能张冠李戴地归属到别的编译任务")
        self.assertEqual(
            "bash-build-output-artifacts", decision.block.rule)
        self.assertEqual(
            "block", decision.block.kind, "裁决类:用户可一次性放行")

    def test_tracked_deletion_without_compile_ledger_remains_committable(self):
        path = "config/runtime.properties"
        write(self.repo, path, "compiled=false\n")
        git(self.repo, "add", path)
        git(self.repo, "commit", "-qm", "track runtime")
        os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", path)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_preexisting_task_deletion_without_ledger_remains_committable(self):
        path = "config/preexisting.properties"
        write(self.repo, path, "compiled=false\n")
        git(self.repo, "add", path)
        git(self.repo, "commit", "-qm", "track preexisting runtime")
        os.remove(os.path.join(self.repo, path))
        self.write_sidecar(compile_side_effects={})
        git(self.repo, "add", "-u", "--", path)

        compile_side_effects, decision = self.decide_pending_files(self.state())

        self.assertEqual([], compile_side_effects)
        self.assertIsNone(decision.block)

    def test_recorded_compile_effect_deletions_are_not_delivery_outputs(self):
        staged = "config/staged.properties"
        commit_all = "config/commit-all.properties"
        pathspec = "config/pathspec.properties"
        for path in (staged, commit_all, pathspec):
            write(self.repo, path, "compiled=true\n")
        git(self.repo, "add", "config")
        git(self.repo, "commit", "-qm", "track compile outputs")
        self.write_sidecar({
            path: {"task_sha256": "older-compile"}
            for path in (staged, commit_all, pathspec)
        })
        for path in (staged, commit_all, pathspec):
            os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", staged)

        commands = (
            "",
            'git commit -am "[REQ123][fix]remove output"',
            'git commit -m "[REQ123][fix]remove output" -- ' + pathspec,
        )
        for command in commands:
            with self.subTest(command=command or "staged"):
                snapshot = mf._pending_commit_candidates(command)
                values = mf._pending_commit_files(
                    command, self.state(), snapshot)
                self.assertEqual([], values[2])


    def test_foreign_openspec_deletion_is_not_a_delivery_output(self):
        foreign = "openspec/changes/retired-change/change.md"
        write(self.repo, foreign, "# retired\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "track retired change")
        os.remove(os.path.join(self.repo, foreign))
        git(self.repo, "add", "-u", "--", foreign)

        values = mf._pending_commit_files("", self.state())

        self.assertEqual([], values[1])


    def test_openspec_trust_is_limited_to_current_delivery(self):
        current = "openspec/changes/current-change/change.md"
        foreign = "openspec/changes/another-change/change.md"
        disguised_story = "openspec/changes/current-change/notes.md"
        write(self.repo, current, "# 变更\n")
        write(self.repo, foreign, "# 其他单\n")
        write(self.repo, disguised_story, "# STORY-REQ123\n")

        state = self.state()
        self.assertTrue(mf._trusted_harness_commit_path(current, state))
        self.assertFalse(mf._trusted_harness_commit_path(foreign, state))
        self.assertFalse(mf._trusted_harness_commit_path(disguised_story, state))

        state["spec"] = {
            "archived_to": "2026-07-28-current-change",
            "archive_paths": [
                "openspec/changes/archive/2026-07-28-current-change",
                "openspec/specs/runtime/spec.md",
            ],
        }
        self.assertTrue(mf._trusted_harness_commit_path(
            "openspec/changes/archive/2026-07-28-current-change/change.md",
            state))
        self.assertTrue(mf._trusted_harness_commit_path(
            "openspec/specs/runtime/spec.md", state))
        self.assertFalse(mf._trusted_harness_commit_path(
            "openspec/specs/other/spec.md", state))

    def test_push_fact_is_independent_of_manually_committed_carryover(self):
        old_story = "openspec/changes/old/STORY-REQ122.md"
        write(self.repo, old_story, "# STORY-REQ122\n\n上一单。\n")
        state = self.state(current="push")
        self.mark_initial(state, old_story)
        write(self.repo, "src/current.cpp", "int current = 1;\n")
        git(self.repo, "add", old_story, "src/current.cpp")
        git(self.repo, "commit", "-qm", "[REQ123][fix]current")
        remote = os.path.join(self.tmp, "remote.git")
        git(self.tmp, "init", "--bare", "-q", remote)
        git(self.repo, "remote", "add", "origin", remote)
        git(self.repo, "push", "-qu", "origin", "HEAD")

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)


    def test_push_fact_is_independent_of_story_disguised_in_current_openspec(self):
        disguised = "openspec/changes/current-change/notes.md"
        state = self.state(current="push")
        write(self.repo, disguised, "# STORY-REQ123\n\n不应入库。\n")
        git(self.repo, "add", disguised)
        git(self.repo, "commit", "-qm", "[REQ123][fix]current")
        self.push_to_new_remote()

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)


    def test_push_allows_eight_deleted_historical_openspec_paths(self):
        prefix = "openspec/changes/resend-condition-change"
        historical = [
            prefix + "/" + name
            for name in (
                "change.md",
                "design.md",
                "proposal.md",
                "tasks.md",
                "specs/nsa/spec.md",
                "specs/storage/spec.md",
                "specs/neighbor/spec.md",
                "notes/decision.md",
            )
        ]
        for path in historical:
            write(self.repo, path, "# historical\n")
        git(self.repo, "add", prefix)
        git(self.repo, "commit", "-qm", "historical fixture")
        git(self.repo, "branch", "-f", "main", "HEAD")
        for path in historical:
            os.remove(os.path.join(self.repo, path))
        git(self.repo, "add", "-u", "--", prefix)
        git(self.repo, "commit", "-qm", "[REQ123][fix]historical cleanup")
        self.push_to_new_remote()
        state = self.state(current="push")
        state["config"]["CHANGE_NAME"] = "nsa-storage-neighbor-fix"

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)

    def test_push_fact_allows_added_foreign_openspec(self):
        foreign = "openspec/changes/resend-condition-change/change.md"
        write(self.repo, foreign, "# foreign added\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "[REQ123][fix]foreign add")
        self.push_to_new_remote()
        state = self.state(current="push")
        state["config"]["CHANGE_NAME"] = "nsa-storage-neighbor-fix"

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)


    def test_push_fact_allows_modified_foreign_openspec(self):
        foreign = "openspec/changes/resend-condition-change/change.md"
        write(self.repo, foreign, "# baseline foreign\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "foreign fixture")
        git(self.repo, "branch", "-f", "main", "HEAD")
        write(self.repo, foreign, "# modified foreign\n")
        git(self.repo, "add", foreign)
        git(self.repo, "commit", "-qm", "[REQ123][fix]foreign modify")
        self.push_to_new_remote()
        state = self.state(current="push")
        state["config"]["CHANGE_NAME"] = "nsa-storage-neighbor-fix"

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)


    def test_user_external_current_delivery_needs_no_agent_provenance(self):
        current = "openspec/changes/current-change/change.md"
        write(self.repo, current, "# user committed current delivery\n")
        git(self.repo, "add", "--", current)
        git(
            self.repo,
            "commit",
            "-qm",
            "[REQ123][fix]user external current delivery",
        )
        self.push_to_new_remote()
        state = self.state(current="push")
        self.assertFalse(os.path.exists(
            os.path.join(self.repo, ".mae-flow.json.agent-writes")))

        ok, why = mf.ev_pushed({}, state)

        self.assertTrue(ok, why)

    def test_archive_clean_checks_only_exact_current_outputs(self):
        stale = "openspec/changes/old/change.md"
        archive = (
            "openspec/changes/archive/2026-07-28-current-change/change.md")
        merged = "openspec/specs/runtime/spec.md"
        write(self.repo, stale, "# old\n")
        state = self.state(current="archive")
        self.mark_initial(state, stale)
        write(self.repo, archive, "# current\n")
        write(self.repo, merged, "# spec\n")
        state["spec"] = {
            "phase": "archived",
            "archived_to": "2026-07-28-current-change",
            "archive_paths": [
                "openspec/changes/archive/2026-07-28-current-change",
                merged,
            ],
        }
        ok, why = mf.ev_archive_paths_clean({}, state)
        self.assertFalse(ok)
        self.assertIn("本次定稿产物", why)
        self.assertNotIn(stale, why)

        git(self.repo, "add",
            "openspec/changes/archive/2026-07-28-current-change", merged)
        git(self.repo, "commit", "-qm", "[REQ123][fix]archive")
        ok, why = mf.ev_archive_paths_clean({}, state)
        self.assertTrue(ok, why)
        self.assertTrue(os.path.isfile(stale))

    def test_story_localize_unstages_and_corrects_wrong_directory(self):
        wrong = "openspec/changes/old/story-notes.md"
        write(self.repo, wrong, "# STORY-REQ123\n\n本地交测。\n")
        git(self.repo, "add", wrong)

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            destination = mf._localize_story("REQ123")

        self.assertFalse(os.path.exists(wrong))
        self.assertTrue(os.path.isfile(destination))
        self.assertTrue(destination.startswith(".mae-flow-work/story/"))
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only", "--", wrong))
        self.assertNotIn(".mae-flow-work", git(
            self.repo, "status", "--short", "--untracked-files=all"))
        exclude = git(self.repo, "rev-parse", "--git-path", "info/exclude")
        with open(os.path.join(self.repo, exclude), encoding="utf-8") as stream:
            self.assertIn("/.mae-flow-work/", stream.read())
        self.assertIn("错误目录", output.getvalue())

    def test_full_flow_can_canonicalize_one_wrong_story_before_evidence(self):
        wrong = "openspec/changes/current-change/notes.md"
        canonical = "docs/story/STORY-REQ123.md"
        write(self.repo, wrong, "# STORY-REQ123\n\n本单内容。\n")
        git(self.repo, "add", wrong)

        with contextlib.redirect_stdout(io.StringIO()):
            result = mf._canonicalize_story_output("REQ123")

        self.assertEqual(canonical, result)
        self.assertFalse(os.path.exists(wrong))
        self.assertTrue(os.path.isfile(canonical))
        self.assertEqual("", git(
            self.repo, "diff", "--cached", "--name-only", "--", wrong))

    def test_full_flow_does_not_adopt_unchanged_previous_story(self):
        wrong = "openspec/changes/old/notes.md"
        write(self.repo, wrong, "# STORY-REQ123\n\n上一单内容。\n")
        state = self.state(current="story")
        self.mark_initial(state, wrong)

        result = mf._canonicalize_story_output("REQ123", state)

        self.assertEqual("", result)
        self.assertTrue(os.path.isfile(wrong))
        self.assertFalse(os.path.exists("docs/story/STORY-REQ123.md"))


if __name__ == "__main__":
    unittest.main()

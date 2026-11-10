"""Reproduce early-written/committed domain docs and recover without deleting them."""
import contextlib
import copy
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from mae_flow_core.cli_parser import parse_args
from mae_flow_core.cli_commands import domain_archive as cli
from mae_flow_core.cli_commands import domain_archive_recovery as recovery
from mae_flow_core.cli_commands import selection_reconcile as selection
from mae_flow_core.orchestration.behavior_baseline import REQUIRED_DOMAIN_SECTIONS
from mae_flow_core.guard.manifest import validate_delivery_document_boundary


def document(suffix):
    return "# Cross RAT\n" + "\n".join("## " + title + "\n" + suffix for title in REQUIRED_DOMAIN_SECTIONS)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        before = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, before)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.root / "base").write_text("base")
        self.git("add", ".")
        self.git("commit", "-m", "baseline")
        self.git("checkout", "-b", "feature")
        self.specs = self.root / "docs/specs"
        self.specs.mkdir(parents=True)
        self.target = self.specs / "cross-rat.md"
        self.target.write_text(document("真实业务规则与已验证的长期事实。"))
        (self.specs / "index.md").write_text("# 领域索引\n\n| 领域 | 关键词 | 文档 |\n| --- | --- | --- |\n| cross-rat | RAT | docs/specs/cross-rat.md |\n")
        self.state = {"current": "end", "config": {"单号": "REQ-4", "基线分支": "main"},
                      "domain_archive": {"status": "applied", "result": "unchanged", "domains": [], "applied_paths": []}}
        self.saved = []
        self.api = SimpleNamespace(
            save_state=lambda value: self.saved.append(value),
            sh=lambda command: subprocess.check_output(command, shell=True, text=True).strip(),
            argv_out=lambda args: subprocess.check_output(args, text=True).strip(),
            _scope_diff=lambda state: ("main...HEAD", ""),
            _dirty_paths=lambda: self.git("ls-files", "--others", "--exclude-standard").splitlines()
                + self.git("diff", "--name-only", "HEAD").splitlines(),
            _authorization_message=lambda *_: (True, "确认归档", {"message_id": "m1"}, ""),
            die=lambda message, code=1: (_ for _ in ()).throw(RuntimeError(message)))
        for module in (cli, recovery, selection):
            patcher = mock.patch.object(module, "api", self.api)
            patcher.start()
            self.addCleanup(patcher.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL, text=True).strip()

    def command(self, *args):
        with contextlib.redirect_stdout(io.StringIO()):
            result = cli.cmd_domain_archive(self.state, parse_args(["domain-archive", *args]))
        if self.saved:
            self.state = self.saved[-1]
        return result

    def prepare(self):
        return self.command("prepare", "--domain", "cross-rat", "--adopt-existing", "--keyword", "RAT")

    def test_recover_committed_documents_then_reconcile_real_selection(self):
        self.git("add", "docs")
        self.git("commit", "-m", "early domain docs")
        package = cli.ensure_work_package(str(self.root), "REQ-4")
        self.state["domain_archive"]["input_sha256"] = cli._fresh_digest(str(self.root), package, ())
        before = self.target.read_bytes()
        self.assertEqual("unchanged", self.command("prepare", "--unchanged")["result"])
        prepared = self.prepare()
        self.assertEqual("prepared", prepared["status"])
        self.assertEqual([], prepared["applied_paths"])
        self.assertEqual(before, self.target.read_bytes())
        applied = self.command("apply", "--message-id", "m1")
        expected = ["docs/specs/cross-rat.md", "docs/specs/index.md"]
        self.assertEqual(expected, applied["applied_paths"])
        self.assertEqual(before, self.target.read_bytes())
        validate_delivery_document_boundary(expected, applied["applied_paths"])
        payload = {"head": self.git("rev-parse", "HEAD"), "paths": expected,
                   "excluded_paths": [], "task_id": "task-4", "waiting_id": "w", "actor": "owner"}
        with mock.patch.object(selection, "save_with_host_proof") as save, contextlib.redirect_stdout(io.StringIO()):
            selection.reconcile_selection(self.state, SimpleNamespace(file="receipt"),
                load_payload=lambda *_: payload, verify_host_proof=lambda *_: "nonce",
                capability=lambda *_: None, head=lambda: payload["head"], history=lambda *_: None,
                state_schema="mae-flow-delivery-loop/1")
        save.assert_called_once()
        self.assertTrue(self.state["delivery_manifest"]["confirmed"])
        self.assertEqual("end", self.state["current"])

    def test_committed_unchanged_candidate_is_reapplied_and_deliverable(self):
        self.git("add", "docs")
        self.git("commit", "-m", "prior round docs")
        self.state.pop("domain_archive")
        template = self.root / ".mae-flow-work/plugin-resources/assets/DOMAIN-SPEC-TEMPLATE.md"
        template.parent.mkdir(parents=True, exist_ok=True)
        template.write_text(document("模板"))
        self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT")
        prepared = self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT")
        self.assertEqual("unchanged", prepared["domains"][0]["action"])
        self.assertEqual("changes", prepared["result"])
        before = self.target.read_bytes()
        applied = self.command("apply", "--message-id", "m1")
        paths = ["docs/specs/cross-rat.md", "docs/specs/index.md"]
        self.assertEqual(paths, applied["applied_paths"])
        self.assertEqual(before, self.target.read_bytes())
        validate_delivery_document_boundary(paths, applied["applied_paths"])
        # 部署前已经 applied/unchanged 且丢失路径的现场也能原命令恢复。
        self.state["domain_archive"]["applied_paths"] = []
        self.state["domain_archive"]["result"] = "unchanged"
        self.state["domain_archive"].pop("reapply_paths", None)
        self.assertEqual(paths, self.command("apply", "--message-id", "m1")["applied_paths"])
        self.assertTrue(validate_delivery_document_boundary(["docs/specs/other.md"], paths))

    def test_later_round_keeps_other_domains_and_rechecks_all_candidates(self):
        (self.specs / "billing.md").write_text(document("真实计费业务规则与已经验证的长期事实。"))
        self.prepare()
        self.command("prepare", "--domain", "billing", "--adopt-existing", "--keyword", "billing")
        self.command("apply", "--message-id", "m1")
        self.git("add", "docs")
        self.git("commit", "-m", "prior round domains")
        template = self.root / ".mae-flow-work/plugin-resources/assets/DOMAIN-SPEC-TEMPLATE.md"
        template.parent.mkdir(parents=True, exist_ok=True)
        template.write_text(document("模板"))
        # 业务修订触发下一轮；只显式 prepare 一个领域，也不能遗失另一个。
        (self.root / "base").write_text("new business implementation")
        prepared = self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT")
        self.assertEqual({"billing", "cross-rat"}, {entry["domain"] for entry in prepared["domains"]})
        applied = self.command("apply", "--message-id", "m1")
        self.assertEqual(["docs/specs/billing.md", "docs/specs/cross-rat.md", "docs/specs/index.md"], applied["applied_paths"])
        validate_delivery_document_boundary(applied["applied_paths"], applied["applied_paths"])

    def test_unchanged_baseline_candidate_does_not_create_delivery_delta(self):
        self.git("add", "docs")
        self.git("commit", "-m", "baseline docs")
        self.git("branch", "-f", "main", "HEAD")
        self.state.pop("domain_archive")
        template = self.root / ".mae-flow-work/plugin-resources/assets/DOMAIN-SPEC-TEMPLATE.md"
        template.parent.mkdir(parents=True, exist_ok=True)
        template.write_text(document("模板"))
        self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT")
        self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT")
        applied = self.command("apply", "--message-id", "m1")
        self.assertEqual("unchanged", applied["result"])
        self.assertEqual([], applied["applied_paths"])

    def test_no_further_archive_edits_preserves_existing_documents(self):
        before = self.target.read_bytes()
        record = self.command("prepare", "--unchanged")
        self.assertEqual("unchanged", record["result"])
        self.assertEqual(before, self.target.read_bytes())

    def test_unchanged_is_still_valid_without_domain_changes(self):
        self.git("add", "docs")
        self.git("commit", "-m", "baseline docs")
        self.git("branch", "-f", "main", "HEAD")
        self.state.pop("domain_archive")
        result = self.command("prepare", "--unchanged")
        self.assertEqual("unchanged", result["result"])

    def test_candidate_changed_after_prepare_is_applied_from_current_content(self):
        prepared = self.prepare()
        candidate = self.root / prepared["domains"][0]["candidate_path"]
        candidate.write_text(document("候选在确认后变化。"))
        applied = self.command("apply")
        self.assertEqual(candidate.read_bytes(), self.target.read_bytes())
        self.assertIn("docs/specs/cross-rat.md", applied["changed_paths"])

    def test_reprepare_preserves_explicit_adoption(self):
        prepared = self.prepare()
        template = self.root / ".mae-flow-work/plugin-resources/assets/DOMAIN-SPEC-TEMPLATE.md"
        template.parent.mkdir(parents=True)
        template.write_text(document("模板"))
        candidate = self.root / prepared["domains"][0]["candidate_path"]
        candidate.write_text(document("核对后补充的领域事实。"))
        record = self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT")
        self.assertEqual(["docs/specs/cross-rat.md"], record["reapply_paths"])
        applied = self.command("apply", "--message-id", "m1")
        self.assertIn("docs/specs/cross-rat.md", applied["applied_paths"])

    def test_refusal_does_not_write_or_register_files(self):
        self.prepare()
        self.api._authorization_message = lambda *_: (True, "不同意", {}, "")
        with self.assertRaisesRegex(RuntimeError, "没有明确批准"):
            self.command("apply", "--message-id", "no")
        self.assertEqual([], self.state["domain_archive"]["applied_paths"])

    def test_template_gaps_are_advisory_not_adoption_authority(self):
        self.target.write_text("# 空文档")
        record = self.prepare()
        self.assertEqual("prepared", record["status"])
        self.assertEqual("# 空文档", self.target.read_text())

    def test_repeated_apply_preserves_bytes_and_uses_current_candidate_after_restart(self):
        from mae_flow_core.orchestration.behavior_baseline import render_domain_index
        index = self.specs / "index.md"
        index.write_text(render_domain_index(index.read_text(), [("cross-rat", ("RAT",))]))
        self.prepare()
        before = self.target.stat().st_mtime_ns
        applied = self.command("apply")
        self.assertEqual("unchanged", applied["result"])
        self.assertEqual([], applied["changed_paths"])
        self.assertTrue(applied["applied_paths"])
        self.assertEqual(before, self.target.stat().st_mtime_ns)
        self.git("add", "docs")
        self.git("commit", "-m", "code and docs are ordinary commits")
        (self.root / "cpp_sdk_repository").mkdir()
        (self.root / "cpp_sdk_repository/generated.hpp").write_text("build output")
        self.assertEqual(applied, self.command("apply"))
        self.assertEqual(applied, self.command("prepare", "--domain", "cross-rat", "--keyword", "RAT"))
        # JSON roundtrip simulates a restarted process; no ephemeral permission.
        import json
        self.state = json.loads(json.dumps(self.state))
        candidate = self.root / applied["domains"][0]["candidate_path"]
        candidate.write_text("# Updated by Agent\nActual new domain knowledge\n")
        result = self.command("apply")
        self.assertEqual("changes", result["result"])
        self.assertEqual(candidate.read_text(), self.target.read_text())
        self.assertIn("docs/specs/cross-rat.md", result["changed_paths"])

    def test_missing_candidate_does_not_erase_target_and_status_remains_readable(self):
        prepared = self.prepare()
        before = self.target.read_bytes()
        (self.root / prepared["domains"][0]["candidate_path"]).unlink()
        self.command("status")
        with self.assertRaisesRegex(RuntimeError, "领域归档失败"):
            self.command("apply")
        self.assertEqual(before, self.target.read_bytes())

    def test_prepare_new_domain_after_apply_is_not_ignored(self):
        self.prepare()
        self.command("apply")
        result = self.command("prepare", "--domain", "billing", "--keyword", "billing")
        self.assertEqual("draft", result["status"])
        self.assertEqual({"billing", "cross-rat"}, {e["domain"] for e in result["domains"]})
        candidate = next(e for e in result["domains"] if e["domain"] == "billing")
        (self.root / candidate["candidate_path"]).write_text(document("计费规则"))
        self.command("prepare", "--domain", "billing", "--keyword", "billing")
        self.command("apply")
        self.assertIn("计费规则", (self.specs / "billing.md").read_text())

    def test_prepare_new_keywords_after_apply_is_not_ignored(self):
        self.prepare()
        self.command("apply")
        result = self.command("prepare", "--domain", "cross-rat", "--keyword", "新的关键词")
        self.assertEqual("prepared", result["status"])
        self.assertEqual(["新的关键词"], result["domains"][0]["keywords"])

    def test_adopt_existing_uses_current_document_not_stale_candidate(self):
        previous = self.prepare()
        candidate = self.root / previous["domains"][0]["candidate_path"]
        candidate.write_text(document("候选中尚未采纳的修改"))
        self.target.write_text(document("人工更新的正式文档"))
        expected = self.target.read_bytes()
        self.prepare()
        self.command("apply")
        self.assertEqual(expected, self.target.read_bytes())
        self.assertEqual(expected, candidate.read_bytes())

    def test_repeated_apply_still_checks_explicit_refusal(self):
        self.prepare()
        self.command("apply")
        before = self.target.read_bytes()
        self.api._authorization_message = lambda *_: (True, "不同意", {}, "")
        with self.assertRaisesRegex(RuntimeError, "没有明确批准"):
            self.command("apply", "--message-id", "no")
        self.assertEqual(before, self.target.read_bytes())

    def test_human_selection_does_not_require_archive_provenance(self):
        payload = {"head": "sha", "paths": ["docs/specs/cross-rat.md"], "excluded_paths": [],
                   "task_id": "task-3", "waiting_id": "w", "actor": "owner"}
        with mock.patch.object(selection, "save_with_host_proof"):
            selection.reconcile_selection(self.state, SimpleNamespace(file="receipt"),
                load_payload=lambda *_: payload, verify_host_proof=lambda *_: "nonce",
                capability=lambda *_: None, head=lambda: "sha", history=lambda *_: None,
                state_schema="schema")
        self.assertEqual(payload["paths"], self.state["delivery_selection"]["paths"])

    def reconcile(self, payload):
        events = []
        with mock.patch.object(selection, "save_with_host_proof"), contextlib.redirect_stdout(io.StringIO()):
            selection.reconcile_selection(self.state, SimpleNamespace(file="receipt"),
                load_payload=lambda *_: payload, verify_host_proof=lambda *_: "nonce",
                capability=lambda *_: None, head=lambda: self.git("rev-parse", "HEAD"),
                history=lambda *args: events.append(args), state_schema="schema")
        return events

    def test_selection_reordering_preserves_decision_and_history(self):
        payload = {"head": self.git("rev-parse", "HEAD"),
                   "paths": ["docs/specs/index.md", "docs/specs/cross-rat.md"],
                   "excluded_paths": ["extra-b", "extra-a"],
                   "task_id": "task-4", "waiting_id": "w", "actor": "owner"}
        self.reconcile(payload)
        before = copy.deepcopy(self.state)
        reordered = dict(payload, paths=list(reversed(payload["paths"])),
                         excluded_paths=list(reversed(payload["excluded_paths"])))
        self.assertEqual([], self.reconcile(reordered))
        self.assertEqual(before, self.state)
        for key, value in (("waiting_id", "new-card"), ("actor", "other-owner"),
                           ("task_id", "task-5"), ("paths", ["base"]),
                           ("excluded_paths", ["extra-c"])):
            self.state = copy.deepcopy(before)
            self.assertTrue(self.reconcile(dict(reordered, **{key: value})), key)
        self.state = before
        with self.assertRaisesRegex(RuntimeError, "HEAD.*不一致"):
            self.reconcile(dict(reordered, head="old-sha"))

    def test_partial_rejection_preserves_unchanged_archive_and_repeat_apply(self):
        self.prepare()
        self.command("apply")
        self.git("add", "docs")
        self.git("commit", "-m", "archive baseline")
        # A completed adoption has provenance but no content delta.
        archive = self.state["domain_archive"]
        archive.update(result="unchanged", changed_paths=[], declined_paths=["docs/specs/older.md"])
        archive["reapply_paths"] = list(archive["applied_paths"])
        payload = {"head": self.git("rev-parse", "HEAD"), "paths": ["docs/specs/cross-rat.md"],
                   "excluded_paths": ["docs/specs/index.md"],
                   "task_id": "task-4", "waiting_id": "w", "actor": "owner"}
        self.reconcile(payload)
        record = self.state["domain_archive"]
        self.assertEqual("unchanged", record["result"])
        self.assertEqual([], record["changed_paths"])
        self.assertEqual(["docs/specs/cross-rat.md"], record["applied_paths"])
        self.assertEqual(["docs/specs/cross-rat.md"], record["reapply_paths"])
        self.assertEqual(["docs/specs/index.md", "docs/specs/older.md"], record["declined_paths"])
        package = cli.ensure_work_package(str(self.root), "REQ-4")
        self.assertEqual(cli._fresh_digest(str(self.root), package, cli._entries(str(self.root), record)),
                         record["input_sha256"])
        before = copy.deepcopy(record)
        with mock.patch.object(cli, "apply_candidates", side_effect=AssertionError("重复写入归档")):
            self.command("apply")
        self.assertEqual(before, self.state["domain_archive"])

    def test_partial_rejection_retains_only_actual_remaining_changes(self):
        self.prepare()
        self.command("apply")
        self.git("add", "docs")
        self.git("commit", "-m", "archive baseline")
        archive = self.state["domain_archive"]
        payload = {"head": self.git("rev-parse", "HEAD"), "paths": ["docs/specs/cross-rat.md"],
                   "excluded_paths": ["docs/specs/index.md"],
                   "task_id": "task-4", "waiting_id": "w", "actor": "owner"}
        for changed, expected in ((["docs/specs/index.md"], "unchanged"),
                                  (list(archive["applied_paths"]), "changes")):
            self.state["domain_archive"] = dict(archive, changed_paths=changed, result="changes")
            self.state.pop("delivery_selection", None)
            self.reconcile(payload)
            record = self.state["domain_archive"]
            self.assertEqual(expected, record["result"])
            self.assertNotIn("docs/specs/index.md", record["changed_paths"])


if __name__ == "__main__":
    unittest.main()

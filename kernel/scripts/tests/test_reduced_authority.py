"""Public CLI regression for the 2026-09-09 human-control contract."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import types
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from mae_flow_core.cli_commands.delivery_manifest import build_delivery_manifest, build_unchanged_delivery_manifest
from mae_flow_core.cli_commands import done_status
from mae_flow_core.workflow.advisories import pending_advisories


class ReducedAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.com')
        (self.root/'a.txt').write_text('before\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.git('checkout', '-qb', 'feature')
        self.state = {'current': 'build', 'config': {'单号': 'REQ1', '分支名': 'feature'},
                      'choices': {'workflow': 'full'}, 'history': [], 'initial_dirty': []}
        self.save()

    def tearDown(self):
        self.tmp.cleanup()

    def save(self):
        (self.root/'.mae-flow.json').write_text(json.dumps(self.state))

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.PIPE).decode().strip()

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS/'mae-flow.py'), *args],
                              cwd=self.root, capture_output=True, text=True, timeout=30)

    def test_local_preparation_needs_no_format_batch_or_machine_ownership_permit(self):
        (self.root/'a.txt').write_text('after\n')
        self.state['delivery_manifest'] = {'files': ['other.txt'], 'confirmed': True}
        self.state['external_repair_authorization'] = {'status': 'ready', 'failed_sha': self.git('rev-parse', 'HEAD')}
        self.save()
        commands = ['git add .', 'git add -A && git commit -m "test: 调整" 2>&1 | tail -5',
                    'git commit -am fix', 'git commit --pathspec-from-file=paths.txt -m fix',
                    'git commit -m one && git commit -m two', 'git rm --cached .mae-flow-dependencies.md',
                    'git add docs/specs/domain.md && git commit -m docs', 'cat .mae-flow.json',
                    'python -c "import subprocess; subprocess.run([\'git\',\'commit\',\'-m\',\'fix\'])"']
        for command in commands:
            with self.subTest(command=command):
                result = self.cli('gate', 'bash', command)
                self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.git('add', 'a.txt')
        self.git('commit', '-qm', 'arbitrary local message')
        self.assertEqual('after', (self.root/'a.txt').read_text().strip())
        persisted = json.loads((self.root/'.mae-flow.json').read_text())
        self.assertFalse(persisted.get('blocks'))

    def test_destructive_and_forged_fact_operations_are_still_denied_after_broad_add(self):
        commands = ['git add . && git push --force origin feature',
                    'git add -A && git reset --hard HEAD',
                    'git add . && git clean -xfd',
                    'printf fake > .mae-flow.json',
                    'python mae-flow.py pipeline record --verdict GREEN']
        for command in commands:
            with self.subTest(command=command):
                result = self.cli('gate', 'bash', command)
                self.assertEqual(2, result.returncode, result.stdout + result.stderr)

    def test_source_edits_wait_for_config_and_workflow_selection(self):
        self.state['current'] = 'workflow_select'; self.state['choices'] = {}; self.save()
        result = self.cli('gate', 'edit', 'src/main.cpp')
        self.assertEqual(2, result.returncode, result.stdout + result.stderr)
        self.assertIn("交付方式尚未选定", result.stdout + result.stderr)
        result = self.cli("gate", "bash", "printf code > main.ts")
        self.assertEqual(2, result.returncode, result.stdout + result.stderr)
        result = self.cli("gate", "edit", "requirement.md")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_selected_domain_and_process_files_are_preserved_with_findings(self):
        paths = ['docs/specs/domain.md', '.mae-flow-dependencies.md', 'a.txt']
        state = {'initial_dirty': ['a.txt']}
        manifest = build_delivery_manifest(state, paths, 'docs', 'main', repository_root=str(self.root))
        self.assertEqual(set(paths), set(manifest['files']))
        self.assertTrue(manifest['advisories'])
        self.assertFalse(manifest['confirmed'])  # Never manufacture user approval.
        for archive in ({}, {'status':'prepared'}, {'status':'applied','result':'changes',
                        'applied_paths':['docs/specs/missing.md']}):
            result = build_unchanged_delivery_manifest({'domain_archive':archive}, 'main', repository_root=str(self.root))
            self.assertTrue(result['no_changes'])

    def test_quality_failures_and_evaluator_errors_are_recorded_not_vetoes(self):
        state_path = str(self.root/'.mae-flow.json')
        step = {'evidence':[{'type':'verification_passed'}, {'type':'agent_ran'}, {'type':'domain_archive_complete'}]}
        def check(value, state):
            if value['evidence'] and value['evidence'][0]['type'] == 'agent_ran':
                raise RuntimeError('receipt unavailable')
            return ['质量尚有疑问'] if value['evidence'] else []
        fake_api = types.SimpleNamespace(check_evidence=check, _evidence_failure_count=mock.Mock())
        with mock.patch.object(done_status, 'api', fake_api), \
             mock.patch.object(done_status, 'STATE_PATH', state_path):
            done_status._done_require_evidence(step, self.state, mock.Mock(), 'build')
        findings = pending_advisories(state_path, 'build')
        self.assertEqual(3, len(findings))
        self.assertTrue(any('receipt unavailable' in item['message'] for item in findings))

    def test_done_advances_without_domain_archive_bookkeeping(self):
        self.state['current'] = 'domain_archive'; self.save()
        result = self.cli('done')
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual('delivery_review', json.loads((self.root/'.mae-flow.json').read_text())['current'])

    def test_missing_human_answer_and_unverified_pipeline_do_not_become_success(self):
        for step in ('open', 'story', 'hf_open', 'tw_open', 'delivery_review', 'external_verify'):
            with self.subTest(step=step):
                self.state['current'] = step
                self.save()
                result = self.cli('done')
                self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
                self.assertEqual(step, json.loads((self.root/'.mae-flow.json').read_text())['current'])

    def test_document_checks_are_not_executed_even_for_legacy_step_declarations(self):
        from mae_flow_core.workflow.authority import PROMPT_ONLY_EVIDENCE
        from mae_flow_core.workflow.execution_plan import _evidence_contract
        step = {'evidence': [{'type': kind} for kind in PROMPT_ONLY_EVIDENCE]
                + [{'type': 'pipeline_obligations_passed'}]}
        calls = []
        def check(value, state):
            kinds = [spec['type'] for spec in value['evidence']]
            calls.extend(kinds)
            self.assertEqual(['pipeline_obligations_passed'], kinds)
            return ['真实流水线未通过']
        def die(message, code):
            raise SystemExit(code)
        fake_api = types.SimpleNamespace(
            check_evidence=check, save_state=mock.Mock(), die=die,
            _evidence_failure_count=lambda *a, **k: 1, _moonlight=lambda state: False)
        with mock.patch.object(done_status, 'api', fake_api):
            with self.assertRaises(SystemExit) as error:
                done_status._done_require_evidence(step, self.state, mock.Mock(), 'external_verify')
        self.assertEqual(2, error.exception.code)
        self.assertEqual(['pipeline_obligations_passed'], calls)
        self.assertEqual(['pipeline_obligations_passed'],
                         [item['type'] for item in _evidence_contract(step)])

    def test_done_does_not_request_formal_review_materials_again(self):
        self.state['current'] = 'rf_triage'; self.save()
        result = self.cli('done')
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual('build', json.loads((self.root/'.mae-flow.json').read_text())['current'])
        self.assertNotIn('未找到证据文件', result.stdout + result.stderr)
        self.assertNotIn('裁决未闭环', result.stdout + result.stderr)
        self.assertFalse(any(item['kind'] in ('quality:glob', 'quality:content_free')
                             for item in pending_advisories(str(self.root/'.mae-flow.json'), 'rf_triage')))

    def test_explicit_spec_diagnostic_still_reports_missing_content(self):
        result = self.cli('local-spec', 'validate')
        self.assertEqual(2, result.returncode, result.stdout + result.stderr)
        self.assertIn('本地 Spec 缺少有效章节内容', result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

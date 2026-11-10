"""Real Git regression: an unchanged adoption is provenance, not a new delta."""
import os
import io
from contextlib import redirect_stdout
import sys
import tempfile
import types
import subprocess
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mae_flow_core.cli_commands.delivery_manifest import build_unchanged_delivery_manifest
from mae_flow_core.delivery.evidence import _unchanged_manifest_result, DeliveryEvidenceRules
from mae_flow_core.cli_commands.domain_archive import _show


class ArchiveCommittedManifestTests(unittest.TestCase):
    def test_adopt_committed_files_then_manifest_and_done_without_empty_commit(self):
        with tempfile.TemporaryDirectory() as root:
            def git(*args):
                return subprocess.check_output(['git', '-C', root, *args], stderr=subprocess.PIPE)
            git('init')
            git('config', 'user.email', 'test@example.com')
            git('config', 'user.name', 'Test')
            path = Path(root, 'docs/specs/cross-self-detect.md')
            path.parent.mkdir(parents=True)
            path.write_text('domain baseline\n')
            git('add', '.')
            git('commit', '-m', 'domain')
            archive = {'status': 'applied', 'result': 'changes',
                       'applied_paths': ['docs/specs/cross-self-detect.md'],
                       'domains': [{'action': 'unchanged'}]}
            state = {'domain_archive': archive}
            output = io.StringIO()
            entry = mock.Mock(domain='cross-self-detect', action='unchanged',
                              target_path='docs/specs/cross-self-detect.md',
                              candidate_path=str(path))
            archive['domains'][0]['candidate_path'] = str(path)
            with redirect_stdout(output), mock.patch(
                    'mae_flow_core.cli_commands.domain_archive.candidate_from_dict', return_value=entry):
                _show(archive, root)
            self.assertIn('归档结果: changes', output.getvalue())
            self.assertIn('不代表仍需新提交', output.getvalue())
            self.assertIn('候选内容 unchanged', output.getvalue())
            # Same-byte reapply preserves its provenance; manifest needs no commit.
            path.write_text('domain baseline\n')
            manifest = build_unchanged_delivery_manifest(state, 'main', repository_root=root)
            self.assertEqual(archive['result'], 'changes')
            self.assertTrue(manifest['committed_archive_receipt'])
            with mock.patch('mae_flow_core.delivery.archive_commit.os.getcwd', return_value=root):
                result = _unchanged_manifest_result(manifest, archive, [])
                self.assertTrue(result.passed, result)
                state['delivery_manifest'] = manifest
                rules = DeliveryEvidenceRules(types.SimpleNamespace(dirty_paths=lambda: []))
                self.assertTrue(rules.delivery_manifest_committed({}, state).passed)
                # Repeating the operation neither invalidates nor asks for approval.
                self.assertEqual(manifest, build_unchanged_delivery_manifest(state, 'main', repository_root=root))
                path.write_text('actual new content\n')
                self.assertFalse(_unchanged_manifest_result(manifest, archive, []).passed)
                with self.assertRaisesRegex(ValueError, '新增未提交'):
                    build_unchanged_delivery_manifest(state, 'main', repository_root=root, current_dirty=['docs/specs/cross-self-detect.md'])
                git('add', '.')
                with self.assertRaisesRegex(ValueError, '新增未提交'):
                    build_unchanged_delivery_manifest(state, 'main', repository_root=root, current_dirty=['docs/specs/cross-self-detect.md'])
                git('commit', '-m', 'changed domain')
                self.assertFalse(_unchanged_manifest_result(manifest, archive, []).passed)
                refreshed = build_unchanged_delivery_manifest(state, 'main', repository_root=root)
                self.assertTrue(_unchanged_manifest_result(refreshed, archive, []).passed)
                path.unlink()
                self.assertFalse(_unchanged_manifest_result(refreshed, archive, []).passed)

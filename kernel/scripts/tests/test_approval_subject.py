"""场景回归：内容、SHA、清单和会话变化均不制造新的人工确认。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]


class ApprovalPolicyTests(unittest.TestCase):
    def test_actual_answer_survives_content_commit_and_legacy_snapshot(self):
        for scene in ('stale-content', 'commit', 'manifest', 'legacy-request', 'no-snapshot'):
            with self.subTest(scene=scene), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                def git(*args):
                    return subprocess.check_output(['git', '-C', folder, *args], stderr=subprocess.PIPE, text=True).strip()
                git('init', '-q', '-b', 'main')
                git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test')
                (root/'a.txt').write_text('initial\n')
                git('add', 'a.txt'); git('commit', '-qm', 'initial')
                state = {'current': 'delivery_review', 'revision': 1,
                         'config': {'分支名': 'main', '基线分支': 'main', '单号': 'REQ5'},
                         'choices': {}, 'history': [], 'implementation_base_head': git('rev-parse', 'HEAD'),
                         'approval_subject': {'step': 'delivery_review', 'sha256': 'a'*64, 'id': 'a'*16}}
                (root/'a.txt').write_text('final change\n')
                if scene == 'commit':
                    git('add', 'a.txt'); git('commit', '-qm', 'final change')
                if scene == 'manifest': state['delivery_manifest'] = {'files': ['a.txt']}
                if scene == 'legacy-request': state['approval_request'] = {'step': 'delivery_review', 'subject_id': 'a'*16}
                if scene == 'no-snapshot': state.pop('approval_subject')
                (root/'.mae-flow.json').write_text(json.dumps(state))
                (root/'.mae-flow.json.usermsg').write_text(json.dumps([{
                    'id': 'actual-answer', 'step': 'delivery_review', 'at': '2099-01-01 00:00:00',
                    'text': json.dumps({'answers': {'交付是否确认': '交付增量无需调整，确认推送'}}, ensure_ascii=False),
                    'approval_subject_sha256': 'b'*64, 'approval_subject_id': 'b'*16}]))
                for command in ('current', 'done'):
                    result = subprocess.run([sys.executable, str(SCRIPTS/'mae-flow.py'), command], cwd=root,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(0, result.returncode, result.stdout + result.stderr)
                after = json.loads((root/'.mae-flow.json').read_text())
                self.assertEqual('push', after['current'])
                self.assertNotIn('approval_request', after)
                self.assertNotIn('approval_subject', after)


if __name__ == '__main__':
    unittest.main()

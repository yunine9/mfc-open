"""Owner input provenance survives document generation without a semantic gate."""
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from mae_flow_core import cli_runtime  # noqa: F401
from mae_flow_core.cli_commands.role_task import _story_context
from mae_flow_core.cli_commands.delivery_support import render_delivery_feedback
from mae_flow_core.application.quality.role_task_documents import RoleTaskContext, build_role_task_document

class OwnerInputContextTest(unittest.TestCase):
    def test_task21_new_answer_precedes_old_spec_and_demotes_target_without_rewinding(self):
        before = os.getcwd()
        with tempfile.TemporaryDirectory() as room:
            os.chdir(room)
            try:
                root = Path('.mae-flow-work/REQ21'); root.mkdir(parents=True)
                (root / 'spec.md').write_text('BEH-4：虚拟化直接返回 false，不执行脚本', encoding='utf8')
                (root / 'decisions.md').write_text('D1：b3 推翻 e5，执行 queryENE.sh 取等效数', encoding='utf8')
                Path('.mae-flow-work/owner-inputs.json').write_text(json.dumps({'instructions': [
                    {'id': 'e5', 'text': '旧方案：不执行脚本'},
                    {'id': 'b3', 'text': '最终答复：执行 queryENE.sh 取等效数'}]}), encoding='utf8')
                state = {'current': 'build', 'config': {'单号': 'REQ21'}, 'delivery_loop': {
                    'target': {'target': '虚拟化统一不支持 airan', 'request_id': 'e5'}}}
                original = copy.deepcopy(state)
                _, paths = _story_context(state, 'story-review')
                self.assertTrue(paths[0].endswith('owner-inputs.json'))
                self.assertLess(next(i for i,p in enumerate(paths) if p.endswith('decisions.md')),
                                next(i for i,p in enumerate(paths) if p.endswith('spec.md')))
                rendered = render_delivery_feedback(state)
                self.assertIn('已有后续用户输入', rendered)
                self.assertIn('需判断是否仍适用', rendered)
                self.assertEqual(state, original, '展示新事实不篡改目标/反馈账，不重走配置')
                for role in ('story-generate', 'story-review'):
                    card = build_role_task_document(role=role, project_root=room, ticket='REQ21', context=RoleTaskContext(context_paths=paths)).body()
                    self.assertIn('点名受影响 BEH/TC', card)
                    self.assertIn('不新增门禁', card)
                    self.assertIn('旧 Spec 不能压过较新的明确答复', card)
            finally:
                os.chdir(before)

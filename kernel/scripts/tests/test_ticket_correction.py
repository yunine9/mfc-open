"""Metadata correction keeps code/decisions and retains an audit snapshot."""
import contextlib
import copy
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mae_flow_core.cli_commands import ticket_correction as command


class TicketCorrectionTests(unittest.TestCase):
    def run_correction(self, state, payload, changed=False):
        def die(message, _code):
            raise ValueError(message)
        fake = SimpleNamespace(sh=lambda cmd: ('different' if changed and 'b' * 40 in cmd else 'tree'), die=die)
        proof = mock.Mock(return_value={'proof': 'host'})
        with mock.patch.object(command, 'api', fake), mock.patch.object(command, 'verify_feedback_facts'), \
                mock.patch.object(command, 'save_with_host_proof') as save, contextlib.redirect_stdout(io.StringIO()):
            command.correct_ticket(state, SimpleNamespace(file='payload'), load_payload=lambda *_: payload,
                                   verify_host_proof=proof, history=lambda *_: None)
        proof.assert_called_once()
        self.assertEqual(proof.call_args.args[2], 'ticket-correction')
        save.assert_called_once()

    def test_keeps_phase_decisions_original_evidence_and_is_idempotent(self):
        old, new = 'a' * 40, 'b' * 40
        state = {'config': {'单号': 'REQ1', '分支名': 'work_REQ1'}, 'current': 'delivery_watch',
                 'quality': {'external_verification': {'sha': old, 'verdict': 'PASS'}},
                 'delivery_loop': {'published': {'sha': old, 'receipt': {'ref': 'refs/heads/work_REQ1'}}},
                 'history': [{'sha': old}], 'step_heads': {'build': old}}
        original = copy.deepcopy(state)
        payload = {'id': 'one', 'old_ticket': 'REQ1', 'ticket': 'REQ2', 'old_branch': 'work_REQ1',
                   'branch': 'work_REQ2', 'sha_map': {old: new}}
        self.run_correction(state, payload)
        self.run_correction(state, payload)
        self.assertEqual(state['current'], original['current'])
        self.assertEqual(state['history'], original['history'])
        self.assertEqual(state['quality']['external_verification'], {'sha': new, 'verdict': 'PASS'})
        self.assertEqual(state['delivery_loop']['published']['receipt']['ref'], 'refs/heads/work_REQ2')
        self.assertEqual(len(state['ticket_corrections']), 1)
        self.assertEqual(state['ticket_corrections'][0]['original']['quality'], original['quality'])

    def test_does_not_invent_a_pass(self):
        state = {'config': {'单号': 'REQ1'}, 'current': 'build', 'quality': {'compile': {'result': 'failed'}}}
        self.run_correction(state, {'id': 'two', 'old_ticket': 'REQ1', 'ticket': 'REQ2'})
        self.assertEqual(state['quality'], {'compile': {'result': 'failed'}})
        self.assertEqual(state['current'], 'build')

    def test_rejects_code_changes(self):
        state = {'config': {'单号': 'REQ1'}}
        with self.assertRaisesRegex(ValueError, '不能改变代码'):
            self.run_correction(state, {'id': 'three', 'old_ticket': 'REQ1', 'ticket': 'REQ2',
                                       'sha_map': {'a' * 40: 'b' * 40}}, changed=True)
        self.assertEqual(state['config']['单号'], 'REQ1')

    def test_wrong_task_ticket_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '当前任务不一致'):
            self.run_correction({'config': {'单号': 'REQ_OTHER'}},
                                {'id': 'four', 'old_ticket': 'REQ1', 'ticket': 'REQ2'})


if __name__ == '__main__':
    unittest.main()

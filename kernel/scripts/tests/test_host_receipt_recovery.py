"""Fault injection at both sides of the state/receipt commit boundary."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mae_flow_core.cli_commands import host_receipts as receipts


class ReceiptRecoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.state_path = self.root / 'state.json'
        self.state = {'current': 'delivery_watch', 'delivery_loop': {'active_batch_id': 'b1'}}
        self.context = {'root': str(self.root), 'proof': {
            'nonce': 'one', 'task_id': 'task-test', 'action': 'feedback-open'}, 'payload': {}}
        self.state_path.write_text(json.dumps(self.state))
        for patcher in [
            mock.patch.object(receipts, 'STATE_PATH', str(self.state_path)),
            mock.patch.object(receipts, '_die', side_effect=lambda msg: (_ for _ in ()).throw(RuntimeError(msg))),
            mock.patch.object(receipts, '_refresh_pulse'),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def save(self, state):
        self.state_path.write_text(json.dumps(state))

    def recover(self):
        staged = next(self.root.glob('*.staged'))
        # Signature validation has separate real-RSA integration coverage.
        with mock.patch.object(receipts, '_valid_stored_receipt', side_effect=lambda a, r, action, p: r['projection'] == p):
            receipts._recover_staged_receipt(str(staged), {})
        return staged, Path(str(staged)[:-7])

    def test_saved_state_recovers_after_rename_failure(self):
        with mock.patch.object(receipts, 'api', SimpleNamespace(save_state=self.save)), mock.patch.object(receipts.os, 'rename', side_effect=OSError('disk fault')):
            with self.assertRaises(RuntimeError):
                receipts.save_with_host_proof(self.state, self.context)
        self.assertEqual(json.loads(self.state_path.read_text())['host_capability_nonces'], ['one'])
        staged, final = self.recover()
        self.assertFalse(staged.exists())
        self.assertTrue(final.exists())

    def test_failed_save_cannot_be_recovered_from_in_memory_nonce(self):
        with mock.patch.object(receipts, 'api', SimpleNamespace(save_state=mock.Mock(side_effect=OSError('before save')))):
            with self.assertRaises(OSError):
                receipts.save_with_host_proof(self.state, self.context)
        staged, final = self.recover()
        self.assertTrue(staged.exists())
        self.assertFalse(final.exists())

    def test_save_failure_after_replacement_retains_recoverable_journal(self):
        def save_then_fail(state):
            self.save(state)
            raise OSError('after atomic replacement')
        with mock.patch.object(receipts, 'api', SimpleNamespace(save_state=save_then_fail)):
            with self.assertRaises(OSError):
                receipts.save_with_host_proof(self.state, self.context)
        self.assertTrue(self.recover()[1].exists())

    def test_large_snapshot_has_no_history_size_veto(self):
        state = {'delivery_loop': {'batches': [{'summary': 'x' * 600000}]}}
        with mock.patch.object(receipts.sys, 'stdin', io.StringIO(json.dumps(state))):
            self.assertEqual(receipts._snapshot_from_stdin(), state)

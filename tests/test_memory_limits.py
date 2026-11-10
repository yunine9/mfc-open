"""资源保护需要能结束真实失控子进程，而不仅是返回一次超时。"""
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'harness'))
from memory_limits import ResourceGuard, limit_address_space
from memory_embedding import onnx_options


class LimitTests(unittest.TestCase):
    def test_memory_and_active_deadline_exit_without_logging_content(self):
        events, exits = [], []
        guard = ResourceGuard(events.append, sample=lambda: 101, terminate=exits.append, rss_limit=100, grace_seconds=0)
        guard.check()
        self.assertEqual(exits, [75])
        self.assertIn('memory_limit', events[0])
        guard.sample = lambda: 0
        with guard.active(0):
            with patch('memory_limits.time.monotonic', return_value=time.monotonic() + 2):
                guard.check()
        self.assertEqual(exits, [75, 75])
        self.assertIn('active_deadline', events[-1])
        guard.check()
        self.assertEqual(len(exits), 2, '空闲时不按过期请求杀进程')

    def test_nested_reads_cannot_erase_parent_deadline(self):
        guard = ResourceGuard(lambda _: None, sample=lambda: 0)
        with guard.active(10):
            first = guard.deadlines[:]
            with guard.active(1):
                self.assertEqual(len(guard.deadlines), 2)
            self.assertEqual(guard.deadlines, first)
        self.assertEqual(guard.deadlines, [])

    def test_real_watchdog_ends_blocked_work(self):
        env = {**os.environ, 'PYTHONPATH': str(Path(__file__).parents[1] / 'harness')}
        result = subprocess.run([sys.executable, '-c', '''
import time
from memory_limits import ResourceGuard
g = ResourceGuard(lambda message: print(message, flush=True), grace_seconds=0)
g.start()
with g.active(.02):
    time.sleep(10)
'''], env=env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn('active_deadline', result.stdout)

    def test_linux_address_limit_never_raises_existing_limit(self):
        import resource
        with patch('memory_limits.sys.platform', 'linux'), patch('memory_limits.resource.getrlimit', return_value=(12345, resource.RLIM_INFINITY)), patch('memory_limits.resource.setrlimit') as set_limit:
            limit_address_space()
        set_limit.assert_called_once_with(resource.RLIMIT_AS, (12345, 12345))

    def test_real_watchdog_ends_memory_growth(self):
        env = {**os.environ, 'PYTHONPATH': str(Path(__file__).parents[1] / 'harness')}
        result = subprocess.run([sys.executable, '-c', '''
import time
from memory_limits import ResourceGuard, resident_bytes
g = ResourceGuard(lambda message: print(message, flush=True), rss_limit=resident_bytes()+8*1024**2)
g.start()
data = bytearray(32*1024**2)
time.sleep(10)
'''], env=env, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn('memory_limit', result.stdout)

    def test_onnx_settings_are_scoped_and_disable_peak_retention(self):
        seen = []
        def original(path, **kw):
            seen.append(kw['sess_options'])
            return object()
        fake = SimpleNamespace(InferenceSession=original, SessionOptions=SimpleNamespace)
        with patch.dict(sys.modules, {'onnxruntime': fake}):
            with onnx_options('onnx'):
                fake.InferenceSession('model')
            self.assertIs(fake.InferenceSession, original)
        self.assertFalse(seen[0].enable_cpu_mem_arena)
        self.assertFalse(seen[0].enable_mem_pattern)
        self.assertEqual(seen[0].intra_op_num_threads, 2)


if __name__ == '__main__': unittest.main()

"""检索子进程的资源边界；原文不受索引进程退出影响。"""
import os
import resource
import sys
import threading
import time
from contextlib import contextmanager

MAX_RSS_BYTES = 4 * 1024**3
MAX_ADDRESS_BYTES = 8 * 1024**3
MAX_ACTIVE_SECONDS = 60


def resident_bytes():
    if sys.platform == "linux":
        values = {}
        with open('/proc/self/status', encoding='ascii') as stream:
            for line in stream:
                if line.startswith(('VmRSS:', 'VmSwap:')):
                    name, value, *_ = line.split()
                    values[name] = int(value) * 1024
        return sum(values.values())
    # macOS 的 ru_maxrss 单位为字节，是峰值；保守地按峰值保护本地验证。
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == 'darwin' else peak * 1024


def limit_address_space():
    if sys.platform != 'linux':
        return
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    ceiling = min(MAX_ADDRESS_BYTES, hard) if hard != resource.RLIM_INFINITY else MAX_ADDRESS_BYTES
    if soft != resource.RLIM_INFINITY:
        ceiling = min(ceiling, soft)
    resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))


class ResourceGuard:
    def __init__(self, log, *, sample=resident_bytes, terminate=os._exit,
                 rss_limit=MAX_RSS_BYTES, grace_seconds=5.0):
        self.log, self.sample, self.terminate = log, sample, terminate
        self.rss_limit, self.grace_seconds = rss_limit, grace_seconds
        self.deadlines = []
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.thread = None

    @contextmanager
    def active(self, seconds):
        deadline = time.monotonic() + min(max(seconds, 0), MAX_ACTIVE_SECONDS) + self.grace_seconds
        with self.lock:
            self.deadlines.append(deadline)
        try:
            yield
        finally:
            with self.lock:
                self.deadlines.remove(deadline)

    def check(self):
        rss = self.sample()
        with self.lock:
            expired = bool(self.deadlines) and time.monotonic() > min(self.deadlines)
        if rss > self.rss_limit or expired:
            reason = 'memory_limit' if rss > self.rss_limit else 'active_deadline'
            self.log(f'检索资源保护: reason={reason} rss_bytes={rss} limit_bytes={self.rss_limit}; 终止子进程')
            self.terminate(75)

    def start(self):
        def watch():
            while not self.stopped.wait(.25):
                try:
                    self.check()
                except OSError as error:
                    self.log(f'检索资源采样失败: {type(error).__name__}')
        self.thread = threading.Thread(target=watch, daemon=True)
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=1)

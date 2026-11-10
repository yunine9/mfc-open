"""Single database owner, bounded priority queue and per-request diagnostics."""
import contextvars
import itertools
import heapq
import math
import json
import queue
import threading
import time
from contextlib import contextmanager, nullcontext

CURRENT = contextvars.ContextVar("memory_request", default=None)


class Request:
    def __init__(self, payload):
        self.payload = payload
        self.started = time.monotonic()
        self.deadline = float(payload.get("deadline_ms", time.time() * 1000 + 60_000)) / 1000
        self.timings = {}

    def remaining(self):
        seconds = self.deadline - time.time()
        if seconds <= 0:
            raise TimeoutError("request deadline exceeded")
        return seconds


@contextmanager
def phase(name):
    started = time.monotonic()
    try:
        yield
    finally:
        request = CURRENT.get()
        if request:
            request.timings[name] = request.timings.get(name, 0) + round((time.monotonic() - started) * 1000, 2)


def check_deadline():
    request = CURRENT.get()
    if request:
        request.remaining()


class BoundedClient:
    """Apply an RPC deadline even to memsearch's internal store calls."""
    def __init__(self, client):
        self.client = client

    def __getattr__(self, name):
        method = getattr(self.client, name)
        if name not in {"create_collection", "delete", "describe_collection", "drop_collection",
                        "get_collection_stats", "has_collection", "hybrid_search", "load_collection",
                        "query", "search", "upsert"}:
            return method
        def call(*args, **kwargs):
            request = CURRENT.get()
            timeout = min(10.0, request.remaining()) if request else 10.0
            if kwargs.get("timeout") is not None:
                timeout = min(timeout, kwargs["timeout"])
            kwargs["timeout"] = timeout
            with phase("database_ms"):
                return method(*args, **kwargs)
        return call


@contextmanager
def local_client_options():
    # memsearch 0.4.19 doesn't expose grpc_options. Scope the factory override
    # strictly to startup in this isolated, single-threaded child; restore it
    # before accepting requests. Never edit installed dependency files.
    import pymilvus
    original = pymilvus.MilvusClient
    def create(*args, **kwargs):
        options = dict(kwargs.pop("grpc_options", {}) or {})
        options.update({"grpc.keepalive_permit_without_calls": False,
                        "grpc.keepalive_time_ms": 300_000})
        kwargs["grpc_options"] = options
        kwargs.setdefault("timeout", 10.0)
        return BoundedClient(original(*args, **kwargs))
    pymilvus.MilvusClient = create
    try:
        yield
    finally:
        pymilvus.MilvusClient = original


class Scheduler:
    def __init__(self, sidecar, reply, log, capacity=128, guard=None):
        self.sidecar, self.reply, self.log = sidecar, reply, log
        self.guard = guard
        self.queue = queue.PriorityQueue(maxsize=capacity)
        self.sequence = itertools.count()
        self.indexing = set()
        self.closed = False
        sidecar.schedule_index = self.schedule_index
        sidecar.yield_reads = self.yield_reads

    def submit(self, req):
        for field in ("deadline_ms", "sent_at_ms"):
            if field in req and (not isinstance(req[field], (int, float)) or not math.isfinite(req[field])):
                self.reply({"id": req.get("id"), "error": "请求时间字段无效"})
                return
        priority = 0 if req.get("op") in ("search", "health", "expand") else 1
        try:
            self.queue.put_nowait((priority, next(self.sequence), req))
        except queue.Full:
            self.reply({"id": req.get("id"), "error": "检索队列繁忙，请稍后重试"})

    def schedule_index(self, path):
        key = str(path)
        if key in self.indexing:
            return
        try:
            self.queue.put_nowait((2, next(self.sequence), {"op": "ingest", "path": key, "background": True}))
            self.indexing.add(key)
        except queue.Full:
            pass  # A later search retries missing sources; never claim indexed.

    async def yield_reads(self):
        check_deadline()
        # Bound each interleave so a busy reader cannot starve indexing forever.
        for _ in range(8):
            # Peek and remove atomically; a concurrent stdin writer cannot fill
            # the slot between removing a background job and putting it back.
            with self.queue.mutex:
                if not self.queue.queue or self.queue.queue[0][0] != 0:
                    return
                item = heapq.heappop(self.queue.queue)
                self.queue.not_full.notify()
            await self.execute(item[2])
        check_deadline()

    async def execute(self, req):
        request = Request(req)
        request.timings["queue_ms"] = max(0, round(time.time() * 1000 - req.get("sent_at_ms", time.time() * 1000), 2))
        token = CURRENT.set(request)
        outcome = "ok"
        try:
            check_deadline()
            op = req.get("op")
            if op not in ("search", "ingest", "reindex", "health", "expand", "remove"):
                raise ValueError("unknown operation")
            with self.guard.active(request.remaining()) if self.guard else nullcontext():
                result = await getattr(self.sidecar, op)(req)
            check_deadline()
            if result.get("pending_sources"):
                request.timings["pending_sources"] = result["pending_sources"]
            if not req.get("background"):
                self.reply({"id": req.get("id"), **result})
            outcome = "error" if result.get("error") else "partial" if result.get("pending_sources") else "ok"
        except Exception as error:
            outcome = type(error).__name__
            if not req.get("background"):
                self.reply({"id": req.get("id"), "error": f"{type(error).__name__}: {error}"})
        finally:
            if req.get("background"):
                self.indexing.discard(req["path"])
            # No query, content, source path or credentials in timing logs.
            work_ms = round((time.monotonic() - request.started) * 1000, 2)
            if self.guard:
                try:
                    request.timings['rss_bytes'] = self.guard.sample()
                except OSError:
                    pass
            self.log(json.dumps({"event": "memory_request", "id": req.get("id"), "op": req.get("op"),
                                 "outcome": outcome, "work_ms": work_ms,
                                 "total_ms": round(work_ms + request.timings["queue_ms"], 2),
                                 **request.timings}, ensure_ascii=False))
            CURRENT.reset(token)

    async def run(self, stream):
        def read():
            for line in stream:
                try:
                    req = json.loads(line)
                    if not isinstance(req, dict):
                        raise ValueError("request must be an object")
                    self.submit(req)
                except (ValueError, TypeError):
                    self.reply({"id": None, "error": "请求不是 JSON 对象"})
            self.closed = True
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        while not self.closed or not self.queue.empty():
            try:
                _, _, req = self.queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if self.closed and req.get("background"):
                continue
            await self.execute(req)

#!/usr/bin/env python3
"""SSE MCP 客户端：GET /sse 长连接 + POST /messages/ JSON-RPC + SSE 流读结果。

协议要点（实测总结）：
1. GET /sse → chunked 响应，endpoint 事件含 session_id
2. POST /messages/?session_id=xxx → initialize + notifications/initialized
3. POST /messages/?session_id=xxx → tools/call
4. 结果在 GET /sse 流上以 message 事件返回，按 JSON-RPC id 匹配
5. download_build_task_log 返回后，日志在 logHost/logs/build_log_{rid}.txt

实测踩坑(2026-08-21)：
- HTTPS 请求后 SSE 连接偶尔慢启动，connect 超时要从 10s 提到 20s + retry
- download_build_task_log 的日志要用 noproxy 的 opener 下载，否则 407
- exec python3 内联脚本里 __file__=<stdin>，sys.path.insert 要硬编码

2026-08-28 收编进仓版本化(逻辑照搬内网实测版,零改动):仅 __main__
自测段泛化——个人路径与真实 MR 链接不进仓,改从环境变量/参数读:
  python3 mcp_sse_client.py <mr_url> [host] [port]
  (token 文件走 MFC_MCP_TOKEN_FILE，生产优先
   /etc/mae-flow-cloud/mcp-token，旧开发机路径作兼容降级)
"""
import socket, http.client, json, re, time, urllib.request, sys

class SSEMcpClient:
    def __init__(self, host, port, timeout=30):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.session_id = None
        self._sock = None
        self._reader = None
        self._next_id = 0

    def connect(self, retries=3):
        """GET /sse，读 endpoint 事件拿 session_id（带重试）"""
        for attempt in range(retries):
            try:
                return self._connect_once()
            except RuntimeError:
                if attempt < retries - 1:
                    time.sleep(2 * (attempt + 1))
                else:
                    raise

    def _connect_once(self):
        self._sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self._sock.sendall(
            b"GET /sse HTTP/1.1\r\nHost: %s:%d\r\nAccept: text/event-stream\r\n\r\n"
            % (self.host.encode(), self.port))
        self._reader = _SSEReader(self._sock)
        self._reader.read_headers()

        # 读 endpoint 事件——SSE 网关偶尔慢启动，给足时间
        self._sock.settimeout(20)
        try:
            while True:
                chunk = self._sock.recv(8192)
                if not chunk:
                    break
                self._reader.buf += chunk
                text = self._reader.get_text()
                match = re.search(r'session_id=([a-f0-9]+)', text)
                if match:
                    self.session_id = match.group(1)
                    return self.session_id
        except socket.timeout:
            pass
        raise RuntimeError("No session_id from SSE endpoint")

    def initialize(self):
        """MCP 握手：initialize + notifications/initialized"""
        self._post({"jsonrpc": "2.0", "id": self._next_id, "method": "initialize",
                     "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "mfc-adapter", "version": "1.0"}}})
        self._next_id += 1
        time.sleep(0.3)
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        time.sleep(0.3)
        # 读 initialize 响应
        self._reader.read_until_id(0, timeout=15)

    def call_tool(self, tool_name, arguments, timeout=60):
        """调 MCP 工具，返回 JSON-RPC result"""
        rid = self._next_id
        self._next_id += 1
        self._post({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                     "params": {"name": tool_name, "arguments": arguments}})
        resp = self._reader.read_until_id(rid, timeout=timeout)
        if resp:
            return resp.get("result", {})
        return None

    def list_tools(self):
        rid = self._next_id
        self._next_id += 1
        self._post({"jsonrpc": "2.0", "id": rid, "method": "tools/list", "params": {}})
        resp = self._reader.read_until_id(rid, timeout=15)
        if resp:
            return resp.get("result", {}).get("tools", [])
        return []

    def download_build_logs(self, record_ids, x_auth_groups, x_auth_token, download_dir=None):
        """调 download_build_task_log + 下载日志文件

        返回: [(record_id, file_path_or_text_or_None), ...]
        """
        result = self.call_tool("download_build_task_log", {
            "record_ids": record_ids,
            "x_auth_groups": x_auth_groups,
            "x_auth_token": x_auth_token,
        }, timeout=60)

        content = result.get("content", [])
        success_text = ""
        for c in content:
            if c.get("type") == "text":
                success_text += c.get("text", "")

        if "Successfully" not in success_text and "Download completed" not in success_text:
            return [(rid, None) for rid in record_ids]

        time.sleep(3)
        downloaded = []
        proxy_handler = urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(proxy_handler)

        for rid in record_ids:
            log_url = f"http://{self.host}:{self.port}/logs/build_log_{rid}.txt"
            try:
                resp = opener.open(log_url, timeout=15)
                log_text = resp.read().decode("utf-8", errors="replace")

                if download_dir:
                    import os
                    os.makedirs(download_dir, exist_ok=True)
                    fpath = os.path.join(download_dir, f"build_log_{rid}.txt")
                    with open(fpath, "w") as f:
                        f.write(log_text)
                    downloaded.append((rid, fpath))
                else:
                    downloaded.append((rid, log_text))
            except Exception:
                downloaded.append((rid, None))

        return downloaded

    def get_mr_pipeline_info(self, mr_url):
        """调 get_mr_pipeline_info，返回解析后的 dict"""
        result = self.call_tool("get_mr_pipeline_info", {"url": mr_url})
        content = result.get("content", [])
        for c in content:
            if c.get("type") == "text":
                try:
                    return json.loads(c["text"])
                except json.JSONDecodeError:
                    return {"raw_text": c["text"]}
        return None

    def close(self):
        if self._sock:
            try:
                self._sock.close()
            except:
                pass

    def _post(self, msg):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=15)
        conn.request("POST", f"/messages/?session_id={self.session_id}",
                     body=json.dumps(msg), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        resp.read()
        conn.close()
        return resp.status


class _SSEReader:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self._body_offset = None

    def read_headers(self):
        """读 HTTP 头部，定位 body 起始"""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(8192)
            if not chunk:
                break
            self.buf += chunk
        idx = self.buf.find(b"\r\n\r\n")
        if idx != -1:
            self._body_offset = idx + 4

    def get_text(self):
        if self._body_offset is None:
            return ""
        return self._parse_chunked(self.buf[self._body_offset:])

    def read_until_id(self, target_id, timeout=30):
        """读 SSE 流，返回匹配 JSON-RPC id 的响应"""
        self.sock.settimeout(timeout)
        while True:
            chunk = self.sock.recv(8192)
            if not chunk:
                return None
            self.buf += chunk
            if self._body_offset is None:
                idx = self.buf.find(b"\r\n\r\n")
                if idx != -1:
                    self._body_offset = idx + 4
            if self._body_offset is not None:
                text = self._parse_chunked(self.buf[self._body_offset:])
                for event_block in text.split("\n\n"):
                    for line in event_block.split("\n"):
                        if line.startswith("data:"):
                            data_str = line[5:].strip()
                            if not data_str:
                                continue
                            try:
                                d = json.loads(data_str)
                                if d.get("id") == target_id:
                                    return d
                            except json.JSONDecodeError:
                                pass

    @staticmethod
    def _parse_chunked(data):
        text, pos = b"", 0
        while pos < len(data):
            end = data.find(b"\r\n", pos)
            if end == -1:
                text += data[pos:]
                break
            s = data[pos:end].decode("utf-8", errors="replace").strip()
            if not s:
                pos = end + 2
                continue
            try:
                cs = int(s, 16)
            except ValueError:
                text += data[pos:]
                break
            if cs == 0:
                break
            pos = end + 2
            text += data[pos:pos + cs]
            pos += cs + 2
        return text.decode("utf-8", errors="replace")


if __name__ == "__main__":
    # 自测:python3 mcp_sse_client.py <mr_url> [host] [port]
    # 个人路径/真实 MR 链接不进仓——从参数与环境变量来。
    import os
    if len(sys.argv) < 2:
        print("用法: mcp_sse_client.py <mr_url> [host] [port]", file=sys.stderr)
        sys.exit(2)
    mr_url = sys.argv[1]
    host = sys.argv[2] if len(sys.argv) > 2 \
        else os.environ.get("MFC_MCP_SSE_HOST", "10.244.150.123")
    port = int(sys.argv[3] if len(sys.argv) > 3
               else os.environ.get("MFC_MCP_SSE_PORT", "9000"))
    from mcp_http_client import default_mcp_token_file
    token_file = default_mcp_token_file()
    mcp_token = open(token_file).read().strip()  # noqa: F841 下载日志时用
    client = SSEMcpClient(host, port)
    try:
        print(f"session_id: {client.connect()}")
        client.initialize()
        print("Initialized")

        info = client.get_mr_pipeline_info(mr_url)
        if info:
            defects = info.get("defects", [])
            for d in defects:
                print(f"  {d.get('toolName')}: defectCount={d.get('defectCount',0)}")
                if d.get("x_auth_groups"):
                    print(f"    x_auth_groups: {d['x_auth_groups']}")
                if d.get("record_ids"):
                    print(f"    record_ids: {d['record_ids']}")
    finally:
        client.close()

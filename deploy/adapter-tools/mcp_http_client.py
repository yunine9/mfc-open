#!/usr/bin/env python3
"""streamable-HTTP MCP 客户端(toolkit 主路同款协议,纯标准库)。

toolkit 仲裁结论(2026-08-28,源码实证):CodeHub 的流水线/质量/门禁
信息主路全部走 MCP 网关(StreamableHTTPClientTransport →
http://mcp.example.com/mcp/<route>/1)。真现场已确认必需
X-Auth-Token=mcp-token；w3token 尚无独立凭据，仅作显式可选头保留。
CLI 是降级,REST 直调只有建 MR 一处。
本客户端就是那条主路的最小实现:POST JSON-RPC(initialize →
notifications/initialized → tools/call),响应兼容纯 JSON 与 SSE 帧。

与 mcp_sse_client.py 的分工:SSE 那台(10.244.150.123:9000)是日志
网关的旧式 SSE 形态,构建日志下载继续走它;本客户端对接 streamable
HTTP 形态的网关(codehub 等)。

环境变量:
  MFC_MCP_HTTP_URL      网关地址(默认 toolkit 同款 codehub 路由)
  MFC_MCP_TOKEN_FILE    所有 MCP 网关共用的可刷新 X-Auth-Token
  MFC_W3TOKEN_FILE      w3token 文件(配了就带 w3token 头)
令牌纪律:只从参数/文件读,永不进日志与异常文本。

自描述对拍:python3 mcp_http_client.py --list-tools --token-file <f>
把 tools/list 的名字与 inputSchema 打出来带回外网,参数形状不用猜。
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


class McpHttpError(RuntimeError):
    pass


# 五网关注册表(toolkit 全景图实证,2026-08-28 用户带回;SSE 网关走
# mcp_sse_client.py 的旧式 SSE 协议,不在此表)。逐网关可用
# MFC_MCP_<NAME>_URL 环境变量覆盖。
GATEWAYS = {
    "codehub": "http://mcp.example.com/mcp/"
               "route/1",
    "build": "http://mcp.example.com/mcp/"
             "route",
    "codecheck": "http://mcp.example.com/mcp/"
               "route/route",
    "codecov": "http://mcp.example.com/mcp/"
               "route",
    "dts": "http://mcp.example.com/mcp/"
           "route",
}


def gateway_url(name: str) -> str:
    override = os.environ.get(f"MFC_MCP_{name.upper()}_URL", "").strip()
    if override:
        return override
    if name not in GATEWAYS:
        raise McpHttpError(f"未知 MCP 网关 {name}(注册表: "
                           + "、".join(sorted(GATEWAYS)) + ")")
    return GATEWAYS[name]


DEFAULT_GATEWAY = os.environ.get(
    "MFC_MCP_HTTP_URL", GATEWAYS["codehub"])


class McpHttpClient:
    def __init__(self, url: str = "", token: str = "", w3token: str = "",
                 timeout: float = 30):
        self.url = url or DEFAULT_GATEWAY
        self.token = token
        self.w3token = w3token
        self.timeout = timeout
        self.session_id = ""
        self._next_id = 0
        # 网关直连,不走代理(SSE 客户端实测 407 的同款坑)。
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}))

    def _mask(self, text: str) -> str:
        for secret in (self.token, self.w3token):
            if secret:
                text = text.replace(secret, "<token>")
        return text

    def _post(self, payload: dict) -> dict | None:
        request = urllib.request.Request(
            self.url, data=json.dumps(payload).encode("utf-8"), method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json, text/event-stream")
        if self.token:
            request.add_header("X-Auth-Token", self.token)
        if self.w3token:
            request.add_header("w3token", self.w3token)
        if self.session_id:
            request.add_header("Mcp-Session-Id", self.session_id)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                self.session_id = response.headers.get(
                    "Mcp-Session-Id", self.session_id)
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")[:300]
            raise McpHttpError(self._mask(
                f"MCP 网关 HTTP {error.code}: {body}")) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise McpHttpError(self._mask(
                f"MCP 网关连接失败: {error}")) from None
        if not raw.strip():
            return None  # 通知类请求 202 空响应是正常的
        # streamable HTTP 允许 SSE 帧包 JSON:取最后一个 data: 帧。
        if raw.lstrip().startswith(("event:", "data:")) or "\ndata:" in raw:
            frames = [line[5:].strip() for line in raw.splitlines()
                      if line.startswith("data:")]
            raw = frames[-1] if frames else raw
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError:
            raise McpHttpError(self._mask(
                f"MCP 响应不是 JSON(前 300 字: {raw[:300]})")) from None
        if isinstance(envelope, dict) and envelope.get("error"):
            raise McpHttpError(self._mask(
                "MCP 报错: "
                + json.dumps(envelope["error"], ensure_ascii=False)[:300]))
        return envelope

    def initialize(self) -> None:
        self._next_id += 1
        self._post({
            "jsonrpc": "2.0", "id": self._next_id, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "mfc-adapter",
                                      "version": "1.0"}}})
        self._post({"jsonrpc": "2.0",
                    "method": "notifications/initialized", "params": {}})

    def call_tool(self, name: str, arguments: dict, timeout: float = 60):
        """返回 result.content 里首个 text(尽量解析成 JSON)。"""
        self._next_id += 1
        saved = self.timeout
        self.timeout = timeout
        try:
            envelope = self._post({
                "jsonrpc": "2.0", "id": self._next_id, "method": "tools/call",
                "params": {"name": name, "arguments": arguments}})
        finally:
            self.timeout = saved
        result = (envelope or {}).get("result") or {}
        if result.get("isError"):
            raise McpHttpError(self._mask(
                f"工具 {name} 返回错误: "
                + json.dumps(result, ensure_ascii=False)[:300]))
        for item in result.get("content") or []:
            if item.get("type") == "text":
                text = item.get("text", "")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return result or None

    def list_tools(self) -> list:
        self._next_id += 1
        envelope = self._post({
            "jsonrpc": "2.0", "id": self._next_id,
            "method": "tools/list", "params": {}})
        return ((envelope or {}).get("result") or {}).get("tools") or []


def load_secret(path: str) -> str:
    if not path:
        return ""
    with open(os.path.expanduser(path), encoding="utf-8") as stream:
        return stream.read().strip()


def default_mcp_token_file() -> str:
    """MCP 令牌的唯一默认定位规则，避免各脚本各猜一处。"""
    configured = os.environ.get("MFC_MCP_TOKEN_FILE", "").strip()
    if configured:
        return os.path.expanduser(configured)
    production = "/etc/mae-flow-cloud/mcp-token"
    if os.path.exists(production):
        return production
    return os.path.expanduser("~/.config/mae-flow-cloud/mcp-token")


if __name__ == "__main__":
    # 自描述对拍:把网关工具清单与 inputSchema 打出来,参数形状不用猜。
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-tools", action="store_true")
    parser.add_argument("--gateway", default="codehub",
                        help="注册表网关名: " + "、".join(sorted(GATEWAYS)))
    parser.add_argument("--url", default="")
    parser.add_argument("--token-file", default=default_mcp_token_file())
    parser.add_argument("--w3token-file",
                        default=os.environ.get("MFC_W3TOKEN_FILE", ""))
    args = parser.parse_args()
    client = McpHttpClient(
        url=args.url or gateway_url(args.gateway),
        token=load_secret(args.token_file),
        w3token=load_secret(args.w3token_file))
    try:
        client.initialize()
        print("initialize OK"
              + (f"(session {client.session_id[:8]}…)"
                 if client.session_id else "(无会话头)"))
        if args.list_tools:
            for tool in client.list_tools():
                print(f"\n== {tool.get('name')} ==")
                print((tool.get("description") or "").strip()[:300])
                print(json.dumps(tool.get("inputSchema") or {},
                                 ensure_ascii=False, indent=2)[:1500])
    except McpHttpError as error:
        print(f"[mcp-http] {error}", file=sys.stderr)
        sys.exit(2)

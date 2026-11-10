#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mae-flow statusline — 状态栏一行:单号 │ 当前步骤 │ 分支。

接入(settings.json,会话重启生效):
  "statusLine": {"type": "command", "command": "python \"<插件>/scripts/statusline.py\""}
读 stdin 的会话 JSON(取 cwd),向上定位 .mae-flow.json 或退出标记。
状态栏高频刷新:必须快——纯文件读,零子进程,任何异常都降级输出而不是报错。
"""
import json, os, sys, threading

from mae_flow_core import RuntimeMode, find_project_root, resolve_runtime
from mae_flow_core.file_io import load_json

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_STDIN_THREAD = None


def _read_stdin(timeout=2.0):
    """守护线程读 stdin,同 dispatch.py 的兜底:宿主不关管道时不能让状态栏挂死。"""
    global _STDIN_THREAD
    box = {}

    def _r():
        try:
            stream = getattr(sys.stdin, "buffer", sys.stdin)
            box["raw"] = stream.read()
        except Exception:
            box["raw"] = b""

    th = threading.Thread(target=_r, daemon=True)
    th.start()
    th.join(timeout)
    _STDIN_THREAD = th
    return box.get("raw", b"")


def main():
    try:
        raw = _read_stdin()
        if isinstance(raw, bytes):
            text = None
            for enc in ("utf-8-sig", "gb18030"):
                try:
                    text = raw.decode(enc, errors="strict")
                    break
                except UnicodeDecodeError:
                    pass
            d = json.loads(text or "{}")
        else:
            d = json.loads(raw or "{}")
    except Exception:
        d = {}
    cwd = ((d.get("workspace") or {}).get("current_dir")) or d.get("cwd") or os.getcwd()
    base = os.path.basename(os.path.abspath(cwd)) or cwd

    root = find_project_root(cwd)
    runtime = resolve_runtime(root)
    if runtime.mode == RuntimeMode.INACTIVE:
        hint = " · mae-flow 空闲" if (os.path.isdir(os.path.join(cwd, "openspec"))
                                      or os.path.isdir(os.path.join(cwd, ".comet"))) else ""
        print(f"📁 {base}{hint}")
        return
    if runtime.mode == RuntimeMode.CORRUPT:
        print(f"📁 {base} · mae-flow 状态异常(doctor 排障)")
        return
    if runtime.mode == RuntimeMode.DIRECT:
        print(f"📁 {base} · mae-flow 已退出 │ 普通开发")
        return
    if runtime.mode == RuntimeMode.STANDALONE:
        action = runtime.action or {}
        label = {
            "ut": "单独补 UT",
            "codecheck": "单独做 CodeCheck",
            "grill": "单独梳理需求",
        }.get(action.get("kind"), "独立任务")
        state = ("等待范围确认" if action.get("status") == "awaiting_scope_confirmation"
                 else "执行中")
        print(f"🧰 {label} │ {state} │ 普通开发不受限")
        return

    st = runtime.flow or {}
    cfg = st.get("config", {})
    sid = st.get("current", "?")
    dan = cfg.get("单号", "未配置")
    moonlight = bool((st.get("moonlight") or {}).get("enabled"))
    if sid == "end":
        print(f"✅ {dan} 交付完成 · 下一单直接说需求")
        return

    title = sid
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        flow = load_json(os.path.join(here, "..", "flow", "flow.json"))
        title = flow["steps"].get(sid, {}).get("title", sid)
    except Exception:
        pass
    if len(title) > 22:
        title = title[:21] + "…"

    parts = [f"{'🌙' if moonlight else '🚦'} {dan}", title]
    if moonlight:
        unresolved = len([
            x for x in ((st.get("moonlight") or {}).get("issues") or [])
            if not x.get("resolved_at")
        ])
        parts.append("无人值守" + (f"·遗留{unresolved}" if unresolved else ""))
    if cfg.get("分支名"):
        parts.append(cfg["分支名"])
    print(" │ ".join(parts))


if __name__ == "__main__":
    main()
    if _STDIN_THREAD is not None and _STDIN_THREAD.is_alive():
        # 读线程仍持有 stdin 缓冲锁:正常解释器收尾会与其争锁触发 Fatal Python error。
        # 输出已经打印完,直接跳过 finalization 干净退出。
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        os._exit(0)

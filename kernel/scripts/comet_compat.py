#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MAE-FLOW 与项目级 Comet Hook 的小型兼容层。"""

import os

from mae_flow_core.file_io import read_text


BEGIN = "# MAE-FLOW DIRECT MODE COMPAT BEGIN"
BLOCK = r'''# MAE-FLOW DIRECT MODE COMPAT BEGIN
_mae_flow_probe="$PWD"
while :; do
  if [ -f "${_mae_flow_probe}/.mae-flow.json.exited" ]; then
    echo "[COMET-HOOK] allowed: mae-flow direct mode" >&2
    exit 0
  fi
  _mae_flow_parent=$(dirname "${_mae_flow_probe}")
  [ "${_mae_flow_parent}" = "${_mae_flow_probe}" ] && break
  _mae_flow_probe="${_mae_flow_parent}"
done
# MAE-FLOW DIRECT MODE COMPAT END
'''


def comet_guard_paths(project_root="."):
    """只认 comet init 的项目级标准位置，不扫描用户目录。"""
    return [
        os.path.join(project_root, base, "skills", "comet", "scripts", "comet-hook-guard.sh")
        for base in (".cac", ".claude")
    ]


def ensure_direct_mode_compat(project_root="."):
    """让 Comet Hook 在 MAE-FLOW 退出标记存在时放行。

    返回 ``(found, patched, errors)``。修改原子化且幂等；脚本每次 Hook 调用都会重新读取，
    因此补丁生效不依赖重启会话。
    """
    found, patched, errors = [], [], []
    for path in comet_guard_paths(project_root):
        if not os.path.isfile(path):
            continue
        found.append(path)
        try:
            text = read_text(path, errors="strict")
            if BEGIN in text:
                continue
            anchor = "set -euo pipefail\n"
            if anchor in text:
                updated = text.replace(anchor, anchor + "\n" + BLOCK, 1)
            elif text.startswith("#!"):
                first, sep, rest = text.partition("\n")
                updated = first + sep + BLOCK + rest
            else:
                # 兼容没有 shebang/set -e 的旧版项目 Hook。BLOCK 只做向上查标记并在命中时
                # 提前返回，不改变后续脚本语义；比因结构差异拒绝退出更安全。
                updated = BLOCK + text
            tmp = path + ".mae-flow.tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as f:
                f.write(updated)
            try:
                os.chmod(tmp, os.stat(path).st_mode)
            except OSError:
                pass
            os.replace(tmp, path)
            patched.append(path)
        except Exception as exc:
            errors.append("%s: %s" % (path, exc))
    return found, patched, errors

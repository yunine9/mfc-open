"""全仓符号引用清单——改动收口的递工具。

这是工具不是门禁:只读、不写状态、不拦任何东西、任何模式可用。
它服务的是最贵的那类事故:动了共享符号(签名/枚举/常量/配置键/协议字段),
十三处引用改了十二处,漏的那处在 MyBatis XML 里——编译全绿,基本功能坏。
靠提示词要求 Agent 自觉 grep 会漏;一条确定性命令把清单打出来,漏项一目了然。
"""

import os
import subprocess

from mae_flow_core.foundation import source_paths

# 清单再长也要能读完。超过这个数说明搜的符号太泛(get/data/config 之类),
# 该换更精确的名字,而不是让 Agent 去啃几百条——但截断必须说出来,
# 因为这份清单的用途正是"逐条对钩才算收口",静默截断=假收口。
_MAX_LISTED_HITS = 200

# 编译器看得见的扩展名;其余一律归入"编译器看不见",漏改就是运行期事故。
_CODE_EXTENSIONS = frozenset((
    ".java", ".kt", ".scala", ".groovy",
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
    ".cs", ".go", ".rs", ".swift",
    ".py", ".js", ".jsx", ".ts", ".tsx",
))


def _git_lines(arguments):
    """git 输出行;无命中/无仓库返回空列表,绝不抛错——工具失败不能变成新卡点。"""
    try:
        completed = subprocess.run(
            ["git", "-c", "core.quotepath=false"] + list(arguments),
            shell=False, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=60)
    except Exception:
        return []
    if completed.returncode not in (0, 1):
        return []
    return [line for line in completed.stdout.splitlines() if line.strip()]


def _is_code_file(path):
    return os.path.splitext(path)[1].lower() in _CODE_EXTENSIONS


def symbol_hits(symbol):
    """(编译可见命中, 编译器看不见命中, 文件名命中);词边界精确匹配,含未跟踪文件。"""
    # --untracked 会把没写进 .gitignore 的 node_modules 一起扫进来。实测一个
    # 3000 文件的 node_modules 里搜一个普通符号:命中 2400 处,排除依赖目录后 0 处。
    # 而这份清单是要 Agent 逐条对钩的("每一处要么适配、要么写明为何不需要"),
    # 2400 条等于当场把它压死——与任务卡被 node_modules 灌爆是同一个洞。
    grep = _git_lines([
        "grep", "-nwIF", "--untracked", "-e", symbol, "--", ".",
        ":(exclude).mae-flow-work", ":(exclude)*.min.js",
        *source_paths.tool_managed_exclude_pathspecs(),
    ])
    code, opaque = [], []
    for line in grep:
        path = line.split(":", 1)[0]
        (code if _is_code_file(path) else opaque).append(line)
    names = [
        path for path in _git_lines(
            ["ls-files", "--cached", "--others", "--exclude-standard"])
        if symbol in os.path.basename(path)
    ]
    return code, opaque, names


def cmd_symbol_refs(args):
    for symbol in args.symbols:
        code, opaque, names = symbol_hits(symbol)
        total = len(code) + len(opaque)
        if total == 0 and not names:
            print("[mae-flow] %s: 0 处引用(词边界精确匹配,含未跟踪文件)。"
                  % symbol)
            print("  若该符号由反射/字符串拼接产生,再用模糊搜索复核: "
                  "git grep --untracked <部分名>")
            continue
        print("[mae-flow] 符号引用清单: %s(共 %d 处,其中编译器看不见 %d 处)"
              % (symbol, total, len(opaque)))
        index = 0

        def listed(title, rows):
            """按名额逐条列出;名额用尽就停,由调用方统一说明截断。
            顺序刻意是"编译器看不见"优先——那是最贵的漏改。"""
            nonlocal index
            if not rows or index >= _MAX_LISTED_HITS:
                return
            print(title)
            for row in rows:
                if index >= _MAX_LISTED_HITS:
                    return
                index += 1
                print("[ ] %d. %s" % (index, str(row)[:300]))

        listed("── 编译器看不见的文件(XML/YAML/SQL/配置/脚本——"
               "漏改这里=编译全绿功能坏)──", opaque)
        listed("── 代码文件 ──", code)
        listed("── 文件名命中 ──", names)
        if index < total + len(names):
            # 静默截断会让"逐项对钩"变成假收口:清单看着完整,其实少了一半。
            print("★ 清单在第 %d 条截断，还有 %d 处未列出。"
                  "**不能据这份清单判定收口**——命中 %d 处说明这个符号太泛。"
                  "两条实路:换更精确的名字(带上类名/前缀)重跑本命令;"
                  "或按目录分批自查 "
                  "`git grep -nwIF --untracked -e %s -- <子目录>`。"
                  % (_MAX_LISTED_HITS, total + len(names) - index,
                     total + len(names), symbol))
        print("每一处要么适配、要么写明为何不需要;清单逐项对钩后这个符号才算收口。")

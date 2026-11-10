#!/usr/bin/env python3
"""内核裁判:用 mae_flow_core 的契约函数验收云端现场。

证据判定的唯一权威实现在内核仓(quality/tool_transcript 等),
TS 侧不复刻一行判定逻辑——它写现场,这里裁决。这既是 cloud-probe
的验收器,也是跨语言对拍的契约:transcript JSONL 是中立格式,
TS 写出的每个字节都必须被内核原样认出。

内核定位:环境变量 MAE_FLOW_HOME,缺省使用随 Cloud 发布的 kernel/；
只有发布快照缺席时才回退本仓同级的 ../mae-flow。
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def kernel_scripts_dir():
    """内核发现链,**必须与 src/kernelDiscovery.ts 同序同项**:
    MAE_FLOW_HOME > 仓内 kernel/ 快照(与 Cloud 版本化发布) >
    兄弟目录 ../mae-flow(快照缺席时的开发兜底)。

    第三项是补的:原来只找前两项,而**内网只能下 ZIP、没有兄弟目录**
    ——那边跑到这一步会直接 SystemExit,一条本来能过的验收莫名其妙
    地挂掉(worktree 里同样撞得到,因为上一级是 .claude/worktrees)。
    发现链写两遍就会漂移,这就是证据。
    """
    candidates = []
    env = os.environ.get("MAE_FLOW_HOME")
    if env:
        candidates.append(env)
    candidates.append(os.path.join(REPO, "kernel"))
    candidates.append(os.path.join(os.path.dirname(REPO), "mae-flow"))
    for candidate in candidates:
        scripts = os.path.join(candidate, "scripts")
        if os.path.isdir(os.path.join(scripts, "mae_flow_core")):
            return scripts
    raise SystemExit(
        "找不到 mae-flow 内核:设 MAE_FLOW_HOME、放在 ../mae-flow,"
        "或确认仓内 kernel/ 快照完整(harness/sync-kernel.sh 刷新)")


sys.path.insert(0, kernel_scripts_dir())

from mae_flow_core.adapters.hook_transcript_paths import (  # noqa: E402
    explicit_agent_transcript_path,
)
from mae_flow_core.application.hooks.event_policies import (  # noqa: E402
    agent_kind,
)
from mae_flow_core.quality.tool_transcript import (  # noqa: E402
    bash_call,
    call_failed,
    parse_transcript,
)


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scene_dir", help="现场目录(transcript/events/waiting)")
    args = parser.parse_args()

    main_path = os.path.join(args.scene_dir, "transcript.jsonl")
    transcript = parse_transcript(read_jsonl(main_path))
    ok = True

    def fact(passed, text):
        nonlocal ok
        print(("  ✅ " if passed else "  ❌ ") + text)
        ok = ok and bool(passed)

    workspace_call = bash_call(
        transcript.tool_calls, "printf 'WORKSPACE_READY\\n'")
    fact(workspace_call is not None and workspace_call.result_seen
         and not call_failed(workspace_call)
         and "WORKSPACE_READY" in workspace_call.result,
         "工作区工具调用经内核解析命中(格式一个字节没漂)")

    denied = [call for call in transcript.tool_calls
              if call.name == "Bash"
              and "rm -rf" in str((call.input or {}).get("command", ""))]
    fact(bool(denied) and denied[0].is_error and "打回" in denied[0].result,
         "同步拦截:危险命令在执行前被打回(exit 2 的云端等价物)")

    ask = [call for call in transcript.tool_calls
           if call.name == "AskUserQuestion"]
    fact(len(ask) == 1 and ask[0].result.startswith("通过"),
         "决定以工具结果按 call_id 回注,同 id 不出双行")

    final_text = transcript.assistant_texts[-1]
    fact("UT_WRITE_RESULT: DONE" in final_text
         and "COMPILE_RESULT" not in final_text,
         "收口只声明 UT 编写完成，不伪造本机质量绿灯")

    task_calls = [call for call in transcript.tool_calls
                  if call.name == "Task"]
    child = ""
    if len(task_calls) == 1:
        child = explicit_agent_transcript_path(
            {"transcript_path": main_path,
             "tool_use_id": task_calls[0].call_id})
    fact(len(task_calls) == 1
         and "UT_WRITE_RESULT: DONE" in task_calls[0].result
         and bool(child) and os.path.isfile(child),
         "子 Agent 桥:Task 一次调用,子会话证据单独落盘且绑定命中")

    if child:
        child_transcript = parse_transcript(read_jsonl(child))
        nested = [call for call in child_transcript.tool_calls
                  if call.name == "Task"]
        fact(len(nested) == 1 and nested[0].is_error,
             "嵌套封顶:子会话里的再派发被打回")
        rows = read_jsonl(main_path)
        spawn_inputs = [
            block["input"]
            for row in rows
            for block in (row.get("message", {}).get("content") or [])
            if isinstance(block, dict) and block.get("type") == "tool_use"
            and block.get("name") == "Task"
        ]
        fact(bool(spawn_inputs)
             and agent_kind(spawn_inputs[0]) == "UT",
             "agent_kind 推断照旧:UT 编写派发意图字段名没漂")

    waiting_path = os.path.join(args.scene_dir, "waiting.json")
    waiting = json.load(open(waiting_path, encoding="utf-8"))
    records = list((waiting.get("records") or {}).values())
    fact(len(records) == 1 and records[0].get("status") == "resolved",
         "人工待办唯一且已由决定关闭(先到决定生效)")

    events = read_jsonl(os.path.join(args.scene_dir, "events.jsonl"))
    ids = [int(event.get("eventId", 0)) for event in events]
    kinds = {event.get("kind") for event in events}
    fact(ids == sorted(set(ids)) and "human_decision" in kinds,
         "事件日志单调完整,human_decision 在案")

    print("[judge] " + ("全部事实成立。" if ok else "❌ 有事实不成立。"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

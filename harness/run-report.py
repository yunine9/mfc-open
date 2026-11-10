#!/usr/bin/env python3
"""试跑现场对拍报告:一键把一次真模型试跑的现场读成 markdown。

用法:
    python3 harness/run-report.py .pilot/run7-delivery-chain
    python3 harness/run-report.py .pilot/archive/run3-REQ2026081402-glm-delivery

现场目录两种布局都认:活跑(<dir>/task-1/...)与归档(文件直接
平铺在 <dir>/)。全程只读;文件缺失如实标「缺」,不报错退出——
报告的职责是把现场读给人看,不是替现场辩护。
"""

import json
import os
import sys
from collections import Counter

MISSING = "(缺)"


def read_json(path):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return None


def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding="utf-8") as stream:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass  # 半行(还在刷盘)不挡整份报告
    except OSError:
        return None
    return rows


def clip(text, width):
    text = " ".join(str(text or "").split())
    return text if len(text) <= width else text[: width - 1] + "…"


def first_line(text):
    return str(text or "").splitlines()[0] if text else ""


def locate_task_dir(root):
    """活跑布局(task-N 子目录,取最小编号)或归档布局(平铺)。"""
    direct = os.path.join(root, "events.jsonl")
    if os.path.isfile(direct):
        return root
    candidates = sorted(
        name for name in (os.listdir(root) if os.path.isdir(root) else [])
        if name.startswith("task-")
        and os.path.isfile(os.path.join(root, name, "events.jsonl")))
    return os.path.join(root, candidates[0]) if candidates else root


def section_summary(out, task_dir):
    out.append("## 任务概要")
    saved = read_json(os.path.join(task_dir, "task.json"))
    if not saved:
        out.append(f"- task.json: {MISSING}(归档现场通常没有,状态看内核轨迹)")
        return
    summary = saved.get("summary", {})
    out.append(f"- 需求: {clip(summary.get('requirement'), 120)}")
    out.append(f"- 最终状态: {summary.get('status', MISSING)}")
    if summary.get("detail"):
        out.append(f"- detail: {clip(summary['detail'], 160)}")
    delivery = summary.get("delivery")
    if delivery:
        out.append(f"- 交付事实: `{json.dumps(delivery, ensure_ascii=False)}`")


def section_kernel(out, task_dir):
    out.append("\n## 内核阶段轨迹")
    state = read_json(os.path.join(task_dir, "origin", ".mae-flow.json"))
    if not state:
        out.append(f"- .mae-flow.json: {MISSING}(流程没走到 init)")
        return
    out.append(f"- current: **{state.get('current', MISSING)}**")
    config = state.get("config") or {}
    if config:
        out.append(f"- config: `{json.dumps(config, ensure_ascii=False)}`")
    history = state.get("history")
    if isinstance(history, list) and history:
        out.append(f"- 阶段推进({len(history)} 步):")
        for item in history:
            note = f" — {clip(item.get('note'), 60)}" if item.get("note") else ""
            out.append(
                f"  - {item.get('at', '?')}  {item.get('step', '?')}"
                f" → {item.get('result', '?')}{note}")


def section_cards(out, events):
    out.append("\n## 审批卡")
    if events is None:
        out.append(f"- events.jsonl: {MISSING}")
        return
    cards = [event for event in events
             if event.get("kind") == "tool_finished"
             and event.get("payload", {}).get("name") == "AskUserQuestion"]
    if not cards:
        out.append("- (没有审批卡)")
        return
    for index, event in enumerate(cards, 1):
        payload = event.get("payload", {})
        questions = (payload.get("input") or {}).get("questions") or []
        answers = payload.get("answers") or {}
        for item in questions:
            question = str(item.get("question", ""))
            risk = " ⚠️**风险卡**" if "风险" in question else ""
            answer = answers.get(question) or first_line(payload.get("result"))
            out.append(
                f"- #{index} [{event.get('ts', '?')}]{risk} "
                f"{clip(first_line(question), 80)}")
            out.append(f"  - 答: {clip(answer, 80)}")


def section_agents(out, events):
    out.append("\n## 子 Agent")
    if events is None:
        out.append(f"- events.jsonl: {MISSING}")
        return
    spawned = {}
    finished = set()
    for event in events:
        payload = event.get("payload", {})
        if event.get("kind") == "agent_spawned":
            spawned[payload.get("call_id")] = payload
        elif event.get("kind") == "agent_finished":
            finished.add(payload.get("call_id"))
    if not spawned:
        out.append("- (没有子 Agent)")
        return
    lost = 0
    for call_id, payload in spawned.items():
        back = call_id in finished
        mark = "✅ 已返回" if back else "🔴 **丢返回(spawned 无 finished)**"
        lost += 0 if back else 1
        out.append(
            f"- {call_id}  {clip(payload.get('agent_type'), 20)}"
            f"  {clip(payload.get('description'), 50)}  {mark}")
    out.append(f"- 合计 {len(spawned)} 个,丢返回 {lost} 个")


def section_ledger(out, task_dir):
    out.append("\n## 质量台账(quality-executions)")
    ledger = read_json(os.path.join(
        task_dir, "origin", ".mae-flow.json.quality-executions"))
    executions = (ledger or {}).get("executions")
    if not executions:
        out.append(f"- 台账: {MISSING}或为空")
        return
    for item in executions:
        flag = "✅" if item.get("succeeded") else "❌"
        out.append(
            f"- {flag} {item.get('kind', '?')}/{item.get('step', '?')}"
            f" [{item.get('at', '?')}] `{clip(item.get('command'), 100)}`")


def section_stats(out, events):
    out.append("\n## 事件统计")
    if not events:
        out.append(f"- events.jsonl: {MISSING}或为空")
        return
    counts = Counter(event.get("kind", "?") for event in events)
    for kind, count in counts.most_common():
        out.append(f"- {kind}: {count}")
    out.append(f"- 首事件: {events[0].get('ts', '?')}"
               f";末事件: {events[-1].get('ts', '?')}")


def main():
    if len(sys.argv) != 2:
        print("用法: run-report.py <run目录>", file=sys.stderr)
        return 2
    root = sys.argv[1].rstrip("/")
    if not os.path.isdir(root):
        print(f"目录不存在: {root}", file=sys.stderr)
        return 2
    task_dir = locate_task_dir(root)
    events = read_jsonl(os.path.join(task_dir, "events.jsonl"))
    out = [f"# 试跑对拍报告: {os.path.basename(root)}",
           f"(现场: {task_dir})"]
    section_summary(out, task_dir)
    section_kernel(out, task_dir)
    section_cards(out, events)
    section_agents(out, events)
    section_ledger(out, task_dir)
    section_stats(out, events)
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

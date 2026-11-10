/** 真实持久调度器 + 模拟作者/评审；不调用模型、源码仓或 everycode。 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ComponentResearchPipeline, type ComponentWork, type ComponentWorkResult } from "../../src/componentResearchPipeline.ts";

const [directory, runId, scenario] = process.argv.slice(2);
if (!directory || !runId || !["interrupt", "fail", "complete"].includes(scenario)) throw new Error("需要数据目录、运行编号和模拟场景");
mkdirSync(directory, { recursive: true });
const save = (name: string, value: unknown) => {
  const file = join(directory, name);
  writeFileSync(file + ".tmp", JSON.stringify(value));
  renameSync(file + ".tmp", file);
};
const event = (entry: Record<string, unknown>) => appendFileSync(join(directory, "events.jsonl"), JSON.stringify({ run_id: runId, pid: process.pid, ...entry }) + "\n");
const pipeline = new ComponentResearchPipeline(join(directory, "state.json"), "simulated-analysis-and-extraction-v1", ["base"]);
save(`${runId}-loaded.json`, pipeline.state);
event({ type: "process-start" });
let maximumRunning = 0;
const budget = setTimeout(() => { console.error("模拟研究子进程超过 12 秒预算"); process.exit(9); }, 12_000);
const authorResult = (task: ComponentWork): ComponentWorkResult => ({ findings: `模拟研究结果：${task.id}`, open_questions: [],
  ...(task.phase === "inventory" ? { components: ["a", "b", "c"].map(id => ({ id, title: `模块 ${id}`, repository_ids: ["base"], scope: `src/${id}.cpp` })) } : {}),
  ...(task.phase === "plan" ? { paradigms: [{ id: "write", title: "写入数据", need: "保存一份数据" }] } : {}),
});

try {
  await pipeline.run({ signal: new AbortController().signal,
    // 不传 concurrency，以真实默认值验收三个在途任务。
    execute: async task => {
      const sessionId = randomUUID();
      event({ type: "author-start", task_id: task.id, session_id: sessionId, attempts: task.attempts });
      if (scenario === "interrupt" && ["plan-b", "plan-c", "pitfalls-a"].includes(task.id)) {
        if (task.id === "pitfalls-a") save("ready-to-kill.json", { pid: process.pid, state: pipeline.state, maximum_running: maximumRunning });
        await new Promise<never>((_, reject) => setTimeout(() => reject(new Error("父进程未在 10 秒内执行强杀")), 10_000));
      }
      const result = authorResult(task);
      event({ type: "author-end", task_id: task.id, session_id: sessionId });
      return result;
    },
    review: async task => {
      const sessionId = randomUUID();
      event({ type: "review-start", task_id: task.id, session_id: sessionId, attempts: task.attempts });
      const feedback = scenario === "fail" && task.id === "plan-b" ? "模拟独立评审：模块 b 需要补充用法依据" : undefined;
      event({ type: "review-end", task_id: task.id, session_id: sessionId, ...(feedback ? { feedback } : {}) });
      return feedback;
    },
    changed: state => { maximumRunning = Math.max(maximumRunning, state.tasks.filter(task => task.status === "running").length); },
  });
  save(`${runId}-result.json`, { status: "done", maximum_running: maximumRunning, state: pipeline.state });
  event({ type: "process-complete" });
} catch (error) {
  save(`${runId}-result.json`, { status: "incomplete", maximum_running: maximumRunning,
    error: error instanceof Error ? error.message : String(error), state: pipeline.state });
  process.exitCode = 2;
} finally { clearTimeout(budget); }

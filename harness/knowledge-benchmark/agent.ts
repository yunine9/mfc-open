import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CloudSession } from "../../src/sessionDriver.ts";
import { createKnowledgeTool } from "../../src/knowledgeTools.ts";
import type { KnowledgeSearch } from "../../src/knowledgeSearch.ts";
import { EventLog } from "../../src/semanticEvents.ts";
import { TranscriptStore } from "../../src/transcriptStore.ts";
import { GateService } from "../../src/gateService.ts";
import { HumanGate } from "../../src/humanGate.ts";
import { REPO } from "./fixtures.ts";
import type { CaseResult } from "./scoring.ts";

export const header = `#pragma once
#include <string>
#include <optional>
class ReportWriter { public: bool open(const std::string&); bool write(const std::string&); void close(); };
class NeConfig { public: static std::optional<std::string> getName(int); };
class Config { public: static int value(const std::string&); };
`;
export const common = `#include "api.hpp"
#include <iostream>
#include <vector>
std::vector<std::string> events;
bool open_ok=true, write_ok=true;
bool ReportWriter::open(const std::string& path) { events.push_back("open:"+path); return open_ok; }
bool ReportWriter::write(const std::string& text) { events.push_back("write:"+text); return write_ok; }
void ReportWriter::close() { events.push_back("close"); }
std::optional<std::string> NeConfig::getName(int id) { events.push_back("query"); return id<0 ? std::nullopt : std::optional<std::string>("node"); }
int Config::value(const std::string& key) { events.push_back(key); if(key=="request_timeout_seconds") return 7; if(key=="request_timeout_ms") return 17; return -1; }
int failures=0;
void check(const char* name, bool pass) { std::cout << name << ":" << (pass?"PASS":"FAIL") << "\\n"; if(!pass) failures++; }
`;
export const agentCases = [
  { id: "owned-writer", prompt: "实现 bool exportName(int neId, const std::string& path)，根据网元 ID 查询名称并导出到文件，任何失败返回 false，成功返回 true。",
    tests: `bool exportName(int, const std::string&);
int main() {
 events.clear(); bool ok=exportName(-1,"out"); check("missing-name", !ok && events==std::vector<std::string>{"query"});
 events.clear(); open_ok=false; ok=exportName(1,"out"); check("open-failure-cleanup", !ok && events==std::vector<std::string>{"query","open:out","close"});
 events.clear(); open_ok=true; write_ok=false; ok=exportName(1,"out"); check("write-failure-cleanup", !ok && events==std::vector<std::string>{"query","open:out","write:node","close"});
 events.clear(); write_ok=true; ok=exportName(1,"out"); check("success-cleanup", ok && events==std::vector<std::string>{"query","open:out","write:node","close"});
 return failures?1:0;
}` },
  { id: "borrowed-writer", prompt: "实现 bool appendReport(ReportWriter& writer, const std::string& text)，向调用方已经打开的报表 writer 追加给定文本，返回写入是否成功。",
    tests: `bool appendReport(ReportWriter&, const std::string&);
int main() { ReportWriter writer;
 events.clear(); bool ok=appendReport(writer,"tail"); check("borrowed-success", ok && events==std::vector<std::string>{"write:tail"});
 events.clear(); write_ok=false; ok=appendReport(writer,"tail"); check("borrowed-failure", !ok && events==std::vector<std::string>{"write:tail"});
 return failures?1:0;
}` },
  { id: "versioned-timeout", prompt: "实现 int timeoutMillis()，读取当前产品版本的请求超时配置，将结果作为整数毫秒返回。",
    tests: `int timeoutMillis();
int main() { events.clear(); const int actual=timeoutMillis(); check("version-and-unit", actual==7000 && events==std::vector<std::string>{"request_timeout_seconds"}); return failures?1:0; }` },
];

/** Same task and API in both arms. Only the knowledge tool is varied. Hidden tests never enter model context. */
export async function runAgentCases(options: {
  out: string; search: KnowledgeSearch; models: string; provider: string; model: string;
  repeats: number; timeoutMs: number; signal?: AbortSignal;
  scenarioIds?: string[]; arms?: string[]; sourceFile?: string; onWorkspace?: (workspace:string)=>void; inject?: (messages:any[])=>Promise<any[]>;
  record: (row: CaseResult) => void;
}) {
  // Check the evaluator before paying for model calls.
  const compiler = spawnSync(process.env.CXX || "c++", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (compiler.status !== 0) throw new Error("Agent benchmark 需要可执行的 C++17 编译器（CXX 或 c++）");
  const agentDir = mkdtempSync(join(tmpdir(), "knowledge-benchmark-model-"));
  writeFileSync(join(agentDir, "models.json"), readFileSync(options.models), { mode: 0o600 });
  try {
    for (let repeat = 1; repeat <= options.repeats; repeat++) for (const scenario of agentCases.filter(s=>!options.scenarioIds||options.scenarioIds.includes(s.id))) {
      // Alternate order across repeats to reduce provider warmup/order effects.
      for (const arm of options.arms ?? (repeat % 2 ? ["without-knowledge", "with-knowledge"] : ["with-knowledge", "without-knowledge"])) {
        if (options.signal?.aborted) return;
        const id = `agent/${scenario.id}/${arm}/${repeat}`;
        const root = join(options.out, id), workspace = join(root, "workspace");
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "api.hpp"), header);
        const sourceFile=options.sourceFile ?? "solution.cpp";
        if(options.onWorkspace) {writeFileSync(join(workspace,sourceFile),"// 待实现\n");options.onWorkspace(workspace);}
        const calls: Array<Record<string, unknown>> = [];
        let session: CloudSession | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const started = performance.now();
        console.log(`开始 ${id}`);
        const abort = () => { timedOut = true; void session?.abort(); };
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          const original: any = createKnowledgeTool({ service: () => options.search,
            context: () => ({ repo: "shared", repositories: [REPO], moduleIds: ["export"], productVersion: "2.7B" }) });
          const tool = { ...original, execute: async (...args: any[]) => {
            const start = performance.now(); const result = await original.execute(...args);
            calls.push({ input: args[1], elapsed_ms: Math.round(performance.now()-start), result });
            writeFileSync(join(root, "knowledge-calls.json"), JSON.stringify(calls, null, 2));
            return result;
          } };
          session = await CloudSession.create({ taskId: `benchmark-${scenario.id}-${repeat}-${arm}`, workspace, agentDir,
            provider: options.provider, model: options.model, eventLog: new EventLog(join(root, "events.jsonl")),
            transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
            gate: new GateService({ workspace, cwd: workspace }), humanGate: new HumanGate(join(root, "waiting.json")),
            memoryContext: arm === "generated-context" && options.inject ? ()=>options.inject! : undefined,
            extraTools: arm === "with-knowledge" ? [tool] : [],
            allowedTools: ["read", "write", "edit", ...(arm === "with-knowledge" ? ["knowledge"] : [])] });
          if (options.signal?.aborted) { await session.abort(); return; }
          timer = setTimeout(() => { timedOut = true; void session?.abort(); }, options.timeoutMs);
          const prompt = `这是独立的虚构 C++17 项目。仓库 ${REPO}，业务模块 export，产品版本 2.7B。
${scenario.prompt}
API 声明位于 ${join(workspace,"api.hpp")}。只把实现写入 ${join(workspace,sourceFile)}，包含 api.hpp；不写 main，不修改头文件，不自行实现库函数。
按适用的组件与版本约定实现。如果信息不足则明确说明不确定性，不声称已经验证。所有文件操作限当前工作区，不访问工作区之外。完成后简短总结。`;
          writeFileSync(join(root, "prompt.txt"), prompt);
          const result = await session.start(prompt);
          clearTimeout(timer);
          session.dispose(); session = undefined;
          const source = join(workspace, sourceFile);
          const headerIntact = readFileSync(join(workspace, "api.hpp"), "utf8") === header;
          writeFileSync(join(workspace, "api.hpp"), header);
          // Create test driver only after the agent has finished and lost tool access.
          writeFileSync(join(workspace, "checks.cpp"), common + scenario.tests);
          const compile = existsSync(source) ? spawnSync(process.env.CXX || "c++", ["-std=c++17", source, join(workspace,"checks.cpp"), "-o", join(root,"checks")],
            { encoding: "utf8", timeout: 30_000, maxBuffer: 1024*1024 }) : undefined;
          const execution = compile?.status === 0 ? spawnSync(join(root, "checks"), [], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024*1024 }) : undefined;
          const checks = (execution?.stdout ?? "").trim().split("\n").filter(Boolean);
          const row: CaseResult = { id, kind: "agent", arm, repeat, passed: !timedOut && headerIntact && result.status === "turn_finished" && compile?.status === 0 && execution?.status === 0,
            header_intact: headerIntact,
            elapsed_ms: Math.round(performance.now()-started), status: result.status, timed_out: timedOut,
            knowledge_searches: calls.filter(c => (c.input as any)?.action === "search").length,
            knowledge_reads: calls.filter(c => (c.input as any)?.action === "read").length,
            compile_status: compile?.status ?? null, execution_status: execution?.status ?? null, checks,
            diagnostics: (compile?.stderr ?? "") + (execution?.stderr ?? ""),
            error: !existsSync(source) ? "未生成 solution.cpp" : compile?.error?.message ?? execution?.error?.message };
          writeFileSync(join(root, "result.json"), JSON.stringify(row, null, 2));
          options.record(row);
        } catch (error) {
          options.record({ id, kind: "agent", arm, repeat, passed: false, elapsed_ms: Math.round(performance.now()-started), error: String(error) });
        } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); session?.dispose(); }
      }
    }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
}

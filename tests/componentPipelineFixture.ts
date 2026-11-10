import { createHash } from "node:crypto";
import type { Scene } from "../src/scriptedModel.ts";
import { researchSourceRepositories, type ResearchExecution } from "../src/componentResearch.ts";
export const fixtureRevision = "a".repeat(40);
export const fixtureCaller = '#include "file.h"\nint main() { Handle handle{}; Close(handle); return handle.closed ? 0 : 1; }\n';
export const fixtureUnitTest = '#include "file.h"\n#include <cassert>\nint main() { Handle handle{}; assert(!handle.closed); Close(handle); assert(handle.closed); }\n';
export const usageContent = (detail: string) => `### 适用场景\n${detail}\n\n### 使用步骤\n创建句柄，调用 Close，检查关闭状态。\n\n### 使用约束\n关闭后不再读取句柄。`;
export const guideOverview = (detail: string) => `## 组件用途\n${detail}\n\n## 接入配置\n包含 file.h，链接 libfile.so。`;
export const everycodeId = (purpose: "usage" | "unit-test", repository: string, path: string, start: number, end: number, content: string) =>
  `everycode-${createHash("sha256").update(JSON.stringify([purpose, repository, path, start, end, content])).digest("hex").slice(0, 24)}`;
export function fixtureEvidence(repositoryId: string) {
  const usageId = everycodeId("usage", "consumer", "src/use.cpp", 1, 2, fixtureCaller);
  const testId = everycodeId("unit-test", "consumer", "tests/file_test.cpp", 1, 3, fixtureUnitTest);
  const reference = { repository_id: repositoryId, path: "src/file.cpp", revision: fixtureRevision, start: 1, end: 2 };
  return { usageId, testId, reference, events: [
    { tool: "component_source", action: "read", status: "returned", component_id: repositoryId, path: reference.path, revision: fixtureRevision, start: 1, end: 2, content: "struct Handle { bool closed = false; };\nvoid Close(Handle& handle) { handle.closed = true; }\n" },
    { tool: "code_search", action: "read", status: "returned", purpose: "usage", evidence_id: usageId, repository: "consumer", path: "src/use.cpp", start: 1, end: 2, content: fixtureCaller },
    { tool: "code_search", action: "read", status: "returned", purpose: "unit-test", evidence_id: testId, repository: "consumer", path: "tests/file_test.cpp", start: 1, end: 3, content: fixtureUnitTest },
  ] };
}
export function recordFixtureEvidence(input: ResearchExecution) {
  for (const component of researchSourceRepositories(input.record)) fixtureEvidence(component.id).events.forEach(input.evidence);
}
export function componentPipelineScript(repositoryId: string, path: string, revision: string, callerContent: string, testContent = fixtureUnitTest) {
  const script: Scene[] = [], offsets: Record<string, number> = {};
  const call = (name: string, input: Record<string, unknown>) => script.push({ tool: { name, input } });
  const usage = everycodeId("usage", "consumer", "src/use.cpp", 1, 30, callerContent);
  const testEvidence = everycodeId("unit-test", "consumer", "tests/file_test.cpp", 1, 30, testContent);
  for (const [id, phase] of [["inventory", "inventory"], ["plan-pool", "plan"], ["contracts-pool", "contracts"], ["paradigm-pool-submit", "paradigm"], ["pitfalls-pool", "pitfalls"], ["index-pool", "index"], ["synthesis", "synthesis"]]) {
    offsets[id] = script.length;
    call("extraction_skill", { path: "references/api-boundary.md" });
    call("component_source", { action: "read", repository_id: repositoryId, path, start: 1, end: 1 });
    call("code_search", { action: "kw", query: "Close" });
    call("code_search", { action: "read", repository: "consumer", path: "src/use.cpp", start: 1, end: 30 });
    if (phase === "paradigm") {
      call("code_search", { action: "kw", query: "Close test", purpose: "unit-test" });
      call("code_search", { action: "read", repository: "consumer", path: "tests/file_test.cpp", start: 1, end: 30, purpose: "unit-test" });
    }
    const writes = !["inventory", "plan", "synthesis"].includes(phase);
    if (writes) call("research_document", { action: "section", section: { id, title: id, repository_ids: [repositoryId], content: phase === "paradigm" ? usageContent("关闭已创建的句柄。") : "明确资源释放顺序", interfaces: "Close(Handle& handle)：将 closed 设置为 true。", integration: "包含 file.h，链接 libfile.so。", example: "```cpp\n" + fixtureCaller + "```", unit_tests: phase === "paradigm" ? "运行：c++ -Iinclude tests/file_test.cpp -lfile && ./a.out\n```cpp\n" + testContent + "```" : "", related_ids: [], paradigm: {
      kind: phase, component: "pool", language: "cpp", status: "recommended", need: "安全释放资源", api: ["Close"], applicability: "本次版本", replaces: { identifiers: [], imports: [], patterns: [] },
      evidence: [{ repository_id: repositoryId, path, revision, start: 1, end: 1 }], usage_evidence: [usage], test_evidence: phase === "paradigm" ? [testEvidence] : [], open_questions: [],
    } } });
    if (phase === "synthesis") call("research_document", { action: "overview", overview: guideOverview("文件资源关闭与释放。") });
    call("component_work_result", { findings: `核对 \`${repositoryId}:${path}:1\``, open_questions: [],
      ...(phase === "inventory" ? { components: [{ id: "pool", title: "资源管理", repository_ids: [repositoryId], scope: path }] } : {}),
      ...(phase === "plan" ? { paradigms: [{ id: "submit", title: "释放资源", need: "安全释放" }] } : {}) });
    script.push({ text: "本项已完成" });
    call("extraction_skill", { path: "references/api-boundary.md" });
    call("component_source", { action: "read", repository_id: repositoryId, path, start: 1, end: 1 });
    call("research_document", { action: "read", ...(writes ? { id } : {}) });
    if (writes) call("component_work", { evidence_id: usage });
    if (phase === "paradigm") call("component_work", { evidence_id: testEvidence });
    call("component_work_result", { pass: true, feedback: "已回查源码与真实调用" });
    script.push({ text: "评审完成" });
  }
  return { script, offsets };
}

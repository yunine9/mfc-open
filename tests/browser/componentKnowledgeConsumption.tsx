import React from "react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { flushSync } from "../../web/node_modules/react-dom";
import { ComponentKnowledgeCheck } from "../../web/src/ComponentKnowledgeCheck";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";
import type { ComponentKnowledgeCheckReport } from "../../src/componentKnowledgeTypes";

const doc = { id: "kd-consumer", title: "后台任务组件使用指南", content: "# 后台任务组件\n正式文档正文与完整示例", form: "document", scope: "platform", repositories: [], module_ids: [], technologies: ["cpp"], product_versions: [], active: true, revision: "a".repeat(64), history: [], when_to_use: "后台任务" };
const report: ComponentKnowledgeCheckReport = { mode: "observe", trigger: "mr", status: "completed", checked_at: "2026-09-29T04:00:00Z", head: "b".repeat(40), base: "c".repeat(40), rules_digest: "d".repeat(64), checked_files: 2, rules: 3, warnings: [], findings: [{
  level: "warning", path: "src/background/worker.cpp", line: 42, end_line: 42, rule_id: "component-demo", need: "后台执行任务", component: "pool", api: ["Pool::Submit"], applicability: "已链接 Pool v2；底层线程适配器允许使用原生线程。", document_id: doc.id, document_revision: doc.revision, document_line: 18, paradigm_id: "pool-submit",
}] };
window.fetch = async (input: RequestInfo | URL) => {
  const path = String(input);
  const value = path === "/knowledge-documents" ? { documents: [{ ...doc, id: "kd-first", title: "其他文档" }, doc] }
    : path.startsWith("/knowledge-documents/") ? doc : path === "/business-modules" ? { modules: [] } : path === "/component-repositories" ? { components: [] } : path === "/component-knowledge" ? { revision: 0, items: [], warnings: [], challenges: [] } : path === "/skills" ? { skills: [], operations: [] } : path.startsWith("/knowledge-review") ? { notes: [] } : {};
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
};
async function main() {
  const root = createRoot(document.getElementById("app")!);
  flushSync(() => root.render(<><ComponentKnowledgeCheck report={report} /><ComponentKnowledgeCheck report={{ ...report, status: "incomplete", findings: [], warnings: ["目标分支基线不存在，检查未完成"] }} /></>));
  (document.querySelector("details") as HTMLDetailsElement).open = true;
  if (!document.body.textContent?.includes("src/background/worker.cpp:42") || !document.body.textContent.includes("检查未完成")) throw new Error("检查位置和失败说明必须可见");
  const link = document.querySelector("a") as HTMLAnchorElement;
  if (!link.href.includes("knowledgeDocument=kd-consumer")) throw new Error("必须定位正式知识文档");
  if (document.documentElement.scrollWidth > innerWidth) throw new Error("检查区域横向溢出");
  // 保留检查卡截图，同时用实际知识库页面验证深链不是只打开文档列表。
  const second = document.createElement("div"); document.body.append(second);
  const library = createRoot(second);
  flushSync(() => library.render(<KnowledgeLibrary onOpenTask={() => {}} />));
  for (let i = 0; i < 80 && !second.querySelector(".km-document .md"); i++) await new Promise(r => setTimeout(r, 20));
  if (!second.querySelector(".km-document .md")?.textContent?.includes("正式文档正文与完整示例")) throw new Error("知识深链未选择目标文档");
  library.unmount(); second.remove();
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
main().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });

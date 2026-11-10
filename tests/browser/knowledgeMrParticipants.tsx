import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { DomainKnowledgePublicationStatus } from "../../web/src/DomainKnowledgePublicationStatus";
import { KnowledgeSourceCleanup } from "../../web/src/KnowledgeSourceCleanup";
import { projectKnowledgeProduction } from "../../src/knowledgeProductionState";
import type { DomainKnowledgeJob, DomainPublication } from "../../src/domainKnowledgeTypes";
import type { KnowledgeArchivePreview } from "../../src/knowledgeProductionTypes";

const target = { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs" };
const receipt: DomainPublication = { target_id: target.id, state: "opened", branch: "codex/knowledge", url: "https://example.test/mr/479", documents: [],
  mr_participants: { status: "failed", requested: { reviewers: ["reviewer"], approval_approvers: ["approver"] }, message: "人员服务暂时不可用" } };
const job: DomainKnowledgeJob = { id: "dkx-479", title: "订单知识", scope: "订单", module_id: "orders", operator: "owner", created_at: "2026-10-13T08:00:00Z",
  status: "done", stage: "已入库", material_ids: [], revisions: {}, knowledge_target: target, repositories: [], turns: [], evidence: [], publications: [receipt],
  documents: [{ id: "doc", title: "订单规则", target_id: target.id, path: "docs/rules.md", layer: "domain", content: "已发布知识", sources: "", revision: 1,
    selected: true, base_content: null, base_revision: "", history: [], knowledge_document_id: "kd-1", published_revision: "r1", published_document_revision: 1 }] };
job.archive_batches = [{ id: "batch-479", created_at: job.created_at, operator: job.operator, issue_no: "REQ479", state: "done",
  documents: structuredClone(job.documents), targets: [target], publications: [receipt] }];
job.production = projectKnowledgeProduction({ kind: "domain", record: job });
const preview: KnowledgeArchivePreview = { job_id: job.id, title: "知识归档", status_label: "已归档", message: "MR 已创建，后续合入由人处理。", issue_no: "REQ479",
  expected_revisions: { "kd-1": "r1" }, actions: [], targets: [{ ...target, configured: true, status_label: "已归档", message: "", url: receipt.url,
    mr_participants: receipt.mr_participants, files: [], actions: [] }] };
const cleanup = structuredClone(job);
cleanup.source_cleanup = { repositories: [target], plans: [{ id: "plan-479", target_id: target.id, target_revision: "a", paths: ["docs"],
  entries: [{ path: "docs/old.md", mode: "100644", oid: "b" }], selected_paths: ["docs/old.md"] }],
  publications: [{ ...receipt, cleanup_plan_id: "plan-479", removed_paths: ["docs/old.md"] }] };
let release: (() => void) | undefined;
const requests: Array<{ path: string; body: any }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (input, init) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, body });
  if (path.endsWith("/archive/preview")) return new Response(JSON.stringify(preview));
  await new Promise<void>(resolve => { release = resolve; });
  if (path.endsWith("/source-cleanup/start")) {
    cleanup.source_cleanup!.started = true;
    return new Response(JSON.stringify(cleanup));
  }
  throw new Error(`不应请求 ${path}`);
};
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent?.trim() === text);
async function until(test: () => unknown, message: string) {
  for (let i = 0; i < 80 && !test(); i++) await pause();
  check(test(), message);
}
const root = createRoot(document.getElementById("app")!);
function checkSilentFailure(scope: ParentNode = document) {
  check(!scope.querySelector('[role="alert"]'), "人员失败仍显示警告节点");
  check(!scope.textContent?.includes("人员服务暂时不可用"), "人员失败仍显示原因");
  check(!scope.textContent?.includes("MR 人员设置未完成"), "人员失败仍显示失败提示");
  check(!button("重试设置人员", scope), "人员失败仍有专用重试入口");
}
async function run() {
  root.render(<DomainKnowledgePublicationStatus job={job} disabled />);
  await until(() => button("归档"), "人员失败改变了正常归档入口");
  check(button("归档")!.disabled, "禁用状态仍可打开归档");
  checkSilentFailure();
  check(document.body.textContent?.includes("已归档") && document.querySelector(`a[href="${receipt.url}"]`), "人员失败丢失归档状态或MR链接");
  root.render(<DomainKnowledgePublicationStatus job={job} />); await pause();
  button("归档")!.click();
  await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes("已归档"), "归档预览没有正常结果");
  const dialog = () => document.querySelector('[role="dialog"]')!;
  checkSilentFailure(dialog());
  check(dialog().querySelector(`a[href="${receipt.url}"]`), "归档预览丢失MR链接");
  check(!button("创建归档 MR", dialog()), "人员失败导致已经归档的内容再次创建MR");
  let changed: DomainKnowledgeJob | undefined;
  root.render(<KnowledgeSourceCleanup task={cleanup} onChange={next => { changed = next; root.render(<KnowledgeSourceCleanup task={next} onChange={() => {}} />); }} />);
  await until(() => document.querySelector('[aria-label="萃取前清理旧知识"]'), "清理界面未显示");
  checkSilentFailure();
  check(button("开始萃取") && !button("开始萃取")!.disabled, "人员失败阻塞后续萃取");
  check(document.querySelector(`a[href="${receipt.url}"]`), "人员失败丢失清理MR链接");
  button("开始萃取")!.click(); await until(() => !!release, "正常开始萃取没有请求");
  check(button("开始萃取")!.disabled, "萃取请求进行中仍可重复点击");
  check(requests.at(-1)?.path.endsWith("/source-cleanup/start"), "人员失败改变了正常开始萃取动作");
  release!(); release = undefined;
  await until(() => changed?.source_cleanup?.started, "人员失败阻止保存开始萃取结果");
  checkSilentFailure();
  check(requests.length === 2 && requests[0].path.endsWith("/archive/preview"), "显示人员失败意外触发了补设或重复归档");
  check(!errors.length, errors.join("; "));
  check(document.documentElement.scrollWidth <= innerWidth, "桌面界面横向溢出");
  return { passed: true, width: innerWidth };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); })
  .finally(() => root.unmount());

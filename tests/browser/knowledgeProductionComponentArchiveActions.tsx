import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { ComponentKnowledgeArchive } from "../../web/src/ComponentKnowledgeArchive";
import { DomainKnowledgePublicationStatus } from "../../web/src/DomainKnowledgePublicationStatus";
import { DomainKnowledgeExtraction } from "../../web/src/DomainKnowledgeExtraction";
import { ComponentResearch } from "../../web/src/ComponentResearch";
import type { knowledgeManualArchiveFixtures } from "../fixtures/knowledgeManualArchiveFixture";

const fixture = JSON.parse(document.getElementById("fixture")!.textContent!) as Awaited<ReturnType<typeof knowledgeManualArchiveFixtures>>;
const requests: Array<{ path: string; method: string; body?: any }> = [], errors: string[] = [];
let preview = fixture.componentReady.preview;
function targetPreview(body: any, current = preview) {
  const targets = current.targets.map(target => {
    const next = body.targets.find((value: any) => value.id === target.id) ?? target;
    return { ...target, ...next, files: target.files.map(file => ({ ...file, path: file.path.replace(`${target.docs_path}/`, `${next.docs_path}/`) })) };
  });
  return { targets, documents: targets.flatMap(target => target.files.map(file => ({ ...file, target_id: target.id }))), archive_revision: 1,
    archive_preview: { ...current, targets } };
}
window.addEventListener("error", event => errors.push(event.message)); window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, body });
  if (method === "GET" && path.endsWith("/archive/preview")) return new Response(JSON.stringify(preview));
  if (method === "POST" && path.endsWith("/archive/targets/preview")) return new Response(JSON.stringify(targetPreview(body)));
  if (method === "POST" && path.endsWith("/archive/create")) { preview = fixture.partial.preview; return new Response(JSON.stringify(preview)); }
  if (method === "POST" && path.endsWith("/archive/retry")) { preview = fixture.completed.preview; return new Response(JSON.stringify(preview)); }
  return new Response(JSON.stringify({ error: `不应调用已退役链：${method} ${path}` }), { status: 400 });
};
const pause = () => new Promise(done => setTimeout(done, 90));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const named = (name: string) => buttons().filter(button => button.textContent?.trim() === name);
let root = createRoot(document.getElementById("app")!);
const phase = (value: string) => { document.getElementById("phase")!.textContent = value; };
async function run() {
  phase("component archive button");
  root.render(<ComponentKnowledgeArchive record={fixture.componentReady.record} />); await pause();
  check(named("归档").length === 1, "已发布研究任务只有一个归档按钮");
  check(!requests.length, "用户尚未打开归档弹窗时不请求准备或创建归档");
  named("归档")[0].click(); await pause();
  phase("component formal preview");
  const dialog = document.querySelector('[role="dialog"]'); check(dialog, "归档必须直接打开弹窗");
  check(requests.length === 1 && requests[0].method === "GET" && requests[0].path.endsWith("/archive/preview"), "打开弹窗只读取归档预览");
  check(!dialog!.textContent?.includes("尚未发布的新草稿"), "归档不能展示未发布草稿");
  for (const file of fixture.componentReady.preview.targets.flatMap(target => target.files)) check(dialog!.textContent?.includes(file.path), `缺少正式文件 ${file.path}`);
  const componentFiles = fixture.componentReady.preview.targets.flatMap(target => target.files);
  check(componentFiles.length === 1 && componentFiles[0].path.endsWith(".md"), "一个组件只归档一篇正文，不带结构文件");
  check(!buttons().some(button => /读取远端|保存合并稿|清理预览|刷新 MR/.test(button.textContent ?? "")), "弹窗不提供旧远端与跟踪机制");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause();
  preview = fixture.domainReady.preview; requests.length = 0;
  phase("domain formal preview");
  root.render(<DomainKnowledgePublicationStatus key="domain" job={fixture.domainReady.job} onConfigure={() => {}} compact />); await pause();
  check(named("归档").length === 1, "领域任务也只有一个归档按钮"); named("归档")[0].click(); await pause();
  const issue = document.querySelector<HTMLInputElement>('[aria-label="归档关联单号"]');
  check(issue?.value === fixture.domainReady.preview.issue_no, "关联单号须由任务预填");
  const create = fixture.domainReady.preview.actions.find(action => action.id === "create-archive")!;
  check(create, "后端提供创建动作"); const createButton = named(create.label)[0]; check(createButton && !createButton.disabled, "预览完整时创建动作可执行");
  for (const target of fixture.domainReady.preview.targets) {
    check(document.body.textContent?.includes(target.repository) && document.body.textContent?.includes(target.branch), "列出各仓现有Git设置");
    for (const file of target.files) check(document.body.textContent?.includes(file.path), `必须归档未勾选但已正式发布的 ${file.path}`);
  }
  createButton.click(); createButton.click(); await pause();
  phase("partial archive and retry");
  const creates = requests.filter(request => request.method === "POST"); check(creates.length === 1, "重复点击不得创建重复批次或MR");
  check(JSON.stringify(creates[0].body.expected_revisions) === JSON.stringify(fixture.domainReady.preview.expected_revisions), "提交预览绑定的精确正式版本");
  check(creates[0].body.target_ids === undefined, "创建覆盖全部正式文件目标，不引入首次目标选择");
  const failedTarget = fixture.partial.preview.targets.find(target => target.actions.some(action => action.id === "retry-archive"))!;
  check(failedTarget && document.body.textContent?.includes(failedTarget.error ?? failedTarget.message), "单仓失败显示后台原文原因");
  const retry = failedTarget.actions.find(action => action.id === "retry-archive")!; const retryButton = named(retry.label)[0]; check(retryButton, "失败仓给出可执行的重试动作");
  retryButton.click(); retryButton.click(); await pause();
  const retries = requests.filter(request => request.path.endsWith("/archive/retry")); check(retries.length === 1, "重复重试只发送一个POST");
  check(retries[0].body.target_id === failedTarget.id && retries[0].body.batch_id === retry.batch_id, "只重试失败目标及原批次，成功仓不重建");
  check(document.body.textContent?.includes(fixture.completed.preview.status_label), "创建成功显示后端已归档事实");
  for (const target of fixture.completed.preview.targets) check(document.querySelector(`a[href="${target.url}"]`), "各目标MRURL可直接打开");
  phase("11-minute no-background-request observation");
  const count = requests.length; await new Promise(done => setTimeout(done, 11 * 60 * 1000));
  check(requests.length === count, "创建MR即结束，不自动刷新或跟踪MR");
  phase("unconfigured archive");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause();
  preview = fixture.unconfigured.preview; requests.length = 0;
  root.render(<ComponentKnowledgeArchive key="unconfigured" record={fixture.unconfigured.record} />); await pause();
  named("归档")[0].click(); await pause();
  const settings = fixture.unconfigured.preview.targets.flatMap(target => target.actions).find(action => action.id === "configure") ?? fixture.unconfigured.preview.actions.find(action => action.id === "configure");
  check(settings, "未配置目标由后端给出设置入口"); check(document.querySelector('[aria-label="组件归档相对目录"]'), "未配置可直接在归档弹窗设置相对目录");
  check(!buttons().some(button => button.textContent?.trim() === create.label && !button.disabled), "未配置不能盲目创建MR");
  check(!errors.length, errors.join(";")); check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面没有横向溢出");
  return { passed: true, width: innerWidth };
}
async function endpointSwitch() {
  phase("endpoint A held create");
  let finishOld!: () => void, finishNext!: () => void;
  const oldPending = new Promise<Response>(resolve => { finishOld = () => resolve(new Response(JSON.stringify(fixture.partial.preview))); });
  const nextPending = new Promise<Response>(resolve => { finishNext = () => resolve(new Response(JSON.stringify(fixture.domainNextCompleted.preview))); });
  window.fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    const next = path.includes(fixture.domainNext.job.id);
    if (method === "GET" && path.endsWith("/archive/preview")) return new Response(JSON.stringify(next ? fixture.domainNext.preview : fixture.domainReady.preview));
    if (method === "POST" && path.endsWith("/archive/create")) return next ? nextPending : oldPending;
    throw new Error(`不应请求 ${method} ${path}`);
  };
  root.render(<DomainKnowledgePublicationStatus job={fixture.domainReady.job} compact />); await pause();
  named("归档")[0].click(); await pause();
  const create = fixture.domainReady.preview.actions.find(action => action.id === "create-archive")!;
  named(create.label)[0].click(); await pause();
  check(named(create.label)[0].disabled, "旧任务创建操作正在等待服务器");
  root.render(<DomainKnowledgePublicationStatus job={fixture.domainNext.job} compact />); await pause();
  phase("endpoint B preview and busy reset");
  const nextCreate = fixture.domainNext.preview.actions.find(action => action.id === "create-archive")!;
  check(document.querySelector('[role="dialog"]')?.textContent?.includes(fixture.domainNext.preview.title), "换任务必须读取新任务正式预览");
  check(!named(nextCreate.label)[0].disabled, "换任务后不能继承旧任务busy而卡死");
  named(nextCreate.label)[0].click(); named(nextCreate.label)[0].click(); await pause();
  check(requests.filter(request => request.method === "POST" && request.path.includes(fixture.domainNext.job.id)).length === 1, "新任务独立提交一次创建");
  finishOld(); await pause();
  phase("late A cannot release B");
  check(named(nextCreate.label)[0].disabled, "旧请求迟到结束不能释放新任务busy");
  check(document.querySelector('[role="dialog"]')?.textContent?.includes(fixture.domainNext.preview.title), "旧请求迟到不得覆写新任务预览");
  finishNext(); await pause();
  phase("endpoint B completed");
  check(document.querySelector('[role="dialog"]')?.textContent?.includes(fixture.domainNextCompleted.preview.status_label), "新任务归档结果可正常完成");
  check(!errors.length, errors.join("；")); root.unmount();
  return { passed: true, width: innerWidth };
}
async function unpublishedArchive() {
  phase("published task A archive route");
  let nextRecord: typeof fixture.componentUnpublished | typeof fixture.componentNextReady.record = fixture.componentUnpublished;
  const taskA = fixture.componentReady.record.id, taskB = fixture.componentUnpublished.id;
  window.fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    let response: unknown;
    if (path === "/component-research") response = { records: [fixture.componentReady.record, nextRecord] };
    else if (path === "/component-repositories") response = { components: [fixture.componentReady.record.component] };
    else if (path === "/business-modules") response = { modules: [] };
    else if (path === `/component-research/${taskA}/reader`) response = fixture.componentReady.record;
    else if (path === `/component-research/${taskB}/reader`) response = nextRecord;
    else if (path.startsWith("/knowledge-review/component/")) response = { notes: [] };
    else if (path.endsWith("/archive/targets/preview")) response = targetPreview(body, path.includes(taskA) ? fixture.componentReady.preview : fixture.componentNextReady.preview);
    else if (path === `/component-research/${taskA}/archive/preview`) response = fixture.componentReady.preview;
    else if (path === `/component-research/${taskB}/archive/preview`) {
      if (!nextRecord.document_id) return new Response(JSON.stringify({ error: "尚无已发布的正式知识" }), { status: 400 });
      response = fixture.componentNextReady.preview;
    } else if (path === `/component-research/${taskB}/publish` && method === "POST") {
      check(body.archive === undefined, "平台发布不携带归档设置");
      nextRecord = fixture.componentNextReady.record; response = nextRecord;
    } else throw new Error(`不应请求 ${method} ${path}`);
    return new Response(JSON.stringify(response));
  };
  const renderTask = (id: string) => root.render(<ComponentResearch open focused focusId={id} surface="knowledge" onClose={() => {}} onAdopt={() => {}} />);
  async function until(condition: () => boolean, message: string) {
    for (let attempt = 0; attempt < 20; attempt++) { if (condition()) return; await pause(); }
    throw new Error(`等待超过1.8秒预算：${message}`);
  }
  history.replaceState({}, "", "?unpublishedArchive=1&kbStage=publish"); renderTask(taskA);
  await until(() => !!document.querySelector('[role="dialog"] [aria-label="归档关联单号"]'), "A归档路由自动打开");
  document.querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="dialog-close"]')!.click(); await pause();
  phase("non-archive task B without formal knowledge");
  history.replaceState({}, "", `?unpublishedArchive=1&kbPage=task&kbKind=component&kbTask=${taskB}&kbReview=1`); renderTask(taskB);
  await until(() => document.querySelector("h2")?.textContent === fixture.componentUnpublished.topic, "B未发布任务就绪"); await pause();
  const previewRequests = () => requests.filter(request => request.path === `/component-research/${taskB}/archive/preview`);
  check(previewRequests().length === 0, "非归档路由的无正式知识任务不继承A请求或读取隐藏预览");
  const publish = fixture.componentUnpublished.production.research_actions.find(action => action.id === "publish")!;
  const publishButton = named(publish.label)[0]; check(publishButton && !publishButton.disabled, "B文稿可发布到平台");
  phase("platform publication does not request archive"); publishButton.click();
  await until(() => named("归档").length === 1, "B平台发布后唯一归档入口可用");
  check(requests.filter(request => request.path === `/component-research/${taskB}/publish`).length === 1, "平台发布只提交一次");
  check(previewRequests().length === 0 && !document.querySelector('[role="dialog"]:not([data-closed]) [aria-label="归档关联单号"]'), "平台发布后仍等用户点击归档");
  phase("manual click reads new formal fact"); named("归档")[0].click(); await pause();
  check(previewRequests().length === 1, "用户点击后才读取当前正式预览");
  for (const file of fixture.componentNextReady.preview.targets.flatMap(target => target.files)) check(document.querySelector('[role="dialog"]')?.textContent?.includes(file.path), "预览展示B新正式版全部文件");
  check(!document.querySelector('[role="dialog"]')?.textContent?.includes("尚无已发布的正式知识"), "旧无正式知识错误不能遗留");
  check(!errors.length, errors.join("；")); root.unmount(); return { passed: true, width: innerWidth };
}
async function componentPaths() {
  phase("component chosen archive path");
  const initial = structuredClone(fixture.componentReady.preview);
  initial.targets[0].files = Array.from({ length: 110 }, (_, index) => ({ ...initial.targets[0].files[0], id: `ability-${index}`, title: `能力 ${index}`, path: `${initial.targets[0].docs_path}/cpp/capabilities/ability-${index}.md` }));
  let saved = false;
  window.fetch = async (input, init) => {
    const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    if (path.endsWith("/archive/preview")) return new Response(JSON.stringify(initial));
    if (path.endsWith("/archive/targets/preview")) return new Response(JSON.stringify(targetPreview(body, initial)));
    if (path.endsWith("/archive/targets")) { saved = true; return new Response(JSON.stringify({ archive_revision: 1 })); }
    if (path.endsWith("/archive/create")) {
      check(saved && body.expected_archive_revision === 1, "创建MR绑定已确认的归档目录版本");
      check(JSON.stringify(body.expected_revisions) === JSON.stringify(initial.expected_revisions), "仍归档原正式知识版本");
      return new Response(JSON.stringify({ ...initial, status_label: "已归档", archive_revision: 1, actions: [], targets: initial.targets.map(target => ({ ...target, status_label: "已归档", url: "https://example.test/mr/chosen" })) }));
    }
    throw new Error(`意外请求 ${path}`);
  };
  root.render(<ComponentKnowledgeArchive record={fixture.componentReady.record} />); await pause(); named("归档")[0].click();
  for (let i = 0; i < 20 && !document.querySelector('[aria-label="组件归档相对目录"]'); i++) await pause();
  const field = document.querySelector<HTMLInputElement>('[aria-label="组件归档相对目录"]')!;
  check(field, "归档弹窗直接显示仓内相对目录输入框");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "docs/my-team/chosen");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  for (let i = 0; i < 30 && (named("确认路径并创建 MR")[0]?.disabled !== false || !document.body.textContent?.includes("docs/my-team/chosen/cpp/capabilities/ability-109.md")); i++) await pause();
  check(document.body.textContent?.includes("docs/my-team/chosen/cpp/capabilities/ability-109.md"), "110项能力均预览到用户所选目录");
  check(!requests.some(request => request.path.endsWith("/archive/targets") || request.path.endsWith("/archive/create")), "预览不保存设置或创建MR");
  const confirm = named("确认路径并创建 MR")[0]; check(confirm && !confirm.disabled, "路径与版本预览完成后才能创建"); confirm.click(); confirm.click();
  for (let i = 0; i < 20 && !document.querySelector('a[href="https://example.test/mr/chosen"]'); i++) await pause();
  check(requests.filter(request => request.path.endsWith("/archive/create")).length === 1, "重复点击只创建一次MR");
  const settings = requests.find(request => request.path.endsWith("/archive/targets"))!;
  check(settings.body.targets[0].docs_path === "docs/my-team/chosen", "保存用户指定目录");
  check(document.querySelector('a[href="https://example.test/mr/chosen"]'), "成功显示MR链接");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面窗口无横向溢出");
  check(!errors.length, errors.join("；")); root.unmount(); return { passed: true, width: innerWidth };
}
async function domainIssueInput() {
  for (const [issue, description] of [["REQ-NEW-ARCHIVE", "本次重新归档的新描述"], [fixture.completed.job.issue_no!, "同一单号的新描述"], ["REQ-CLEAR-DESCRIPTION", ""]]) {
    phase(`domain recreate ${issue}`);
    let current = structuredClone(fixture.completed.job), created = 0;
    const oldPreview = fixture.completed.preview;
    window.fetch = async (input, init) => {
      const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === `/domain-extraction/${current.id}/reader`) return new Response(JSON.stringify(current));
      if (path.startsWith("/knowledge-review/")) return new Response(JSON.stringify({ notes: [] }));
      if (path.endsWith("/archive/preview")) return new Response(JSON.stringify(oldPreview));
      if (path.endsWith("/archive-targets/preview")) return new Response(JSON.stringify({ targets: body.targets, archive_revision: 1,
        documents: current.documents.map(document => ({ ...document, path: `${body.targets.find((target: any) => target.id === document.target_id).docs_path}/${document.id}.md` })) }));
      if (path.endsWith("/archive-targets")) {
        current = { ...current, archive_revision: 1, knowledge_layout: "directory-v1", knowledge_target: body.targets[0], repositories: body.targets.slice(1) };
        return new Response(JSON.stringify(current));
      }
      if (path.endsWith("/archive/create")) {
        check(body.issue_no === issue, "最终创建MR使用本次填写的单号");
        check((body.issue_description ?? "") === description, "最终创建MR使用本次描述，留空不恢复旧描述");
        check(body.replace_existing === true, "保留重新创建并撤销旧MR的决定");
        created++;
        return new Response(JSON.stringify({ ...oldPreview, issue_no: issue, issue_description: description }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    history.replaceState({}, "", "?domainIssueInput=1");
    root.render(<DomainKnowledgeExtraction focusId={current.id} surface="knowledge" focused />);
    for (let i = 0; i < 30 && !named("归档").length; i++) await pause();
    check(named("归档")[0], "领域任务已有归档可打开"); named("归档")[0].click();
    for (let i = 0; i < 30 && !document.querySelector('[aria-label="归档关联单号"]'); i++) await pause();
    const fill = async (label: string, value: string) => {
      const field = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; check(field, `missing ${label}`);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); await pause();
    };
    await fill("归档关联单号", issue); await fill("归档单号描述", description);
    const replace = oldPreview.actions.find(action => action.id === "replace-archive")!;
    check(named(replace.label)[0], "已有MR可重新创建"); named(replace.label)[0].click();
    for (let i = 0; i < 30 && !document.querySelector('[aria-label="本次归档单号"]'); i++) await pause();
    check(document.querySelector<HTMLInputElement>('[aria-label="本次归档单号"]')?.value === issue, "切换路径确认窗口保留新单号");
    check(document.querySelector<HTMLInputElement>('[aria-label="本次归档单号描述"]')?.value === description, "路径确认窗口显示新描述");
    for (let i = 0; i < 30 && named("确认并重新创建 MR")[0]?.disabled !== false; i++) await pause();
    check(named("确认并重新创建 MR")[0]?.disabled === false, "路径预览完成可确认"); named("确认并重新创建 MR")[0].click();
    for (let i = 0; i < 30 && !created; i++) await pause();
    check(created === 1, "路径确认后只创建一次，旧预览没有覆盖本次输入");
    root.unmount(); root = createRoot(document.getElementById("app")!); await pause();
  }
  check(!errors.length, errors.join("；")); return { passed: true, width: innerWidth };
}
const scenario = new URLSearchParams(location.search);
const operation = scenario.has("domainIssueInput") ? domainIssueInput() : scenario.has("componentPaths") ? componentPaths() : scenario.has("unpublishedArchive") ? unpublishedArchive() : scenario.has("endpointSwitch") ? endpointSwitch() : run();
operation.then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });

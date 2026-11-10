import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeLibrary } from "../../web/src/KnowledgeLibrary";

const pause = () => new Promise(resolve => setTimeout(resolve, 90));
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const scenario = new URLSearchParams(location.search).get("scenario");
const componentScenario = scenario?.startsWith("component");
const calls: Array<{ path: string; input?: any }> = [];
const sourceRepositories = [
  { id: "core", name: "基础实现来源仓", enabled: true, languages: ["cpp"], repository: "https://example.test/core.git", branch: "main", path: "", description: "" },
  { id: "network", name: "网络实现来源仓", enabled: true, languages: ["cpp"], repository: "https://example.test/network.git", branch: "main", path: "src", description: "" },
  { id: "disabled", name: "停用来源不应出现", enabled: false, languages: ["cpp"], repository: "https://example.test/disabled.git", branch: "main", path: "", description: "" },
  { id: "java", name: "Java参考来源仓", enabled: true, languages: ["java"], repository: "https://example.test/java.git", branch: "main", path: "", description: "" },
];
const componentRecord = { id: "cr-functional", source_repositories: sourceRepositories.filter(source => source.enabled && source.languages.includes("cpp")),
  language: "cpp", topic: "C++ 组件知识", operator: "专家", status: "running", stage: "分析功能能力", created_at: "2026-10-10T00:00:00Z", evidence: [],
  pipeline: { tasks: [{ id: "inventory", title: "分析功能能力", status: "done", result: { components: [
    { id: "file-operations", title: "文件操作", repository_ids: ["core"], scope: "读写与关闭" },
    { id: "database-operations", title: "数据库操作", repository_ids: ["core", "network"], scope: "连接和查询" },
    { id: "p2p", title: "P2P", repository_ids: ["network"], scope: "发现与传输" },
  ] } }] } };
const skill = { name: "领域萃取方法", digest: "a".repeat(64), can_manage: false, versions: [], files: { "SKILL.md": "# 领域萃取方法\n\n先阅读业务材料。" } };
const componentSkills = {
  "component-analysis": { ...skill, name: "组件模块分析", can_manage: false, files: { "SKILL.md": "# 组件模块分析\n\n按源码边界划分模块。" } },
  component: { ...skill, name: "组件用法萃取", can_manage: false, files: { "SKILL.md": "# 组件用法萃取\n\n按模板编写用法及单元测试。" } },
};
window.fetch = async (url, options) => {
  const path = String(url), input = options?.body ? JSON.parse(String(options.body)) : undefined;
  calls.push({ path, input }); let result: unknown;
  if (path === "/business-modules") result = { modules: [{ id: "trade", name: "交易业务", repositories: ["https://example.test/trade.git"], status: "active", assets: [] }], warnings: [], operations: [] };
  else if (path === "/knowledge-tasks") result = { tasks: [], summary: { running: 0, attention: 0, total: 0 }, warnings: [] };
  else if (path === "/memory-insights") result = { memories: [], repos: [] };
  else if (path === "/technology-stacks") result = { stacks: componentScenario ? [{ id: "cpp", name: "C++", enabled: true }, { id: "java", name: "Java", enabled: true }] : [] };
  else if (path === "/component-repositories") result = { components: componentScenario ? sourceRepositories : [] };
  else if (path === "/component-research" && input) {
    check(Object.keys(input).length === 1 && input.language === "cpp", "按技术栈启动一次完整能力研究，不传仓当组件的ID");
    result = componentRecord;
  } else if (path === "/component-research") result = { records: [componentRecord] };
  else if (path === "/component-research/cr-functional") result = componentRecord;
  else if (path === "/knowledge-documents") result = { documents: [] };
  else if (path === "/skills") result = { skills: [], operations: [], warnings: [] };
  else if (path === "/knowledge-extraction/skills/domain") {
    if (input) Object.assign(skill, { files: input.files, digest: "b".repeat(64) });
    result = skill;
  } else if (path === "/knowledge-extraction/skills/component-analysis" || path === "/knowledge-extraction/skills/component") {
    const current = componentSkills[path.endsWith("component-analysis") ? "component-analysis" : "component"];
    check(!input, "仓库维护的组件方法不允许页面上传更新");
    result = current;
  } else if (path === "/knowledge-materials") result = { id: "material-fixture", name: input.name, version: "v2", scope: "本次萃取任务", state: "ready", sections: 2 };
  // 验证创建请求即结束，不让模拟研究体掩盖草稿是否清理。
  else if (path === "/domain-extraction" && input) return new Response(JSON.stringify({ error: "fixture: create unavailable" }), { status: 500 });
  else throw new Error(`unexpected request: ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
root.render(<KnowledgeLibrary onOpenTask={() => {}} />);
const visible = (e: Element) => !!e.getClientRects().length;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(e => visible(e) && e.textContent?.trim() === text);
async function click(text: string) { const e = button(text); check(e && !e.disabled, `missing enabled button ${text}`); e!.click(); await pause(); }
async function waitFor(selector: string) { for (let i = 0; i < 40 && !document.querySelector(selector); i++) await pause(); check(document.querySelector(selector), `missing ${selector}; route=${location.search}`); }
async function fill(selector: string, value: string) {
  const e = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!; check(e, `missing ${selector}`);
  Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(e, value);
  e.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function pick(selector: string, files: File[]) {
  const list = new DataTransfer(); files.forEach(file => list.items.add(file));
  const field = document.querySelector<HTMLInputElement>(selector)!; check(field, `missing ${selector}`);
  field.files = list.files; field.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
const description = "核对退款规则", issue = "REQ-449", goal = "只研究退款规则", branch = "feature/refunds";
const value = (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value;
async function run() {
  await waitFor('[aria-label="研究知识"]'); await pause();
  if (componentScenario) {
    const sources = document.querySelector('[aria-label="参考来源仓列表"]');
    check(sources?.querySelectorAll("li").length === 2 && sources.textContent?.includes("基础实现来源仓") && sources.textContent?.includes("网络实现来源仓"), "技术栈需显示全部启用的参考仓");
    check(!sources?.textContent?.includes("停用来源") && !sources?.textContent?.includes("Java参考"), "停用和其他技术栈来源不得混入");
    check(!document.querySelector('[aria-label="组件"]') && !document.body.textContent?.includes("每个组件各建一个任务"), "来源仓不能作为组件选择目标");
    check(document.body.textContent?.includes("一个来源仓可以包含多个组件") && document.body.textContent?.includes("同一个组件也可以涉及多个来源仓"), "应说明功能能力与来源仓是多对多关系");
  }
  if (scenario === "component-start") {
    const select = document.querySelector<HTMLButtonElement>('[aria-label="技术栈"]')!;
    select.click(); await pause();
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === "Java")!.click(); await pause();
    check(document.querySelector('[aria-label="参考来源仓列表"]')?.textContent?.includes("Java参考来源仓"), "切换技术栈应更新来源范围");
    check(document.querySelector('[aria-label="参考来源仓列表"]')?.querySelectorAll("li").length === 1, "切换后不能保留旧技术栈的来源仓");
    select.click(); await pause();
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === "C++")!.click(); await pause();
    await click("开始研究"); await waitFor('[aria-label="组件文稿审查"]');
    const posts = calls.filter(call => call.path === "/component-research" && call.input);
    check(posts.length === 1 && posts[0].input.language === "cpp" && Object.keys(posts[0].input).length === 1, "两个来源仓只创建一个技术栈研究任务");
    check(document.body.textContent?.includes("2 个来源仓") && !document.body.textContent?.includes("个组件仓"), "任务工作台来源计数不可冒充组件数量");
    const scope = [...document.querySelectorAll<HTMLElement>("summary")].find(item => visible(item) && item.textContent?.trim() === "来源范围");
    check(scope, "新任务应可展开来源范围"); scope!.click(); await pause();
    check(document.body.textContent?.includes("基础实现来源仓") && document.body.textContent?.includes("网络实现来源仓"), "新任务source_repositories需完整展示且无需旧component字段");
    check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面研究入口不能横向溢出");
    if (!(window as any).__KEEP_RESEARCH_PREVIEW__) root.unmount();
    return { passed: true };
  }
  if (scenario === "component-methods") {
    check(button("模块分析方法") && button("用法萃取方法") && !button("萃取方法"), "组件研究应提供两个清晰方法入口");
    for (const [label, kind] of [["模块分析方法", "component-analysis"], ["用法萃取方法", "component"]]) {
      await click(label); await waitFor('[aria-label="平台 Skill 详情"]');
      check(new URLSearchParams(location.search).get("knowledgeDocument") === `platform-skill-${kind}`, "方法应打开独立的 Skill 页面");
      check(document.querySelector('[aria-label="Skill 文件正文"]')?.textContent?.includes(kind === "component-analysis" ? "按源码边界划分模块" : "用法及单元测试"), "两个入口不能显示同一份方法");
      check(!button("更新方法") && !button("确认更新") && !button("回退") && !button("选择 Skill 目录") && !button("选择 SKILL.md"), "组件方法页面只读，不提供更新或回退操作");
      check(!document.querySelector('input[aria-label="上传平台 Skill 目录"]') && !document.querySelector('input[aria-label="上传平台 SKILL.md"]'), "组件方法页面不挂载上传控件");
      await click("使用此 Skill"); await waitFor('[aria-label="研究知识"]');
      check(new URLSearchParams(location.search).get("kbModule") === "engineering:cpp", "使用组件方法应回到原组件研究入口");
      check(document.querySelector('[aria-label="技术栈"]')?.textContent?.includes("C++"), "查看方法后技术栈不能丢失");
      check(document.querySelector('[aria-label="参考来源仓列表"]')?.querySelectorAll("li").length === 2 && !document.querySelector('[aria-label="组件"]'), "查看方法后应恢复整个技术栈来源范围，不出现仓当组件的选择");
      check(button("模块分析方法") && button("用法萃取方法"), "返回后仍应是组件模式");
    }
    check(!calls.some(c => c.path.startsWith("/knowledge-extraction/skills/component") && c.input), "阅读和返回组件方法不产生写入请求");
    check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面组件方法入口不能横向溢出");
    if (!(window as any).__KEEP_RESEARCH_PREVIEW__) root.unmount();
    return { passed: true };
  }
  await fill('[aria-label="单号描述"]', description);
  await fill('input[placeholder="需求或问题单号"]', issue);
  if (scenario === "cleanup") { document.querySelector<HTMLInputElement>('input[aria-label="萃取前清理旧知识"]')!.click(); await pause(); }
  if (scenario === "description") {
    check(value('[aria-label="单号描述"]') === description, "填单号后，先填写的单号描述被清空");
    await fill('input[placeholder="需求或问题单号"]', "REQ-450");
    check(value('[aria-label="单号描述"]') === description, "修改单号不应清空人工描述");
  } else {
    // 单独隔离导航缺陷，不被描述清空缺陷提前中断。
    await fill('[aria-label="单号描述"]', description);
    await fill('.field-pair input', branch); await fill('textarea', goal);
    // 避免 Chrome 虚拟时钟先于文件 I/O 超时。
    const OriginalReader = window.FileReader;
    (window as any).FileReader = class { result = "data:text/plain;base64,IyBydWxlcw=="; onload?: () => void; readAsDataURL() { this.onload?.(); } };
    await pick('input[aria-label="上传业务资料"]', [new File(["# rules"], "业务.md")]);
    window.FileReader = OriginalReader;
    await click("萃取方法"); await waitFor('[aria-label="平台 Skill 详情"]');
    check(!button("开始研究"), "方法阅读页不显示研究表单");
    if (scenario === "method") {
      check(!button("更新方法") && !button("确认更新") && !button("回退"), "领域方法随平台发布，仅供阅读");
      check(!document.querySelector('input[aria-label="上传平台 Skill 目录"]') && !document.querySelector('input[aria-label="上传平台 SKILL.md"]'), "领域方法页不再挂载上传控件");
      check(document.querySelector('[aria-label="Skill 文件正文"]')?.textContent?.includes("先阅读业务材料"), "方法正文仍可阅读");
      check(document.querySelector('[aria-label="平台 Skill 详情"]')?.textContent?.includes("无需上传"), "说明方法随平台更新");
      check(button("使用此 Skill"), "保留返回研究入口");
      check(!calls.some(c => c.path === "/knowledge-extraction/skills/domain" && c.input), "阅读内置方法不发起写入");
      check(document.documentElement.scrollWidth <= innerWidth + 2, "方法页不能横向溢出");
      if (!(window as any).__KEEP_RESEARCH_PREVIEW__) root.unmount();
      return { passed: true };
    } else if (scenario === "return") {
      // 使用产品提供的返回入口，不能靠测试直接重写地址。
      const back = [...document.querySelectorAll<HTMLButtonElement>("button")].find(e => visible(e) && (e.textContent?.trim() === "返回研究知识" || e.textContent?.trim() === "返回知识库"));
      check(back, "萃取方法缺少返回入口"); back!.click(); await pause();
    } else if (scenario === "history") { history.back(); await pause(); }
    else await click("使用此 Skill");
    check(new URLSearchParams(location.search).get("kbPage") === "research", "从方法页返回应回到之前的研究表单");
    await waitFor('[aria-label="研究知识"]');
    check(value('input[placeholder="需求或问题单号"]') === issue, "返回后关联单号丢失");
    check(value('[aria-label="单号描述"]') === description, "返回后单号描述丢失");
    check(value('.field-pair input') === branch && value('textarea') === goal, "返回后基准分支或研究要求丢失");
    check(document.querySelector('[aria-label="业务资料上传"]')?.textContent?.includes("业务.md"), "返回后上传资料丢失");
    check(document.querySelector('[aria-label="知识归属"]')?.textContent?.includes("交易业务"), "返回后业务模块丢失");
    if (scenario === "cleanup") check(document.querySelector<HTMLInputElement>('input[aria-label="萃取前清理旧知识"]')?.checked, "查看方法后清理选择不能丢失");
    await click(scenario === "cleanup" ? "进入旧知识清理" : "开始研究");
    const submitted = calls.find(c => c.path === "/domain-extraction" && c.input)?.input;
    check(submitted?.issue_no === issue && submitted.issue_description === description && submitted.baseline_branch === branch && submitted.instructions === goal && submitted.material_ids[0] === "material-fixture", "恢复后的全部信息需进入创建请求");
    check(scenario === "cleanup" ? submitted.prepare_cleanup === true : submitted.prepare_cleanup === undefined, "清理须是显式可选，默认不改变直接研究");
    // 创建失败后离开再回来，也必须保留输入。
    await click("萃取方法"); await waitFor('[aria-label="平台 Skill 详情"]'); await click("使用此 Skill");
    check(value('[aria-label="单号描述"]') === description, "创建失败不能删除草稿");
  }
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面窗口不能横向溢出");
  if (!(window as any).__KEEP_RESEARCH_PREVIEW__) root.unmount(); return { passed: true };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); root.unmount(); });

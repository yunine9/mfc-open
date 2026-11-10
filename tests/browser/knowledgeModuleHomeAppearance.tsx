import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleHome } from "../../web/src/KnowledgeModuleHome";
import type { BusinessModule } from "../../web/src/api";
import type { KnowledgeDocument } from "../../web/src/knowledgeDocumentsApi";

const moduleFixtures = [
  ["trade", "交易订单与支付", "订单生命周期、支付状态与退款边界，帮助研发和测试快速核对业务规则。", 200],
  ["new", "企业账户与客户服务", "账户体系与企业客户服务知识。", 0],
  ["inventory", "跨区域供应链库存协同与售后履约规则管理", "覆盖多区域库存调度、仓间流转、售后逆向物流、补偿策略及异常场景；描述较长时保持卡片整齐，不挤压打开入口。", 32],
  ["member", "会员与权益", "会员等级、积分、优惠券及权益的适用范围。", 18],
  ["billing", "结算与对账", "账单、资金清分、差异核对与财务结算。", 9],
  ["notification", "消息与通知", "站内信、邮件和推送通知的触发条件与送达规则。", 5],
  ["risk", "风控与合规", "准入校验、交易风险识别和业务操作审计。", 1],
  ["fulfillment", "物流与履约", "发货、配送、签收及履约异常处理。", 12],
] as const;
const stacks = [{ id: "cpp", name: "C++", enabled: true }, { id: "java", name: "Java", enabled: true }, { id: "typescript", name: "TypeScript 与前端工程", enabled: true }];
const modules: BusinessModule[] = moduleFixtures.map(([id, name, description]) => ({
  id, name, description, owner: "demo", maintainers: [], repositories: [`https://git.example.test/business/${id}.git`],
  knowledge_location: { repository: "https://git.example.test/domain-knowledge.git", branch: "main", docs_path: `Function_Knowledge/Access Function/${name}` },
  revision: 1, assets: [], status: "active", created_at: "2026-10-01T08:00:00Z", created_by: "demo",
  updated_at: "2026-10-19T08:00:00Z", updated_by: "demo", can_manage: true,
}));
function documentFixture(id: string, title: string, moduleId?: string, technology?: string): KnowledgeDocument {
  return {
    id, title, scope: moduleId ? "module" : "platform", module_ids: moduleId ? [moduleId] : [], technologies: technology ? [technology] : [],
    repositories: [], product_versions: [], when_to_use: "", active: true, revision: "published-1",
    source: { repository: "https://git.example.test/domain-knowledge.git", branch: "main", path: `Function_Knowledge/Access Function/${moduleId ?? technology}/${title}.md`, revision: "commit-1" },
    history: [{ at: "2026-10-19T08:00:00Z", operator: "demo", action: "create" }],
  };
}
const documents = [
  ...moduleFixtures.flatMap(([id, name, , count]) => Array.from({ length: count }, (_, index) => documentFixture(`kg-${id}-${index}`, id === "trade" && index === 0 ? "退款边界指南" : `${name}规则-${index + 1}`, id))),
  ...stacks.flatMap((stack, stackIndex) => Array.from({ length: [48, 23, 11][stackIndex] }, (_, index) => documentFixture(`kd-${stack.id}-${index}`, `${stack.name}组件指南-${index + 1}`, undefined, stack.id))),
];
const errors: string[] = [], opened: string[] = [], openedDocuments: Array<{ id: string; moduleKey: string }> = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.fetch = async input => {
  const path = String(input);
  const result = path === "/knowledge-documents?view=directory" ? { documents, revision: "appearance-1" }
    : path === "/business-modules" ? { modules }
    : path === "/technology-stacks" ? { stacks }
    : path === "/component-repositories" ? { components: [] }
    : path === "/skills?view=directory" ? { skills: [], operations: [] }
    : undefined;
  if (!result) throw new Error(`不应请求 ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
// 只渲染真实首页组件；为实际 App 的 228px 侧栏和 86px 知识库标题条保留空间。
createRoot(document.getElementById("app")!).render(<div className="tw-root" style={{ display: "grid", gridTemplateColumns: "228px minmax(0, 1fr)", minHeight: "100vh", background: "var(--canvas)" }}>
  <aside aria-hidden="true" style={{ background: "var(--sidebar)", borderRight: "1px solid var(--line)" }} />
  <main className="knowledge-app-main" style={{ minWidth: 0, paddingInline: 40 }}>
    <section className="knowledge-hub"><header className="knowledge-hub-header" aria-hidden="true"><span className="knowledge-hub-brand"><strong>知识库</strong></span></header>
      <KnowledgeModuleHome onOpenModule={key => opened.push(key)} onOpenDocument={(id, moduleKey) => openedDocuments.push({ id, moduleKey })} />
    </section>
  </main>
</div>);

const pause = () => new Promise(resolve => setTimeout(resolve, 70));
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 70 && !predicate(); i++) await pause(); check(predicate(), message); }
const cards = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="打开"][aria-label$="知识目录"]')];
const card = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="打开${name}知识目录"]`);
async function click(selector: string) {
  const element = document.querySelector<HTMLButtonElement>(selector); check(element && !element.disabled, `入口不可用：${selector}`);
  element!.click(); await pause();
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索目录或文稿"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
async function category(value: "all" | "business" | "engineering") {
  await click(".km-category-trigger");
  await click(`.km-category-disc button[data-category="${value}"]`);
  const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getClientRects().length && button.textContent?.trim() === "收起");
  check(close, "分类弹窗可收起"); close!.click(); await pause();
}
function desktop() {
  check(document.documentElement.scrollWidth <= innerWidth + 2, "首页横向溢出");
  for (const entry of cards()) {
    const bounds = entry.getBoundingClientRect();
    check(bounds.left >= 0 && bounds.right <= innerWidth + 1, `卡片超出桌面宽度：${entry.getAttribute("aria-label")}`);
    check(entry.clientWidth >= 200, "桌面卡片过窄");
  }
}
async function run() {
  await until(() => cards().length === 12, "加载 8 个业务模块和 3 个技术栈");
  check(!document.querySelector('[aria-label="知识目录"]')?.textContent?.includes("Function_Knowledge"), "首页不显示已配置的领域知识相对路径");
  check(cards().every(entry => !/文档：|最近维护|暂无维护记录/.test(entry.textContent ?? "") && !entry.querySelector('[aria-label^="文档数量"]')), "模块卡片不展示文档数量和维护时间");
  const longTitle = moduleFixtures[2][1], longCard = card(longTitle);
  check(longCard?.title === longTitle || longCard?.querySelector(`[title="${longTitle}"]`), "截断的长标题可通过悬停查看完整名称");
  desktop();
  card("通用")!.click(); await pause(); check(opened.at(-1) === "engineering:agnostic", "通用入口打开工程通用目录");
  card("交易订单与支付")!.click(); await pause(); check(opened.at(-1) === "business:trade", "业务模块卡片打开正确模块");
  card("企业账户与客户服务")!.click(); await pause(); check(opened.at(-1) === "business:new", "空模块仍可打开");
  await search("跨区域");
  check(cards().length === 1 && card(moduleFixtures[2][1]), "长标题可通过模块搜索定位"); desktop();
  await search("退款边界指南");
  check(cards().length === 1 && card("交易订单与支付"), "按文件名找到所属模块");
  const documentButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "退款边界指南.md");
  check(documentButton, "搜索命中文稿直接打开入口"); documentButton!.click(); await pause();
  check(openedDocuments.at(-1)?.id === "kg-trade-0" && openedDocuments.at(-1)?.moduleKey === "business:trade", "搜索文稿回调保留模块和文稿标识");
  await search("不存在的业务或文稿");
  check(cards().length === 0 && document.body.textContent?.includes("没有匹配的目录或文稿"), "搜索空结果可解释");
  const clear = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "清空搜索");
  check(clear, "空结果可清空搜索"); clear!.click(); await until(() => cards().length === 12, "清空搜索恢复全部卡片");
  await category("business"); check(cards().length === 8, "业务分类只展示 8 个模块"); desktop();
  await category("engineering"); check(cards().length === 4, "工程分类只展示 3 个技术栈"); desktop();
  card("C++")!.click(); await pause(); check(opened.at(-1) === "engineering:cpp", "技术栈卡片打开正确目录");
  await category("all"); check(cards().length === 12, "全部分类恢复 11 个目录");
  if (new URLSearchParams(location.search).get("category") === "engineering") await category("engineering");
  window.scrollTo({ top: 0 }); desktop();
  check(!errors.length, errors.join("\n"));
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth, cards: cards().length, businessModules: 8, technologyStacks: 3, general: 1 });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });

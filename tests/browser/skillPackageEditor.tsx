import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeModuleReader } from "../../web/src/KnowledgeModuleReader";

const mode = new URLSearchParams(location.search).get("mode") ?? "edit";
const engineering = mode === "replace", errors: string[] = [], writes: any[] = [];
const markdown = "---\nname: review-helper\ndescription: 核对代码和业务规则\n---\n# 核对规则\n\n先读取参考文档，再核对实现与验证结果。\n";
let revision = 1, conflict = false;
let files: Array<{ path: string; content?: string; bytes: number }> = [
  { path: "SKILL.md", content: markdown, bytes: 160 },
  { path: "references/check.md", content: "# 核对清单\n\n检查异常处理。\n", bytes: 55 },
  { path: "bin/native-cli", bytes: 7 },
];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
window.confirm = () => true;
window.fetch = async (input, init) => {
  const path = String(input); let result: unknown;
  if (path === "/knowledge-documents?view=directory") result = { documents: [], revision: "directory" };
  else if (path === "/business-modules") result = { modules: [{ id: "trade", name: "交易业务", status: "active", repositories: [], assets: [] }] };
  else if (path === "/business-modules/trade/knowledge-location") result = { configured: false };
  else if (path === "/technology-stacks") result = { stacks: [] };
  else if (path === "/component-repositories") result = { components: [] };
  else if (path === "/component-knowledge") result = { revision: 0, items: [], warnings: [], challenges: [] };
  else if (path === "/skills?view=directory") result = { skills: [{ path: "review-helper/SKILL.md", name: "review-helper", description: "核对代码和业务规则", nature: engineering ? "engineering" : "business", loadable: true, digest: `v${revision}`, business_module_ids: engineering ? [] : ["trade"], repositories: [], technologies: engineering ? ["agnostic"] : [] }], operations: [] };
  else if (path === "/skills/review-helper/package") {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (conflict) return new Response(JSON.stringify({ error: "Skill 已被更新，请保留本次修改，重新打开最新版本后再保存" }), { status: 409, headers: { "content-type": "application/json" } });
      check(body.expected_package_digest === `v${revision}`, "写入必须基于打开时的整包版本");
      const uploaded = body.files.map((file: any) => ({ path: file.path, content: new TextDecoder().decode(Uint8Array.from(atob(file.content_base64), char => char.charCodeAt(0))), bytes: atob(file.content_base64).length }));
      files = body.mode === "replace" ? uploaded : files.map(file => uploaded.find((row: any) => row.path === file.path) ?? file);
      revision++; result = { action: "update" };
    } else result = { package_digest: `v${revision}`, digest: `v${revision}`, content: files[0].content, files };
  } else if (path.startsWith("/knowledge-review/")) result = { notes: [], submissions: {} };
  else throw new Error(`不应请求 ${path}`);
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
createRoot(document.getElementById("app")!).render(<main className="tw-root knowledge-hub is-focused" style={{ padding: 24 }}>
  <KnowledgeModuleReader moduleKey={engineering ? "engineering:agnostic" : "business:trade"} selectedDocumentId="skill:review-helper/SKILL.md" onBack={() => {}} onResearch={() => { throw new Error("Skill 更新不创建知识研究任务"); }} />
</main>);
const pause = () => new Promise(resolve => setTimeout(resolve, 70));
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 80 && !predicate(); i++) await pause(); check(predicate(), message); }
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text); }
async function click(text: string) { const node = button(text); check(node && !node.disabled, `缺少可用按钮 ${text}`); node!.click(); await pause(); }
async function fill(text: string) {
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true })); await pause();
}
const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0xff, 0x80]);
async function pick() {
  const rows = [new File([markdown + "\n替换后的规则。\n"], "SKILL.md"), new File([binary], "new-cli")];
  rows.forEach((row, index) => Object.defineProperty(row, "webkitRelativePath", { value: ["bundle/SKILL.md", "bundle/bin/new-cli"][index] }));
  const transfer = new DataTransfer(); rows.forEach(row => transfer.items.add(row));
  const input = document.querySelector<HTMLInputElement>("input[webkitdirectory]")!;
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true })); await pause();
}
async function run() {
  await until(() => button("编辑") && button("替换") && document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("先读取参考文档"), "业务和工程 Skill 详情都有两个入口");
  if (mode === "edit") {
    await click("编辑"); await until(() => document.querySelector("textarea"), "编辑载入当前包");
    await fill(markdown + "\n编辑后的规则。\n");
    await click("references/check.md"); await fill("# 核对清单\n\n补充异常处理。\n");
    await click("保存并生效");
    await until(() => !document.querySelector('[role="dialog"]') && document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("编辑后的规则"), "保存后正文立即刷新");
    check(writes.length === 1 && writes[0].mode === "edit" && writes[0].files.length === 2, "编辑仅提交改动文件，二进制不经文本重写");
    await click("编辑"); await until(() => document.querySelector("textarea"), "可再次编辑");
    await fill(markdown + "\n冲突时保留的草稿。\n"); conflict = true;
    await click("保存并生效"); await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("Skill 已被更新"), "冲突错误明确可见");
    check(document.querySelector("textarea")?.value.includes("冲突时保留的草稿"), "冲突不清空修改");
    await click("取消"); await click("编辑"); await until(() => document.querySelector("textarea"), "最终编辑视图");
    await fill(markdown + "\n核对失败时补充日志与复现步骤。\n");
  } else {
    await click("替换"); await until(() => document.querySelector("input[webkitdirectory]"), "替换可选择完整目录");
    await pick(); check(document.querySelector('[aria-label="替换文件清单"]')?.textContent?.includes("移除 · references/check.md"), "替换前列出移除的旧文件");
    await click("替换并生效");
    await until(() => !document.querySelector('[role="dialog"]') && document.querySelector('[aria-label="知识正文"]')?.textContent?.includes("替换后的规则"), "整包替换后刷新详情");
    check(writes.length === 1 && writes[0].mode === "replace" && writes[0].files.length === 2, "替换发送完整包");
    check(writes[0].files[1].path === "bin/new-cli" && writes[0].files[1].content_base64 === btoa(String.fromCharCode(...binary)), "CLI 相对路径和二进制字节原样上传");
    check(!document.querySelector('[aria-label="模块知识目录"]')?.textContent?.includes("references/check.md"), "目录不残留已删除附件");
    await click("替换"); await until(() => document.querySelector("input[webkitdirectory]"), "可再次替换"); await pick();
  }
  await pause();
  const dialog = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
  check(dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight, "桌面弹窗完整可见");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面无横向溢出");
  check(!errors.length, errors.join("\n"));
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });

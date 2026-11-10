import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeSkillImport } from "../../web/src/KnowledgeSkillImport";

const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
let submitted: any, created = "";
window.fetch = async (input, init) => {
  const path = String(input);
  const data = path === "/business-modules" ? { modules: [] }
    : path === "/technology-stacks" ? { stacks: [{ id: "java", name: "Java", enabled: true }] }
    : path === "/skills/general-triage/submissions" && init?.method === "POST"
      ? (submitted = JSON.parse(String(init.body)), { directory: "general-triage", id: "submission-1" }) : undefined;
  if (!data) throw new Error(`不应请求 ${path}`);
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
};
createRoot(document.getElementById("app")!).render(<main className="tw-root knowledge-app-main" style={{ padding: "32px 48px", minHeight: "100vh" }}>
  <KnowledgeSkillImport moduleKey="engineering:agnostic" onBack={() => {}} onCreated={id => { created = id; }} />
</main>);

const pause = () => new Promise(resolve => setTimeout(resolve, 70));
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
async function until(predicate: () => unknown, message: string) { for (let i = 0; i < 80 && !predicate(); i++) await pause(); check(predicate(), message); }
async function run() {
  await until(() => document.querySelector('[role="combobox"]')?.textContent?.includes("工程 · 通用"), "读取技术栈后保留工程通用选择");
  const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0xff, 0x80]);
  const rows = [new File(["---\nname: general-triage\ndescription: 通用问题处理流程\n---\n按问题类型核对证据。\n"], "SKILL.md"),
    new File(["#!/bin/sh\necho ready\n"], "check"), new File([binary], "native-cli")];
  rows.forEach((file, index) => Object.defineProperty(file, "webkitRelativePath", { value: ["package/SKILL.md", "package/bin/check", "package/bin/native-cli"][index] }));
  const transfer = new DataTransfer(); rows.forEach(row => transfer.items.add(row));
  const input = document.querySelector<HTMLInputElement>('input[webkitdirectory]')!;
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => document.body.textContent?.includes("bin/native-cli"), "完整 Skill 包保留 CLI 相对目录");
  document.querySelector<HTMLButtonElement>('[role="combobox"]')!.click(); await pause();
  const general = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(button => button.textContent === "通用");
  check(general, "通用是工程知识内的固定可选项"); general!.click(); await pause();
  const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "提交并审查")!;
  check(!submit.disabled, "通用 Skill 可提交"); submit.click();
  await until(() => created === "general-triage/submission-1", "上传后进入审查");
  check(submitted.nature === "engineering", "工程性质正确");
  check(JSON.stringify(submitted.technologies) === '["agnostic"]', "通用标签正确");
  check(submitted.business_module_ids.length === 0 && submitted.repositories.length === 0, "通用不绑定业务和仓库");
  check(submitted.files.length === 3 && submitted.files[2].path === "bin/native-cli", "完整保留包内资源");
  check(submitted.files[2].content_base64 === btoa(String.fromCharCode(...binary)), "CLI 二进制字节不经文本转换");
  check(document.documentElement.scrollWidth <= innerWidth + 2, "桌面无横向溢出");
  check(!errors.length, errors.join("\n"));
  document.getElementById("result")!.textContent = JSON.stringify({ passed: true, width: innerWidth });
}
run().catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });

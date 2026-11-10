import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeSkillTask } from "../../web/src/KnowledgeSkillTask";
import type { SkillSubmissionRecord, SkillExtractionJob } from "../../web/src/api";
import type { KnowledgeProductionView } from "../../src/knowledgeProductionTypes";

type Package = { record: SkillSubmissionRecord; files: Array<{ path: string; bytes: number; content?: string }>; production: KnowledgeProductionView };
type Job = SkillExtractionJob & { production: KnowledgeProductionView };
const fixture = JSON.parse(document.getElementById("fixture")!.textContent!) as { submissions: Package[]; pendingApproved: Package; jobs: Job[] };
const errors: string[] = [], calls: Array<{ method: string; path: string }> = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等待超过1秒预算：${message}`);
}
const packId = (pack: Package) => `${pack.record.directory}/${pack.record.id}`;
const submitted = new Map(fixture.submissions.map(pack => [packId(pack), pack]));
window.fetch = async (input, init) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://fixture.test").pathname;
  const method = init?.method ?? "GET";
  calls.push({ method, path });
  if (method === "GET" && path.startsWith("/knowledge/skill-extract/")) {
    const job = fixture.jobs.find(job => path.endsWith(`/${job.id}`));
    return new Response(JSON.stringify(job), { status: job ? 200 : 404, headers: { "content-type": "application/json" } });
  }
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "skills" && parts[2] === "submissions") {
    const id = `${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[3])}`;
    const pack = submitted.get(id);
    if (method === "POST" && parts[4] === "approve") {
      check(id === packId(fixture.pendingApproved), "发布只能操作当前后端指定的待审包");
      submitted.set(id, fixture.pendingApproved);
      return new Response(JSON.stringify({ action: "approve", production: fixture.pendingApproved.production }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET") return new Response(JSON.stringify(pack), { status: pack ? 200 : 404, headers: { "content-type": "application/json" } });
  }
  throw new Error(`浏览器夹具没有授权请求：${method} ${path}`);
};

function Fixture() {
  const [scene, setScene] = useState(0);
  const pack = fixture.submissions[scene], job = fixture.jobs[scene - fixture.submissions.length];
  return <><nav aria-label="验收场景">{[...fixture.submissions.map(pack => pack.record.directory), ...fixture.jobs.map(job => job.id)].map((label, index) => <button id={`scene-${index}`} key={label} onClick={() => setScene(index)}>{label}</button>)}</nav>
    <KnowledgeSkillTask key={scene} kind={pack ? "skill-submission" : "skill-extraction"} id={pack ? packId(pack) : job.id} onBack={() => {}} onSubmitted={() => {}} />
  </>;
}
const task = () => document.querySelector<HTMLElement>('[aria-label="Skill 知识任务"]');
const taskButtons = () => [...task()!.querySelectorAll<HTMLButtonElement>("button")];
const actionButton = (label: string) => taskButtons().find(button => button.textContent === label);
async function run() {
  const root = createRoot(document.getElementById("app")!);
  root.render(<Fixture />);
  try {
    for (let index = 0; index < fixture.submissions.length; index++) {
      const pack = fixture.submissions[index];
      await until(() => !!document.getElementById(`scene-${index}`), "场景按钮渲染");
      document.getElementById(`scene-${index}`)!.click();
      await until(() => !!task()?.textContent?.includes(pack.record.directory) && !!task()?.textContent?.includes("SKILL.md"), "完整 Skill 包载入");
      check(task()!.textContent!.includes(pack.production.status_label), `${pack.record.status} 必须渲染后端状态 ${pack.production.status_label}`);
      for (const action of pack.production.research_actions) check(actionButton(action.label), `必须渲染后端动作 ${action.id}/${action.label}`);
      if (pack.production.review.readonly) {
        check(!actionButton("发布 Skill") && !actionButton("需要调整"), "只读状态不提供再次批准或退回入口");
        if (pack.record.status === "approving") check(!task()!.textContent!.includes("已退回"), "审批通过中的包不能被界面误标退回");
      } else {
        const publish = pack.production.research_actions.find(action => action.id === "publish")!;
        check(publish, "待审包必须提供真实批准动作");
        actionButton(publish.label)!.click();
        await until(() => !!task()?.textContent?.includes(fixture.pendingApproved.production.status_label), "批准后重新读取真实生产状态");
        check(calls.some(call => call.method === "POST" && call.path === `/skills/${pack.record.directory}/submissions/${pack.record.id}/approve`), "发布点击必须到达当前提交的批准 HTTP 入口");
        check(!actionButton(publish.label), "批准后不保留旧状态的批准动作");
      }
    }
    for (let index = 0; index < fixture.jobs.length; index++) {
      const job = fixture.jobs[index];
      document.getElementById(`scene-${fixture.submissions.length + index}`)!.click();
      await until(() => !!task()?.textContent?.includes(job.intent), "制作任务载入");
      check(task()!.textContent!.includes(job.production.status_label), `制作 ${job.status} 必须渲染后端状态 ${job.production.status_label}`);
      for (const action of job.production.research_actions) check(actionButton(action.label), `制作页必须渲染后端动作 ${action.id}/${action.label}`);
      if (job.error) check(task()!.textContent!.includes(job.error), "失败原因保持服务端原文");
      if (!job.production.research_actions.length) check(!actionButton("继续研究") && !actionButton("审查文稿"), "无真实可执行动作时不编造恢复或审查入口");
    }
    check(!errors.length, errors.join("；"));
    check(document.documentElement.scrollWidth <= innerWidth, "1366桌面不横向溢出");
    return { passed: true, width: innerWidth, height: innerHeight };
  } finally { root.unmount(); }
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });

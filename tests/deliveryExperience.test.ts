import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DeliveryExperiences, parseDeliveryExperiences } from "../src/deliveryExperience.ts";
import { DELIVERY_EXPERIENCE_MISSION } from "../src/deliveryExperienceAgent.ts";
import { MemoryStore, memoryAccessible } from "../src/taskMemory.ts";

const draft = { dimension:"组件与接口用法", trigger:"创建内部文件句柄时", scope:"local", paths:["file.cpp"], problem:"首次未释放句柄，最终补齐清理", conclusion:"使用组件提供的资源管理对象释放句柄。\n\n适用例外：限本组件，借用句柄不自行释放。", evidence_ids:["diff","annotation:a"] };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "delivery-experience-"));
  const cwd = join(dir, "repo"); const workspace=join(dir,"task"); mkdirSync(cwd); mkdirSync(workspace);
  const git = (...args:string[]) => execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init");git("config","user.name","Test");git("config","user.email","test@example.com");
  writeFileSync(join(cwd,"file.cpp"),"open();\n");git("add",".");git("commit","-m","first implementation");const first=git("rev-parse","HEAD");
  const task:any={cwd,summary:{id:"task-1",workspace,status:"await_merge",requirement:"文件处理",delivery:{mr_url:"https://code/mr/1",git_push:{sha:first},mr_state:"opened"}}};
  const store=new MemoryStore(dir);
  const options=()=>({store,repo:"repo",module:"files",model:{json:{}},evidence:()=>[{id:"annotation:a",note:"句柄未释放",resolution:{outcome:"fixed"}}]});
  const merge=()=>{writeFileSync(join(cwd,"file.cpp"),"ScopedFile file;\n");git("add",".");git("commit","-m","fix resource cleanup");task.summary.delivery.git_push.sha=git("rev-parse","HEAD");task.summary.delivery.merged_sha=task.summary.delivery.git_push.sha;task.summary.delivery.mr_state="已合入";task.summary.status="completed";};
  return {dir,workspace,task,store,options,first,merge,git,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test("首次交付冻结；合入完成才旁路整理，重复回调/重启不重复入库；采纳后复用",async()=>{
 const f=fixture();let calls=0;let notified=0;
 const run=async(input:any)=>{calls++;assert.equal(input.base,f.first);assert.notEqual(input.head,input.base);assert.match(input.context,/annotation:a/);return JSON.stringify({drafts:[draft]});};
 const options=()=>({...f.options(),notify:async()=>{notified++;}});
 try{const service=new DeliveryExperiences(options,run);service.capture(f.task);service.start(f.task);await service.flush();assert.equal(calls,0);f.merge();service.capture(f.task);service.start(f.task);service.start(f.task);assert.equal(f.task.summary.status,"completed");await service.flush();
 assert.equal(calls,1);assert.equal(notified,1);const row=f.store.list()[0]!;assert.equal(row.source,"delivery_review");assert.equal(row.dimension,draft.dimension);assert.equal(row.review?.status,"pending");assert.equal(memoryAccessible(row,"repo"),false);
 const edited=f.store.review(row.id,"owner",{decision:"accepted",revision:1,dimension:"设计与实现约束",conclusion:"仅本组件的拥有者释放句柄。",scope:"local"});assert.equal(edited.dimension,"设计与实现约束");assert.equal(memoryAccessible(edited,"repo"),true);
 assert.match(readFileSync(join(f.workspace,"交付经验复盘.md"),"utf8"),new RegExp(row.id));
 const restarted=new DeliveryExperiences(options,run);restarted.start(f.task);await restarted.flush();assert.equal(calls,1);assert.equal(f.store.list().length,1);
 }finally{f.cleanup();}
});
test("缺首次快照、取消、仅完成未合入不启动",async()=>{const f=fixture();let calls=0;const service=new DeliveryExperiences(f.options,async()=>{calls++;return '{"drafts":[]}';});try{f.merge();service.start(f.task);service.capture(f.task);f.task.summary.status="canceled";service.start(f.task);f.task.summary.status="completed";f.task.summary.delivery.mr_state="closed";service.start(f.task);await service.flush();assert.equal(calls,0);}finally{f.cleanup();}});
test("交付报告已更新到最终版本时，经验复盘仍使用首次交付版本", async () => {
  const f = fixture(); let base: string | undefined;
  try {
    f.merge();
    mkdirSync(join(f.workspace, "delivery-summary"));
    writeFileSync(join(f.workspace, "delivery-summary/state.json"), JSON.stringify({ first_head: f.first, head: f.task.summary.delivery.git_push.sha }));
    const service = new DeliveryExperiences(f.options, async input => { base = input.base; return '{"drafts":[]}'; });
    service.start(f.task); await service.flush();
    assert.equal(base, f.first);
  } finally { f.cleanup(); }
});
test("空结果是成功，不凑草稿；模型失败不阻断完成也不反复重试",async()=>{for(const fail of [false,true]){const f=fixture();let calls=0;const service=new DeliveryExperiences(f.options,async()=>{calls++;if(fail)throw Error("unavailable");return '{"drafts":[]}';});try{service.capture(f.task);f.merge();service.start(f.task);await service.flush();service.start(f.task);await service.flush();assert.equal(calls,1);assert.equal(f.store.list().length,0);assert.equal(f.task.summary.status,"completed");assert.equal(JSON.parse(readFileSync(join(f.workspace,"delivery-experience/state.json"),"utf8")).status,fail?"failed":"completed");}finally{f.cleanup();}}});
test("已保存模型结果但发布中断，重启复用结果并补齐草稿不重复模型调用",async()=>{const f=fixture();try{const service=new DeliveryExperiences(f.options,async()=>{throw Error("不应重新调用");});service.capture(f.task);f.merge();const root=join(f.workspace,"delivery-experience");writeFileSync(join(root,"state.json"),'{"status":"running"}');writeFileSync(join(root,"output.json"),JSON.stringify([draft]));f.store.record({...draft,source:"delivery_review",judged_by:"agent",repo:"repo",task:"task-1",evidence:"delivery:task-1:0"} as any);service.start(f.task);await service.flush();assert.equal(f.store.list().length,1);assert.equal(JSON.parse(readFileSync(join(root,"state.json"),"utf8")).status,"completed");}finally{f.cleanup();}});
test("最终版本包含责任人直接提交的修正",async()=>{const f=fixture();try{let final="";const service=new DeliveryExperiences(f.options,async input=>{final=input.head;return '{"drafts":[]}';});service.capture(f.task);f.merge();const platformPush=f.task.summary.delivery.git_push.sha;writeFileSync(join(f.task.cwd,"file.cpp"),"ScopedFile file;\ncheck(file);\n");f.git("add",".");f.git("commit","-m","owner correction");f.task.summary.delivery.merged_sha=f.git("rev-parse","HEAD");service.start(f.task);await service.flush();assert.notEqual(final,platformPush);assert.equal(final,f.task.summary.delivery.merged_sha);}finally{f.cleanup();}});
test("草稿必须有真实依据；六个分析维度不等于六条必填",()=>{assert.deepEqual(parseDeliveryExperiences('{"drafts":[]}',new Set()),[]);assert.throws(()=>parseDeliveryExperiences(JSON.stringify({drafts:[{...draft,evidence_ids:["invented"]}]}),new Set(["diff"])));assert.match(DELIVERY_EXPERIENCE_MISSION,/不要求每类都有/);assert.match(DELIVERY_EXPERIENCE_MISSION,/新增需求、业务变化、个人偏好/);assert.match(DELIVERY_EXPERIENCE_MISSION,/不是第一个 commit/);});
test("生产闭环与 Build-Fix 不再即时提炼，主动记忆入口仍保留",()=>{const source=readFileSync("src/taskService.ts","utf8");assert.doesNotMatch(source,/this\.recordMemory\(task, this\.memoryFromAnnotation\(task, verified/);assert.doesNotMatch(source,/this\.prePushFixMemory\(task,/);assert.match(source,/source: "agent_note"/);assert.match(source,/this\.deliveryExperiences\.capture\(task\)/);assert.match(source,/this\.deliveryExperiences\.start\(task\)/);});
test("squash 合入使用已核对的源代码版本，不把目标提交误作首次版本",async()=>{const f=fixture();try{let final="";const service=new DeliveryExperiences(f.options,async input=>{final=input.head;return '{"drafts":[]}';});service.capture(f.task);f.merge();const sourceHead=f.git("rev-parse","HEAD");f.task.summary.delivery.merged_sha=f.git("commit-tree",f.git("rev-parse","HEAD^{tree}"),"-m","squashed");service.start(f.task);await service.flush();assert.equal(final,sourceHead);assert.notEqual(final,f.task.summary.delivery.merged_sha);}finally{f.cleanup();}});
test("子会话只开放固定版本源码和分页证据工具，继承主模型并记用量",async t=>{
 const {CloudSession}=await import("../src/sessionDriver.ts");
 const {runDeliveryExperienceAgent,experienceEvidenceTool}=await import("../src/deliveryExperienceAgent.ts");
 const f=fixture();let config:any;let disposed=false;
 t.mock.method(CloudSession,"create",async (options:any)=>{config=options;return {start:async(prompt:string)=>{assert.match(prompt,/首次交付是已发布到 MR/);return {status:"turn_finished"};},finalReply:()=>'{"drafts":[]}',dispose:()=>{disposed=true;},abort:async()=>{}} as any;});
 try{writeFileSync(join(f.workspace,"evidence.json"),JSON.stringify([{id:"annotation:a",note:"x".repeat(16000),resolution:{outcome:"not_adopted"}}]));
 const body=await runDeliveryExperienceAgent({taskId:"task-1",repo:f.task.cwd,root:f.workspace,base:f.first,head:f.first,mrUrl:"https://mr/1",capturedAt:"now",context:"{}"},new AbortController().signal,{model:{choice:{provider:"main",model:"selected"},json:{}}});
 assert.equal(body,'{"drafts":[]}');assert.deepEqual(config.allowedTools,["delivery_source","experience_evidence"]);assert.equal(config.provider,"main");assert.equal(config.model,"selected");assert.equal(config.allowHumanQuestions,false);assert.equal(disposed,true);
 const tool=experienceEvidenceTool(f.workspace);const result=await tool.execute("call",{action:"read",id:"annotation:a",offset:12000});assert.match(result.content[0].text,/not_adopted/);await assert.rejects(tool.execute("call",{action:"read",id:"missing"}));
 }finally{f.cleanup();}
});
test("通知发给责任人并直达本次草稿，不改变任务状态",async()=>{
 const {TaskService}=await import("../src/taskService.ts");const f=fixture();const calls:any[]=[];
 const svc=new TaskService({dataDir:f.dir,provider:"test",model:"test",modelsJson:{},maxConcurrent:0,notifier:{notifyOutcome:async(input:any)=>{calls.push(input);return {};}}} as any);
 try {f.task.summary.luban_account="owner";const coordinator=(svc as any).deliveryExperiences;await coordinator.options(f.task).notify(3,"c-test-abc123");assert.equal(calls[0].account,"owner");assert.match(calls[0].summary,/3 条经验草稿.*尽快审核/);assert.match(calls[0].link,/kbPage=experience&memory_id=c-test-abc123&source_task=task-1/);assert.equal(f.task.summary.status,"await_merge");}finally{await svc.shutdown();f.cleanup();}
});
test("草稿保存后通知失败，重启只补通知不重跑模型",async()=>{const f=fixture();let models=0,notifications=0;const options=()=>({...f.options(),notify:async()=>{notifications++;if(notifications===1)throw Error("暂时离线");}});const runner=async()=>{models++;return JSON.stringify({drafts:[draft]});};try{const service=new DeliveryExperiences(options,runner);service.capture(f.task);f.merge();service.start(f.task);await service.flush();assert.equal(f.store.list().length,1);const restarted=new DeliveryExperiences(options,runner);restarted.start(f.task);await restarted.flush();assert.equal(models,1);assert.equal(notifications,2);assert.equal(f.store.list().length,1);}finally{f.cleanup();}});

test("原任务的下一次交付独立整理经验，并使用本次要求", async () => {
  const f = fixture();
  let context = "";
  const service = new DeliveryExperiences(f.options, async input => {
    context = input.context;
    return JSON.stringify({ drafts: [draft] });
  });
  try {
    service.capture(f.task); f.merge(); service.start(f.task); await service.flush();
    rmSync(join(f.workspace, "delivery-experience"), { recursive: true, force: true });
    f.task.summary.delivery_generation = "next-delivery";
    f.task.summary.continuation = { state: "active", text: "修复空行并补说明" };
    service.capture(f.task); service.start(f.task); await service.flush();
    assert.equal(f.store.list().length, 2);
    assert.equal(JSON.parse(context).requirement, "修复空行并补说明");
    assert.ok(f.store.list().some(row => row.evidence === "delivery:task-1:next-delivery:0"));
  } finally { f.cleanup(); }
});

test("大型需求超过八条独立经验全部保存，不因数量拒绝或截断", async () => {
  const f = fixture();
  const drafts = Array.from({ length: 12 }, (_, index) => ({ ...draft, trigger: `组件场景 ${index + 1} 的适用条件` }));
  let notified = 0;
  const service = new DeliveryExperiences(() => ({ ...f.options(), notify: async count => { notified = count; } }),
    async () => JSON.stringify({ drafts }));
  try {
    service.capture(f.task); f.merge(); service.start(f.task); await service.flush();
    assert.equal(f.store.list().length, 12);
    assert.equal(notified, 12);
    assert.equal(JSON.parse(readFileSync(join(f.workspace, "delivery-experience/state.json"), "utf8")).status, "completed");
    assert.match(DELIVERY_EXPERIENCE_MISSION, /反例一/);
    assert.match(DELIVERY_EXPERIENCE_MISSION, /正例/);
    assert.match(DELIVERY_EXPERIENCE_MISSION, /不设条数上限/);
  } finally { f.cleanup(); }
});

test('解释文字加唯一 JSON 块可解析，多个候选块与伪造依据仍拒绝',()=>{
  assert.deepEqual(parseDeliveryExperiences('核对后没有新经验。\n\n```json\n{"drafts":[]}\n```',new Set()),[]);
  assert.throws(()=>parseDeliveryExperiences('```json\n{"drafts":[]}\n```\n```json\n{"drafts":[]}\n```',new Set()));
  assert.throws(()=>parseDeliveryExperiences('```json\n{"drafts":[{"dimension":"组件与接口用法","scope":"local","trigger":"使用接口时","problem":"失败","conclusion":"检查条件","paths":[],"evidence_ids":["invented"]}]}\n```',new Set(['diff'])),/真实依据/);
});

test("交付复盘收到消费时的历史经验，修订建议待审且不覆盖现行人工内容",async()=>{
 const {recordMemoryUsage}=await import("../src/memoryUsage.ts");
 const f=fixture();
 try {
  const row=f.store.record({source:"user_note",judged_by:"human",scope:"local",repo:"repo",paths:["file.cpp"],task:"old",evidence:"note",trigger:"资源释放",conclusion:"旧结论：open 失败不需要 close。"});
  f.store.review(row.id,"owner",{decision:"accepted",revision:1});
  recordMemoryUsage({workspace:f.workspace,taskId:"task-1",store:()=>f.store},{moment:"context",ids:[row.id],assets:[{id:row.id,revision:"2"}]});
  f.store.review(row.id,"owner",{decision:"accepted",revision:2,conclusion:"人工补充：借用资源不能关闭，其他条件待核实。"});
  const reference=`memory:${row.id}:2`;
  const service=new DeliveryExperiences(f.options,async input=>{
   const context=JSON.parse(input.context);assert.equal(context.memory_usage_available,true);
   const evidence=JSON.parse(readFileSync(join(input.root,"evidence.json"),"utf8")).find((e:any)=>e.id===reference);
   assert.equal(evidence.historical.conclusion,"旧结论：open 失败不需要 close。");
   assert.equal(evidence.current_revision,3);
   return JSON.stringify({drafts:[{...draft,evidence_ids:["diff","annotation:a",reference]}]});
  });
  service.capture(f.task);f.merge();service.start(f.task);await service.flush();
  assert.equal(f.store.find(row.id)?.revision,3);
  assert.equal(f.store.find(row.id)?.conclusion,"人工补充：借用资源不能关闭，其他条件待核实。");
  const proposal=f.store.list({task:"task-1"})[0];
  assert.equal(proposal.review?.status,"pending");assert.match(proposal.quote!,new RegExp(reference));
 }finally{f.cleanup();}
});

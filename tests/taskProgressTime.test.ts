import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { progressAdvanced, taskProgressTimestamp } from "../src/taskProgressTime.ts";
import { taskHealthFacts } from "../web/src/taskHealth.ts";
import { progressAgeMs } from "../web/src/teamOps.ts";

test("重读、脉冲 revision、标题和阻塞说明变化不是进展，步骤和里程碑推进才是",()=>{
  const p={phases:[],current_index:0,current_phase:"实现",step_id:"build",revision:1,milestone:{task_id:"a",title:"实现接口",event:"blocked" as const,reason:"等待"}};
  assert.equal(progressAdvanced(undefined,p),false);
  assert.equal(progressAdvanced(p,{...p,revision:999,step:"改名",milestone:{...p.milestone,reason:"仍在等待"}}),false);
  assert.equal(progressAdvanced(p,{...p,step_id:"external_verify"}),true);
  assert.equal(progressAdvanced(p,{...p,milestone:{...p.milestone,event:"completed"}}),true);
});

test("真实宿主：落盘、Token 回报、同阶段看板刷新不重置卡点时间，真正推进会更新",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"progress-clock-"));const service=new TaskService({dataDir:dir,provider:"test",model:"test",modelsJson:{},maxConcurrent:0});
  try{
    const id=service.create("卡点时钟测试").id;const state=(service as any).tasks.get(id);state.cwd=state.summary.workspace;
    const fixed=new Date(Date.now()-3*3600000).toISOString();state.summary.last_progress_at=fixed;state.summary.updated_at=fixed;
    mkdirSync(join(state.cwd,".mae-flow-work"),{recursive:true});const pulse=join(state.cwd,".mae-flow-work/panel-pulse.js");
    const write=(revision:number,step="build")=>writeFileSync(pulse,`window.pulse=${JSON.stringify({phase:"test",step,revision})};`);
    write(1);(service as any).readProgress(state);assert.equal(state.summary.last_progress_at,fixed,"首次读取不能冒充进展");
    (service as any).persist(state);assert.notEqual(state.summary.updated_at,fixed);assert.equal(state.summary.last_progress_at,fixed);
    (service as any).recordTaskTokenUsage(state,{input_tokens:1200,output_tokens:300,at:new Date().toISOString(),session_id:"main"});assert.equal(state.summary.last_progress_at,fixed);
    write(2);(service as any).readProgress(state);assert.equal(state.summary.last_progress_at,fixed,"revision 变化不能把卡点刷成刚刚");
    assert.equal(service.get(id)?.last_progress_at,fixed);
    const report=service.deliveryAnalysis();assert.equal(report.task_tokens?.find(r=>r.id===id)?.usage?.total_tokens,1500,"分析读取真实持久化台账，不依赖 summary 内是否有快照");
    const changed=new Date(Date.now()-1000);write(3,"external_verify");utimesSync(pulse,changed,changed);(service as any).readProgress(state);assert.equal(state.summary.last_progress_at,changed.toISOString());
    assert.equal(JSON.parse(readFileSync(join(state.summary.workspace,"task.json"),"utf8")).summary.last_progress_at,changed.toISOString());
    state.progressCache=undefined;state.progressPulse=undefined;(service as any).readProgress(state);assert.equal(state.summary.last_progress_at,changed.toISOString(),"重建缓存不能重置时间");
  }finally{await service.shutdown();rmSync(dir,{recursive:true,force:true});}
});

test("旧数据的健康时间和团队卡点统计不用不断变化的 updated_at 兜底",()=>{
  const task={id:"task-1",status:"running",created_at:"2026-09-01T00:00:00Z",updated_at:"2026-09-18T00:00:00Z",focus:{headline:"编码",next_action:"继续",owner:"agent" as const,needs_attention:false}};
  assert.equal(taskHealthFacts(task,"alice")?.last_progress_at,task.created_at);
  assert.equal(progressAgeMs(task as any,Date.parse("2026-09-02T00:00:00Z")),86400000);
});

test("历史等人/已完成任务优先使用真实进入等待/完成的时间",()=>{
 const base={created_at:"2026-09-01T00:00:00Z",last_progress_at:"2026-09-18T00:00:00Z"};
 assert.equal(taskProgressTimestamp({...base,status:"waiting_for_human",waiting:{created_at:"2026-09-16T00:00:00Z"}}),"2026-09-16T00:00:00Z");
 assert.equal(taskProgressTimestamp({...base,status:"completed",completed_at:"2026-09-17T00:00:00Z"}),"2026-09-17T00:00:00Z");
});

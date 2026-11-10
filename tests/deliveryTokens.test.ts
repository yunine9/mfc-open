import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateDeliveryTokens } from "../src/deliveryAnalyticsSummary.ts";
import { buildDeliveryAnalysis } from "../src/deliveryAnalytics.ts";
import type { TaskSummary } from "../src/taskService.ts";
const usage=(input:number,output:number)=>({input_tokens:input,output_tokens:output,total_tokens:input+output});
test("任务自身、父子汇总和筛选子集：不重复计数，也不丢主任务分析 Token",()=>{
  const ledger=[{id:"p",usage:usage(100,10)},{id:"a",parent_id:"p",usage:usage(200,20)},{id:"b",parent_id:"p",usage:usage(300,30)},{id:"old",parent_id:"p"}];
  assert.deepEqual(aggregateDeliveryTokens(["a"],ledger),{input:200,output:20,total:220,available:1,tasks:1});
  assert.deepEqual(aggregateDeliveryTokens(["a","b","a","old"],ledger,"p"),{input:600,output:60,total:660,available:3,tasks:4});
  assert.equal(aggregateDeliveryTokens(["a"],ledger,"p").total,330);
  assert.equal(aggregateDeliveryTokens(["old"],ledger).available,0);
});
test("多层拆分保留中间任务分析用量，坏的循环关系也不重复计数",()=>{
  const ledger=[{id:"p",usage:usage(1,1)},{id:"mid",parent_id:"p",usage:usage(2,2)},{id:"leaf",parent_id:"mid",usage:usage(3,3)}];
  assert.equal(aggregateDeliveryTokens(["leaf"],ledger,"p").total,12);
  assert.equal(aggregateDeliveryTokens(["leaf","mid"],ledger,"p").total,12);
  assert.equal(aggregateDeliveryTokens(["a"],[{id:"a",parent_id:"b",usage:usage(1,1)},{id:"b",parent_id:"a",usage:usage(2,2)}],"p").total,6);
});
test("未推送、没有代码快照、主任务不直接交付，均仍有独立 Token 记录",()=>{
  const task=(id:string,parent?:string)=>({id,parent_task_id:parent,workspace:`/nonexistent/${id}`,requirement:id,status:"running",created_at:"2026-09-18T00:00:00Z",token_usage:usage(100,25)} as TaskSummary);
  const report=buildDeliveryAnalysis([task("p"),task("a","p"),{...task("issue"),origin:"issue"}]);
  assert.deepEqual(report.rows.map(r=>r.id),["a"]);
  assert.deepEqual(report.task_tokens?.map(r=>r.id),["p","a"]);
  assert.equal(report.rows[0].metric,undefined);
  assert.equal(aggregateDeliveryTokens(["a"],report.task_tokens,"p").total,250);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/taskMemory.ts";
import { recordMemoryUsage } from "../src/memoryUsage.ts";
import { memoryFeedbackEvidence } from "../src/memoryFeedback.ts";

test("复盘读取实际接触的历史版本，不拿维护后的正文替换现场", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-memory-feedback-"));
  try {
    const store = new MemoryStore(dir);
    const row = store.record({source:"user_note",judged_by:"human",author:"owner",scope:"general",repo:"repo",paths:[],task:"old",evidence:"note",trigger:"请求超时",conclusion:"旧版单位为秒"});
    const accepted = store.review(row.id,"owner",{decision:"accepted",revision:1});
    const context = {workspace:dir,taskId:"task",store:()=>store};
    recordMemoryUsage(context,{moment:"search",ids:[row.id,row.id],assets:[{id:row.id,revision:"1"}]});
    recordMemoryUsage(context,{moment:"expand",status:"rejected",ids:[row.id],assets:[{id:row.id,revision:"3"}]});
    recordMemoryUsage(context,{moment:"context",status:"ready",ids:[row.id],assets:[{id:row.id,revision:String(accepted.revision)}]});
    recordMemoryUsage(context,{moment:"expand",status:"ready",ids:[row.id],assets:[{id:row.id,revision:"2",start_line:5,end_line:9}]});
    recordMemoryUsage(context,{moment:"context",status:"unavailable",ids:[row.id],assets:[{id:row.id,revision:"2"}]});
    store.review(row.id,"owner",{decision:"accepted",revision:2,conclusion:"新版单位为毫秒"});
    const result = memoryFeedbackEvidence(dir,store);
    assert.equal(result.available,true);assert.equal(result.records.length,1);
    const evidence = result.records[0];
    assert.equal(evidence.revision,"2");assert.equal(evidence.current_revision,3);
    assert.equal(evidence.historical?.conclusion,"旧版单位为秒");
    assert.equal(evidence.current?.conclusion,"新版单位为毫秒");
    assert.deepEqual(evidence.observations.map(o=>o.moment),["context","expand","context"]);
    assert.equal(evidence.observations[1].end_line,9);
    assert.equal(store.ledger.rows().find(r=>r.kind==="push")?.revision,"2");
    assert.equal(store.ledger.stats().get(row.id)?.hits,2,"搜索的重复片段与拒读不重复计数，只有一次搜索和一次展开");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("旧日志没有版本或历史版本缺失时只留事实，不补造正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-memory-feedback-old-"));
  try {
    const store=new MemoryStore(dir);
    assert.equal(memoryFeedbackEvidence(dir,store).available,false);
    writeFileSync(join(dir,"memory-usage.jsonl"),[
      {moment:"context",ids:["c-legacy"]},
      {moment:"context",ids:["c-missing"],assets:[{id:"c-missing",revision:"9"}]},
      {moment:"search",ids:["c-search-only"]},
    ].map(v=>JSON.stringify(v)).join("\n")+"\n");
    const result=memoryFeedbackEvidence(dir,store);
    assert.equal(result.records.length,2);
    assert.ok(result.records.every(r=>!r.historical));
    assert.equal(result.records[0].revision,undefined);
    assert.equal(result.records[1].revision,"9");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

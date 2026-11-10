import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRanking, summarize, compareReports, type CaseResult } from "../harness/knowledge-benchmark/scoring.ts";
import { documents, queries } from "../harness/knowledge-benchmark/fixtures.ts";

test("benchmark 不把越界命中、无结果或第六名算成召回成功", () => {
  assert.equal(scoreRanking(["wanted"], ["wanted", "forbidden"], ["forbidden"]).passed, false);
  assert.equal(scoreRanking(["wanted"], []).passed, false);
  assert.equal(scoreRanking(["wanted"], ["a","b","c","d","e","wanted"]).passed, false);
  assert.equal(scoreRanking([], ["unrelated"]).passed, false);
  assert.equal(scoreRanking([], []).passed, true);
});

test("benchmark 正例召回、负例拒绝、章节证据和安全检查分别计分", () => {
  const rows: CaseResult[] = [
    {id:"one",kind:"retrieval",passed:true,positive:true,rank:1,elapsed_ms:10,evidence_expected:true,evidence_rank:3},
    {id:"two",kind:"retrieval",passed:false,positive:true,elapsed_ms:30},
    {id:"negative",kind:"retrieval",passed:true,positive:false,elapsed_ms:20},
    {id:"guard",kind:"guard",passed:false,elapsed_ms:2000},
  ];
  const s = summarize(rows);
  assert.equal(s.retrieval.hit_at_5,0.5);
  assert.equal(s.retrieval.mrr_at_5,0.5);
  assert.equal(s.retrieval.negative_rejection_rate,1);
  assert.equal(s.retrieval.p95_ms,30);
  assert.equal(s.evidence.hit_at_1,0);
  assert.equal(s.evidence.hit_at_5,1);
  assert.deepEqual(s.guards,{total:1,passed:0});
  assert.equal(summarize([]).retrieval.hit_at_5,null);
});

test("benchmark 比较拒绝更换语料或评分口径，并指出退步与新增案例", () => {
  const row = (id:string,passed:boolean):CaseResult => ({id,passed,kind:"guard",elapsed_ms:1});
  const report = (cases:CaseResult[]) => ({schema_version:1,fixture_hash:"fixed",evaluator_hash:"same",run_config:{agent:false},cases,summary:summarize(cases)});
  const old=report([row("regressed",true),row("improved",false),row("removed",true)]);
  const now=report([row("regressed",false),row("improved",true),row("added",true)]);
  const c=compareReports(now,old);
  assert.deepEqual(c.regressions,["regressed"]);assert.deepEqual(c.improvements,["improved"]);
  assert.deepEqual(c.added,["added"]);assert.deepEqual(c.removed,["removed"]);
  assert.throws(()=>compareReports({...now,fixture_hash:"changed"},old));
  assert.throws(()=>compareReports({...now,evaluator_hash:"changed"},old));
  assert.throws(()=>compareReports({...now,run_config:{agent:true}},old));
});

test("benchmark 固定集的预期和禁止条目真实存在且不互相矛盾", () => {
  const keys=new Set(documents.map(d=>d.key));
  assert.equal(keys.size,documents.length);
  assert.equal(new Set(queries.map(q=>q.id)).size,queries.length);
  for(const q of queries) {
    for(const id of [...q.expected,...q.forbidden??[]]) assert.ok(keys.has(id),`${q.id}: ${id}`);
    assert.ok(!q.expected.some(id=>q.forbidden?.includes(id)),q.id);
    if(q.evidence) assert.ok(documents.some(d=>q.expected.includes(d.key)&&d.content.includes(q.evidence!)),q.id);
  }
});

test("benchmark C++ 评分器接受正确实现，并拒绝三个关键规则被破坏的实现", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { header, common, agentCases } = await import("../harness/knowledge-benchmark/agent.ts");
  const correct = [
    'bool exportName(int id,const std::string& path){auto n=NeConfig::getName(id);if(!n)return false;ReportWriter w;if(!w.open(path)){w.close();return false;}bool ok=w.write(*n);w.close();return ok;}',
    'bool appendReport(ReportWriter& w,const std::string& text){return w.write(text);}',
    'int timeoutMillis(){return Config::value("request_timeout_seconds")*1000;}',
  ];
  const broken = [correct[0].replace('w.close();return false;','return false;'),
    correct[1].replace('return w.write(text);','bool ok=w.write(text);w.close();return ok;'),
    correct[2].replace('request_timeout_seconds','request_timeout_ms').replace('*1000','')];
  const dir=mkdtempSync(join(tmpdir(),"knowledge-benchmark-oracle-"));
  try {
    writeFileSync(join(dir,"api.hpp"),header);
    for(const [i,scenario] of agentCases.entries()) for(const [label,source] of [["correct",correct[i]],["broken",broken[i]]]) {
      writeFileSync(join(dir,"solution.cpp"),'#include "api.hpp"\n'+source);
      writeFileSync(join(dir,"checks.cpp"),common+scenario.tests);
      const compiled=spawnSync(process.env.CXX||"c++",["-std=c++17",join(dir,"solution.cpp"),join(dir,"checks.cpp"),"-o",join(dir,"check")],{encoding:"utf8",timeout:30000});
      assert.equal(compiled.status,0,compiled.stderr);
      const run=spawnSync(join(dir,"check"),[],{encoding:"utf8",timeout:5000});
      assert.equal(run.status,label==="correct"?0:1,`${scenario.id}/${label}: ${run.stdout} ${run.stderr}`);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

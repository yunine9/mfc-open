import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scoreGeneration} from '../harness/knowledge-benchmark/generation.ts';
import {generationFixtures} from '../harness/knowledge-benchmark/generation-fixtures.ts';
import {runScopeCases} from '../harness/knowledge-benchmark/scope.ts';
import type {CaseResult} from '../harness/knowledge-benchmark/scoring.ts';
import {assessPipelineConsumption} from '../harness/knowledge-benchmark/pipeline.ts';

test('生成到消费的通过必须同时有相关经验进入上下文和代码行为通过',()=>{
  const row:CaseResult={id:'agent/example/generated-context/1',kind:'agent',passed:true,elapsed_ms:1};
  assert.equal(assessPipelineConsumption(row,['expected'],['expected']).passed,true);
  assert.equal(assessPipelineConsumption(row,['expected'],[]).passed,false);
  assert.equal(assessPipelineConsumption(row,['expected'],['unrelated']).passed,false);
  assert.equal(assessPipelineConsumption({...row,passed:false},['expected'],['expected']).passed,false);
});

test('生成评分接受有条件的结论，拒绝去掉例外、依据或虚构验证的输出',()=>{
  const fixture=generationFixtures[0];
  const draft={dimension:'组件与接口用法',scope:'local',module:'export',paths:['example.cpp'],trigger:'自己拥有 ReportWriter 时',
    problem:'open 失败分支未清理，现已修复。',conclusion:'自己拥有的句柄在 open 失败时也应 close。适用例外：借用句柄由调用方管理。',evidence_ids:['annotation:owned']};
  const score=(d:unknown[])=>scoreGeneration(fixture,JSON.stringify({drafts:d}));
  assert.equal(score([draft]).passed,true);
  for(const mutation of [
    {...draft,conclusion:'所有句柄都应 close。'},
    {...draft,conclusion:draft.conclusion.replace('适用例外：借用句柄由调用方管理。','')},
    {...draft,scope:'platform'},
    {...draft,evidence_ids:['annotation:borrowed']},
    {...draft,problem:'UT 已通过'},
  ]) assert.equal(score([mutation]).passed,false,JSON.stringify(mutation));
  assert.equal(score([]).passed,false);
  assert.equal(score([draft,draft]).passed,false);
  assert.throws(()=>score([{...draft,evidence_ids:['invented']}]),/真实依据/);
  assert.equal(scoreGeneration(generationFixtures[3],'{"drafts":[]}').passed,true);
  assert.equal(scoreGeneration(generationFixtures[3],JSON.stringify({drafts:[{...draft,evidence_ids:['annotation:style']}]})).passed,false);
});

test('真实任务装配：共仓、父任务、显式多模块和版本的消费范围一致',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mfc-scope-contract-'));const rows:CaseResult[]=[];
  try {await runScopeCases(dir,row=>rows.push(row));assert.equal(rows.length,9);assert.deepEqual(rows.filter(r=>!r.passed),[]);}
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('生成汇总区分运行故障、无效输出与契约失败，不报告语义准确率',async()=>{
  const {summarize}=await import('../harness/knowledge-benchmark/scoring.ts');
  const cases:CaseResult[]=['contract_passed','contract_failed','invalid_output','execution_error'].map(outcome=>({id:outcome,kind:'generation',outcome,passed:outcome==='contract_passed',elapsed_ms:1}));
  assert.deepEqual(summarize(cases).generation,{total:4,contract_passed:1,contract_failed:1,invalid_output:1,execution_errors:1,semantic_accuracy:null});
});

test('相同否决依据可以支撑正反两种结论，评分器必须交给语义复核',()=>{
  const fixture=generationFixtures[0];
  const accepted={dimension:'组件与接口用法',scope:'local',paths:[],trigger:'自己拥有句柄',problem:'失败未清理',
    conclusion:'open 失败也应 close。适用例外：借用句柄由调用方管理。',evidence_ids:['annotation:owned']};
  for(const conclusion of ['借用句柄不得关闭；应由其所有者管理。','借用句柄必须关闭；所有函数统一 close。']) {
    const reflection={...accepted,trigger:'借用句柄',conclusion,evidence_ids:['annotation:borrowed']};
    const result=scoreGeneration(fixture,JSON.stringify({drafts:[accepted,reflection]}));
    assert.equal(result.passed,true,'自动概念检查不冒充语义判定');
    assert.equal(result.review_required,true);assert.equal(result.review_flags.length,1);
  }
});

test('引用意见必须实际成功回读，调用失败或读了别的意见不能冒充证据',async()=>{
  const {assessGeneration}=await import('../harness/knowledge-benchmark/generation.ts');
  const fixture=generationFixtures[3];
  const parts:any[]=[{type:'tool_use',id:'diff',name:'delivery_source',input:{action:'diff'}},{type:'tool_result',tool_use_id:'diff',is_error:false}];
  for(const e of fixture.evidence)parts.push({type:'tool_use',id:e.id,name:'experience_evidence',input:{action:'read',id:e.id}},{type:'tool_result',tool_use_id:e.id,is_error:false});
  const trace=()=>JSON.stringify({message:{content:parts}});
  assert.equal(assessGeneration(fixture,'{"drafts":[]}',trace()).passed,true);
  parts.at(-1).is_error=true;
  assert.equal(assessGeneration(fixture,'{"drafts":[]}',trace()).passed,false);
});

test('回放保留旧报告与运行故障，只重新评估已有输出',async()=>{
  const {writeFileSync,mkdirSync,readFileSync}=await import('node:fs');
  const {replayGenerationCases}=await import('../harness/knowledge-benchmark/generation.ts');
  const dir=mkdtempSync(join(tmpdir(),'mfc-generation-replay-'));
  try {
    const output=join(dir,'prior'),id='generation/no-defect/1',root=join(output,id);mkdirSync(root,{recursive:true});
    const fixture=generationFixtures[3],parts:any[]=[];
    for(const e of fixture.evidence)parts.push({type:'tool_use',id:e.id,name:'experience_evidence',input:{action:'read',id:e.id}},{type:'tool_result',tool_use_id:e.id,is_error:false});
    parts.push({type:'tool_use',id:'d',name:'delivery_source',input:{action:'diff'}},{type:'tool_result',tool_use_id:'d',is_error:false});
    writeFileSync(join(root,'output.txt'),'{"drafts":[]}');writeFileSync(join(root,'transcript.jsonl'),JSON.stringify({message:{content:parts}}));
    for(const file of ['prompt.txt','evidence.json','rubric.json'])writeFileSync(join(root,file),'fixture');
    const source=join(dir,'report.json');const original=JSON.stringify({output,cases:[{id,kind:'generation',passed:false,outcome:'contract_failed',elapsed_ms:10},
      {id:'generation/owned-resource/1',kind:'generation',passed:false,error:'Connection error',elapsed_ms:20}]});writeFileSync(source,original);
    const rows:CaseResult[]=[];replayGenerationCases(source,join(dir,'replay'),row=>rows.push(row));
    assert.equal(rows[0].passed,true);assert.equal(rows[0].previous_outcome,'contract_failed');
    assert.equal(rows[1].outcome,'execution_error');assert.equal(rows[1].passed,false);
    assert.equal(readFileSync(source,'utf8'),original);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

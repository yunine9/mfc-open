import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runDeliveryExperienceAgent, DELIVERY_EXPERIENCE_MISSION } from '../../src/deliveryExperienceAgent.ts';
import { parseDeliveryExperiences } from '../../src/deliveryExperience.ts';
import { generationFixtures, type GenerationFixture } from './generation-fixtures.ts';
import type { CaseResult } from './scoring.ts';

export function scoreGeneration(fixture: GenerationFixture, text: string) {
  const checks: Array<{name:string;passed:boolean}> = [];
  const drafts = parseDeliveryExperiences(text,new Set(['diff',...fixture.evidence.map(e=>e.id)]),fixture.id==='non-idempotent-retry'?'billing':'export');
  if(fixture.empty) checks.push({name:'没有可靠缺陷时不生成经验',passed:drafts.length===0});
  else {
    const relevant=drafts.filter(d=>d.evidence_ids.includes(fixture.requiredEvidence!));
    checks.push({name:'引用真实缺陷依据',passed:relevant.length>0});
    checks.push({name:'同一根因不拆成多条',passed:relevant.length===1});
    for(const concept of fixture.concepts) checks.push({name:concept.name,passed:relevant.some(d=>concept.alternatives.some(pattern=>new RegExp(pattern,'is').test(d.trigger+'\n'+d.conclusion)))});
    checks.push({name:'明确保留适用例外',passed:relevant.every(d=>/适用例外/.test(d.conclusion))});
  }
  checks.push({name:'未扩大到跨仓规范',passed:drafts.every(d=>d.scope!=='platform')});
  // A rejected review can legitimately be cited as counterevidence. Preserve it for human review;
  // flag it for semantic review. The same evidence can support either a useful lesson or a wrong rule.
  const reviewFlags = drafts.flatMap((d,index)=>d.evidence_ids.some(id=>fixture.forbiddenEvidence.includes(id))
    ? [{draft:index+1,reason:'引用被否决意见或新增需求：核对是否学习了反证，还是将错误建议当作规范。来源类别不能代替语义判断。'}] : []);
  checks.push({name:'未虚构测试通过',passed:drafts.every(d=>!/(测试|UT|用例).{0,10}(全部通过|已通过|执行通过)/i.test(d.problem+'\n'+d.conclusion))});
  return {passed:checks.every(c=>c.passed),checks,drafts,
    review_required:true, review_flags:reviewFlags, scoring_note:'固定证据与概念契约检查；概念词出现不证明语义正确，原始输出仍需人工核对。'};
}

export function assessGeneration(fixture:GenerationFixture,text:string,transcriptText:string) {
  const scored=scoreGeneration(fixture,text);
  const transcript=transcriptText.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const parts=transcript.flatMap(row=>row.message?.content??[]);
  const successful=new Set(parts.filter((p:any)=>p.type==='tool_result'&&!p.is_error).map((p:any)=>p.tool_use_id));
  const calls=parts.filter((p:any)=>p.type==='tool_use').map((p:any)=>({id:p.id,name:p.name,input:p.input,successful:successful.has(p.id)}));
  const readIds=new Set(calls.filter((c:any)=>c.successful&&c.name==='experience_evidence'&&c.input.action==='read').map((c:any)=>c.input.id));
  const diffRead=calls.some((c:any)=>c.successful&&c.name==='delivery_source'&&c.input.action==='diff');
  const cited=scored.drafts.flatMap(d=>d.evidence_ids).filter(id=>id!=='diff');
  const checks=[...scored.checks,
    {name:'回读全部引用的意见；空结果也核对完整否决依据',passed:(cited.length?cited:fixture.evidence.map(e=>e.id)).every(id=>readIds.has(id))},
    {name:'读取交付差异',passed:diffRead}];
  const passed=checks.every(c=>c.passed);
  return {...scored,checks,passed,outcome:passed?'contract_passed':'contract_failed',tool_calls:calls};
}

/** Re-evaluate immutable model artifacts when correcting the evaluator; never silently replace the original report. */
export function replayGenerationCases(sourceReport:string,out:string,record:(row:CaseResult)=>void) {
  const prior=JSON.parse(readFileSync(sourceReport,'utf8'));
  for(const original of prior.cases.filter((c:CaseResult)=>c.kind==='generation')) {
    const fixture=generationFixtures.find(f=>original.id.split('/')[1]===f.id);
    if(!fixture) throw new Error(`未知生成用例 ${original.id}`);
    const source=join(prior.output,original.id),dest=join(out,original.id);mkdirSync(dest,{recursive:true});
    let row:CaseResult;
    if(original.error) row={...original,outcome:original.outcome??'execution_error',replayed_from:sourceReport};
    else {
      for(const file of ['output.txt','transcript.jsonl','prompt.txt','evidence.json','rubric.json']) writeFileSync(join(dest,file),readFileSync(join(source,file)));
      const assessment=assessGeneration(fixture,readFileSync(join(source,'output.txt'),'utf8'),readFileSync(join(source,'transcript.jsonl'),'utf8'));
      row={...original,...assessment,replayed_from:sourceReport,previous_outcome:original.outcome??(original.passed?'contract_passed':'contract_failed')};
    }
    writeFileSync(join(dest,'result.json'),JSON.stringify(row,null,2));record(row);
  }
}

export async function runGenerationCases(options: {
  out:string;models:string;provider:string;model:string;repeats:number;timeoutMs:number;
  signal:AbortSignal;record:(row:CaseResult)=>void;split:'development'|'holdout'|'all';
}) {
  for(const fixture of generationFixtures.filter(f=>options.split==='all'||f.split===options.split)) for(let repeat=1;repeat<=options.repeats;repeat++) {
    options.signal.throwIfAborted();
    const id=`generation/${fixture.id}/${repeat}`, root=join(options.out,id),repo=join(root,'repo');
    mkdirSync(repo,{recursive:true});
    const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:repo,encoding:'utf8',timeout:10000});
    git('init','-q');git('config','user.name','Benchmark');git('config','user.email','benchmark@example.invalid');
    writeFileSync(join(repo,'example.cpp'),fixture.before);git('add','.');git('commit','-qm','first delivery');const base=git('rev-parse','HEAD').trim();
    writeFileSync(join(repo,'example.cpp'),fixture.after);git('add','.');git('commit','-qm','final delivery');const head=git('rev-parse','HEAD').trim();
    writeFileSync(join(root,'evidence.json'),JSON.stringify(fixture.evidence,null,2));
    writeFileSync(join(root,'rubric.json'),JSON.stringify(fixture,null,2));
    const context=`${fixture.context}\n模块 ID：${fixture.id==='non-idempotent-retry'?'billing':'export'}。\n证据目录：${fixture.evidence.map(e=>`${e.id}: ${e.note}`).join('\n')}\n已有经验：无。请读取完整处理结果和源码差异。`;
    writeFileSync(join(root,'prompt.txt'),DELIVERY_EXPERIENCE_MISSION+'\n\n交付证据：\n'+context);
    const controller=new AbortController(),abort=()=>controller.abort();options.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(),options.timeoutMs),started=performance.now();
    const usage:unknown[]=[];
    let modelCompleted=false;
    console.log(`开始 ${id} (${fixture.split})`);
    try {
      const text=await runDeliveryExperienceAgent({taskId:id,repo,root,base,head,mrUrl:'https://example.invalid/mr/1',capturedAt:new Date().toISOString(),context},controller.signal,
        {model:{choice:{provider:options.provider,model:options.model},json:JSON.parse(readFileSync(options.models,'utf8'))},onTokenUsage:event=>{usage.push(event);}});
      modelCompleted=true;
      writeFileSync(join(root,'output.txt'),text);
      const assessment=assessGeneration(fixture,text,readFileSync(join(root,'transcript.jsonl'),'utf8'));
      const result:CaseResult={...assessment,id,kind:'generation',split:fixture.split,repeat,elapsed_ms:Math.round(performance.now()-started),usage};
      writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));options.record(result);
    } catch(error) {
      const result:CaseResult={id,kind:'generation',outcome:modelCompleted?'invalid_output':'execution_error',split:fixture.split,repeat,passed:false,
        elapsed_ms:Math.round(performance.now()-started),error:String(error),aborted:controller.signal.aborted,usage};
      writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));options.record(result);
    }
    finally {clearTimeout(timer);options.signal.removeEventListener('abort',abort);rmSync(join(root,'agent','models.json'),{force:true});}
  }
}

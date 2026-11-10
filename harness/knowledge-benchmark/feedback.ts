/** Real delivery coordinator: observed knowledge -> evidence -> reviewable proposals. */
import {mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {DeliveryExperiences} from '../../src/deliveryExperience.ts';
import {runDeliveryExperienceAgent,DELIVERY_EXPERIENCE_MISSION} from '../../src/deliveryExperienceAgent.ts';
import {MemoryStore} from '../../src/taskMemory.ts';
import {recordMemoryUsage} from '../../src/memoryUsage.ts';
import {assessGeneration} from './generation.ts';
import type {GenerationFixture} from './generation-fixtures.ts';

const fixtures=[
  {id:'rule-still-valid',empty:true,conclusion:'ReportWriter 由本函数拥有时，open 失败也必须 close；借用句柄不得关闭。',
    before:'bool save(ReportWriter& owned) { if(!owned.open()) return false; bool ok=owned.write(); owned.close(); return ok; }\n',
    after:'bool save(ReportWriter& owned) { if(!owned.open()) {owned.close(); return false;} bool ok=owned.write(); owned.close(); return ok; }\n',
    note:'实现违反已经明确的 ReportWriter 清理规则，open 失败也要 close。',resolution:'采纳并修复，已有经验的规则正确；没有发现新的条件或例外。'},
  {id:'rule-needs-update',empty:false,conclusion:'ReportWriter open 失败不会保留资源，无需 close；借用句柄不得关闭。',
    before:'bool save(ReportWriter& owned) { if(!owned.open()) return false; bool ok=owned.write(); owned.close(); return ok; }\n',
    after:'bool save(ReportWriter& owned) { if(!owned.open()) {owned.close(); return false;} bool ok=owned.write(); owned.close(); return ok; }\n',
    note:'当前产品 2.7B 的 ReportWriter.open 失败前可能已分配资源，自有句柄失败也必须 close。此前经验不再适用该版本。',resolution:'已修复失败分支。仅当前组件与版本，借用句柄不得关闭的约定仍有效；不能据此要求所有组件 open 失败都 close。'},
  {id:'history-unavailable',empty:true,missing:true,conclusion:'当前记录中的规则不能证明过去提供给模型的内容。',
    before:'int value() { return 7; }\n',after:'int value() { return 7; }\n',
    note:'建议所有函数名改成大写。',resolution:'否决，个人偏好，无团队约定；交付中没有发现真实缺陷。'},
];
const {values}=parseArgs({options:{output:{type:'string'},case:{type:'string'},models:{type:'string',default:'.local/models.json'},provider:{type:'string',default:'glm'},model:{type:'string'},'timeout-ms':{type:'string',default:'180000'}}});
const selected=values.case?fixtures.filter(f=>f.id===values.case):fixtures;
if(!selected.length)throw Error('未知 case');
const out=resolve(values.output??`.local/knowledge-benchmark/feedback-${Date.now()}`);
if(existsSync(out))throw Error('输出目录已存在');mkdirSync(out,{recursive:true});
const config=JSON.parse(readFileSync(resolve(values.models!),'utf8'));
const choice={provider:values.provider!,model:values.model??config.providers[values.provider!]?.models?.[0]?.id};
if(!choice.model)throw Error('模型配置不存在');
const timeout=Number(values['timeout-ms']);if(!Number.isInteger(timeout)||timeout<1000||timeout>600000)throw Error('timeout-ms 必须为 1000–600000');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const report:any={started_at:new Date().toISOString(),model:choice,selected_cases:selected.map(f=>f.id),fixture_hash:hash(JSON.stringify(fixtures)),
  head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  source_hash:hash(['src/deliveryExperience.ts','src/deliveryExperienceAgent.ts','src/memoryFeedback.ts','src/memoryUsage.ts','src/knowledgeWritingGuidance.ts','src/taskMemory.ts', 'harness/knowledge-benchmark/feedback.ts','harness/knowledge-benchmark/generation.ts'].map(p=>readFileSync(p,'utf8')).join('\n')),
  semantic_accuracy:null,cases:[]};
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));save();
writeFileSync(join(out,'fixtures.json'),JSON.stringify(fixtures,null,2));
writeFileSync(join(out,'mission.txt'),DELIVERY_EXPERIENCE_MISSION);
let active:DeliveryExperiences<any>|undefined,interrupted=false;
const stop=()=>{interrupted=true;void active?.shutdown();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {
 for(const fixture of selected) {
  if(interrupted)break;
  const root=join(out,fixture.id),repo=join(root,'repo'),workspace=join(root,'task');mkdirSync(repo,{recursive:true});mkdirSync(workspace);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:repo,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
  git('init');git('config','user.name','Benchmark');git('config','user.email','benchmark@example.invalid');
  writeFileSync(join(repo,'example.cpp'),fixture.before);git('add','.');git('commit','-qm','first delivery');const base=git('rev-parse','HEAD');
  const store=new MemoryStore(root);
  const prior=store.record({source:'user_note',judged_by:'human',author:'benchmark',scope:'local',module:'export',repo:'repo',paths:['example.cpp'],task:'previous',evidence:'synthetic',trigger:'ReportWriter 清理约定',conclusion:fixture.conclusion});
  store.review(prior.id,'benchmark',{decision:'accepted',revision:1});
  const revision=fixture.missing?'999':'2',memoryId=`memory:${prior.id}:${revision}`;
  recordMemoryUsage({workspace,taskId:fixture.id,store:()=>store},{moment:'context',status:'ready',ids:[prior.id],assets:[{id:prior.id,revision}]});
  const current=store.review(prior.id,'benchmark',{decision:'accepted',revision:2,conclusion:fixture.conclusion+'\n人工补充：失败日志应保留请求 ID。'});
  const task:any={cwd:repo,summary:{id:fixture.id,workspace,status:'await_merge',requirement:'export 模块产品 2.7B 交付；未执行测试。核对已有经验是否仍有效。',delivery:{git_push:{sha:base},mr_url:'https://example.invalid/mr/1',mr_state:'opened'}}};
  const evidence=[{id:'annotation:cleanup',note:fixture.note,resolution:fixture.resolution}];
  let calls=0,modelCompleted=false;const started=performance.now();const usage:unknown[]=[];
  active=new DeliveryExperiences(()=>({store,repo:'repo',module:'export',model:{choice,json:config},evidence:()=>evidence,onTokenUsage:event=>usage.push(event)}),async(input,signal,options)=>{
    calls++;writeFileSync(join(root,'context.txt'),input.context??'');
    const result=await runDeliveryExperienceAgent(input,AbortSignal.any([signal,AbortSignal.timeout(timeout)]),options);
    modelCompleted=true;
    writeFileSync(join(root,'output.txt'),result);return result;
  });
  console.log(`开始 feedback/${fixture.id}`);
  try {
   active.capture(task);writeFileSync(join(repo,'example.cpp'),fixture.after);git('add','.');git('commit','--allow-empty','-qm','final delivery');
   task.summary.status='completed';task.summary.delivery.git_push.sha=git('rev-parse','HEAD');task.summary.delivery.merged_sha=task.summary.delivery.git_push.sha;task.summary.delivery.mr_state='已合入';
   active.start(task);await active.flush();
   const state=JSON.parse(readFileSync(join(workspace,'delivery-experience/state.json'),'utf8'));
   const rubric:GenerationFixture={id:fixture.id,split:'development',context:'',before:fixture.before,after:fixture.after,evidence:[...evidence,{id:memoryId,note:'历史经验',resolution:'需要核对'}],forbiddenEvidence:[],empty:fixture.empty,requiredEvidence:'annotation:cleanup',concepts:[{name:'清理动作',alternatives:['close']},{name:'失败条件',alternatives:['失败']},{name:'借用边界',alternatives:['借用']},{name:'产品版本',alternatives:['2\\.7B']}]};
   writeFileSync(join(root,'rubric.json'),JSON.stringify(rubric,null,2));
   if(state.status!=='completed')throw Error(state.error??state.status);
   const assessment=assessGeneration(rubric,readFileSync(join(root,'output.txt'),'utf8'),readFileSync(join(workspace,'delivery-experience/transcript.jsonl'),'utf8'));
   const candidates=store.list({task:fixture.id});
   const linked=fixture.empty||candidates.some(c=>c.quote?.includes(memoryId));
   const preserved=store.find(prior.id)?.conclusion===current.conclusion&&store.find(prior.id)?.revision===current.revision;
   const pending=candidates.every(c=>c.review?.status==='pending');
   report.cases.push({...assessment,id:fixture.id,passed:assessment.passed&&linked&&preserved&&pending,linked,preserved,pending,model_calls:calls,elapsed_ms:Math.round(performance.now()-started),usage});
  }catch(error){report.cases.push({id:fixture.id,passed:false,outcome:modelCompleted?'invalid_output':'execution_error',error:String(error),model_calls:calls,elapsed_ms:Math.round(performance.now()-started),usage});}
  finally{await active.shutdown();active=undefined;rmSync(join(workspace,'delivery-experience/agent/models.json'),{force:true});save();}
  console.log(`${report.cases.at(-1).passed?'PASS':'FAIL'} feedback/${fixture.id}`);
 }
}finally{await active?.shutdown();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);report.finished_at=new Date().toISOString();report.interrupted=interrupted;save();}
console.log(JSON.stringify({report:join(out,'report.json'),cases:report.cases.map((r:any)=>({id:r.id,passed:r.passed,outcome:r.outcome}))},null,2));
process.exitCode=interrupted||report.cases.length!==selected.length||report.cases.some((r:any)=>!r.passed)?1:0;

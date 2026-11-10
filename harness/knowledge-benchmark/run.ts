import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { MemorySidecar } from "../../src/memorySidecar.ts";
import { KnowledgeSearch } from "../../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../../src/knowledgeTools.ts";
import { saveKnowledgeDocument, type KnowledgeDocument } from "../../src/knowledgeDocuments.ts";
import { createBusinessModule } from "../../src/businessModuleLibrary.ts";
import { createMemoryContext } from "../../src/memoryContext.ts";
import { MemoryStore } from "../../src/taskMemory.ts";
import { documents, queries, REPO, SUITE_VERSION, type QueryFixture } from "./fixtures.ts";
import { summarize, scoreRanking, compareReports, type CaseResult } from "./scoring.ts";
import { runAgentCases } from "./agent.ts";
import { runPipelineCases } from "./pipeline.ts";
import { runScopeCases } from "./scope.ts";
import { runGenerationCases, replayGenerationCases } from "./generation.ts";

const { values } = parseArgs({ options: {
  output: { type: "string" }, python: { type: "string" }, baseline: { type: "string" },
  "generation-replay": { type: "string" }, generation: { type: "boolean", default: false }, split: { type: "string", default: "development" },
  pipeline: { type: "boolean", default: false },
  agent: { type: "boolean", default: false }, models: { type: "string" }, provider: { type: "string", default: "glm" },
  model: { type: "string" }, repeats: { type: "string", default: "1" }, "timeout-ms": { type: "string", default: "180000" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("npm run benchmark:knowledge -- [--output DIR] [--python PATH] [--baseline REPORT.json] [--generation --split development|holdout|all | --generation-replay REPORT.json] [--pipeline] [--agent] [--models FILE --provider NAME --model ID --repeats 1 --timeout-ms 180000]");
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);
const python = resolve(values.python ?? process.env.MFC_MEMSEARCH_PYTHON ?? ".local/memsearch-venv/bin/python");
if (!existsSync(python)) throw new Error(`未找到 memsearch Python：${python}；通过 --python 指定已有环境`);
const repeats = Number(values.repeats), timeoutMs = Number(values["timeout-ms"]);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("repeats 必须为 1–20，timeout-ms 必须为 1000–600000");
const models = resolve(values.models ?? ".local/models.json");
if(values["generation-replay"] && values.generation) throw new Error("generation 与 generation-replay 不能同时使用");
if(values.pipeline && ((!values.generation && !values["generation-replay"]) || values.generation && values.split==="holdout")) throw new Error("pipeline 需要 --generation --split development/all 或 --generation-replay REPORT.json");
const useModel = values.agent || values.generation || values.pipeline;
if (!["development","holdout","all"].includes(values.split!)) throw new Error("split 必须为 development、holdout 或 all");
const model = useModel ? values.model ?? JSON.parse(readFileSync(models,"utf8")).providers[values.provider!]?.models?.[0]?.id : null;
if (useModel && !model) throw new Error("未找到模型配置；请指定 --models、--provider 和 --model");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fixtureHash = sha(["fixtures.ts","generation-fixtures.ts","scope.ts"].map(p => readFileSync(join(root,"harness/knowledge-benchmark",p),"utf8")).join("\n"));
const evaluatorHash = sha(["scoring.ts","agent.ts","generation.ts","pipeline.ts","scope.ts","run.ts"].map(p => readFileSync(join(root,"harness/knowledge-benchmark",p),"utf8")).join("\n"));
const replay = values["generation-replay"] ? JSON.parse(readFileSync(resolve(values["generation-replay"]),"utf8")) : undefined;
if(replay && replay.fixture_hash !== fixtureHash) throw new Error("语料发生变化，不能回放旧模型输出");
const runConfig = { embedding: "gpahal/bge-m3-onnx-int8", generation_replay: replay ? sha(JSON.stringify(replay)) : null, agent: values.agent, pipeline:values.pipeline, generation: values.generation, split: values.generation ? values.split : null, provider: useModel ? values.provider : null, model, repeats: useModel ? repeats : 0, timeout_ms: useModel ? timeoutMs : null };
const report: any = { schema_version: 2, suite_version: SUITE_VERSION, fixture_hash: fixtureHash, evaluator_hash: evaluatorHash,
  replay_model_config: replay?.run_config, run_config: runConfig, started_at: new Date().toISOString(), fixture_type: "synthetic; production corpus is never read", cases: [],
  limitations: ["固定的虚构样例不代表生产准确率", "检索命中不等于正确应用", "Agent 对照比较 knowledge 工具是否可用；pipeline 单独验证生成经验的自动注入，均未覆盖 Skill 触发", "未验证知识引用的业务源码语义是否过期", "真实模型存在随机性；repeats 测量重复稳定性，不增加独立事件数", "生成评测只自动检查证据及概念契约，需人工复核语义，不等同生成质量准确率", "scope 使用真实 TaskService 装配和确定性检索替身，检验范围判断，不测召回"] };
const baseline = values.baseline ? JSON.parse(readFileSync(resolve(values.baseline),"utf8")) : undefined;
if (baseline) compareReports({ ...report, summary: summarize([]) }, baseline);
const parent = resolve(".local/knowledge-benchmark");
mkdirSync(parent, { recursive: true });
const out = values.output ? resolve(values.output) : mkdtempSync(join(parent,"run-"));
if (values.output) { if (existsSync(out)) throw new Error("输出目录已存在；请换一个目录以保留历史结果"); mkdirSync(out,{recursive:true}); }
const data = join(out,"data"); mkdirSync(data);
report.output = out;
report.code = { head: execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  working_tree: execFileSync("git",["status","--short"],{encoding:"utf8"}).trim().split("\n").filter(Boolean),
  source_hash: sha(["src/taskService.ts","src/deliveryExperienceAgent.ts","src/knowledgeWritingGuidance.ts","src/memoryDraft.ts","src/memoryTools.ts","src/knowledgeExtractionSkills.ts","src/memoryUsage.ts","src/deliveryExperience.ts","src/knowledgeSearch.ts","src/knowledgeTools.ts","src/memoryContext.ts","src/taskMemory.ts","src/sessionDriver.ts","src/memorySidecar.ts","src/knowledgeDocuments.ts","harness/knowledge_retrieval.py","harness/knowledge_chunks.py","harness/memsearch-sidecar.py"].map(p=>readFileSync(p,"utf8")).join("\n")) };
report.runtime = { node: process.version, platform: process.platform, arch: process.arch,
  python_packages: JSON.parse(execFileSync(python,["-c",'import json,importlib.metadata as m; print(json.dumps({p:m.version(p) for p in ["memsearch","milvus-lite","pymilvus","onnxruntime"]}))'],{encoding:"utf8",timeout:15000})) };
const cases: CaseResult[] = report.cases;
function save() { report.summary = summarize(cases); writeFileSync(join(out,"report.json"),JSON.stringify(report,null,2)+"\n"); }
function record(row: CaseResult) { cases.push(row); save(); console.log(`${row.passed ? "PASS" : "FAIL"} ${row.id} ${row.elapsed_ms}ms`); }
function context(q: Partial<QueryFixture> = {}) { return { repo: q.repo ? "other" : "shared", repositories: [q.repo ?? REPO], moduleIds: q.module ? [q.module] : [], productVersion: q.version ?? "2.7B" }; }
const docs = new Map<string,KnowledgeDocument>();
const keys = new Map<string,string>();
for (const id of ["export","alarm","order"]) createBusinessModule(data,{ id,name:id,description:"benchmark fixture",owner:"benchmark",repositories:[REPO] },"benchmark");
for (const fixture of documents) {
  const { key, ...input } = fixture;
  const doc = saveKnowledgeDocument(data,{ technologies:["cpp"], ...input },"benchmark");
  docs.set(key,doc); keys.set(doc.id,key);
}
const store = new MemoryStore(data);
const memory = store.record({source:"user_note",judged_by:"human",author:"benchmark",scope:"platform",repo:"shared",paths:[],task:"benchmark",evidence:"fixture",trigger:"执行写入接口遇到超时",conclusion:"重试前先检查幂等保障。"});
store.review(memory.id,"benchmark",{decision:"accepted",revision:1}); keys.set(memory.id,"memory");
writeFileSync(join(out,"fixture-manifest.json"),JSON.stringify({version:SUITE_VERSION,documents,queries,ids:Object.fromEntries(keys)},null,2));
let logBytes = 0;
const sidecar = new MemorySidecar({ python,script:resolve("harness/memsearch-sidecar.py"),corpusDir:data,milvusPath:join(data,"index.db"),
  provider:"onnx",model:runConfig.embedding,env:{HF_HUB_OFFLINE:"1"},
  budgets:{bootMs:60000,ingestMs:120000,searchMs:3000}, log: message => {
    const line = message.slice(0,2000);
    if (logBytes < 1024*1024) { appendFileSync(join(out,"sidecar.log"),line+"\n"); logBytes += Buffer.byteLength(line)+1; }
  } });
const search = new KnowledgeSearch(data,sidecar);
let interrupted = false;
const controller = new AbortController();
const stop = () => { interrupted = true; controller.abort(); sidecar.stop(); report.fatal_error = "收到中断信号"; save(); };
process.once("SIGINT",stop); process.once("SIGTERM",stop);
async function guard(id: string, action: () => Promise<Record<string, unknown> & { passed: boolean }> | (Record<string, unknown> & { passed: boolean })) {
  const started = performance.now();
  try { record({id:`guard/${id}`,kind:"guard",...await action(),elapsed_ms:Math.round(performance.now()-started)}); }
  catch(error) { record({id:`guard/${id}`,kind:"guard",passed:false,error:String(error),elapsed_ms:Math.round(performance.now()-started)}); }
}
try {
  console.log(`报告目录：${out}`); save();
  await runScopeCases(out,record);
  const boot = performance.now();
  if (!await sidecar.start()) throw new Error("本地 ONNX / memsearch 启动失败");
  report.boot_ms = Math.round(performance.now()-boot);
  const indexing = performance.now(); await search.prepare(); report.index_ms = Math.round(performance.now()-indexing); save();
  for (const q of queries) {
    if (interrupted) throw new Error("评测已中断");
    const start = performance.now();
    try {
      const result = await search.search(context(q),q.query,5);
      const hits = result.hits.map(h=>({...h,key:keys.get(h.id) ?? h.id}));
      const scored = scoreRanking(q.expected,hits.map(h=>h.key),[...(q.forbidden ?? []),"pending","disabled","skill"]);
      const evidenceReads: any[] = [];
      if (q.evidence) for (const [index, hit] of hits.entries()) {
        if (!q.expected.includes(hit.key)) continue;
        const tool: any = createKnowledgeTool({service:()=>search,context:()=>context(q)});
        const response = await tool.execute("benchmark-read",{action:"read",id:hit.id,revision:hit.revision,start_line:hit.start_line,end_line:hit.end_line});
        evidenceReads.push({ rank:index+1, expected:q.evidence, matched:response.content[0].text.includes(q.evidence),...response });
      }
      const evidenceRank = evidenceReads.find(r=>r.matched)?.rank;
      record({id:`retrieval/${q.id}`,kind:"retrieval",...scored,passed:result.available && scored.passed && (!q.evidence || evidenceRank !== undefined),
        elapsed_ms:Math.round(performance.now()-start),query:q.query,context:context(q),expected:q.expected,available:result.available,hits,warnings:result.warnings,evidence_expected:!!q.evidence,evidence_rank:evidenceRank,evidence_reads:evidenceReads });
    } catch(error) { record({id:`retrieval/${q.id}`,kind:"retrieval",positive:q.expected.length>0,passed:false,error:String(error),elapsed_ms:Math.round(performance.now()-start)}); }
  }
  await guard("ambiguous-module",()=>{ const result=search.catalog(context()); return {passed:result.warnings.some(w=>w.includes("多个业务模块")) && !result.assets.some(a=>["alarm","order","name"].includes(keys.get(a.id)??"")),warnings:result.warnings}; });
  await guard("disabled-not-readable",()=>({passed:!search.read(context(),docs.get("disabled")!.id)}));
  await guard("cross-module-read",()=>({passed:!search.read(context({module:"alarm"}),docs.get("order")!.id)}));
  await guard("wrong-version-read",()=>({passed:!search.read(context({version:"2.7B"}),docs.get("v26")!.id)}));
  await guard("old-revision-rejected",async()=>{
    const tool:any=createKnowledgeTool({service:()=>search,context:()=>context()});
    const before=docs.get("symbol")!;
    const changed=saveKnowledgeDocument(data,{content:before.content.replaceAll("ResolveFmaFileKey","LookupFmaArtifactKey")},"benchmark",before.id);
    const response=await tool.execute("old-revision",{action:"read",id:before.id,revision:before.revision});
    docs.set("symbol",changed);
    return {passed:response.content[0].text.includes("文档已更新"),response};
  });
  await guard("updated-index",async()=>{
    await search.prepare(); const result=await search.search(context(),"LookupFmaArtifactKey");
    const hit=result.hits.find(h=>h.id===docs.get("symbol")!.id);
    return {passed:result.available && !!hit && hit.revision===docs.get("symbol")!.revision && !!hit.summary?.includes("LookupFmaArtifactKey") && !hit.summary?.includes("ResolveFmaFileKey"),result};
  });
  const inject = createMemoryContext({
    context:()=>"写入接口超时重试之前检查幂等保障",
    search:async query=>(await search.search(context(),query)).hits.filter(h=>h.id===memory.id).map(h=>h.id),
    resolve:ids=>ids.flatMap(id=>{const asset=search.read(context(),id);return asset?[{id,text:asset.content}]:[];}),
  });
  await guard("automatic-memory-context",async()=>{
    const messages=await inject([{role:"user",content:"写入接口超时重试之前检查幂等保障"}]);
    return {passed:messages.some(m=>m.customType==="mae-memory-context" && m.content.includes(memory.id)),messages};
  });
  await guard("withdrawn-memory",async()=>{
    store.withdraw(memory.id,"benchmark");
    const result=await search.search(context(),"写入接口超时重试之前检查幂等保障");
    const messages=await inject([{role:"user",content:"写入接口超时重试之前检查幂等保障"}]);
    return {passed:result.available && !result.hits.some(h=>h.id===memory.id) && !search.read(context(),memory.id)
      && !messages.some(m=>m.customType==="mae-memory-context"),result,messages};
  });
  await guard("disable-after-index",async()=>{
    const doc=docs.get("json")!;saveKnowledgeDocument(data,{active:false},"benchmark",doc.id);
    const result=await search.search(context(),"JSON schema 字段名称校验");
    return {passed:result.available && !result.hits.some(h=>h.id===doc.id) && !search.read(context(),doc.id),result};
  });
  await guard("unavailable-keeps-original",async()=>{
    const offline=new KnowledgeSearch(data);const result=await offline.search(context(),"ReportWriter");
    return {passed:!result.available && !!offline.read(context(),docs.get("writer")!.id) && result.warnings.some(w=>w.includes("继续当前任务")),result};
  });
  if (replay && !interrupted) replayGenerationCases(resolve(values["generation-replay"]!),out,record);
  if (values.generation && !interrupted) await runGenerationCases({out,models,provider:values.provider!,model:model!,repeats,timeoutMs,signal:controller.signal,record,split:values.split as "development"|"holdout"|"all"});
  if (values.pipeline && !interrupted) await runPipelineCases({out,data,sidecar,search,models,provider:values.provider!,model:model!,repeats,timeoutMs,signal:controller.signal,record});
  if (values.agent && !interrupted) await runAgentCases({out,search,models,provider:values.provider!,model:model!,repeats,timeoutMs,signal:controller.signal,record});
} catch(error) { report.fatal_error=String(error); console.error(String(error)); }
finally {
  sidecar.stop(); process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);
  report.finished_at=new Date().toISOString();
  report.required_failures=cases.filter(c=>!c.passed && c.arm!=="without-knowledge").map(c=>c.id);
  save();
  if (baseline) { report.comparison=compareReports(report,baseline); save(); }
  const summary = ["# 知识 benchmark", "", `运行时间：${report.started_at}`, `代码：${report.code.head}`, `语料：虚构固定样例，版本 ${SUITE_VERSION}`,
    "", "```json", JSON.stringify(report.summary,null,2),"```", "", "## 逐例结果", "", "| 案例 | 结果 | 毫秒 |", "| --- | --- | --- |",
    ...cases.map(c=>`| ${c.id} | ${c.passed?"通过":"失败"} | ${c.elapsed_ms} |`),"",...report.limitations.map((s:string)=>`- ${s}`),
    ...(report.fatal_error?[`\n运行错误：${report.fatal_error}`]:[]), ...(report.comparison?["\n## 与基线比较\n", "```json",JSON.stringify(report.comparison,null,2),"```"]:[])].join("\n");
  writeFileSync(join(out,"summary.md"),summary+"\n");
  console.log(JSON.stringify({report:join(out,"report.json"),summary:report.summary,required_failures:report.required_failures,fatal_error:report.fatal_error},null,2));
  process.exitCode = interrupted || report.fatal_error || report.required_failures.length ? 1 : 0;
}

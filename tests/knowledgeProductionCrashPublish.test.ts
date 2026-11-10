import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments } from "../src/knowledgeDocuments.ts";
import { readDomainArchiveProgress } from "../src/domainArchiveProgress.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("生产线验收4/F6：首个目标 MR 回执耐久保存后真 kill -9，重启只补未提交目标", {
  timeout: 35_000,
  skip: !constants.signals.SIGSTOP || !constants.signals.SIGKILL ? "当前系统不支持 POSIX SIGSTOP/SIGKILL，不能执行真 kill -9" : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-crash-publish-")), marker = join(dir, "mr-receipt-renamed.json");
  const entry = pathToFileURL(fileURLToPath(new URL("../src/domainKnowledgeExtraction.ts", import.meta.url))).href;
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  // 只在测试子进程替换 Node 的文件系统边界，不给生产发布流程增加测试开关。
  const source = `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const dir=${JSON.stringify(dir)},marker=${JSON.stringify(marker)};
let jobId,stopped=false;
const rename=fs.renameSync;
fs.renameSync=function(from,to){
  const result=rename.apply(this,arguments);
  if(!stopped&&String(to).endsWith('/archive-progress.json')){
    const record=JSON.parse(fs.readFileSync(to,'utf8'));
    const batch=record.batches?.find(batch=>batch.publications.some(publication=>publication.state==='opened'));
    if(batch){
      stopped=true;
      const receipt=batch.publications.find(publication=>publication.state==='opened');
      fs.writeFileSync(marker,JSON.stringify({job_id:jobId,batch_id:batch.id,receipt}));
      process.kill(process.pid,'SIGSTOP');
    }
  }
  return result;
};
syncBuiltinESMExports();
const startup=setTimeout(()=>{console.error('子进程提交超过10秒预算');process.exit(9)},10000);
try{
  const {DomainKnowledgeExtraction}=await import(${JSON.stringify(entry)});
  const service=new DomainKnowledgeExtraction(dir,async input=>{
    for(const target of [input.job.knowledge_target,...input.job.repositories])input.save({id:target.id==='domain'?'one':'two',title:target.name,target_id:target.id,path:target.docs_path+'/rules.md',layer:target.id==='domain'?'domain':'repository',content:'# '+target.id+'\\n有效规则正文',sources:'固定版本源码'},{revision:'a'.repeat(40),content:null});
    return '研究完成';
  },{publish:async(job,target)=>({target_id:target.id,state:'opened',branch:'codex/'+target.id,url:'https://example.test/mr/'+target.id,documents:job.documents.map(document=>({id:document.id,path:document.path,content:document.content,revision:document.revision}))})});
  const job=service.create({title:'订单域',scope:'核对订单规则',issue_no:'REQ-CRASH',repositories:[{repository:'https://example.test/orders.git',branch:'main',docs_path:'docs/orders'}],knowledge_target:{repository:'https://example.test/knowledge.git',branch:'main',docs_path:'domains'}},'alice');
  jobId=job.id;
  const deadline=Date.now()+5000;
  while(service.get(job.id).status!=='done'){
    if(Date.now()>=deadline)throw new Error('测试研究未在5秒内完成');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  await service.createArchive(job.id,{issue_no:'REQ-CRASH',expected_revisions:service.previewArchive(job.id).expected_revisions},'alice');
  throw new Error('未在首个 MR 回执写成后暂停');
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1}
finally{clearTimeout(startup)}
`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => { if (output.length < 8192) output += chunk.toString("utf8").slice(0, 8192 - output.length); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => undefined);
  let service: DomainKnowledgeExtraction | undefined;
  try {
    await until(() => {
      if (existsSync(marker)) return true;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`子进程未到达 MR 回执保存暂停点：${output}`);
      return false;
    }, `未在10秒内达到 MR 回执 rename 后的暂停点：${output}`);
    assert.ok(child.pid);
    assert.equal(child.kill("SIGKILL"), true);
    assert.equal((await within(closed, 5000, "SIGKILL 后子进程未退出")).signal, "SIGKILL");

    const checkpoint = JSON.parse(readFileSync(marker, "utf8")) as { job_id: string; batch_id: string; receipt: DomainPublication };
    assert.deepEqual(listKnowledgeDocuments(dir), [], "MR 回执写成也不提前写正式知识库");
    const path = join(dir, "domain-extraction", checkpoint.job_id, "job.json"),
      disk = readDomainArchiveProgress(path, JSON.parse(readFileSync(path, "utf8")) as DomainKnowledgeJob);
    const original = disk.archive_batches!.find(batch => batch.id === checkpoint.batch_id)!;
    assert.equal(original.state, "running");
    // 检查点把正文换成摘要引用,回执按身份字段比(还原读的实际正文另行核对)。
    const receiptKey = (publication: DomainPublication) => [publication.target_id, publication.state, publication.url, publication.branch, publication.documents.map(document => document.id)];
    assert.deepEqual(original.publications.map(receiptKey), [receiptKey(checkpoint.receipt)], "必须真正杀在两个目标之间，仅首个 MR 回执已生效");
    assert.equal(checkpoint.receipt.target_id, "domain"); assert.equal(checkpoint.receipt.documents[0].id, "one");
    assert.deepEqual(disk.documents.map(document => document.id), ["one", "two"], "两份候选均保留");
    assert.ok(disk.documents.every(document => !document.knowledge_document_id));
    const seen: Array<{ target: string; documents: DomainPublication["documents"] }> = [];
    let researchCalls = 0;
    service = new DomainKnowledgeExtraction(dir, async () => { researchCalls++; throw new Error("重启不应重新研究"); }, {
      publish: async (job, target) => {
        const documents = job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision }));
        seen.push({ target: target.id, documents });
        return { target_id: target.id, branch: "codex/recovered-crash", state: "opened", url: "https://example.test/mr/2", documents };
      },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(seen.length, 0, "重启不能自动启动 Git/MR");
    const recovered = service.get(checkpoint.job_id), batch = recovered.archive_batches!.find(batch => batch.id === checkpoint.batch_id)!;
    assert.equal(batch.state, "failed"); assert.deepEqual(receiptKey(batch.publications[0]), receiptKey(checkpoint.receipt));
    assert.equal(batch.publications[0].documents[0].content, disk.documents[0].content, "检查点还原出完整正文");
    assert.deepEqual(recovered.documents, disk.documents, "恢复不会重新生成或覆盖候选");
    await service.retryArchive(checkpoint.job_id, "alice", { batch_id: checkpoint.batch_id });
    assert.equal(researchCalls, 0); assert.equal(seen.length, 1);
    assert.equal(seen[0].target, "repo-1"); assert.deepEqual(seen[0].documents.map(document => document.id), ["two"]);
    const completed = service.get(checkpoint.job_id).archive_batches!.find(batch => batch.id === checkpoint.batch_id)!;
    assert.equal(completed.state, "done"); assert.deepEqual(receiptKey(completed.publications.find(publication => publication.target_id === "domain")!), receiptKey(checkpoint.receipt));
    await service.retryArchive(checkpoint.job_id, "alice", { batch_id: checkpoint.batch_id });
    assert.equal(seen.length, 1, "重试成功批次不能重复创建 MR");
    assert.deepEqual(listKnowledgeDocuments(dir), [], "恢复及补齐 MR 均不提前写入正式知识库");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await within(closed, 5000, "测试清理期间子进程未退出");
    if (service) await within(service.shutdown(), 5000, "测试清理期间管理器未关停");
    rmSync(dir, { recursive: true, force: true });
  }
});

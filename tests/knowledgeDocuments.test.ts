import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveKnowledgeDocument, readKnowledgeDocument } from '../src/knowledgeDocuments.ts';
import { collectSearchableKnowledge, KnowledgeSearch } from '../src/knowledgeSearch.ts';
import { knowledgeDocumentCatalog } from '../src/knowledgeDocumentCatalog.ts';
import { MemoryStore } from '../src/taskMemory.ts';
import { createBusinessModule } from '../src/businessModuleLibrary.ts';
import { TaskService } from '../src/taskService.ts';
import { createTaskServer } from '../src/server.ts';
import { createTechnologyStack } from '../src/technologyStacks.ts';
import { gitKnowledgeDocument, removeGitKnowledgeDocument } from './fixtures/gitKnowledge.ts';
const context={repo:'repo',repositories:['https://code.example/team/repo.git'],moduleIds:[],productVersion:'2.7B'};
test('正式 Git 业务文稿按模块、仓库、版本隔离；工程手册修改和停用留痕',()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-documents-'));
 try {
  createBusinessModule(dir,{id:'module',name:'模块',description:'示例模块',owner:'owner',repositories:context.repositories},'owner');
  createTechnologyStack(dir,{name:'C++'},'fixture');
  const doc=gitKnowledgeDocument(dir,'module',{title:'规范.md',content:'# 规范\n## 文件\n释放资源',technologies:['cpp'],product_versions:['2.7B']});
  assert.ok(collectSearchableKnowledge(dir,context).assets.some(a=>a.id===doc.id));
  assert.equal(collectSearchableKnowledge(dir,{...context,productVersion:'2.6B'}).assets.length,0);
  assert.equal(collectSearchableKnowledge(dir,{...context,repositories:[]}).assets.length,0);
  const updated=gitKnowledgeDocument(dir,'module',{title:'规范.md',content:'# 修订\n借用句柄不释放',technologies:['cpp'],product_versions:['2.7B']});
  assert.equal(updated.id,doc.id);assert.notEqual(updated.revision,doc.revision);assert.match(readKnowledgeDocument(dir,doc.id).content,/借用句柄不释放/);
  removeGitKnowledgeDocument(dir,'module',doc.id);
  assert.equal(collectSearchableKnowledge(dir,context).assets.length,0);
  const manual=saveKnowledgeDocument(dir,{title:'工程规范',content:'核对句柄'},'member');
  const revised=saveKnowledgeDocument(dir,{content:'借用句柄不释放'},'another',manual.id);
  assert.equal(revised.history.at(-1)?.action,'替换文档');
  saveKnowledgeDocument(dir,{active:false},'member',manual.id);
  assert.equal(readKnowledgeDocument(dir,manual.id).history.length,3);
  assert.throws(()=>saveKnowledgeDocument(dir,{title:'坏文档',content:'x\0'},'member'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('索引排队、进行、失败、重试、就绪均来自实际索引作业',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-status-'));
 try{
  const a=saveKnowledgeDocument(dir,{title:'a.md',content:'# 规则\n内容'},'member');
  let done!:(ok:boolean)=>void;
  let resolveNext=true;
  const sidecar={ingest:()=>resolveNext?new Promise<boolean>(r=>{done=r}):Promise.resolve(true),indexedSections:()=>2,
   search:async({sources}:any)=>{assert.ok(sources.some((source:any)=>source.id===a.id));return [{id:a.id,heading:'规则',score:1}];}};
  const search=new KnowledgeSearch(dir,sidecar as any);
  const asset=collectSearchableKnowledge(dir,context).assets.find(x=>x.id===a.id)!;
  assert.equal(search.documentStatus(asset).state,'queued');
  const pending=search.search(context,'规则');await new Promise(r=>setImmediate(r));
  assert.equal(search.documentStatus(asset).state,'indexing');resolveNext=false;done(false);await pending;
  assert.equal(search.documentStatus(asset).state,'failed');
  const b=saveKnowledgeDocument(dir,{title:'b.md',content:'# 无关\n其他'},'member');
  assert.equal((await search.search(context,'规则')).hits[0].id,a.id);
  assert.equal(search.documentStatus(asset).state,'ready');
  assert.equal(search.documentStatus(collectSearchableKnowledge(dir,context).assets.find(x=>x.id===b.id)!).state,'ready');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('B1验收1：普通文档上传、仓库导入、导出和试查退役，研究成果仍可编辑及恢复',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-api-'));
 const service=new TaskService({dataDir:dir,provider:'test',model:'test',modelsJson:{},maxConcurrent:0});
 const server=createTaskServer(service);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as any).port}/knowledge-documents`;
 try{
  const post=(path:string,body:any)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('',{title:'规范.md',content:'# 规则\n内容'})).status,404);
  const doc=saveKnowledgeDocument(dir,{title:'规范.md',content:'# 规则\n内容'},'research');
  for (const path of ['/export','/search','/repository-tree','/repository-import',`/${doc.id}/search`]) {
    assert.equal((await post(path,{query:'规则',ids:[doc.id],repository:'https://example.com/repo.git',branch:'main'})).status,404,path);
  }
  const list=await (await fetch(url)).json() as any;assert.equal(list.documents[0].indexing.state,'failed');assert.equal(list.documents[0].content,undefined);
  assert.equal((await post(`/${doc.id}`,{active:false,expected_revision:doc.revision})).status,200);
  const edit = await post(`/${doc.id}`, { content: '# 人工修订', expected_revision: (await (await fetch(url+`/${doc.id}`)).json() as any).revision });
  assert.equal(edit.status, 200); const revised = await edit.json() as any;
  const versions = await (await fetch(url+`/${doc.id}/versions`)).json() as any;
  assert.equal(versions.versions.length, 3);
  const old = await (await fetch(url+`/${doc.id}/versions/${doc.revision}`)).json() as any;
  assert.equal(old.document.content, doc.content);
  assert.equal((await post(`/${doc.id}/restore`, { revision: doc.revision, expected_revision: doc.revision })).status, 400);
  const restored = await post(`/${doc.id}/restore`, { revision: doc.revision, expected_revision: revised.revision });
  assert.equal(restored.status, 200); assert.equal((await restored.json() as any).content, doc.content);
 }finally{await service.shutdown();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});

test('知识库汇总已采纳经验，始终读取原记录，不另复制一份',()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-unified-'));
 try {
  const store=new MemoryStore(dir);
  const row=store.record({source:'agent_note',judged_by:'human',scope:'platform',repo:'r',paths:[],task:'task-1',evidence:'example',trigger:'读取文件',conclusion:'先检查句柄'});
  assert.equal(knowledgeDocumentCatalog(dir).documents.length,0);
  const accepted=store.review(row.id,'member',{decision:'accepted',revision:1});
  let docs=knowledgeDocumentCatalog(dir).documents;
  assert.equal(docs.length,1);assert.equal(docs[0].id,row.id);assert.equal(docs[0].form,'experience');
  store.review(row.id,'member',{decision:'accepted',revision:accepted.revision!,conclusion:'借用句柄不释放'});
  docs=knowledgeDocumentCatalog(dir).documents;assert.match(docs[0].content,/借用句柄不释放/);
  assert.equal(docs.length,1);
 } finally{rmSync(dir,{recursive:true,force:true});}
});



test('同仓相似模块知识不串台：明确模块优先，歧义不猜；平台知识保留',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-isolation-'));
 try {
  for(const id of ['a','b'])createBusinessModule(dir,{id,name:id,description:id,owner:'owner',repositories:context.repositories},'owner');
  const a=gitKnowledgeDocument(dir,'a',{title:'规范.md',content:'创建者释放句柄'});
  const b=gitKnowledgeDocument(dir,'b',{title:'规范.md',content:'借用者不能释放句柄'});
  const global=saveKnowledgeDocument(dir,{title:'通用规范',content:'检查错误码'},'owner');
  const selected={...context,moduleIds:['a']};
  assert.deepEqual(new Set(collectSearchableKnowledge(dir,selected).assets.map(a=>a.id)),new Set([a.id,global.id]));
  assert.equal(new KnowledgeSearch(dir).read(selected,b.id),undefined);
  const ambiguous=collectSearchableKnowledge(dir,context);assert.deepEqual(ambiguous.assets.map(a=>a.id),[global.id]);assert.match(ambiguous.warnings.join(''),/多个业务模块/);
  const search=new KnowledgeSearch(dir,{ingest:async()=>true,search:async()=>[{id:b.id,score:1},{id:a.id,score:0.9}]} as any);
  assert.deepEqual((await search.search(selected,'句柄')).hits.map(h=>h.id),[a.id],'侧车即便返回不适用文档，宿主也要过滤');
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('任务知识工具使用需求所属模块，子任务继承父任务，不扩大到同仓其他模块',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'knowledge-task-scope-'));
 const service=new TaskService({dataDir:dir,provider:'test',model:'test',modelsJson:{},maxConcurrent:0});
 try {
  for(const id of ['a','b'])createBusinessModule(dir,{id,name:id,description:id,owner:'owner',repositories:context.repositories},'owner');
  const a=gitKnowledgeDocument(dir,'a',{title:'a',content:'a规则'});
  const b=gitKnowledgeDocument(dir,'b',{title:'b',content:'b规则'});
  const api=service as any,parent=api.tasks.get(service.create('主需求').id),child=api.tasks.get(service.create('子任务').id);
  parent.summary.business_module={id:'a',name:'a'};child.summary.parent_task_id=parent.summary.id;
  child.summary.business_modules=[{id:'a'},{id:'b'}];
  const tool=api.memoryTools(child).find((t:any)=>t.name==='knowledge');
  const good=await tool.execute('read-a',{action:'read',id:a.id});assert.match(good.content[0].text,/a规则/);
  const bad=await tool.execute('read-b',{action:'read',id:b.id});assert.doesNotMatch(bad.content[0].text,/b规则/);
 }finally{await service.shutdown();rmSync(dir,{recursive:true,force:true});}
});

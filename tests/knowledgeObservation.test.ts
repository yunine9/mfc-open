import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKnowledgeTool} from '../src/knowledgeTools.ts';
import {KnowledgeSearch} from '../src/knowledgeSearch.ts';
import {saveKnowledgeDocument} from '../src/knowledgeDocuments.ts';
import {recordMemoryUsage,type MemoryUsageEvent} from '../src/memoryUsage.ts';
import {MemoryStore} from '../src/taskMemory.ts';

test('知识读取观测记录实际版本和裁剪行号，拒绝读取不冒充已使用',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mfc-knowledge-observe-'));
  try {
    const row=saveKnowledgeDocument(dir,{title:'长手册',content:'# 长手册\n'+Array.from({length:800},(_,i)=>`第${i}条规则`).join('\n')},'benchmark');
    const events:MemoryUsageEvent[]=[];
    const tool:any=createKnowledgeTool({service:()=>new KnowledgeSearch(dir),context:()=>({repo:'r',repositories:[],moduleIds:[]}),onUse:event=>{
      events.push(event);recordMemoryUsage({workspace:dir,taskId:'task',store:()=>new MemoryStore(dir)},event);
    }});
    const result=await tool.execute('read',{action:'read',id:row.id,revision:row.revision,start_line:2,end_line:750});
    assert.equal(result.details.end_line,601);
    assert.deepEqual(events[0].assets,[{id:row.id,revision:row.revision,start_line:2,end_line:601}]);
    await tool.execute('old',{action:'read',id:row.id,revision:'old'});
    assert.deepEqual(events[1].ids,[]);assert.equal(events[1].reason,'revision_changed');
    assert.equal(events[1].assets,undefined);
    assert.match(readFileSync(join(dir,'memory-usage.jsonl'),'utf8'),/"end_line":601/);
    assert.equal(new MemoryStore(dir).ledger.stats().size,0,'文档不是经验使用计数');
    const failing:any=createKnowledgeTool({service:()=>new KnowledgeSearch(dir),context:()=>({repo:'r',repositories:[],moduleIds:[]}),onUse:()=>{throw Error('disk full');}});
    const stillRead=await failing.execute('read',{action:'read',id:row.id});
    assert.equal(stillRead.details.id,row.id);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('自动上下文逐轮记录当前经验版本，观测异常不丢失有效经验',async()=>{
  const {createMemoryContext}=await import('../src/memoryContext.ts');
  let revision='1';const events:any[]=[];
  const hook=createMemoryContext({context:()=>'',search:async()=>['memory'],resolve:()=>[{id:'memory',text:'有效规则',revision}],onUse:event=>{events.push(event);throw Error('log unavailable');}});
  const input=[{role:'user',content:'使用规则'}];
  assert.equal((await hook(input)).length,2);
  revision='2';assert.equal((await hook(input)).length,2);
  assert.deepEqual(events.map(e=>e.assets),[[{id:'memory',revision:'1'}],[{id:'memory',revision:'2'}]]);
});

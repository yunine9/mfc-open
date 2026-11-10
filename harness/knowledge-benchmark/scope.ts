/** Exercise the real TaskService tool/context wiring; the sidecar double only returns its allowed sources. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskService } from '../../src/taskService.ts';
import { MemoryStore } from '../../src/taskMemory.ts';
import { createBusinessModule } from '../../src/businessModuleLibrary.ts';
import type { CaseResult } from './scoring.ts';

export async function runScopeCases(out: string, record: (row: CaseResult) => void) {
  const dataDir = join(out, 'scope-data'); mkdirSync(dataDir, {recursive:true});
  const repo = 'https://example.invalid/benchmark/shared.git';
  for (const id of ['alarm','order']) createBusinessModule(dataDir,{id,name:id,description:'fixture',owner:'benchmark',repositories:[repo]},'benchmark');
  const otherRepo='https://example.invalid/benchmark/inventory.git';
  createBusinessModule(dataDir,{id:'inventory',name:'inventory',description:'fixture',owner:'benchmark',repositories:[otherRepo]},'benchmark');
  const store = new MemoryStore(dataDir);
  const memories = ['alarm','order','inventory'].map(module => {
    const row = store.record({source:'user_note',judged_by:'human',author:'benchmark',scope:'general',repo:module==='inventory'?'inventory':'shared',module,
      paths:[],task:'historical',evidence:'fixture',trigger:`${module} 去重`,conclusion:`${module} 独立规则`,product_versions:['2.7B']});
    store.review(row.id,'benchmark',{decision:'accepted',revision:1}); return row;
  });
  const svc = new TaskService({dataDir,provider:'test',model:'test',modelsJson:{},maxConcurrent:0});
  const internal = svc as any;
  internal.memorySidecar = {available:true,searchBudgetMs:10,stop(){},async search(input:any){
    return (input.sources ?? []).map((s:any)=>({id:s.id,snippet:'fixture',score:1}));
  }};
  try {
    for (const scenario of [
      {id:'explicit-module',selected:'alarm',expected:['alarm']},
      {id:'parent-module',parent:'order',expected:['order']},
      {id:'selected-modules',multiple:['alarm'],expected:['alarm']},
      {id:'ambiguous-repository',expected:[]},
      {id:'unknown-explicit-module',selected:'unknown',expected:[]},
      {id:'explicit-over-multiple',selected:'alarm',multiple:['order'],expected:['alarm']},
      {id:'both-explicit',multiple:['alarm','order'],expected:['alarm','order']},
      {id:'unique-repository',repository:otherRepo,expected:['inventory']},
      {id:'wrong-product-version',selected:'alarm',version:'2.6',expected:[]},
    ]) {
      const started = performance.now();
      const id = svc.create('检查去重规则').id, task = internal.tasks.get(id);
      Object.assign(task.summary,{repo_url:scenario.repository??repo,repositories:[scenario.repository??repo],product_version:scenario.version ?? '2.7B'});
      if(scenario.selected) task.summary.business_module={id:scenario.selected};
      if(scenario.multiple) task.summary.business_modules=scenario.multiple.map(id=>({id}));
      if(scenario.parent) {
        const parentId=svc.create('父任务').id; internal.tasks.get(parentId).summary.business_module={id:scenario.parent};
        task.summary.parent_task_id=parentId;
      }
      const tool=internal.memoryTools(task).find((t:any)=>t.name==='knowledge');
      const readable:string[]=[];
      for(const memory of memories) {
        const response=await tool.execute('scope-read',{action:'read',id:memory.id});
        if(response.details?.id===memory.id) readable.push(memory.module!);
      }
      const messages=await internal.taskMemoryContext(task)([{role:'user',content:'去重规则'}]);
      const injected=memories.filter(m=>messages.some((msg:any)=>msg.customType==='mae-memory-context'&&msg.content.includes(m.id))).map(m=>m.module!);
      const equal=(value:string[])=>JSON.stringify([...value].sort())===JSON.stringify([...scenario.expected].sort());
      record({id:`scope/${scenario.id}`,kind:'scope',passed:equal(readable)&&equal(injected),elapsed_ms:Math.round(performance.now()-started),
        expected:scenario.expected,readable,injected,backend:'deterministic source allowlist; no embedding'});
    }
  } finally {await svc.shutdown();}
}

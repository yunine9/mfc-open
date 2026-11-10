/** Actual generated conclusions -> simulated adoption -> TaskService context -> executable C++ checks. */
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {TaskService} from '../../src/taskService.ts';
import {MemoryStore} from '../../src/taskMemory.ts';
import {createBusinessModule} from '../../src/businessModuleLibrary.ts';
import {parseDeliveryExperiences} from '../../src/deliveryExperience.ts';
import type {MemorySidecar} from '../../src/memorySidecar.ts';
import type {KnowledgeSearch} from '../../src/knowledgeSearch.ts';
import {generationFixtures} from './generation-fixtures.ts';
import {runAgentCases} from './agent.ts';
import {REPO} from './fixtures.ts';
import type {CaseResult} from './scoring.ts';
import {MEMORY_CONTEXT_TYPE} from '../../src/memoryContext.ts';

export function assessPipelineConsumption(row:CaseResult,expected:string[],observed:string[]):CaseResult {
  const injected=expected.some(id=>observed.includes(id));
  return {...row,passed:row.passed&&injected,context_injected:injected,expected_memory_ids:expected,observed_memory_ids:observed};
}

export async function runPipelineCases(options:{out:string;data:string;sidecar:MemorySidecar;search:KnowledgeSearch;models:string;provider:string;model:string;repeats:number;timeoutMs:number;signal:AbortSignal;record:(row:CaseResult)=>void}) {
  for(let repeat=1;repeat<=options.repeats;repeat++) {
    const out=join(options.out,'pipeline',String(repeat)),dataDir=join(options.data,'pipeline',String(repeat));mkdirSync(dataDir,{recursive:true});mkdirSync(out,{recursive:true});
    createBusinessModule(dataDir,{id:'export',name:'Export',description:'synthetic fixture',owner:'benchmark',repositories:[REPO]},'benchmark');
    const store=new MemoryStore(dataDir),saved:string[]=[],scenarioIds:string[]=[];
    const expected=new Map<string,string[]>();
    for(const fixtureId of ['owned-resource','versioned-config']) {
      const fixture=generationFixtures.find(f=>f.id===fixtureId)!;
      const path=join(options.out,'generation',fixtureId,String(repeat),'output.txt');
      const consumers=fixtureId==='owned-resource'?['owned-writer','borrowed-writer']:['versioned-timeout'];
      try {
        if(!existsSync(path)) throw new Error(`缺少生成产物：${fixtureId}/${repeat}`);
        const drafts=parseDeliveryExperiences(readFileSync(path,'utf8'),new Set(['diff',...fixture.evidence.map(e=>e.id)]),'export');
        if(!drafts.length) throw new Error('该正例未生成可供消费的经验');
        const ids:string[]=[];
        for(const draft of drafts) {
          const row=store.record({...draft,source:'delivery_review',judged_by:'agent',author:'benchmark-agent',repo:'shared',task:'synthetic-delivery',evidence:draft.evidence_ids.join(','),product_versions:['2.7B']});
          const accepted=store.review(row.id,'benchmark-reviewer',{decision:'accepted',revision:1});
          // Match production adoption's ingest; measure consumption after indexing is ready.
          if(!await options.sidecar.ingest(join(store.root,accepted.file))) throw new Error('采纳后的经验索引未就绪');
          saved.push(row.id);ids.push(row.id);
        }
        for(const scenarioId of consumers) expected.set(scenarioId,ids);
        scenarioIds.push(...consumers);
      }catch(error){for(const scenarioId of consumers)options.record({id:`pipeline/${repeat}/agent/${scenarioId}/generated-context/1`,kind:'agent',arm:'generated-context',passed:false,outcome:'source_unavailable',elapsed_ms:0,error:String(error)});}

    }
    writeFileSync(join(out,'adoption.json'),JSON.stringify({simulated_reviewer:true,ids:saved,note:'测试消费生成结果；不代表生产中自动采纳'},null,2));
    const service=new TaskService({dataDir,provider:'test',model:'test',modelsJson:{},maxConcurrent:0}),host=service as any;
    host.memorySidecar=options.sidecar;
    try {
      const id=service.create('按经验实现导出与配置读取').id,task=host.tasks.get(id);
      Object.assign(task.summary,{repo_url:REPO,repositories:[REPO],business_module:{id:'export'},product_version:'2.7B'});
      const context=host.taskMemoryContext(task),observed=new Set<string>();
      const inject=async(messages:any[])=>{
        const result=await context(messages);
        for(const message of result.filter((m:any)=>m.customType===MEMORY_CONTEXT_TYPE)) {
          for(const id of saved) if(String(message.content).includes(`(${id})`)) observed.add(id);
        }
        return result;
      };
      await runAgentCases({...options,out,repeats:1,arms:['generated-context'],scenarioIds,inject,sourceFile:'example.cpp',onWorkspace:workspace=>{task.cwd=workspace;observed.clear();},
        record:row=>{
          const result={...assessPipelineConsumption(row,expected.get(row.id.split('/')[1])??[],[...observed]),id:`pipeline/${repeat}/${row.id}`,generation_repeat:repeat};
          writeFileSync(join(out,row.id,'result.json'),JSON.stringify(result,null,2));
          options.record(result);
        }});
      const log=join(task.summary.workspace,'memory-usage.jsonl');
      if(existsSync(log))writeFileSync(join(out,'memory-usage.jsonl'),readFileSync(log));
    }finally{host.memorySidecar=undefined;await service.shutdown();}
  }
}

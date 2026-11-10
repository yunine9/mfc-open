import { readFileSync, writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { compile } from './compile.ts';
import { renderArchify } from '../../src/archifyRender.ts';
const out=resolve(process.env.ARCHIFY_PROBE_OUT||'.local/archify-probe');
const base=JSON.parse(readFileSync(join(out,'semantic-1.json'),'utf8')).modules[0];
const cases=[{name:'12-module-chain',n:12,edges:Array.from({length:11},(_,i)=>[i,i+1])},{name:'diamond',n:4,edges:[[0,1],[0,2],[1,3],[2,3]]},{name:'feedback-cycle',n:6,edges:[[0,1],[1,2],[2,3],[3,1],[3,4],[4,5],[5,0]]},{name:'fan-out-in',n:12,edges:Array.from({length:10},(_,i)=>[[0,i+1],[i+1,11]]).flat()}];
const results: Array<{name:string;success:boolean;modules?:number;relations?:number;ms?:number;error?:string}>=[];
for(const c of cases){const data={title:c.name+' · 构造压力样本',modules:Array.from({length:c.n},(_,i)=>({...base,id:`m${i}`,name:`模块${i+1}`,summary:'校验多节点布局与完整关系保留'})),relations:c.edges.map(([a,b])=>({from:`m${a}`,to:`m${b}`,label:'交付材料'}))};const t=performance.now();try{const source=await compile(data,out);const r=await renderArchify(source);results.push({name:c.name,modules:c.n,relations:c.edges.length,ms:Math.round(performance.now()-t),success:!!r.html,error:r.error});if(r.html)writeFileSync(join(out,`stress-${c.name}.html`),r.html);}catch(e){results.push({name:c.name,success:false,error:String(e)})}}
writeFileSync(join(out,'stress-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));

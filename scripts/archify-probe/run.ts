/** Local experiment only: no production task state or prompt is changed. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { compile } from './compile.ts';
import { draftWithModel } from '../../src/modelTransport.ts';
import { renderArchify } from '../../src/archifyRender.ts';
const out = resolve(process.env.ARCHIFY_PROBE_OUT || '.local/archify-probe');
mkdirSync(out, { recursive: true });
const modelsJson = JSON.parse(readFileSync(process.env.ARCHIFY_MODELS || '.local/models.json', 'utf8'));
const provider = process.env.ARCHIFY_PROVIDER || 'glm';
const model = process.env.ARCHIFY_MODEL || modelsJson.providers[provider].models[0].id;
const inputPath = process.env.ARCHIFY_INPUT || 'docs/overall-story.md';
const input = readFileSync(inputPath, 'utf8');
writeFileSync(join(out, 'input.md'), input);
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2));
const semantic = `只返回 JSON，不要代码围栏。根据提供的设计材料提炼模块协作图，不补造不存在的功能。不是生产现状审计。格式：{"title":"标题","modules":[{"id":"英文短ID","name":"模块名","type":"frontend|backend|database|cloud|security|messagebus|external","summary":"20字内职责摘要","responsibility":"完整职责","interfaces":"提供或消费的接口/材料；未明确则如实写","acceptance":"设计要求的验收行为，不声称已验证","evidence":"原文中一段逐字引用"}],"relations":[{"from":"模块ID","to":"模块ID","label":"12字内关系说明"}]}。覆盖主要参与者、文档会话、发布存储、检视与子任务协作；合理合并，不超过9个模块。type 按真实职责选择：界面 frontend，处理/编排 backend，持久存储 database（不限数据库），基础设施 cloud，安全 security，消息队列 messagebus，文档资料或外部依赖 external。不得为了配色编造队列或数据库，不统一标成 backend。关系表示调用或材料流转，不代表任务必须串行。只表达设计内容，不生成坐标、布局或Archify字段。`;
const native = `只返回一份可直接渲染的 Archify architecture JSON，不要围栏。依据相同设计材料生成有意义的模块职责和关系图，覆盖主要参与者、文档会话、发布存储、检视与子任务协作，不超过9个模块。cards保留职责、接口和验收信息，不补造。使用中文。遵守以下schema及例子；禁用brand/repository/sources。\n${readFileSync('vendor/archify/schemas/architecture.schema.json','utf8')}\n${readFileSync('vendor/archify/schemas/common.schema.json','utf8')}\n${readFileSync('vendor/archify/examples/web-app.architecture.json','utf8')}`;
const mode=process.argv[2] || 'all';
const names= mode==='rerender' ? ['semantic-1','semantic-2','semantic-3'] : mode==='fast' ? ['fast-1','fast-2','fast-3'] : ['native-1','semantic-1','semantic-2','semantic-3'];
let renderTail=Promise.resolve();
async function serialRender(source:any){const previous=renderTail;let release!:()=>void;renderTail=new Promise<void>(r=>release=r);await previous;try{return await renderArchify(source)}finally{release()}}
const results=await Promise.all(names.map(async name=>{
  const start=performance.now(); let gen=0;
  try{
    let data;
    if(mode==='rerender') data=JSON.parse(readFileSync(join(out,`${name}.json`),'utf8'));
    else {
      const raw=await draftWithModel({modelsJson,provider,model,system:name.startsWith('native')?native:semantic+(mode==='fast'?' 每项responsibility/interfaces/acceptance各用一句不超过45字，evidence引用不超过35字。不要反复抄写相同背景、免责声明或解释字段，不遗漏关键职责。':''),user:input,timeoutMs:240000});
      gen=performance.now()-start;
      writeFileSync(join(out,`${name}.txt`),raw);
      data=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));save(`${name}.json`,data);
    }
    const t=performance.now();
    const source=name.startsWith('native')?data:await compile(data,out);
    save(`${name}.source.json`,source);
    const rendered=await serialRender(source);
    if(rendered.html) writeFileSync(join(out,`${name}.html`),rendered.html);
    const result={name,model,generation_ms:Math.round(gen),compile_render_ms:Math.round(performance.now()-t),success:!!rendered.html,error:rendered.error,modules:source.components.length,relations:source.connections.length};
    save(`${name}${mode==='rerender'?'.rerender':''}.result.json`,result);console.log(JSON.stringify(result));return result;
  }catch(e){const result={name,success:false,generation_ms:Math.round(performance.now()-start),error:e instanceof SyntaxError?'Invalid model JSON':e instanceof Error?e.name:'Failed'};save(`${name}${mode==='rerender'?'.rerender':''}.result.json`,result);console.log(JSON.stringify(result));return result;}
}));
save(mode==='rerender'?'rerender-results.json':mode==='fast'?'fast-results.json':'results.json',{inputPath,model,results});

/** Import real probe output into an isolated local service fixture. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalAuth } from '../../src/auth.ts';
import { classifyStoryFixture, moduleDot } from './moduleRoles.ts';
import { compile } from './compile.ts';
const out=resolve('.local/archify-probe');
const root=resolve('.local/archify-service-preview');
const refresh=process.argv.includes('--refresh-architecture');
if(existsSync(root)&&!refresh) throw Error('Preview directory already exists; refusing to overwrite it');
if(refresh && JSON.parse(readFileSync(join(root,'task-1/task.json'),'utf8')).summary.ui_fixture!==true) throw Error('Only the isolated fixture may be refreshed');
const workspace=join(root,'task-1'),cwd=join(workspace,'repositories'),ticket='ARCHIFY-DEMO';
const artifactDir=join(cwd,'.mae-flow-work',ticket);mkdirSync(artifactDir,{recursive:true});
if(!refresh){const auth=new LocalAuth(join(root,'auth.json'));auth.bootstrapAdmin('admin','mae-flow-demo');auth.createUser('dev','mae-flow-demo','developer','本地体验');}
const data=classifyStoryFixture(JSON.parse(readFileSync(join(out,'fast-1.json'),'utf8')));
const story=readFileSync(join(out,'input.md'),'utf8');
const overview=await compile(data,out);overview.cards=[];
const diagrams: any[]=[{id:'overview',view:'development',nodes:data.modules,source:{...overview,meta:{...overview.meta,title:'全部模块与协作关系'}}}];
for(const m of data.modules){
 const neighbors=new Set([m.id,...data.relations.filter((e:any)=>e.from===m.id||e.to===m.id).flatMap((e:any)=>[e.from,e.to])]);
 const source=await compile({...data,title:m.name,modules:data.modules.filter((x:any)=>neighbors.has(x.id)),relations:data.relations.filter((e:any)=>neighbors.has(e.from)&&neighbors.has(e.to))},out);
 // One concise selected-module card, never repeat all modules as a wall of text.
 source.cards=[{dot:moduleDot(m.type),title:m.name+' · 具体工作',items:[m.responsibility,m.interfaces]}];
 diagrams.push({id:m.id,view:'development',overview_id:'overview',focus_node:m.id,nodes:data.modules,source});
}
if(!refresh) writeFileSync(join(artifactDir,'story.md'),story);
writeFileSync(join(artifactDir,'architecture.json'),JSON.stringify({schema_version:1,story_sha256:createHash('sha256').update(story).digest('hex'),diagrams},null,2));
if(refresh){console.log('Updated isolated architecture artifact');process.exit(0);}
const now=new Date().toISOString();
const summary={id:'task-1',ui_fixture:true,title:'整体 Story 模块协作 · Archify 本地验证',requirement:'# 本地真实服务体验\n\n以现有整体 Story 设计材料验证模块协作图。图源来自本机 GLM 实际输出，布局由程序生成。\n\n这是隔离预览任务，不执行开发、推送或部署。',status:'paused',created_at:now,updated_at:now,workspace,luban_account:'dev',ticket,lane:'完整开发',requirement_analysis_requested:true,repositories:['fixture://mae-flow-cloud'],detail:'本地验证：查看设计与架构图；没有启动开发 Agent。',control:{last_action:'pause',actor:'dev',at:now,paused_from:'running'},requirement_graph:{stage:'analysis',source_document:'story.md',projection_state:'ready',plan_revision:'preview-1',repositories:data.modules.map((m:any)=>({id:m.id,name:'mae-flow-cloud',url:'fixture://mae-flow-cloud',responsibility:m.summary,scope:{name:m.name,paths:[]}})),dependencies:[]}};
writeFileSync(join(workspace,'task.json'),JSON.stringify({summary,cwd},null,2));
console.log('Preview seeded: '+root+'; task-1; login dev / mae-flow-demo');

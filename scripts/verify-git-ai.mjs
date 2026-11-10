// Run only in a disposable Linux container; argv[2] is the bundled Cloud adapter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Usage: node verify-git-ai.mjs /path/to/bundled-adapter.mjs');
assert.ok(fs.existsSync('/.dockerenv') && process.env.MFC_GIT_AI_VERIFY_DISPOSABLE==='1',
 'Run this verifier only in an explicitly disposable Docker container');
assert.ok(!fs.existsSync(path.join(os.homedir(),'.git-ai')), 'Use a fresh container with an empty temporary HOME');
const {GitAiSession,publicGitAiNote,preserveGitAiNotes}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const binary=process.env.MFC_GIT_AI_BIN ?? '/opt/git-ai/bin/git-ai';
process.env.MFC_GIT_AI_ENABLED='1';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mfc-git-ai-verify-'));
const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Synthetic Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Synthetic Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
const logs=[],cases=[];
function processRun(exe,args,cwd,input) {
 return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject);child.on('close',code=>resolve({exitCode:code,stdout,stderr}));child.stdin.end(input);
 });
}
async function run(exe,args,cwd=root,input) {const r=await processRun(exe,args,cwd,input);if(r.exitCode!==0)throw new Error(JSON.stringify({exe,args,...r}));return r.stdout.trim();}
const git=(cwd,...args)=>run('git',args,cwd);
const backend={exec:async(command,cwd,options)=>{
 const r=await processRun('/bin/sh',['-c',command],cwd);options.onData(Buffer.from(r.stdout+r.stderr));return {exitCode:r.exitCode};
}};
function tracker(cwd,id='main') {return {instance:new GitAiSession(backend,cwd,m=>logs.push(m),binary),ctx:{cwd,model:{provider:'test',id:'synthetic-model'},sessionManager:{getSessionId:()=>`synthetic-${id}`}}};}
let counter=0;
async function bash(t,command) {
 const event={toolName:'bash',toolCallId:`bash-${++counter}`,input:{command}};
 await t.instance.before(event,t.ctx);
 try {return await t.instance.operations().exec(command,t.ctx.cwd,{onData:()=>{}});} finally {await t.instance.after(event);}
}
async function edit(t,file,content) {
 const event={toolName:'write',toolCallId:`write-${++counter}`,input:{path:file}};
 await t.instance.before(event,t.ctx);fs.writeFileSync(path.join(t.ctx.cwd,file),content);await t.instance.after(event);
}
async function repo(name) {
 const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});await git(dir,'init','-q','-b','main');
 fs.writeFileSync(path.join(dir,'sample.txt'),'base\n');await git(dir,'add','.');await git(dir,'commit','-qm','Base');return dir;
}
async function stats(cwd,name,expected) {
 const result=JSON.parse(await run(binary,['stats','HEAD','--json'],cwd));
 for(const [key,value] of Object.entries(expected)) assert.equal(result[key],value,`${name}: ${JSON.stringify(result)}`);
 cases.push({name,stats:result});return result;
}
try {
 const cwd=await repo('requirement'),t=tracker(cwd);
 await edit(t,'sample.txt','base\nAI write\n');assert.equal((await bash(t,'git add . && git commit -qm "AI write"')).exitCode,0);
 await stats(cwd,'host Write then container commit',{ai_additions:1});
 fs.appendFileSync(path.join(cwd,'sample.txt'),'human dirty\n');
 await bash(t,"printf 'AI bash\\n' >> sample.txt; git add .; git commit -qm 'mixed'");
 // This is an upstream 1.7.5 accuracy limitation, not evidence of human authorship.
 await stats(cwd,'upstream limitation: mixed dirty lines counted as AI',{ai_additions:2});
 await bash(t,'git commit --amend -qm "amended"');await stats(cwd,'amend',{ai_additions:2});
 const old=await git(cwd,'rev-parse','HEAD'),base=await git(cwd,'rev-list','--max-parents=0','HEAD'),tree=await git(cwd,'rev-parse','HEAD^{tree}');
 const rewritten=await git(cwd,'commit-tree',tree,'-p',base,'-m','Host squash');
 await preserveGitAiNotes(cwd,new Map([[old,rewritten]]),m=>logs.push(m));await git(cwd,'update-ref','refs/heads/main',rewritten,old);
 await stats(cwd,'host squash preserves existing attribution',{ai_additions:3});
 const raw=await git(cwd,'notes','--ref=ai','show','HEAD'),sanitized=publicGitAiNote(raw,rewritten);
 assert.ok(sanitized);fs.writeFileSync(path.join(root,'public-note.txt'),sanitized);
 await git(cwd,'notes','--ref=ai','add','-f','-F',path.join(root,'public-note.txt'),rewritten);
 await stats(cwd,'public anonymous note compatibility',{ai_additions:3});
 await run(binary,['bg','shutdown'],cwd);
 const daemonPid=path.join(os.homedir(),'.git-ai/internal/daemon/daemon.pid.json');
 for(let attempt=0;fs.existsSync(daemonPid)&&attempt<200;attempt++) await new Promise(resolve=>setTimeout(resolve,25));
 assert.ok(!fs.existsSync(daemonPid),'test daemon did not finish shutting down');
 // Empty runtime storage simulates a recreated task container while the repo survives.
 fs.rmSync(path.join(os.homedir(),'.git-ai'),{recursive:true,force:true});
 const resumed=tracker(cwd,'resumed');await edit(resumed,'sample.txt',fs.readFileSync(path.join(cwd,'sample.txt'),'utf8')+'resumed AI\n');
 await bash(resumed,'git add . && git commit -qm "resume"');await stats(cwd,'resumed session with fresh runtime storage',{ai_additions:1});
 const issue=path.join(root,'issue');await repo('issue/repo/A');await repo('issue/repo/B');const multi=tracker(issue,'issue');
 await bash(multi,"printf 'AI A\\n' >> repo/A/sample.txt; printf 'AI B\\n' >> repo/B/sample.txt; git -C repo/A add .; git -C repo/A commit -qm A; git -C repo/B add .; git -C repo/B commit -qm B");
 await stats(path.join(issue,'repo/A'),'issue repo A',{ai_additions:1});await stats(path.join(issue,'repo/B'),'issue repo B',{ai_additions:1});
 await edit(multi,'repo/B/sample.txt',fs.readFileSync(path.join(issue,'repo/B/sample.txt'),'utf8')+'issue Write\n');
 await bash(multi,'git -C repo/B add . && git -C repo/B commit -qm write');
 await stats(path.join(issue,'repo/B'),'issue parent cwd with Write in child repo',{ai_additions:1});
 const partial=await bash(multi,"printf 'partial AI\\n' >> repo/A/sample.txt; exit 1");assert.equal(partial.exitCode,1);
 await bash(multi,'git -C repo/A add . && git -C repo/A commit -qm partial');await stats(path.join(issue,'repo/A'),'partial failure still attributed',{ai_additions:1});
 assert.deepEqual(logs,[],`Unexpected attribution failure: ${logs.join('; ')}`);
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({version:await run(binary,['--version']),cases,logs},null,2));
 console.log(JSON.stringify({root,cases:cases.length,passed:true}));
} finally {await processRun(binary,['bg','shutdown'],root);}

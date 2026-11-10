import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DomainKnowledgeExtraction } from '../../src/domainKnowledgeExtraction.ts';
import { runDomainKnowledge } from '../../src/domainKnowledgeAgent.ts';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { ExtractionSkillSnapshot } from '../../src/knowledgeExtractionSkills.ts';
import { domainExecutionContract } from '../../src/domainKnowledgeExecution.ts';
import { knowledgeArchiveDefaults } from '../../src/knowledgeArchiveDefaults.ts';
import { scanForSecrets } from '../../src/hostSkillLibrary.ts';
import { saveKnowledgeMaterial } from '../../src/knowledgeMaterials.ts';
import { createFixture, hash, instructions, MATERIALS, SUITE_VERSION } from './fixtures.ts';
import { assessRun, FACTS, filesUnder } from './scoring.ts';

export interface Options { output: string; skill: string; models?: string; provider: string; model: string; budgetMs: number; profile: 'small'|'full'; diagrams: boolean; prepareOnly: boolean; restartAfterDocuments?: number }
export function parseOptions(args: string[]): Options {
  const values: Record<string, string> = {}, flags = new Set<string>();
  const booleanFlags = new Set(['--prepare-only', '--no-diagrams']);
  const names = new Set(['--output', '--skill', '--models', '--provider', '--model', '--budget-ms', '--profile', '--restart-after-documents']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (booleanFlags.has(name)) flags.add(name);
    else if (names.has(name) && args[i + 1] && !args[i + 1].startsWith('--')) values[name] = args[++i];
    else throw new Error(`未知参数或缺少值：${name}`);
  }
  if (!values['--output']) throw new Error('请用 --output 指定新的结果目录');
  if (!flags.has('--prepare-only') && !values['--models']) throw new Error('真实模型运行需要 --models 指定本地模型配置');
  const budgetMs = Number(values['--budget-ms'] ?? 300_000), restart = values['--restart-after-documents'] === undefined ? undefined : Number(values['--restart-after-documents']);
  if (!Number.isFinite(budgetMs) || budgetMs < 1000 || budgetMs > 48 * 60 * 60_000) throw new Error('整体预算应在 1000 毫秒到 48 小时之间');
  if (restart !== undefined && (!Number.isInteger(restart) || restart < 1)) throw new Error('重启位置须为正整数文档数');
  const profile = values['--profile'] ?? 'small'; if (!['small', 'full'].includes(profile)) throw new Error('profile 仅支持 small/full');
  return { output: resolve(values['--output']), skill: resolve(values['--skill'] ?? 'internal-skills/business-docs-generator'), models: values['--models'] ? resolve(values['--models']) : undefined,
    provider: values['--provider'] ?? 'glm', model: values['--model'] ?? 'glm-5.3-flash', budgetMs, profile: profile as 'small'|'full', diagrams: !flags.has('--no-diagrams'), prepareOnly: flags.has('--prepare-only'), restartAfterDocuments: restart };
}
export function readSkill(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path = '') => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 不能包含软链接');
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && name.endsWith('.md')) result[name] = readFileSync(join(root, name), 'utf8');
      else throw new Error(`Skill 包存在非 Markdown 文件：${name}`);
    }
  };
  walk(); if (!result['SKILL.md']) throw new Error('Skill 目录缺少 SKILL.md'); return result;
}
export function modelSecrets(json: unknown): string[] {
  const result = new Set<string>();
  const walk = (value: any, sensitive = false) => {
    if (typeof value === 'string') { if (sensitive && value.length >= 4) result.add(value); }
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) walk(child, sensitive || /api.?key|token|authorization|password|secret|headers/i.test(key));
  };
  walk(json); return [...result].sort((a, b) => b.length - a.length);
}
export function scrub(value: string, secrets: string[]) {
  for (const secret of secrets) for (const encoded of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) value = value.split(encoded).join('[REDACTED]');
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
export function cleanCredentials(root: string, secrets: string[]) {
  for (const file of filesUnder(root)) {
    if (/\/(?:models(?:-store)?|auth)\.json$/.test(file)) { rmSync(file, { force: true }); continue; }
    if (!/\.(?:json|jsonl|txt|log|md|ts|mts)$/.test(file)) continue;
    const original = readFileSync(file, 'utf8'), cleaned = scrub(original, secrets);
    if (cleaned !== original) writeFileSync(file, cleaned, { mode: 0o600 });
  }
}
export function exportData(source: string, destination: string, secrets: string[]) {
  for (const file of filesUnder(source)) {
    const path = relative(source, file);
    // Keep the production logs and state, but never export model/auth configuration.
    if (/^(?:models(?:-store)?|auth)\.json$/.test(path.split('/').at(-1)!)) continue;
    if (!/\.(?:json|jsonl|txt|log|md)$/.test(path)) continue;
    const target = join(destination, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, scrub(readFileSync(file, 'utf8'), secrets), { mode: 0o600 });
  }
}
export async function run(options: Options) {
  if (existsSync(options.output)) throw new Error('结果目录已存在；请指定新目录，避免覆盖历史结果');
  const skillFiles = readSkill(options.skill);
  const modelJson = options.models ? JSON.parse(readFileSync(options.models, 'utf8')) : undefined;
  if (!options.prepareOnly && !modelJson?.providers?.[options.provider]?.models?.some((m: any) => m.id === options.model)) throw new Error('指定 provider/model 不在模型配置中');
  const secrets = modelSecrets(modelJson), out = options.output;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  // Production creates models.json itself. Keep that runtime outside the retained report directory.
  const data = mkdtempSync(join(tmpdir(), 'business-docs-benchmark-'));
  const write = (name: string, value: unknown) => { const path = join(out, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, scrub(typeof value === 'string' ? value : JSON.stringify(value, null, 2), secrets), { mode: 0o600 }); };
  let service: DomainKnowledgeExtraction | undefined, timer: ReturnType<typeof setTimeout> | undefined, expired = false, interrupted = false;
  let jobId: string | undefined;
  const restoreEnv = { MAE_FLOW_WXDOUBAO_BIN: process.env.MAE_FLOW_WXDOUBAO_BIN, WXDOUBAO_USERID: process.env.WXDOUBAO_USERID, WXDOUBAO_TOKEN: process.env.WXDOUBAO_TOKEN };
  const stop = () => { interrupted = true; if (jobId) service?.stop(jobId); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const started = Date.now();
  try {
    const fixture = createFixture(join(out, 'sources'));
    for (const material of MATERIALS) write(`materials/${material.name}`, material.content);
    write('fixture-manifest.json', { suite: SUITE_VERSION, digest: fixture.digest, sources: fixture.sources.map(s => ({ repository: s.repository, revision: s.revision })), files: fixture.sourceManifest, material_digests: MATERIALS.map(m => ({ name: m.name, version: m.version, sha256: hash(m.content) })) });
    // The evaluator and expectations are outside the allowed source roots. The research tools cannot read them.
    write('expected-facts.json', FACTS.map(({ id, expected, source }) => ({ id, expected, source })));
    write('input.json', { title: '订单与库存知识', scope: '研究订单生命周期与库存预留的完整行为、跨仓交互、错误处理及业务边界。', instructions: instructions(options.profile), profile: options.profile });
    const { frontmatter } = parseFrontmatter<{ name?: string; description?: string }>(skillFiles['SKILL.md']);
    if (!frontmatter.name || !frontmatter.description) throw new Error('评测方法需要有效的 name 和 description');
    domainExecutionContract(skillFiles); knowledgeArchiveDefaults(skillFiles, 'domain');
    for (const [path, content] of Object.entries(skillFiles)) scanForSecrets(path, Buffer.from(content));
    const skill: ExtractionSkillSnapshot = { name: frontmatter.name, kind: 'domain',
      digest: hash(JSON.stringify(Object.entries(skillFiles).sort(([a], [b]) => a.localeCompare(b)))), captured_at: new Date().toISOString(), files: skillFiles };
    write('skill.json', { name: skill.name, digest: skill.digest, files: skill.files });
    const materials = await Promise.all(MATERIALS.map(m => saveKnowledgeMaterial(join(data, 'knowledge-materials'), { name: m.name, version: m.version, content_base64: Buffer.from(m.content).toString('base64') })));
    if (materials.some(m => m.state !== 'ready')) throw new Error('合成业务资料未成功解析');
    const scorerDigest = hash(readFileSync(fileURLToPath(new URL('./scoring.ts', import.meta.url))));
    const implementationDigest = hash(['domainKnowledgeAgent.ts', 'domainSkillWork.ts', 'domainKnowledgeExtraction.ts', 'sessionDriver.ts'].map(name => readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), 'utf8')).join('\n'));
    const metadata = { suite: SUITE_VERSION, fixture_digest: fixture.digest, skill_digest: skill.digest, scorer_digest: scorerDigest, implementation_digest: implementationDigest,
      input_digest: hash(readFileSync(join(out, 'input.json'))), provider: options.provider, model: options.model, profile: options.profile, budget_ms: options.budgetMs, diagrams: options.diagrams, configured: !!modelJson, started_at: new Date(started).toISOString() };
    write('run.json', metadata);
    if (options.prepareOnly) { write('report.json', { ...metadata, status: 'prepared', model_called: false, quality_verified: false }); console.log(JSON.stringify({ status: 'prepared', output: out, fixture_digest: fixture.digest, model_called: false })); return 0; }
    if (interrupted || Date.now() >= started + options.budgetMs) throw new Error('任务已中断或准备阶段已用完整体预算，未请求模型');
    const deny = join(out, 'external-lookup-disabled.cjs'); writeFileSync(deny, `#!${process.execPath}\nprocess.stderr.write('External business lookup is disabled in this synthetic benchmark.');process.exit(1);\n`, { mode: 0o700 });
    process.env.MAE_FLOW_WXDOUBAO_BIN = deny; delete process.env.WXDOUBAO_USERID; delete process.env.WXDOUBAO_TOKEN;
    const createService = () => new DomainKnowledgeExtraction(data, input => {
      // 评测选择的包只固定到本次任务；重启继续沿用同一副本，不修改平台公共方法。
      const pinned = join(input.root, 'skill.json');
      if (!existsSync(pinned)) {
        mkdirSync(input.root, { recursive: true });
        writeFileSync(`${pinned}.tmp`, JSON.stringify(skill), { mode: 0o600 }); renameSync(`${pinned}.tmp`, pinned);
      }
      return runDomainKnowledge(input, { dataDir: data,
      model: () => ({ provider: options.provider, model: options.model, json: modelJson }), source: async repository => {
        const source = fixture.sources.find(s => s.repository.id === repository.id); if (!source) throw new Error('只能读取固定合成仓');
        return { root: source.root, revision: source.revision };
      } });
    });
    service = createService();
    const input = JSON.parse(readFileSync(join(out, 'input.json'), 'utf8'));
    const job = service.create({ issue_no: 'BENCH-SYNTHETIC', ...input, repositories: fixture.sources.map(s => s.repository), material_ids: materials.map(m => m.id) }, 'benchmark'); jobId = job.id;
    const deadline = started + options.budgetMs;
    timer = setTimeout(() => { expired = true; if (jobId) service?.stop(jobId); }, Math.max(1, deadline - Date.now()));
    let restarted = false, restartSnapshot: unknown;
    while (Date.now() < deadline && !interrupted) {
      const current = service.get(jobId);
      if (['done', 'failed', 'cancelled', 'paused'].includes(current.status)) break;
      if (!restarted && options.restartAfterDocuments && current.documents.length >= options.restartAfterDocuments) {
        restartSnapshot = { before: current.documents.map(d => ({ id: d.id, revision: d.revision, digest: hash(d.content) })), turn: current.turns.at(-1)?.id };
        await service.shutdown(); service = createService(); restarted = true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (Date.now() >= deadline) { expired = true; service.stop(jobId); }
    const final = service.get(jobId); write('job.json', final);
    await service.shutdown(); service = undefined;
    for (const doc of final.documents) write(`documents/${doc.target_id}/${doc.path}`, doc.content);
    for (const doc of final.work_documents ?? []) write(`work-documents/${doc.id}.md`, doc.content);
    const assessment = await assessRun({ job: final, root: data, sources: fixture.sources, profile: options.profile, diagrams: options.diagrams, deadline });
    if (Date.now() >= deadline) expired = true;
    const report = { ...metadata, status: expired ? 'budget_exhausted' : interrupted ? 'interrupted' : final.status, model_called: true, elapsed_ms: Date.now() - started, job_id: jobId, error: final.error,
      restart: { requested: !!options.restartAfterDocuments, performed: restarted, snapshot: restartSnapshot, mode: 'controlled service shutdown and recovery, not SIGKILL' }, ...assessment };
    write('report.json', report);
    write('semantic-review.json', { status: 'pending', reviewer: null, checks: FACTS.map(f => ({ id: f.id, expected: f.expected, judgement: null, evidence: null })), note: '逐文稿对照固定源码、业务材料、图与引用，记录遗漏、错误条件及结论；不能依据自动通过代签。' });
    console.log(JSON.stringify({ output: out, status: report.status, documents: final.documents.length, contract_passed: assessment.contract_passed, quality_verified: false, elapsed_ms: report.elapsed_ms }));
    return assessment.contract_passed && !expired && !interrupted ? 0 : 1;
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error), secrets); write('failure.json', { error: message, elapsed_ms: Date.now() - started }); console.error(message); return 1;
  } finally {
    clearTimeout(timer);
    try { if (jobId && service) service.stop(jobId); await service?.shutdown(); }
    finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      for (const [key, value] of Object.entries(restoreEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      try { exportData(data, join(out, 'data'), secrets); cleanCredentials(out, secrets); }
      finally { rmSync(data, { recursive: true, force: true }); }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await run(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

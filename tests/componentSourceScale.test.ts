import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { componentSourceTool, listGitTreePaths, readGitBlobPage, readGitBuildFile } from '../src/componentResearchTools.ts';
import { knowledgeStructure, knowledgeStructurePage, scanKnowledgeCode, validateKnowledgeReferences, type KnowledgeCodeSnapshot } from '../src/domainKnowledgeCode.ts';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'component-source-scale-'));
  const git = (args: string[], input?: string) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, input, encoding: 'utf8', timeout: 15_000 }).trim();
  git(['init', '-q']);
  const blob = (content: string) => git(['hash-object', '-w', '--stdin'], content);
  const commit = (files: Array<{ path: string; blob: string }>) => git(['commit-tree', git(['mktree', '-z'], files.map(f => `100644 blob ${f.blob}\t${f.path}\0`).join(''))], 'synthetic scale fixture\n');
  return { root, blob, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const config = { id: 'repo-1', name: 'fixture', repository: 'https://example.invalid/fixture.git', branch: 'main', path: '', docs_path: 'docs' };
async function invoke(tool: ReturnType<typeof componentSourceTool>, input: object) {
  const result = await tool.execute('test', input as never, undefined, undefined, {} as never);
  return { isError: !!(result as any).isError, text: result.content.map(c => c.type === 'text' ? c.text : '').join('\n') };
}

test('超过1MiB源码能读开头两行和末尾，引用行号与末尾符号校验不再整文件缓冲失败', async () => {
  const f = repository();
  try {
    const lines = ['FIRST', 'SECOND', ...Array.from({ length: 18_000 }, (_, i) => `const value_${i} = "${'x'.repeat(75)}";`), 'function tail_rule() { return "尾部"; }', 'LAST'];
    const source = lines.join('\n') + '\n'; assert.ok(Buffer.byteLength(source) > 1024 * 1024);
    const revision = f.commit([{ path: 'large.ts', blob: f.blob(source) }]);
    const events: any[] = [], tool = componentSourceTool(f.root, revision, '', event => events.push(event));
    const first = await invoke(tool, { action: 'read', path: 'large.ts', start: 1, end: 2 });
    assert.equal(first.isError, false); assert.match(first.text, /1: FIRST\n2: SECOND/); assert.doesNotMatch(first.text, /value_0/); assert.match(first.text, /后续从 3 行/);
    const tailStart = lines.length - 1;
    const tail = await invoke(tool, { action: 'read', path: 'large.ts', start: tailStart, end: lines.length });
    assert.equal(tail.isError, false); assert.match(tail.text, /tail_rule/); assert.match(tail.text, /LAST/);
    assert.equal(events.at(-1).start, tailStart); assert.equal(events.at(-1).end, lines.length);
    const snapshot = await scanKnowledgeCode(config, { root: f.root, revision }, new AbortController().signal);
    const refs = await validateKnowledgeReferences(`\`repo-1:large.ts:${tailStart}-${lines.length}\` \`repo-1:large.ts#tail_rule\``, [snapshot], new AbortController().signal);
    assert.equal(refs.checked.length, 2); assert.deepEqual(refs.errors, []);
    const bad = await validateKnowledgeReferences(`\`repo-1:large.ts:${lines.length + 2}\` \`repo-1:large.ts#missing_symbol\``, [snapshot], new AbortController().signal);
    assert.equal(bad.errors.length, 2); assert.equal(bad.checked.length, 0);
  } finally { f.cleanup(); }
});

test('超长单行不冒充完整已读，仍能跳过该行读取尾部；页预算的续读位置不跳行', async () => {
  const f = repository();
  try {
    const revision = f.commit([{ path: 'long.ts', blob: f.blob('x'.repeat(1_200_000) + '\nAFTER_LONG_LINE\n') },
      { path: 'page.ts', blob: f.blob(Array.from({ length: 400 }, (_, i) => `${i}:${'z'.repeat(300)}`).join('\n')) }]);
    const events: any[] = [], tool = componentSourceTool(f.root, revision, '', event => events.push(event));
    const long = await invoke(tool, { action: 'read', path: 'long.ts', start: 1, end: 1 });
    assert.equal(long.isError, true); assert.match(long.text, /完整行返回预算/); assert.equal(events.at(-1).status, 'failed');
    const after = await invoke(tool, { action: 'read', path: 'long.ts', start: 2, end: 2 });
    assert.equal(after.isError, false); assert.match(after.text, /2: AFTER_LONG_LINE/);
    const page = await invoke(tool, { action: 'read', path: 'page.ts', start: 1, end: 400 });
    assert.equal(page.isError, false); assert.ok(page.text.length < 30000);
    const numbers = [...page.text.matchAll(/^(\d+):/gm)].map(m => Number(m[1]));
    const next = Number(/后续从 (\d+) 行/.exec(page.text)![1]); assert.equal(next, numbers.at(-1)! + 1);
    const resumed = await invoke(tool, { action: 'read', path: 'page.ts', start: next, end: next });
    assert.match(resumed.text, new RegExp(`^${next}: ${next - 1}:`, 'm'));
  } finally { f.cleanup(); }
});

test('超过1MiB的目录清单完整盘点，分页游标遵循实际返回项，不丢长路径', async () => {
  const f = repository();
  try {
    const empty = f.blob(''), files = Array.from({ length: 8_000 }, (_, i) => ({ path: `file-${String(i).padStart(5, '0')}-${'x'.repeat(150)}.ts`, blob: empty }));
    assert.ok(Buffer.byteLength(files.map(f => f.path).join('\0')) > 1024 * 1024);
    const revision = f.commit(files);
    const all = await listGitTreePaths(f.root, revision); assert.equal(all.length, files.length); assert.equal(all.at(-1), files.at(-1)!.path);
    const snapshot = await scanKnowledgeCode(config, { root: f.root, revision }, new AbortController().signal);
    assert.deepEqual(snapshot.files, files.map(f => f.path));
    const tool = componentSourceTool(f.root, revision, '', () => {});
    const page = await invoke(tool, { action: 'list', recursive: true, start: 1, end: 200 });
    assert.equal(page.isError, false); assert.match(page.text, /目录共 8000 项/); assert.ok(page.text.length < 30000);
    const returned = page.text.split('\n').filter(line => line.startsWith('file-'));
    const next = Number(/list start=(\d+)/.exec(page.text)![1]); assert.equal(next, returned.length + 1); assert.ok(next < 201);
    const following = await invoke(tool, { action: 'list', recursive: true, start: next, end: next });
    assert.ok(following.text.includes(files[next - 1].path));
    const tail = await invoke(tool, { action: 'list', recursive: true, start: 7_999 });
    assert.ok(tail.text.includes(files[7_998].path)); assert.ok(tail.text.includes(files[7_999].path)); assert.doesNotMatch(tail.text, /后续请用/);
  } finally { f.cleanup(); }
});

test('大构建文件读取完整尾部依赖，取消或解析预算不足明确失败', async () => {
  const f = repository();
  try {
    const revision = f.commit([{ path: 'package.json', blob: f.blob(JSON.stringify({ description: 'x'.repeat(1_100_000), name: 'large-package', dependencies: { actual_dependency: '1.0.0' } })) },
      { path: 'CMakeLists.txt', blob: f.blob(' '.repeat(16 * 1024 * 1024 + 1)) }]);
    const large = await readGitBuildFile(f.root, revision, 'package.json'); assert.ok(large.includes('actual_dependency'));
    const snapshot = await scanKnowledgeCode({ ...config, path: 'package.json' }, { root: f.root, revision }, new AbortController().signal);
    assert.deepEqual(snapshot.build_units[0].dependencies, ['actual_dependency']); assert.deepEqual(snapshot.build_units[0].targets, ['large-package']);
    await assert.rejects(readGitBuildFile(f.root, revision, 'CMakeLists.txt'), /完整解析预算/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(listGitTreePaths(f.root, revision, '', controller.signal));
    await assert.rejects(readGitBlobPage(f.root, revision, 'package.json', { start: 1, end: 1 }, controller.signal));
  } finally { f.cleanup(); }
});

test('大型结构四类结果分别分页，数千万跨仓依赖只返回当前页且末页不漏', () => {
  const dependencies = Array.from({ length: 40 }, (_, i) => `target-${i}`);
  const source: KnowledgeCodeSnapshot = {
    repository: config, root: '', revision: 'fixed-source',
    files: Array.from({ length: 1_250 }, (_, i) => `unit-${i}/package.json`),
    build_units: Array.from({ length: 1_200 }, (_, i) => ({ path: `unit-${i}/package.json`, targets: [], dependencies })),
  };
  const other: KnowledgeCodeSnapshot = {
    repository: { ...config, id: 'repo-2' }, root: '', revision: 'fixed-target', files: [],
    build_units: Array.from({ length: 1_601 }, (_, i) => ({ path: `target-${i}/CMakeLists.txt`, targets: dependencies, dependencies: [] })),
  };
  const snapshots = [source, other], totalEdges = 1_200 * 40 * 1_601;
  const first = knowledgeStructurePage(snapshots, config.id);
  for (const key of ['build_units', 'build_files', 'dependency_edges', 'directories'] as const) {
    assert.equal(first[key].length, 30); assert.equal(first[`${key}_next_start`], 30);
  }
  assert.equal(first.build_units_total, 1_200); assert.equal(first.build_files_total, 1_250);
  assert.equal(first.directories_total, 1_250); assert.equal(first.dependency_edges_total, totalEdges);
  assert.equal(first.next_start, 30); assert.ok(JSON.stringify(first).length < 40_000);
  const directoriesTail = knowledgeStructurePage(snapshots, config.id, 1_240);
  assert.deepEqual(directoriesTail.directories, source.files.slice(1_240).map(path => path.slice(0, path.lastIndexOf('/'))));
  assert.deepEqual(directoriesTail.build_files, source.files.slice(1_240));
  assert.equal(directoriesTail.directories_next_start, undefined); assert.equal(directoriesTail.next_start, 1_270);
  const last = knowledgeStructurePage(snapshots, config.id, totalEdges - 2);
  assert.deepEqual(last.dependency_edges, [1_599, 1_600].map(i => ({ from: 'repo-1:unit-1199/package.json', to: `repo-2:target-${i}/CMakeLists.txt`, dependency: 'target-39', dependency_truncated: false })));
  assert.deepEqual(last.build_units, []); assert.deepEqual(last.build_files, []); assert.deepEqual(last.directories, []);
  assert.equal(last.dependency_edges_next_start, undefined); assert.equal(last.next_start, undefined);
});

test('结构预览明确标记未展示的依赖和长名称，并保留完整文件入口与原依赖顺序', () => {
  const long = 'long-target-'.repeat(100);
  const snapshot: KnowledgeCodeSnapshot = {
    repository: config, root: '', revision: 'fixed', files: ['package.json'],
    build_units: [{ path: 'package.json', targets: [long, long], dependencies: [long, long, ...Array.from({ length: 50 }, (_, i) => `dependency-${i}`)] }],
  };
  const page = knowledgeStructurePage([snapshot], config.id), unit = page.build_units[0];
  assert.equal(unit.dependencies_total, 52); assert.equal(unit.dependencies_preview.length, 8);
  assert.equal(unit.dependencies_preview_complete, false); assert.equal(unit.targets_preview_complete, false);
  assert.ok(unit.targets_preview.every(value => value.length <= 257));
  assert.deepEqual(unit.source, { tool: 'component_source', action: 'read', repository_id: config.id, path: 'package.json', start: 1 });
  assert.equal(page.dependency_edges_total, 2); assert.ok(page.dependency_edges.every(edge => edge.dependency_truncated));
  const small = { ...snapshot, build_units: [{ path: 'package.json', targets: ['one', 'one'], dependencies: ['one', 'one'] }] };
  assert.deepEqual(knowledgeStructurePage([small], config.id).dependency_edges.map(({ dependency_truncated, ...edge }) => edge), knowledgeStructure([small])[0].dependency_edges);
  assert.throws(() => knowledgeStructurePage([snapshot], 'missing'), /研究范围/);
  assert.throws(() => knowledgeStructurePage([snapshot], config.id, -1), /非负安全整数/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { symlinkSync, chmodSync, readdirSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MAE_BUILD_REPOSITORIES, MAE_BUILD_SKILLS, MAE_CONTAINER_BOOTSTRAP, MAE_EXEC_ENVIRONMENT, isMaeRepository, prepareMaeBuildSupport, maeBuildVolumes } from '../src/maeBuildSupport.ts';
import { materializeHostSkills } from '../src/hostSkillRuntime.ts';
import { prePushSecurityDecision } from '../src/prepushAgent.ts';
import { isPrePushBuildCommand, resolvePrePushExecutionBudget, prePushCommandTimeoutSeconds } from '../src/prepushBuildPlaybook.ts';
import { collectRepoContextFiles } from '../src/issueFlow/repoContextFiles.ts';
// JS is the exact artifact mounted into task containers; test it directly rather than a TS copy.
const { buildType, quotaCores, acquireBuildLock } = await import('../assets/mae-build/first-build.mjs');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
function removeFixture(dir: string) {
  if (!existsSync(dir)) return;
  const writable = (path: string) => { if (lstatSync(path).isSymbolicLink()) return; chmodSync(path, 0o700);
    if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); };
  writable(dir); rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
function temp(t: any) { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mae-build-'))); t.after(() => removeFixture(dir)); return dir; }

test('首编锁：旧空锁可恢复；活进程互斥；异常元数据明确报错而非永久等待', t => {
  const repo = temp(t), lock = join(repo, '.mae-flow-work/mae-first-build.lock');
  mkdirSync(lock, { recursive: true });
  const release = acquireBuildLock(repo);
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid, process.pid);
  assert.throws(() => acquireBuildLock(repo), /已有首编正在执行/);
  release();
  assert.equal(existsSync(lock), false);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{broken');
  assert.throws(() => acquireBuildLock(repo), /锁信息损坏/);
  assert.deepEqual(readdirSync(dirname(lock)), ['mae-first-build.lock'], '失败的临时发布目录必须清理');
  rmSync(lock, { recursive: true });
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ host: 'removed-test-container', pid: 42 }));
  const releaseAfterRestart = acquireBuildLock(repo);
  releaseAfterRestart();
  assert.equal(existsSync(lock), false);
});
async function cloneFixture(url: string, target: string) {
  mkdirSync(target, { recursive: true });
  git(target, 'init', '-q');
  git(target, 'remote', 'add', 'origin', url);
  writeFileSync(join(target, 'fixture'), 'build support');
  git(target, 'add', '.');
  git(target, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture');
}
test('仅适配 MAE HTTPS 仓；宿主固定四仓版本、复用并拒绝污染', async t => {
  const dir = temp(t), root = join(dir, 'task'); let clones = 0;
  const input = { root, dataDir: join(dir, 'data'), repositories: ['https://codehub.example.com/example-org/FarsService.git'],
    clone: async (url: string, target: string) => { clones++; await cloneFixture(url, target); } };
  assert.equal(isMaeRepository('https://github.com/example-org/repo'), false);
  assert.equal(isMaeRepository('https://codehub.example.com.attacker.invalid/example-org/repo'), false);
  assert.equal(await prepareMaeBuildSupport({ ...input, repositories: ['https://github.com/test/repo'] }), false);
  await Promise.all([prepareMaeBuildSupport(input), prepareMaeBuildSupport(input)]);
  assert.equal(clones, 4);
  await prepareMaeBuildSupport(input); assert.equal(clones, 4);
  assert.equal(maeBuildVolumes(root).length, 5);
  assert.ok(existsSync(join(root, 'MAEServiceBuildCache/mfc-support.json')));
  writeFileSync(join(root, 'MAEBuild/fixture'), 'changed');
  await assert.rejects(prepareMaeBuildSupport(input), /已被修改/);
});
for (const main of MAE_BUILD_REPOSITORIES) {
  test(`需求容器：${main.name} 作为主仓时可写，修改或提交后仍可重建`, async t => {
    const { TaskService } = await import('../src/taskService.ts');
    const { TaskContainer } = await import('../src/containerRuntime.ts');
    const dir = temp(t), root = join(dir, 'task'), workspace = join(root, main.name);
    for (const repo of MAE_BUILD_REPOSITORIES) await cloneFixture(repo.url, join(root, repo.name));
    const service = new TaskService({ dataDir: join(dir, 'data'), provider: 'fixture', model: 'fixture', modelsJson: {} });
    try {
      const task = { cwd: workspace, summary: { id: 'task-57', workspace: root, repo_url: main.url } };
      for (const state of ['clean', 'modified', 'committed']) {
        if (state === 'modified') writeFileSync(join(workspace, 'fixture'), 'task changes');
        if (state === 'committed') git(workspace, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-am', 'task changes');
        const mounts = await (service as any).taskContainerMounts(task, []);
        assert.equal(mounts.environment.MFC_MAE_BUILD_ERROR, undefined, state);
        const container = new TaskContainer('fixture/build:test', workspace, 'mfc-mae-main', undefined,
          mounts.volumes, {}, { environment: mounts.environment });
        assert.doesNotThrow(() => (container as any).validateConfiguration(), state);
        const args: string[] = (container as any).runArgs();
        const volumes = args.filter((_, index) => args[index - 1] === '-v');
        assert.deepEqual(volumes.filter(volume => volume.split(':')[1] === workspace), [`${workspace}:${workspace}:rw`]);
        const manifest = JSON.parse(readFileSync(join(root, 'MAEServiceBuildCache/mfc-support.json'), 'utf8'));
        assert.equal(manifest[main.name], undefined, '主仓不固定为辅助仓版本');
        for (const helper of MAE_BUILD_REPOSITORIES.filter(repo => repo !== main)) {
          const path = join(root, helper.name);
          assert.ok(volumes.includes(`${path}:${path}:ro`), helper.name);
          assert.match(manifest[helper.name], /^[a-f0-9]{40,64}$/);
        }
        const cache = join(root, 'MAEServiceBuildCache');
        assert.ok(volumes.includes(`${cache}:${cache}:rw`));
      }
    } finally { await service.shutdown(); }
  });
}
test('多仓工作区中的同源仓不会排除工作区外的辅助仓', async t => {
  const { TaskService } = await import('../src/taskService.ts');
  const dir = temp(t), root = join(dir, 'task'), workspace = join(root, 'repositories');
  await cloneFixture(MAE_BUILD_REPOSITORIES[0].url, join(workspace, 'MAEStarterParent'));
  for (const repo of MAE_BUILD_REPOSITORIES) await cloneFixture(repo.url, join(root, repo.name));
  const service = new TaskService({ dataDir: join(dir, 'data'), provider: 'fixture', model: 'fixture', modelsJson: {} });
  try {
    const mounts = await (service as any).taskContainerMounts({ cwd: workspace,
      summary: { id: 'task-56', workspace: root, repo_url: MAE_BUILD_REPOSITORIES[0].url } }, []);
    assert.equal(mounts.environment.MFC_MAE_BUILD_ERROR, undefined);
    for (const volume of maeBuildVolumes(root)) assert.ok(mounts.volumes.includes(volume));
  } finally { await service.shutdown(); }
});
test('辅助仓父目录不能借符号链接越出任务现场', async t => {
  const dir = temp(t), outside = join(dir, 'outside'), root = join(dir, 'task'); mkdirSync(outside); symlinkSync(outside, root);
  await assert.rejects(prepareMaeBuildSupport({ root, dataDir: join(dir, 'data'), repositories: [MAE_BUILD_REPOSITORIES[0].url], clone: cloneFixture }), /符号链接/);
  assert.deepEqual(readdirSync(outside), []);
});
test('克隆半途失败不会冒充就绪；重试可完成', async t => {
  const dir = temp(t); let fail = true;
  const input = { root: join(dir, 'task'), dataDir: join(dir, 'data'), repositories: [MAE_BUILD_REPOSITORIES[0].url],
    clone: async (url: string, target: string) => { await cloneFixture(url, target); if (fail) { fail = false; throw new Error('network'); } } };
  await assert.rejects(prepareMaeBuildSupport(input), /network/);
  assert.equal(existsSync(join(input.root, 'MAEStarterParent')), false);
  await prepareMaeBuildSupport(input);
  assert.ok(existsSync(join(input.root, 'MAEServiceBuildCache/mfc-support.json')));
});
test('问题流 prepareMaeBuild 降级：辅助仓 dirty 不再抛断会话，回执+转移账留痕', async t => {
  const { IssueFlowService } = await import('../src/issueFlow/service.ts');
  const { ScriptedModelServer } = await import('../src/scriptedModel.ts');
  const dir = temp(t), root = join(dir, 'repo');
  for (const repo of MAE_BUILD_REPOSITORIES) await cloneFixture(repo.url, join(root, repo.name));
  const model = new ScriptedModelServer([{ text: 'idle' }]); await model.start();
  const service = new IssueFlowService({ dataDir: join(dir, 'data'), provider: 'maeflow',
    model: 'scripted-v1', modelsJson: model.modelsJson(), deferRecovery: true });
  const state: any = { repo_urls: ['https://codehub.example.com/example-org/FarsService.git'] };
  const live = { id: 'issue-degrade', root: dir, state };
  try {
    // 干净辅助仓:照常就绪,无降级回执。
    assert.equal(await (service as any).prepareMaeBuild(live), undefined);
    // 模拟签名工具原地写脏 DeployBuildTool(重启续跑撞上的现场):
    // 降级回执给调用方,转移账留痕,绝不抛——抛了就是重启即 failed。
    writeFileSync(join(root, 'DeployBuildTool/fixture'), 'signature tool rewrote config');
    const detail = await (service as any).prepareMaeBuild(live);
    assert.match(String(detail), /已被修改: DeployBuildTool/);
    assert.match(String(state.transitions?.at(-1)?.note ?? ''), /降级/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
test('POM parent 按完整节点识别；cgroup v1/v2/max/小于一核', () => {
  assert.equal(buildType('<project><parent>\n<groupId>mae</groupId>\n<version>1</version><artifactId>cpp-parent</artifactId></parent></project>'), 'ServiceBuild_C');
  assert.equal(buildType('<!-- <parent><artifactId>cpp</artifactId></parent> --><parent><artifactId>java</artifactId></parent>'), 'ServiceBuild');
  assert.equal(quotaCores('800000 100000', '', '', 32), 8);
  assert.equal(quotaCores('max 100000', '', '', 6), 6);
  assert.equal(quotaCores('50000 100000', '', '', 32), 1);
  assert.equal(quotaCores('', '200000', '100000', 32), 2);
});
test('恢复 HOME 与 npm 路由，不输出配置；旧 registry 不能盖过 MAE 路由', t => {
  const dir = temp(t), support = join(dir, 'support');
  mkdirSync(join(support, 'MAEBuild/full_build/common_config'), { recursive: true });
  const contents = 'registry=https://internal.example/npm\n@example:registry=https://internal.example/product\n//internal.example/:_authToken=fixture-secret\n';
  writeFileSync(join(support, 'MAEBuild/full_build/common_config/.npmrc'), contents);
  for (const homeName of ['home1', 'home2']) {
    const home = join(dir, homeName); mkdirSync(home);
    const result = spawnSync('sh', ['-ec', MAE_CONTAINER_BOOTSTRAP + '\n' + MAE_EXEC_ENVIRONMENT + '\nprintf "%s" "$npm_config_registry"'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, MFC_MAE_BUILD_ROOT: support, NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), npm_config_registry: 'https://old.example' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'https://internal.example/npm');
    assert.equal(readFileSync(join(home, '.npmrc'), 'utf8'), contents);
  }
});
test('内置 Skill 可投影、可被 Build-Fix 读取；不放宽 clone/凭据边界', t => {
  const dir = temp(t);
  const result = materializeHostSkills({ sourceRoot: MAE_BUILD_SKILLS, workspaceRoot: dir, snapshotRoot: join(dir, '.mae-flow-work/host-skills/platform-build') });
  assert.deepEqual(result.warnings, []); assert.deepEqual(result.names, ['mae-first-build']);
  assert.equal(prePushSecurityDecision('Read', result.paths[0]), undefined);
  assert.ok(prePushSecurityDecision('Bash', 'git clone https://example.com/repo'));
  assert.equal(prePushSecurityDecision('Bash', 'node /opt/mae-flow-build/first-build.mjs run /work/repo -- mvn package -DskipTests'), undefined);
  const budget = resolvePrePushExecutionBudget({ stacks: ['cpp'], mae: true, maven: true, maven_command: 'mvn', repository_guides: [], selected_skill_snapshot: false, signals: [] });
  assert.equal(budget.attemptTimeoutMs, 90 * 60_000);
  assert.equal(prePushCommandTimeoutSeconds('node /opt/mae-flow-build/first-build.mjs run /work/repo -- bash build/build.sh', 120, budget), 4500);
  assert.equal(isPrePushBuildCommand('node /opt/mae-flow-build/first-build.mjs status /work/repo'), false);
});
test('问题流辅助仓的 AGENTS.md 不污染业务上下文', t => {
  const dir = temp(t);
  for (const name of ['business', ...MAE_BUILD_REPOSITORIES.map(r => r.name)]) {
    const target = join(dir, 'repo', name); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'AGENTS.md'), name);
  }
  assert.deepEqual(collectRepoContextFiles(dir).map(f => f.content), ['business']);
});
test('首编脚本：成功才记录；源文件变化保留增量，配置变更重新准备；命令失败不记成功', t => {
  const root = temp(t), repo = join(root, 'business'), home = join(root, 'home');
  mkdirSync(repo); mkdirSync(home); git(repo, 'init', '-q'); git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo');
  const script = join(root, 'MAEServiceBuild/maecloudbuild/scripts/pre_build.sh'); mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, '#!/bin/sh\necho prepare >> "$1/prepared.log"\n');
  mkdirSync(join(root, 'MAEServiceBuildCache')); writeFileSync(join(root, 'MAEServiceBuildCache/mfc-support.json'), '{}');
  writeFileSync(join(repo, 'package.json'), '{}'); writeFileSync(join(home, '.npmrc'), 'registry=https://internal.example');
  const env = { ...process.env, HOME: home, MFC_MAE_BUILD_ROOT: root, MFC_MAE_BUILD_PLATFORM: 'euleros_x86', MFC_MAE_BASELINE: 'release/test', NPM_CONFIG_USERCONFIG: join(home, '.npmrc') };
  const runner = resolve('assets/mae-build/first-build.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', env });
  assert.match(run('status', repo).stdout, /needs_first_build/);
  assert.notEqual(run('run', repo, '--', 'sh', '-c', 'exit 9').status, 0);
  assert.equal(existsSync(join(repo, '.mae-flow-work/mae-first-build.json')), false);
  assert.equal(run('run', repo, '--', 'sh', '-c', 'mkdir -p node_modules; echo compiled >> compiled.log').status, 0);
  assert.match(run('status', repo).stdout, /ready_for_incremental/);
  writeFileSync(join(repo, 'source.js'), 'source changed');
  assert.match(run('status', repo).stdout, /ready_for_incremental/);
  assert.equal(run('run', repo, '--', 'sh', '-c', 'echo compiled >> compiled.log').status, 0);
  assert.equal(readFileSync(join(repo, 'compiled.log'), 'utf8').trim().split('\n').length, 2);
  assert.equal(readFileSync(join(repo, 'prepared.log'), 'utf8').trim().split('\n').length, 2);
  writeFileSync(join(repo, 'package.json'), '{"name":"changed"}');
  assert.match(run('status', repo).stdout, /needs_first_build/);
});

test('真实 Docker：只读辅助仓、临时 HOME 重建后恢复路由，首编记录跨容器复用', {
  skip: !process.env.MFC_REAL_BUILD_IMAGE ? '设置 MFC_REAL_BUILD_IMAGE 运行真实容器回归' : false,
  timeout: 120_000,
}, async t => {
  const { TaskContainer } = await import('../src/containerRuntime.ts');
  const base = join(process.cwd(), '.e2e-fixtures'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'mae-first-build-')), repo = join(root, 'business');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(repo); git(repo, 'init', '-q'); git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo');
  for (const helper of MAE_BUILD_REPOSITORIES) mkdirSync(join(root, helper.name));
  const prepare = join(root, 'MAEServiceBuild/maecloudbuild/scripts'); mkdirSync(prepare, { recursive: true });
  writeFileSync(join(prepare, 'pre_build.sh'), '#!/bin/sh\necho prepare >> "$1/prepared.log"\n');
  const config = join(root, 'MAEBuild/full_build/common_config'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, '.npmrc'), 'registry=https://internal.example/npm\n@example:registry=https://internal.example/product\n');
  mkdirSync(join(root, 'MAEServiceBuildCache/c2'), { recursive: true });
  writeFileSync(join(root, 'MAEServiceBuildCache/mfc-support.json'), '{}');
  writeFileSync(join(repo, 'package.json'), '{}'); writeFileSync(join(repo, 'source.js'), 'const works = 1;');
  const options = { network: 'none', environment: { MFC_MAE_BUILD_ROOT: root, MFC_MAE_BASELINE: 'release/test',
    MFC_MAE_BUILD_PLATFORM: 'euleros_x86', npm_config_registry: 'https://old.example' } };
  const { perRepoBuildCacheMounts } = await import('../src/buildCacheMounts.ts');
  const cache = perRepoBuildCacheMounts({ cacheRoot: join(root, 'cache'), cacheKeySource: 'fixture', volumes: [] });
  Object.assign(options.environment, cache.environment);
  const volumes = [...cache.volumes, ...maeBuildVolumes(root), `${resolve('assets/mae-build')}:/opt/mae-flow-build:ro`];
  const invoke = async (container: InstanceType<typeof TaskContainer>, command: string) => {
    let output = ''; const result = await container.exec(command, repo, { timeout: 30, onData: data => { output += data.toString(); } });
    assert.equal(result.exitCode, 0, output); return output;
  };
  for (let round = 0; round < 2; round++) {
    const container = new TaskContainer(process.env.MFC_REAL_BUILD_IMAGE!, repo, `mfc-mae-first-${process.pid}-${round}`, undefined,
      volumes, { user: '501:20', cpus: '2' }, options);
    try {
      await container.start();
      assert.equal((await invoke(container, 'printf "%s" "$npm_config_registry"')).trim(), 'https://internal.example/npm');
      await invoke(container, `test -s "$HOME/.mae-build-image" && test -r "$NPM_CONFIG_USERCONFIG"`);
      if (round === 0) {
        await invoke(container, `node /opt/mae-flow-build/first-build.mjs run '${repo}' -- sh -c 'node --check source.js && mkdir -p node_modules'`);
      } else assert.match(await invoke(container, `node /opt/mae-flow-build/first-build.mjs status '${repo}'`), /ready_for_incremental/);
      const result = await container.exec(`touch '${root}/MAEBuild/forbidden'`, repo, { onData: () => {}, timeout: 5 });
      assert.notEqual(result.exitCode, 0, '辅助仓必须只读');
    } finally { await container.stop(); }
  }
  assert.equal(readFileSync(join(repo, 'prepared.log'), 'utf8').trim(), 'prepare');
});

test('真实会话装配：需求和问题流都能发现内置首编 Skill，同名旧 Skill 不重复注入', async t => {
  const { CloudSession } = await import('../src/sessionDriver.ts');
  const { ScriptedModelServer } = await import('../src/scriptedModel.ts');
  const { EventLog } = await import('../src/semanticEvents.ts');
  const { TranscriptStore } = await import('../src/transcriptStore.ts');
  const { GateService } = await import('../src/gateService.ts');
  const { HumanGate } = await import('../src/humanGate.ts');
  const root = temp(t), workspace = join(root, 'business'), shelf = join(root, 'shelf/mae-first-build');
  mkdirSync(workspace); mkdirSync(shelf, { recursive: true });
  writeFileSync(join(shelf, 'SKILL.md'), '---\nname: mae-first-build\ndescription: OBSOLETE-RECIPE\n---\nold');
  const prepare = join(root, 'MAEServiceBuild/maecloudbuild/scripts'); mkdirSync(prepare, { recursive: true }); writeFileSync(join(prepare, 'pre_build.sh'), 'true');
  for (const knowledgeScope of ['task', 'issue'] as const) {
    const model = new ScriptedModelServer([{ text: 'done' }]); await model.start();
    const agentDir = join(workspace, 'pi-agent'); mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify(model.modelsJson()));
    const session = await CloudSession.create({ taskId: `mae-${knowledgeScope}`, workspace, agentDir, knowledgeScope,
      hostSkillsDir: dirname(shelf), provider: 'maeflow', model: 'scripted-v1',
      eventLog: new EventLog(join(workspace, 'events.jsonl')), transcript: new TranscriptStore(join(workspace, 'transcript.jsonl'), 'main'),
      gate: new GateService({ workspace, cwd: workspace }), humanGate: new HumanGate(join(workspace, 'waiting.json')) });
    try { assert.equal((await session.start('开始')).status, 'turn_finished');
      const prompt = JSON.stringify(model.requests); assert.match(prompt, /MAE 标准构建镜像中首次编译/); assert.doesNotMatch(prompt, /OBSOLETE-RECIPE/);
    } finally { session.dispose(); await model.stop(); }
  }
});

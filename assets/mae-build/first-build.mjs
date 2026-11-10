#!/usr/bin/env node
// Runs only inside a task container. Receipts accelerate preparation; they are not delivery evidence.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { availableParallelism, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
export function quotaCores(cpuMax, quota, period, available = availableParallelism()) {
  const [q, p] = cpuMax.trim().split(/\s+/);
  const limit = q && q !== 'max' ? Number(q) / Number(p) : Number(quota) / Number(period);
  return Math.max(1, Math.min(available, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : available));
}
export function buildType(pom, nativeFiles = false) {
  const xml = pom.replace(/<!--[\s\S]*?-->/g, '');
  const parent = xml.match(/<(?:\w+:)?parent\b[^>]*>([\s\S]*?)<\/(?:\w+:)?parent>/)?.[1] ?? '';
  const artifact = parent.match(/<(?:\w+:)?artifactId\b[^>]*>\s*([^<]+)</)?.[1] ?? '';
  return /cpp/i.test(artifact) || nativeFiles ? 'ServiceBuild_C' : 'ServiceBuild';
}
function execute(command, args, cwd) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', fail);
    child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`${command} 未完成 (${signal ?? code})`)));
  });
}
function identity(repo, root) {
  const hash = createHash('sha256').update('mae-first-build-v1');
  hash.update(read(join(process.env.HOME ?? '', '.mae-build-image')));
  hash.update(process.env.MFC_MAE_BUILD_PLATFORM ?? process.arch);
  hash.update(read(join(root, 'MAEServiceBuildCache/mfc-support.json')));
  // Source-only edits preserve incremental outputs. Build configuration changes invalidate preparation.
  for (const file of ['pom.xml', 'CMakeLists.txt', 'build/build.sh', 'package.json', 'package-lock.json',
    'pnpm-lock.yaml', 'yarn.lock', 'website/package.json', 'website/package-lock.json', 'website/pnpm-lock.yaml', 'website/yarn.lock']) {
    hash.update(file).update(read(join(repo, file)));
  }
  for (const tool of ['java', 'mvn', 'gcc', 'node']) {
    const result = spawnSync(tool, [tool === 'java' ? '-version' : '--version'], { encoding: 'utf8', timeout: 10_000 });
    hash.update(tool).update(String(result.stdout ?? '')).update(String(result.stderr ?? ''));
  }
  return hash.digest('hex');
}

export function acquireBuildLock(repo) {
  const lock = join(repo, '.mae-flow-work/mae-first-build.lock');
  mkdirSync(dirname(lock), { recursive: true });
  // 先写完整元数据，再原子发布目录；进程中途退出不会留下“无人持有”的正式锁。
  const publication = mkdtempSync(`${lock}.prepare-`);
  const owner = { pid: process.pid, host: hostname(), token: publication };
  try {
    writeFileSync(join(publication, 'owner.json'), JSON.stringify(owner));
    if (existsSync(lock)) {
      let previous;
      try { previous = JSON.parse(read(join(lock, 'owner.json'))); } catch { /* inspect below */ }
      if (!previous || typeof previous.host !== 'string' || !Number.isInteger(previous.pid) || previous.pid <= 0) {
        // 旧版本崩溃留下的空目录可以由 rename 原子替换；不猜测损坏的非空锁。
        if (readdirSync(lock).length) throw new Error(`首编锁信息损坏：${lock}；请确认没有构建进程后移走该锁再重试`);
      } else {
        let alive = previous.host === hostname();
        if (alive) { try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; } }
        if (alive) throw new Error('本仓已有首编正在执行，请等待其收口；不要同时启动第二次构建');
        rmSync(lock, { recursive: true });
      }
    }
    try { renameSync(publication, lock); }
    catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw new Error('本仓已有首编正在执行，请等待其收口');
      throw error;
    }
  } finally { rmSync(publication, { recursive: true, force: true }); }
  return () => {
    let current;
    try { current = JSON.parse(read(join(lock, 'owner.json'))); } catch { return; }
    if (current.token === owner.token) rmSync(lock, { recursive: true, force: true });
  };
}

export async function main(argv = process.argv.slice(2)) {
  const [action, rawRepo, ...args] = argv;
  if (action === 'cores') {
    console.log(quotaCores(read('/sys/fs/cgroup/cpu.max'), read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), read('/sys/fs/cgroup/cpu/cpu.cfs_period_us')));
    return;
  }
  if (!['status', 'run'].includes(action) || !rawRepo) throw new Error('用法: first-build.mjs status <仓根> | run <仓根> -- <构建命令与参数> | cores');
  if (!process.env.MFC_MAE_BUILD_ROOT) throw new Error('平台尚未准备 MAE 构建资源；请检查任务容器配置');
  if (process.env.MFC_MAE_BUILD_ERROR) throw new Error('平台准备 MAE 辅助仓失败；请查看任务构建资源日志');
  const repo = realpathSync(resolve(rawRepo));
  const root = realpathSync(process.env.MFC_MAE_BUILD_ROOT);
  if (dirname(repo) !== root || !existsSync(join(repo, '.git'))) throw new Error('必须传入已克隆的 MAE 业务仓根目录');
  const script = join(root, 'MAEServiceBuild/maecloudbuild/scripts/pre_build.sh');
  if (!existsSync(script) || !existsSync(join(root, 'MAEServiceBuildCache/mfc-support.json'))) throw new Error('MAE 辅助仓不完整');
  const receipt = join(repo, '.mae-flow-work/mae-first-build.json');
  const key = identity(repo, root);
  let previous;
  try { previous = JSON.parse(read(receipt)); } catch { /* no successful first build */ }
  const outputs = ['target', 'website/node_modules', 'node_modules', 'build/CMakeCache.txt'];
  const ready = previous?.identity === key && Array.isArray(previous?.outputs) && previous.outputs.length > 0
    && previous.outputs.every((path) => outputs.includes(path) && existsSync(join(repo, path)));
  if (action === 'status') {
    console.log(JSON.stringify({ state: ready ? 'ready_for_incremental' : 'needs_first_build',
      meaning: '仅表示构建准备状态；当前代码仍须真实编译和测试' }));
    return;
  }
  if (args.shift() !== '--' || !args.length) throw new Error('run 必须提供 -- 后的真实构建命令');
  const releaseLock = acquireBuildLock(repo);
  try {
  if (!ready) {
    const platform = process.env.MFC_MAE_BUILD_PLATFORM || (process.arch === 'x64' ? 'euleros_x86' : '');
    if (!platform || !/^[a-zA-Z0-9_-]+$/.test(platform)) throw new Error('此首编配方仅验证过 euleros_x86；当前架构需由部署配置 MFC_MAE_BUILD_PLATFORM');
    const baseline = process.env.MFC_MAE_BASELINE;
    const branch = baseline || spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo, encoding: 'utf8' }).stdout?.trim().replace(/^origin\//, '');
    if (!branch) throw new Error('无法确定构建基线，请由平台登记基线；不能猜 master');
    const codeUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).stdout?.trim();
    if (!codeUrl) throw new Error('业务仓没有 origin 地址');
    console.log('[mae-build] 准备首次构建环境');
    await execute('bash', [script, repo, join(root, 'MAEServiceBuildCache/c2'), codeUrl,
      buildType(read(join(repo, 'pom.xml')), existsSync(join(repo, 'build/svc_profile.sh'))), branch, platform, ''], repo);
    // The old script may silently ignore readonly writes. Check the essential platform replacements.
    if (existsSync(join(repo, 'pom.xml')) && !existsSync('/etc/mae-flow/maven/settings.xml')) throw new Error('Maven settings 未由平台挂载');
    if ((existsSync(join(repo, 'package.json')) || existsSync(join(repo, 'website/package.json')))
      && !read(process.env.NPM_CONFIG_USERCONFIG ?? '').match(/^\s*registry\s*=/m)) throw new Error('MAE npm registry 未准备好');
  }
  // Always execute the supplied command, even if preparation is already ready.
  await execute(args[0], args.slice(1), repo);
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(`${receipt}.tmp`, JSON.stringify({ identity: identity(repo, root), finished_at: new Date().toISOString(),
    outputs: outputs.filter((path) => existsSync(join(repo, path))) }));
  renameSync(`${receipt}.tmp`, receipt);
  console.log('[mae-build] 本次构建命令成功；后续按语言 Skill 增量构建，交付仍需编译和测试验收');
  } finally { releaseLock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[mae-build] ${error.message}`); process.exitCode = 1; });
}

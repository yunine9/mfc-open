/** Root 守护进程把实际 bind 工作区交给非 root 容器用户的回归。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  prepareContainerHostPaths,
  prepareContainerWritableFile,
  repairContainerCloneOwnership,
  repairContainerKernelOwnership,
  repairContainerMutationOwnership,
  rootContainerOwner,
} from "../src/containerOwnership.ts";

test("只有 Linux root 宿主需要 chown，且必须给数字非 root uid:gid", () => {
  assert.equal(rootContainerOwner("10001:10001", {
    platform: "linux", effectiveUid: 1000,
  }), undefined);
  assert.equal(rootContainerOwner("10001:10001", {
    platform: "darwin", effectiveUid: 0,
  }), undefined);
  assert.deepEqual(rootContainerOwner("10001:10002", {
    platform: "linux", effectiveUid: 0,
  }), { uid: 10001, gid: 10002 });
  for (const invalid of [undefined, "builder:builder", "10001", "0:10001", "10001:0"]) {
    assert.throws(() => rootContainerOwner(invalid, {
      platform: "linux", effectiveUid: 0,
    }), /数字 uid:gid|正整数/);
  }
});

test("工作区、分仓缓存与共享下载缓存统一交给容器用户，符号链接不跟随到外部", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-"));
  const workspace = join(root, "repo");
  const nested = join(workspace, "src");
  const outside = join(root, "outside.txt");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "main.ts"), "export {};\n");
  writeFileSync(outside, "do not follow\n");
  symlinkSync(outside, join(workspace, "outside-link"));
  const cache = join(root, "cache");
  const markerRoot = join(root, "ownership-markers");
  const volumes: string[] = [];
  for (const name of ["maven", "npm", "ccache", "xdg"]) {
    const path = join(cache, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "seed"), name);
    volumes.push(`${path}:/cache/${name}`);
  }
  const cppSdk = join(cache, "cpp-sdk");
  mkdirSync(cppSdk, { recursive: true });
  writeFileSync(join(cppSdk, "seed"), "cpp-sdk");
  volumes.push(
    `${cppSdk}:${join(dirname(workspace), "cpp_sdk_repository")}`,
  );
  const shared = join(cache, "shared-maven", "remote");
  mkdirSync(shared, { recursive: true });
  volumes.push(`${shared}:/cache/maven/repository/.mfc-remote`);
  const customOutsideCacheRoot = join(root, "custom-cpp-sdk");
  mkdirSync(customOutsideCacheRoot, { recursive: true });
  volumes.push(
    `${customOutsideCacheRoot}:${join(root, "other", "cpp_sdk_repository")}`,
  );

  const currentUid = process.getuid?.();
  const currentGid = process.getgid?.();
  assert.notEqual(currentUid, undefined);
  assert.notEqual(currentGid, undefined);
  // 普通开发机只能 chown 给自己；root CI 则故意换一个 uid/gid，证明
  // 外部文件不会被工作区里的软链连带修改。
  const uid = currentUid === 0 ? 12345 : currentUid!;
  const gid = currentGid === 0 ? 12345 : currentGid!;
  const outsideBefore = statSync(outside);
  const prepared = prepareContainerHostPaths({
    workspace,
    volumes,
    cacheRoot: cache,
    markerRoot,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(prepared.active, true);
  assert.equal(prepared.cacheTrees, 6);
  assert.equal(statSync(shared).uid, uid, "共享下载目录也必须允许构建用户写入");
  assert.equal(statSync(customOutsideCacheRoot).uid, currentUid,
    "即使目标同名，自定义 volume 也不能被平台递归 chown");
  assert.equal(statSync(workspace).uid, uid);
  assert.equal(statSync(join(nested, "main.ts")).uid, uid);
  assert.equal(lstatSync(join(workspace, "outside-link")).uid, uid);
  assert.equal(statSync(outside).uid, outsideBefore.uid,
    "工作区软链不能把 chown 带到宿主其他文件");
  for (const name of ["maven", "npm", "ccache", "xdg"]) {
    assert.equal(statSync(join(cache, name, "seed")).uid, uid);
  }
  assert.equal(statSync(join(cppSdk, "seed")).uid, uid,
    "动态目的路径的 C++ SDK 缓存也必须在自检/正式任务前交给容器用户");

  const repeated = prepareContainerHostPaths({
    workspace,
    volumes,
    cacheRoot: cache,
    markerRoot,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(repeated.cacheTrees, 0, "缓存属主正确后不应每单递归重扫");

  // 共享挂载上线前 maven 根已有 marker；新增的父目录仍需交给构建用户。
  const repository = join(cache, "maven", "repository");
  mkdirSync(join(repository, ".mfc-remote"), { recursive: true });
  prepareContainerHostPaths({ workspace, volumes, cacheRoot: cache, markerRoot,
    user: `${uid}:${gid}`, runtime: { platform: "linux", effectiveUid: 0 } });
  assert.equal(statSync(repository).uid, uid);
  assert.equal(statSync(join(repository, ".mfc-remote")).uid, uid);
});

test("独立挂载的 reviews 目录也交给非 root 容器用户", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-review-owner-"));
  const reviews = join(root, "task-1", "reviews");
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(reviews, "local-annotations.json"), "{}\n");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();

  const prepared = prepareContainerHostPaths({
    workspace: reviews,
    volumes: [],
    markerRoot: join(root, "markers"),
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });

  assert.equal(prepared.active, true);
  assert.equal(statSync(reviews).uid, uid);
  assert.equal(statSync(join(reviews, "local-annotations.json")).uid, uid);
});

test("反馈回执只交接单个文件，不改变同目录宿主索引的属主", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-receipt-owner-"));
  const workspace = join(root, "task-1");
  const feedback = join(workspace, "feedback");
  const index = join(feedback, "index.jsonl");
  const receipt = join(feedback, "result-one.json");
  mkdirSync(feedback, { recursive: true, mode: 0o700 });
  writeFileSync(index, "{}\n");
  writeFileSync(receipt, "");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const directoryBefore = statSync(feedback);
  const indexBefore = statSync(index);

  prepareContainerWritableFile({
    workspace,
    path: receipt,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });

  assert.equal(statSync(receipt).uid, uid);
  assert.equal(statSync(receipt).gid, gid);
  assert.equal(statSync(feedback).uid, directoryBefore.uid,
    "不能为写一份回执把 feedback 整目录交给 Agent");
  assert.equal(statSync(index).uid, indexBefore.uid,
    "宿主持续检视索引必须保持原属主");
});

test("bind 工作区根本身是软链时拒绝，不能把宿主路径偷换出去", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-link-"));
  const outside = join(root, "outside");
  const linked = join(root, "workspace");
  mkdirSync(outside);
  symlinkSync(outside, linked, "dir");
  assert.throws(() => prepareContainerHostPaths({
    workspace: linked,
    volumes: [],
    markerRoot: join(root, "markers"),
    user: "10001:10001",
    runtime: { platform: "linux", effectiveUid: 0 },
  }), /挂载根不能是符号链接/);
});

test("宿主 Write/Edit 后只修实际工作区文件与父目录，不碰仓外材料", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-write-"));
  const workspace = join(root, "repo");
  const source = join(workspace, "src", "new", "Main.java");
  const outside = join(root, "pipeline.log");
  mkdirSync(join(workspace, "src", "new"), { recursive: true });
  writeFileSync(source, "class Main {}\n");
  writeFileSync(outside, "failed\n");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const outsideBefore = statSync(outside);
  assert.equal(repairContainerMutationOwnership({
    workspace,
    path: "src/new/Main.java",
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  }), true);
  assert.equal(statSync(source).uid, uid);
  assert.equal(statSync(join(workspace, "src", "new")).uid, uid);
  assert.equal(repairContainerMutationOwnership({
    workspace,
    path: "../pipeline.log",
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  }), false);
  assert.equal(statSync(outside).uid, outsideBefore.uid);
});

test("#602 CodeCheck 预置目录递归交还容器用户，保留硬链接且不跟随外部软链接", t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-codecheck-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "repo"), cli = join(workspace, ".codecheckcli");
  const tools = join(cli, "home/product/tools/agent/1/tools");
  mkdirSync(tools, { recursive: true });
  const master = join(root, "master"), linked = join(tools, "checker");
  writeFileSync(master, "binary", { mode: 0o700 });
  linkSync(master, linked);
  const outside = join(root, "outside"); writeFileSync(outside, "private");
  const before = statSync(outside);
  symlinkSync(outside, join(tools, "external"));
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  assert.equal(repairContainerMutationOwnership({ workspace, path: cli, user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 }, recursive: true }), true);
  for (const path of [cli, tools, linked]) {
    assert.equal(statSync(path).uid, uid);
    assert.equal(statSync(path).gid, gid);
  }
  assert.equal(statSync(linked).ino, statSync(master).ino);
  assert.equal(statSync(linked).mode & 0o777, 0o700);
  assert.equal(statSync(outside).uid, before.uid);
  assert.equal(statSync(outside).gid, before.gid);
});

test("宿主内核原子换新的状态文件会立即交还容器用户", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-container-owner-kernel-"));
  mkdirSync(join(workspace, ".mae-flow", "evidence"), { recursive: true });
  writeFileSync(join(workspace, ".mae-flow.json"), "{}\n");
  writeFileSync(join(workspace, ".mae-flow", "evidence", "state.json"), "{}\n");
  writeFileSync(join(workspace, "README.md"), "business\n");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const readmeBefore = statSync(join(workspace, "README.md"));
  repairContainerKernelOwnership({
    workspace,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(statSync(join(workspace, ".mae-flow.json")).uid, uid);
  assert.equal(statSync(join(workspace, ".mae-flow", "evidence", "state.json")).uid,
    uid);
  assert.equal(statSync(join(workspace, "README.md")).uid, readmeBefore.uid,
    "内核收口不能顺带遍历业务源码");
});

test("克隆收口只在 Linux root 宿主激活，守卫先行零副作用", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-container-owner-clone-"));
  const repo = join(workspace, "repo", "origin");
  // 守卫不激活时连"目录不存在"都不许报错:非 root 部署每次拉仓都路过
  // 这里,缺 user 也一样——rootContainerOwner 对缺 user 的 fail-loud
  // 是容器启动期契约,不能泄漏到拉仓收口。
  for (const runtime of [
    { platform: "linux" as const, effectiveUid: 1000 },
    { platform: "darwin" as const, effectiveUid: 0 },
  ]) {
    assert.equal(repairContainerCloneOwnership({
      workspace, dir: repo, user: "10001:10001", runtime,
    }), false);
  }
  assert.equal(repairContainerCloneOwnership({
    workspace, dir: repo, runtime: { platform: "linux", effectiveUid: 0 },
  }), false);
});

test("克隆收口只认工作区内的仓现场，根目录与越界路径一律不碰", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-clone-b-"));
  const workspace = join(root, "ws");
  mkdirSync(join(workspace, "repo"), { recursive: true });
  writeFileSync(join(workspace, "issue.json"), "{}\n");
  const outside = join(root, "outside");
  mkdirSync(join(outside, "repo"), { recursive: true });
  writeFileSync(join(outside, "repo", "f"), "x");
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const outsideBefore = statSync(join(outside, "repo", "f"));
  const user = `${uid}:${gid}`;
  const runtime = { platform: "linux" as const, effectiveUid: 0 };
  assert.equal(repairContainerCloneOwnership({
    workspace, dir: join(root, "elsewhere", "repo"), user, runtime,
  }), false, "工作区外的同名仓现场不认");
  assert.equal(repairContainerCloneOwnership({
    workspace, dir: join(outside, "repo"), user, runtime,
  }), false, "绝对路径越界同样不认");
  assert.equal(repairContainerCloneOwnership({
    workspace, dir: workspace, user, runtime,
  }), false, "工作区根本身还背着 issue.json 等控制面文件,不许整树交接");
  assert.equal(statSync(join(outside, "repo", "f")).uid, outsideBefore.uid,
    "越界路径不能被 chown");
});

test("克隆收口整树交给容器用户，.git 内部照常交接且软链不跟随", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-container-owner-clone-t-"));
  const workspace = join(root, "ws");
  const repo = join(workspace, "repo", "origin");
  mkdirSync(join(repo, ".git", "objects", "ab"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(join(repo, ".git", "objects", "ab", "cdef"), "obj");
  writeFileSync(join(repo, "Main.ts"), "export {};\n");
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "keep\n");
  symlinkSync(outside, join(repo, ".git", "linked-source"));
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const outsideBefore = statSync(outside);
  assert.equal(repairContainerCloneOwnership({
    workspace, dir: repo, user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  }), true);
  for (const entry of [repo, join(repo, "Main.ts"), join(repo, ".git"),
    join(repo, ".git", "HEAD"),
    join(repo, ".git", "objects", "ab", "cdef")]) {
    assert.equal(statSync(entry).uid, uid, `uid 必须是容器用户: ${entry}`);
    assert.equal(statSync(entry).gid, gid, `gid 必须一起交接: ${entry}`);
  }
  assert.equal(lstatSync(join(repo, ".git", "linked-source")).uid, uid,
    "仓内软链只改链接本身");
  assert.equal(statSync(outside).uid, outsideBefore.uid,
    "软链绝不能把交接带到工作区外");
});

test("root 形态下仓目录缺席必须炸出来，不吞成静默 false", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-container-owner-clone-m-"));
  assert.throws(() => repairContainerCloneOwnership({
    workspace, dir: join(workspace, "repo", "origin"),
    user: "10001:10001", runtime: { platform: "linux", effectiveUid: 0 },
  }), /不存在的容器目录/);
});


test("缓存重建后旧 marker 失效:签名绑定 inode(MFC-013)", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-marker-inode-"));
  const cacheRoot = join(root, "cache");
  const cache = join(cacheRoot, "maven");
  const markerRoot = join(root, "markers");
  const workspace = join(root, "ws");
  mkdirSync(cache, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  const run = () => prepareContainerHostPaths({
    workspace,
    volumes: [`${cache}:/cache/maven:rw`],
    cacheRoot,
    markerRoot,
    user: `${uid}:${gid}`,
    runtime: { platform: "linux", effectiveUid: 0 },
  });
  assert.equal(run().cacheTrees, 1, "首轮核对整棵缓存");
  assert.equal(run().cacheTrees, 0, "同一 inode 第二轮命中 marker 跳过");
  // 模拟回收重建:同路径、新 inode。旧 marker 不得再放行跳过——
  // 曾经签名只有 uid:gid,重建后 root 误以为属主已就位。
  // 不赌"删了重建必换 inode":ext4/overlay 就近分配常复用同号(CI
  // 实测复现),直接把 marker 篡改回陈旧签名,对契约等价且确定。
  const marker = join(markerRoot, readdirSync(markerRoot)[0]);
  const stale = readFileSync(marker, "utf-8")
    .replace(/^(\d+:\d+ \d+):(\d+)$/m, "$1:$2-stale");
  writeFileSync(marker, stale);
  assert.equal(run().cacheTrees, 1, "重建后 inode 变化,必须重新核对");
  assert.equal(run().cacheTrees, 0, "重新核对落账后恢复跳过");
});

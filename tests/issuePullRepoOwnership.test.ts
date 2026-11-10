/**
 * pull_repo 的属主交接回归(#25 真实环境事故形态):问题流的克隆与
 * 切分支都在宿主执行,而容器已经在跑——宿主 root 落盘的 .git 不交回
 * 容器用户,容器内 git add/commit 就是 Permission denied。契约钉在
 * pullRepoFor 的收口时序上:必须在 ensureBranch 等全部宿主 git 写
 * 之后、无条件(不按 cloned 门,存量 root 仓顺带修好)。
 *
 * root 形态用 runtime 注入模拟(先例:containerOwnership.test.ts 的
 * effectiveUid:0),所以不需要 docker 在场;属主断言在 root CI 上是
 * 真交接,开发机上属主本就一致,退化为锁定"收口被调用且在切分支
 * 之后"的契约(时序用例靠 fail-loud 探针在开发机上也保持锋利)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import {
  FIXED_TICKET_STAGES,
  saveState,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import { HumanGate } from "../src/humanGate.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const TICKET = "DTS-2026-1025";
/** 会话修复分支(ADR-0063):基线_工号_单号_时间戳;夹具用定死的假
 * 时间戳代表"会话已定名",属主交接测试不关心时间戳本身。 */
const BRANCH = `master_dev_${TICKET}_20261015090000`;

/** 造一个带初始提交的裸仓远端(克隆源)。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"],
    { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin],
    { env: GIT_ENV });
  return origin;
}

interface LiveHandle {
  id: string;
  root: string;
  state: IssueSessionState;
  humanGate: HumanGate;
}

/** 直驱 pullRepoFor(私有方法按 as 直取,先例:issueContainerUser 的
 * runArgs):不走回合/容器/模型,root 形态的属主交接不需要 docker。 */
function handcraftLive(service: IssueFlowService, root: string, origin: string):
  LiveHandle {
  const state: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "属主交接回归", description: "", source: "dts",
    ticket: TICKET, repo_url: origin, repo_urls: [origin],
    baseline: "master", fix_branch: BRANCH,
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
    status: "idle", stage: "prep_repo", stage_note: "",
    stage_at: new Date().toISOString(),
  };
  saveState(root, state);
  const live: LiveHandle = {
    id: "issue-1", root, state,
    humanGate: new HumanGate(join(root, "waiting.json")),
  };
  (service as unknown as { live: Map<string, LiveHandle> })
    .live.set(live.id, live);
  return live;
}

type PullRepoFor = (live: LiveHandle, url: string) => Promise<{
  dir: string; cloned: boolean; branch?: string; head: string;
}>;

function pullRepoFor(service: IssueFlowService): PullRepoFor {
  return (service as unknown as { pullRepoFor: PullRepoFor })
    .pullRepoFor.bind(service);
}

function rootFormRuntime() {
  return { platform: "linux" as const, effectiveUid: 0 };
}

/** 容器 uid:gid:root CI 故意换一组证明 chown 真的发生;开发机只能
 * chown 给自己,与 containerOwnership.test.ts 同一取舍。 */
function containerOwner(): { user: string; uid: number; gid: number } {
  const uid = process.getuid?.() === 0 ? 12345 : process.getuid!();
  const gid = process.getgid?.() === 0 ? 12345 : process.getgid!();
  return { user: `${uid}:${gid}`, uid, gid };
}

/** 整树(含 .git 内部)属主断言;checked 帽子防止空目录假绿。 */
function assertTreeOwned(dir: string, uid: number, gid: number): void {
  let checked = 0;
  const stack = [dir];
  while (stack.length) {
    const entry = stack.pop()!;
    const stat = lstatSync(entry);
    assert.equal(stat.uid, uid,
      `属主必须是容器 uid: ${relative(dir, entry)}`);
    assert.equal(stat.gid, gid,
      `属组必须一起交接: ${relative(dir, entry)}`);
    checked += 1;
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) stack.push(join(entry, child));
    }
  }
  assert.ok(checked > 10, "整树断言必须真扫到 .git 内部,不能是空壳仓");
}

function currentBranchOf(repoDir: string): string {
  // safe.directory 只认保护级配置(-c 属于它):交接后仓主不再是
  // 当前 euid(root CI 上 12345),不加它 git 直接拒绝读仓。
  return spawnSync("git",
    ["-c", "safe.directory=*", "-C", repoDir, "branch", "--show-current"],
    { encoding: "utf-8" }).stdout.trim();
}

test("root 形态:pull_repo 克隆+宿主切分支后,整树含 .git 交回容器 uid:gid", async () => {
  const dataDir = mfcTemp("mfc-issue-clone-owner-");
  const origin = bareOrigin(dataDir);
  const owner = containerOwner();
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    isolation: {
      image: "fixture/builder:test", volumes: [],
      memory: "512m", cpus: "1", pidsLimit: 128, network: "bridge",
      user: owner.user,
    },
    // 注入 root 宿主形态:开发机也走真 chown 分支(属主恰是本人时
    // walk 幂等零写入),root CI 上则是真实交接。
    ownershipRuntime: rootFormRuntime(),
  });
  try {
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      origin);
    const receipt = await pullRepoFor(service)(live, origin);
    assert.equal(receipt.cloned, true);
    assert.equal(receipt.branch, BRANCH, "有单场景宿主先切好修复分支");
    assert.equal(currentBranchOf(join(live.root, "repo", "origin")), BRANCH,
      "切分支必须真的发生(收口在它之后才有效)");
    assertTreeOwned(join(live.root, "repo", "origin"), owner.uid, owner.gid);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("存量 root 仓(cloned=false):pull_repo 不克隆也把整树交接修好", async () => {
  const dataDir = mfcTemp("mfc-issue-legacy-owner-");
  const origin = bareOrigin(dataDir);
  const owner = containerOwner();
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    isolation: {
      image: "fixture/builder:test", volumes: [],
      memory: "512m", cpus: "1", pidsLimit: 128, network: "bridge",
      user: owner.user,
    },
    ownershipRuntime: rootFormRuntime(),
  });
  try {
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      origin);
    // 预先落一个"上次部署留下的仓":以宿主身份 git init+commit(开发
    // 机=测试用户,CI=root),对容器用户而言就是归别人的存量现场。
    const repoDir = join(live.root, "repo", "origin");
    execFileSync("git", ["init", "-q", "-b", "master", repoDir],
      { env: GIT_ENV });
    writeFileSync(join(repoDir, "legacy.txt"), "legacy\n");
    execFileSync("git", ["-C", repoDir, "add", "."], { env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "legacy"],
      { env: GIT_ENV });
    const receipt = await pullRepoFor(service)(live, origin);
    assert.equal(receipt.cloned, false, "存量仓在场就不该再克隆");
    assert.equal(currentBranchOf(repoDir), BRANCH,
      "存量仓同样过宿主切分支(它又会落新的 root 文件)");
    assertTreeOwned(repoDir, owner.uid, owner.gid);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("属主收口必须压在整个宿主 git 写之后:探针炸出时序倒置", async () => {
  const dataDir = mfcTemp("mfc-issue-owner-order-");
  const origin = bareOrigin(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    // 探针:root 形态 + 名字式 user 会在收口守卫处 fail-loud。若有人
    // 把收口挪回 ensureBranch 之前(伪码方案的原始形态),这里连修复
    // 分支都来不及建——用分支在不在场钉死先后次序。
    isolation: {
      image: "fixture/builder:test", volumes: [],
      memory: "512m", cpus: "1", pidsLimit: 128, network: "bridge",
      user: "builder",
    },
    ownershipRuntime: rootFormRuntime(),
  });
  try {
    const live = handcraftLive(service, join(dataDir, "issues", "issue-1"),
      origin);
    await assert.rejects(() => pullRepoFor(service)(live, origin),
      /数字 uid:gid/, "收口守卫必须被触发,证明调用在场");
    assert.equal(currentBranchOf(join(live.root, "repo", "origin")), BRANCH,
      "守卫炸响时分支已切好:收口在宿主 git 写之后");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("非 root 宿主或缺 isolation.user:pull_repo 照常,属主原样保留", async () => {
  const dataDirA = mfcTemp("mfc-issue-owner-guard-");
  const dataDirB = mfcTemp("mfc-issue-owner-guard2-");
  const origin = bareOrigin(dataDirA);
  const hostUid = process.getuid?.();
  // 形态一:isolation 在场但宿主不是 root(守卫返回 false,零副作用)。
  const nonRoot = new IssueFlowService({
    dataDir: dataDirA, provider: "p", model: "m", modelsJson: {},
    isolation: {
      image: "fixture/builder:test", volumes: [],
      memory: "512m", cpus: "1", pidsLimit: 128, network: "bridge",
      user: "10001:10001",
    },
    ownershipRuntime: { platform: "linux", effectiveUid: 1000 },
  });
  // 形态二:root 形态但没配 isolation.user(非隔离部署每单都路过,
  // 缺 user 必须安静 false,绝不能把容器启动期的 fail-loud 泄漏过来)。
  const noUser = new IssueFlowService({
    dataDir: dataDirB, provider: "p", model: "m", modelsJson: {},
    ownershipRuntime: rootFormRuntime(),
  });
  try {
    const cases: Array<[string, IssueFlowService, string]> = [
      ["非 root", nonRoot, dataDirA],
      ["缺 user", noUser, dataDirB],
    ];
    for (const [name, service, dir] of cases) {
      const live = handcraftLive(service, join(dir, "issues", "issue-1"),
        origin);
      const receipt = await pullRepoFor(service)(live, origin);
      assert.equal(receipt.cloned, true, `${name}:拉仓本身照常成功`);
      const repoDir = join(live.root, "repo", "origin");
      assert.equal(currentBranchOf(repoDir), BRANCH,
        `${name}:切分支照常`);
      // 整树属主保持宿主身份(开发机=当前用户,CI=root 0):守卫
      // false 意味着连一个 inode 都不许被 chown 触碰。
      let checked = 0;
      const stack = [repoDir];
      while (stack.length) {
        const entry = stack.pop()!;
        const stat = lstatSync(entry);
        assert.equal(stat.uid, hostUid,
          `${name}:属主不许被改动: ${relative(repoDir, entry)}`);
        checked += 1;
        if (stat.isDirectory()) {
          for (const child of readdirSync(entry)) stack.push(join(entry, child));
        }
      }
      assert.ok(checked > 10, `${name}:整树核对必须真扫到 .git 内部`);
    }
  } finally {
    await nonRoot.shutdown().catch(() => undefined);
    await noUser.shutdown().catch(() => undefined);
  }
});

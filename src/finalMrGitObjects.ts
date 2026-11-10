import { isAbsolute } from "node:path";
import { HostGitSandbox, runGitProcess } from "./hostGitSandbox.ts";
import { createSafeGitView, runSafeWorktreeGitAsync, safeGitArguments } from "./safeGit.ts";

type MrVersions = { head?: string; base?: string; id?: string | number; source_branch?: string; target_branch?: string };

const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** 首发提交保存在任务仓本地，即使原分支重写，Git 回收时也会保留它。 */
export async function retainInitialMrCommit(cwd: string, head: string): Promise<void> {
  if (!objectId.test(head)) throw new Error("初版 MR 的源提交无效");
  const ref = "refs/mfc-initial-" + head;
  const result = await runSafeWorktreeGitAsync(cwd, ["update-ref", "--no-deref", ref, head], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error("未能在任务仓中保留初版 MR 的源提交");
}

/** 只补齐比较所需的 Git 对象，保留工作区当前分支、暂存区和所有本地引用。 */
export async function prepareFinalMrObjects(cwd: string, repo: string, versions: MrVersions[],
  sandbox: HostGitSandbox, credential?: { username: string; password: string }): Promise<void> {
  const shas = [...new Set(versions.flatMap(mr => [mr.head, mr.base]).filter((sha): sha is string => !!sha))];
  if (!shas.length) return;
  if (shas.some(sha => !objectId.test(sha))) throw new Error("MR 代码版本无效");
  // repo 来自任务配置和平台详情的同仓校验。只允许直接传输，无重定向、子模块或仓库自带的 helper。
  if (!isAbsolute(repo)) {
    const url = new URL(repo);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
      throw new Error("代码仓地址不支持只读取件");
  }

  const view = createSafeGitView(cwd);
  try {
    const git = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) =>
      runGitProcess(safeGitArguments(cwd, args), { cwd, env, timeoutMs });
    const local = view.environment();
    const missing: string[] = [];
    const hasCommit = async (sha: string) =>
      (await git(["cat-file", "-e", sha + "^{commit}"], local, 5000)).status === 0;
    for (const sha of shas) {
      if (!await hasCommit(sha)) missing.push(sha);
    }
    if (!missing.length) return;
    const prepared = sandbox.prepare(credential);
    try {
      const fetch = (refs: string[]) => git([...prepared.args, "-c", "http.followRedirects=false",
        "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "--", repo, ...refs],
        view.environment(prepared.env), 30_000);
      const requested = await fetch(missing);
      if (requested.status !== 0) {
        // 有些服务器只允许按公布的引用读取。源分支删除后，代码平台仍可能保留 MR 的只读引用。
        const refs = new Set<string>();
        for (const mr of versions) {
          if (/^[1-9]\d*$/.test(String(mr.id))) refs.add("refs/merge-requests/" + mr.id + "/head");
          for (const branch of [mr.source_branch, mr.target_branch]) {
            if (branch && (await git(["check-ref-format", "refs/heads/" + branch], local, 5000)).status === 0)
              refs.add("refs/heads/" + branch);
          }
        }
        for (const ref of refs) {
          await fetch([ref]);
          if ((await Promise.all(missing.map(hasCommit))).every(Boolean)) break;
        }
      }
      for (const sha of missing) {
        if (!await hasCommit(sha)) throw new Error("未能读取 MR 对应的代码版本，请核对仓库权限和提交是否仍可读取");
      }
    } finally { sandbox.cleanup(prepared); }
  } finally { view.cleanup(); }
}

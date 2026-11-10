/** MAE 构建资源由宿主准备，业务脚本只在容器运行；不把传输凭据交给 Agent。 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareContainerHostPaths } from "./containerOwnership.ts";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";

export const MAE_BUILD_ASSETS = fileURLToPath(new URL("../assets/mae-build", import.meta.url));
export const MAE_BUILD_SKILLS = fileURLToPath(new URL("../assets/build-skills", import.meta.url));
export const MAE_BUILD_MOUNT = "/opt/mae-flow-build";
export const MAE_BUILD_REPOSITORIES = [
  { name: "MAEStarterParent", url: "https://codehub.example.com/MAE-M/CI/MAEStarterParent.git", ref: "master" },
  { name: "MAEServiceBuild", url: "https://codehub.example.com/MAE-M-Internal/DevTools/MAEServiceBuild.git", ref: "master" },
  { name: "MAEBuild", url: "https://codehub.example.com/MAE-M/CI/MAEBuild.git", ref: "master" },
  { name: "DeployBuildTool", url: "https://codehub.example.com/MAE-M/CI/DeployBuildTool.git", ref: "master" },
] as const;

export function isMaeRepository(repository: string): boolean {
  try { const url = new URL(repository); return url.protocol === "https:"
    && (url.hostname === "codehub.example.com" || url.hostname.endsWith(".codehub.example.com")) && /^\/MAE[^/]*\//i.test(url.pathname); }
  catch { return false; }
}

export function maeBuildRoot(workspace: string): string | undefined {
  return [dirname(resolve(workspace)), join(resolve(workspace), "repo")]
    .find((root) => existsSync(join(root, "MAEServiceBuild", "maecloudbuild", "scripts", "pre_build.sh")));
}

const preparing = new Map<string, Promise<void>>();
/** 同一任务只解析一次 master 并固定 SHA；重建容器不更新辅助仓。 */
export async function prepareMaeBuildSupport(input: {
  root: string; dataDir: string; repositories: readonly string[]; user?: string;
  /** 已由任务以可写方式挂载的工作仓，不作为只读辅助仓准备或固定版本。 */
  workspace?: string;
  clone: (url: string, target: string, ref: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<boolean> {
  if (!input.repositories.some(isMaeRepository)) return false;
  if (existsSync(input.root) && lstatSync(input.root).isSymbolicLink()) throw new Error("MAE 辅助仓父目录不能是符号链接");
  mkdirSync(input.root, { recursive: true });
  const root = realpathSync(input.root);
  let job = preparing.get(root);
  if (!job) {
    job = (async () => {
      mkdirSync(root, { recursive: true });
      if (realpathSync(root) !== root) throw new Error("MAE 辅助仓父目录不能经过符号链接");
      const key = createHash("sha256").update(root).digest("hex");
      const ledgerRoot = join(input.dataDir, ".runtime", "mae-build");
      mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });
      const ledger = join(ledgerRoot, `${key}.json`);
      const pinned = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) as Record<string, string> : {};
      for (const repo of MAE_BUILD_REPOSITORIES) {
        const target = join(root, repo.name);
        if (input.workspace && resolve(target) === resolve(input.workspace)) {
          delete pinned[repo.name];
          continue;
        }
        if (!existsSync(target)) {
          if (pinned[repo.name]) throw new Error(`已固定的 MAE 辅助仓缺失: ${repo.name}；请恢复该任务构建资源`);
          input.log?.(`[mae-build] 准备辅助仓 ${repo.name} (${repo.ref})`);
          // 克隆失败的临时目录不当作完成目录；失败后可重新准备。
          const stagingRoot = mkdtempSync(join(root, `${repo.name}.prepare-`));
          const staging = join(stagingRoot, repo.name);
          try {
            await input.clone(repo.url, staging, repo.ref);
            if (realpathSync(root) !== root) throw new Error("MAE 辅助仓父目录已变化");
            renameSync(staging, target);
          } finally { rmSync(stagingRoot, { recursive: true, force: true }); }
        }
        if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target
          || lstatSync(join(target, ".git")).isSymbolicLink()
          || !lstatSync(join(target, ".git")).isDirectory()) throw new Error(`MAE 辅助仓路径不安全: ${repo.name}`);
        const origin = await runSafeWorktreeGitAsync(target,
          ["config", "--no-includes", "--file", join(target, ".git/config"), "--get", "remote.origin.url"], { timeoutMs: 30_000 });
        if (origin.status !== 0 || String(origin.stdout).trim() !== repo.url) throw new Error(`MAE 辅助仓来源不符: ${repo.name}`);
        const head = await runSafeWorktreeGitAsync(target, ["rev-parse", "HEAD"], { timeoutMs: 30_000 });
        const sha = String(head.stdout ?? "").trim();
        if (head.status !== 0 || !/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`MAE 辅助仓不完整: ${repo.name}`);
        if (pinned[repo.name] && pinned[repo.name] !== sha) throw new Error(`MAE 辅助仓版本已变化: ${repo.name}`);
        const dirty = await runSafeWorktreeGitAsync(target, ["diff", "--quiet", "HEAD", "--"], { timeoutMs: 30_000 });
        if (dirty.status !== 0) throw new Error(`MAE 辅助仓已被修改: ${repo.name}`);
        pinned[repo.name] = sha;
        writeFileSync(`${ledger}.tmp`, JSON.stringify(pinned), { mode: 0o600 });
        renameSync(`${ledger}.tmp`, ledger);
      }
      const cache = join(root, "MAEServiceBuildCache");
      if (existsSync(cache) && lstatSync(cache).isSymbolicLink()) throw new Error("MAE 构建缓存不能是符号链接");
      if (existsSync(join(cache, "c2")) && lstatSync(join(cache, "c2")).isSymbolicLink()) throw new Error("MAE 构建缓存不能是符号链接");
      mkdirSync(join(cache, "c2"), { recursive: true });
      // Agent can write this cache. Atomic replacement never follows an Agent-created manifest symlink.
      const publication = mkdtempSync(join(cache, ".support-"));
      try { writeFileSync(join(publication, "manifest"), JSON.stringify(pinned), { flag: "wx" });
        renameSync(join(publication, "manifest"), join(cache, "mfc-support.json"));
      } finally { rmSync(publication, { recursive: true, force: true }); }
      prepareContainerHostPaths({ workspace: cache, volumes: [], user: input.user, markerRoot: join(input.dataDir, ".container-ownership") });
      input.log?.("[mae-build] 辅助仓就绪，已固定版本；凭据保留在宿主");
    })();
    preparing.set(root, job);
    void job.finally(() => { if (preparing.get(root) === job) preparing.delete(root); }).catch(() => {});
  }
  await job;
  return true;
}

export function maeBuildVolumes(root: string, workspace?: string): string[] {
  return [...MAE_BUILD_REPOSITORIES
    .filter((repo) => !workspace || resolve(root, repo.name) !== resolve(workspace))
    .map((repo) => `${join(root, repo.name)}:${join(root, repo.name)}:ro`),
    `${join(root, "MAEServiceBuildCache")}:${join(root, "MAEServiceBuildCache")}:rw`];
}

export const MAE_CONTAINER_BOOTSTRAP = [
  'if [ -n "${MFC_MAE_BUILD_ROOT:-}" ] && [ -f "$MFC_MAE_BUILD_ROOT/MAEBuild/full_build/common_config/.npmrc" ]; then',
  'cp "$MFC_MAE_BUILD_ROOT/MAEBuild/full_build/common_config/.npmrc" "$NPM_CONFIG_USERCONFIG";',
  'chmod 600 "$NPM_CONFIG_USERCONFIG"; fi',
].join("\n");

/** npm 的环境变量优先于用户配置；每次 exec 都按已准备的 MAE 路由恢复。 */
export const MAE_EXEC_ENVIRONMENT = [
  'if [ -n "${MFC_MAE_BUILD_ROOT:-}" ] && [ -f "$MFC_MAE_BUILD_ROOT/MAEBuild/full_build/common_config/.npmrc" ] && [ -r "$NPM_CONFIG_USERCONFIG" ]; then',
  'mfc_mae_registry=$(sed -n "s/^[[:space:]]*registry[[:space:]]*=[[:space:]]*//p" "$NPM_CONFIG_USERCONFIG" | tail -1 | tr -d "\\r");',
  'if [ -n "$mfc_mae_registry" ]; then export npm_config_registry="$mfc_mae_registry" NPM_CONFIG_REGISTRY="$mfc_mae_registry"; fi; fi',
].join("\n");

export const MAE_FIRST_BUILD_GUIDANCE = "MAE 构建：若能力目录包含 mae-first-build，首次编译前必须读取；C++ 首编必须先准备 UT 依赖，再通过带 DT_test=UT 的 compile 完成编译和全量 UT，不得添加定向筛选；准备有效后使用语言构建 Skill 与 build-notes 增量验证。首编记录不能替代当前代码编译、UT 或流水线。";

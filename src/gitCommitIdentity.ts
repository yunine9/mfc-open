import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface GitCommitIdentity { username: string; email?: string }
export const GIT_COMMIT_IDENTITY_GUIDANCE = "Git 提交身份：使用宿主已写入仓库的 user.name/user.email，直接 git commit。不要根据工号、登录名或域名拼接邮箱；不要用 git -c user.name/user.email、--author、GIT_AUTHOR_* / GIT_COMMITTER_* 或修改 git config 覆盖署名。需要核实时只读 git config --get user.name 和 git config --get user.email；缺失或可疑时如实反馈，由责任人确认正确身份，不自行补造，也不自动改写已推送历史。子 Agent 同样遵循。";

export function gitCommitIdentityConfigs(identity?: GitCommitIdentity): Array<[string, string]> {
  if (!identity?.email) return [];
  return ["user", "author", "committer"].flatMap(prefix => [
    [`${prefix}.name`, identity.username], [`${prefix}.email`, identity.email!],
  ] as Array<[string, string]>);
}

/** Refresh only the managed clone's identity, never global config or commit history. */
export async function applyGitCommitIdentity(cwd: string, identity?: GitCommitIdentity): Promise<void> {
  const configs = gitCommitIdentityConfigs(identity);
  if (!configs.length) return;
  const git = join(cwd, ".git"), config = join(git, "config");
  if (!lstatSync(git).isDirectory() || lstatSync(git).isSymbolicLink()
      || !lstatSync(config).isFile() || lstatSync(config).isSymbolicLink()) {
    throw new Error("无法更新提交身份：任务克隆的 Git 配置不是普通文件");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  for (const [key, value] of configs) await promisify(execFile)("git", ["config", "--file", config, "--replace-all", key, value], {
    cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 10_000,
  });
}

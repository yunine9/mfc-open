/**
 * 本地一键演示:环境验证闸全流程(2026-09-10,PR #168)。
 *
 * 拼好四件假件再拉起 serve,浏览器里手工走完整链:
 *   ① 剧本假模型(驱动 dts_info→分析→修复→MR→申报全绿)
 *   ② FakeGitPlatform(本地裸仓 + MR/流水线假平台,首轮即绿)
 *   ③ 模拟 DTS(--dts-mock,单据 DTS-2026-1001~1007)
 *   ④ 业务模块种子(仓指向假平台裸仓,登记页可选用)
 *
 * 用法:npx tsx scripts/demo-issue-verify.ts [--port 8840]
 * 之后浏览器打开打印的地址,登录 dev / mae-flow-demo,
 * 问题处理 → DTS 页签选 DTS-2026-1001 → 模块选「验证闸演示」→ 登记。
 * AI 全链跑到 MR 全绿后弹出环境验证卡:验证没问题无需作答——MR 全部
 * 合入即视为验证通过,自动归档收口(ADR-0043);答「验证发现问题」+贴
 * 截图 → 回退「问题分析」(第 2 轮),回退指令要求 AI 先与用户对齐再
 * 重写报告;不想要了直接取消(不锁死)。
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";

/** 问题流全链剧本:每幕恰好一个工具调用,按 tool_result 深度顺演。 */
const SCRIPT: Scene[] = [
  { tool: { name: "dts_get_ticket", input: {} } },
  { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
  { tool: { name: "pull_repo", input: {} } },
  { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
  { tool: { name: "bash", input: { command:
    "printf '# 分析\\n\\n## 问题现象\\n导出大数据量时超时。\\n## 问题根因\\n未分页全量查询。\\n## 置信度\\n高。\\n## 修改方案\\n改分页批次导出。\\n' > issue-analysis.md" } } },
  { tool: { name: "submit_analysis",
    input: { conclusion: "issue", summary: "根因=未分页全量查询" } } },
  { tool: { name: "bash", input: { command:
    "echo 'fix: batch export in pages' >> src/App.java" } } },
  { tool: { name: "complete_stage", input: { note: "分页导出已改,自测通过" } } },
  { tool: { name: "push_branch", input: {} } },
  { tool: { name: "create_mr", input: {} } },
  { tool: { name: "complete_stage", input: { mrs: "__REPOS__" } } },
  // 全绿回执指引同回合举卡(#246/ADR-0024):验证卡由 AI 经 raise_gate
  // 举出,平台不代举——漏了这幕,收口后会一直被催办「欠验证卡」。
  { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
  { text: "MR 已申报,流水线全绿,验证卡已交给用户。" },
];

async function main(): Promise<void> {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag > 0 ? process.argv[portFlag + 1] : "8840";
  const home = mkdtempSync(join(tmpdir(), "mfc-demo-verify-"));
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });

  // ① 源仓:一个带初始提交的本地 git 仓(裸仓远端的灌入源)。
  const srcRepo = join(home, "src-repo");
  mkdirSync(join(srcRepo, "src"), { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", ["-C", srcRepo, ...args], { encoding: "utf-8" });
  git(["init", "-q", "-b", "master"]);
  writeFileSync(join(srcRepo, "src", "App.java"),
    "class App { void export() { /* 全量导出 */ } }\n");
  git(["add", "-A"]);
  git(["-c", "user.name=demo", "-c", "user.email=demo@local", "commit", "-qm", "init"]);

  // ② 假交付平台:灌裸仓 + 起 HTTP(MR/流水线全绿剧本)。
  const platform = new FakeGitPlatform();
  platform.initBare(srcRepo, dataDir);
  await platform.start();

  // ③ 剧本模型:申报幕的 MR 清单指向裸仓地址。
  const script = SCRIPT.map((scene) =>
    scene.tool?.name === "complete_stage" && scene.tool.input.mrs === "__REPOS__"
      ? { ...scene, tool: { ...scene.tool,
          input: { mrs: [platform.barePath] } } }
      : scene);
  const model = new ScriptedModelServer(script, "scripted-issue-v1");
  await model.start();
  const modelsJson = join(home, "models.json");
  writeFileSync(modelsJson, JSON.stringify(model.modelsJson(), null, 2));

  // ④ 业务模块种子:登记页的仓来源。
  createBusinessModule(dataDir, {
    id: "demo-verify", name: "验证闸演示", description: "本地演示用",
    owner: "dev", repositories: [platform.barePath],
  }, "demo");

  const url = `http://127.0.0.1:${port}`;
  console.log(`[demo] 假平台: ${platform.baseUrl}(裸仓 ${platform.barePath})`);
  console.log(`[demo] 剧本模型: ${model.baseUrl}`);
  console.log(`[demo] 数据目录: ${dataDir}`);
  console.log(`[demo] 启动服务: ${url}  登录 dev / mae-flow-demo`);
  console.log("[demo] 路径:问题处理 → DTS 页签 → DTS-2026-1001 →"
    + " 模块选「验证闸演示」→ 登记,看 AI 全链跑到验证卡。");

  const child = spawn("npx", ["tsx", "src/serve.ts",
    "--data", dataDir, "--port", port,
    "--dts-mock", "--platform", platform.baseUrl,
    "--models", modelsJson], {
      stdio: "inherit",
      env: { ...process.env, MAE_FLOW_ADMIN_PASSWORD: "demo-verify-123" },
    });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await model.stop();
  await platform.stop();
}

await main();
